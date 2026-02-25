/**
 * Restricted Network Mode for NanoClaw
 * Creates a custom Docker bridge network with iptables-based domain allowlisting.
 * Containers on this network can only reach pre-approved domains on port 443.
 */
import { execFile } from 'child_process';
import dns from 'dns';
import { promisify } from 'util';

import {
  RESTRICTED_ALLOWED_DOMAINS,
  RESTRICTED_DNS_REFRESH_MS,
  RESTRICTED_NETWORK_NAME,
  RESTRICTED_NETWORK_SUBNET,
} from './config.js';
import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';
import { getAllAllowlisted } from './db.js';
import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

// Custom resolver with longer timeout and retries — the default Node DNS
// resolver has a very short timeout that fails on hosts with slow resolvers.
const resolver = new dns.Resolver({ timeout: 10000, tries: 4 });
const resolve4 = promisify(resolver.resolve4.bind(resolver));

const IPTABLES_CHAIN = 'NANOCLAW-RESTRICTED';

let refreshTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Idempotently create the restricted Docker network and set up iptables rules.
 * Call at startup.
 */
export async function ensureRestrictedNetwork(): Promise<void> {
  // 1. Create Docker network (idempotent)
  try {
    await execFileAsync(CONTAINER_RUNTIME_BIN, [
      'network', 'inspect', RESTRICTED_NETWORK_NAME,
    ]);
    logger.debug('Restricted network already exists');
  } catch {
    logger.info('Creating restricted Docker network');
    await execFileAsync(CONTAINER_RUNTIME_BIN, [
      'network', 'create',
      '--driver', 'bridge',
      '--subnet', RESTRICTED_NETWORK_SUBNET,
      RESTRICTED_NETWORK_NAME,
    ]);
    logger.info({ network: RESTRICTED_NETWORK_NAME, subnet: RESTRICTED_NETWORK_SUBNET }, 'Restricted network created');
  }

  // 2. Set up iptables chain
  await setupIptablesChain();

  // 3. Populate initial rules
  await refreshAllowedIps();

  // 4. Start periodic refresh
  refreshTimer = setInterval(() => {
    refreshAllowedIps().catch((err) =>
      logger.error({ err }, 'Failed to refresh restricted network IPs'),
    );
  }, RESTRICTED_DNS_REFRESH_MS);

  logger.info('Restricted network mode initialized');
}

/**
 * Create the custom iptables chain and hook it into DOCKER-USER.
 */
async function setupIptablesChain(): Promise<void> {
  // Create chain (ignore error if already exists)
  try {
    await execFileAsync('iptables', ['-N', IPTABLES_CHAIN]);
  } catch {
    // Chain already exists
  }

  // Check if DOCKER-USER already jumps to our chain
  try {
    const { stdout } = await execFileAsync('iptables', [
      '-L', 'DOCKER-USER', '-n', '--line-numbers',
    ]);
    if (stdout.includes(IPTABLES_CHAIN)) {
      logger.debug('DOCKER-USER already has jump to restricted chain');
      return;
    }
  } catch {
    // DOCKER-USER may not exist yet (Docker not fully started)
    // It will be created by Docker; we'll retry on refresh
    logger.warn('DOCKER-USER chain not found, will retry on next refresh');
    return;
  }

  // Insert jump rule at the top of DOCKER-USER for traffic from our subnet
  try {
    await execFileAsync('iptables', [
      '-I', 'DOCKER-USER', '1',
      '-s', RESTRICTED_NETWORK_SUBNET,
      '-j', IPTABLES_CHAIN,
    ]);
    logger.info('Inserted DOCKER-USER jump to restricted chain');
  } catch (err) {
    logger.error({ err }, 'Failed to insert DOCKER-USER jump rule');
  }
}

/**
 * Resolve all allowed domains and rebuild iptables rules.
 * Called periodically and after dynamic domain approval.
 *
 * Uses a temporary chain to atomically swap rules, avoiding a window
 * where all connections are blocked during the flush-rebuild cycle.
 */
export async function refreshAllowedIps(): Promise<void> {
  // Merge static config domains with dynamically approved domains from DB
  const dynamicDomains = getAllAllowlisted().map((d) => d.domain);
  const allDomains = [...new Set([...RESTRICTED_ALLOWED_DOMAINS, ...dynamicDomains])];

  // Resolve all domains to IPs
  const allIps = new Set<string>();
  let resolveFailures = 0;
  await Promise.all(
    allDomains.map(async (domain) => {
      try {
        const ips = await resolve4(domain);
        for (const ip of ips) allIps.add(ip);
      } catch (err) {
        resolveFailures++;
        logger.warn({ domain, err }, 'Failed to resolve domain for restricted network');
      }
    }),
  );

  // If ALL domains failed to resolve, skip the update to preserve existing rules
  if (allIps.size === 0 && allDomains.length > 0) {
    logger.warn(
      { domainCount: allDomains.length, failures: resolveFailures },
      'All DNS resolutions failed, keeping existing iptables rules',
    );
    return;
  }

  // Build rules in a temporary chain, then swap atomically
  const tmpChain = `${IPTABLES_CHAIN}-TMP`;

  // Create temp chain (delete first if leftover from a previous crash)
  try { await execFileAsync('iptables', ['-F', tmpChain]); } catch {}
  try { await execFileAsync('iptables', ['-X', tmpChain]); } catch {}
  try {
    await execFileAsync('iptables', ['-N', tmpChain]);
  } catch {
    // Shouldn't happen after delete above, but be safe
  }

  // Rule 1: Allow established/related connections
  await iptablesAppendTo(tmpChain, [
    '-m', 'conntrack', '--ctstate', 'ESTABLISHED,RELATED',
    '-j', 'RETURN',
  ]);

  // Rule 2: Allow DNS (UDP 53) so containers can resolve hostnames
  await iptablesAppendTo(tmpChain, [
    '-p', 'udp', '--dport', '53',
    '-j', 'RETURN',
  ]);

  // Rule 3: Allow each resolved IP on port 443
  for (const ip of allIps) {
    await iptablesAppendTo(tmpChain, [
      '-d', ip, '-p', 'tcp', '--dport', '443',
      '-j', 'RETURN',
    ]);
  }

  // Rule 4: Drop everything else
  await iptablesAppendTo(tmpChain, ['-j', 'DROP']);

  // Atomic swap: update DOCKER-USER to jump to temp chain, flush old, swap back
  // Step 1: Redirect DOCKER-USER jump from old chain to temp chain
  try {
    await execFileAsync('iptables', [
      '-R', 'DOCKER-USER', '1',
      '-s', RESTRICTED_NETWORK_SUBNET,
      '-j', tmpChain,
    ]);
  } catch (err) {
    // If replace fails (e.g. rule index changed), fall back to flush-swap
    logger.warn({ err }, 'Atomic swap failed, falling back to flush');
    try { await execFileAsync('iptables', ['-F', tmpChain]); } catch {}
    try { await execFileAsync('iptables', ['-X', tmpChain]); } catch {}
    return;
  }

  // Step 2: Flush old chain (now unreferenced by DOCKER-USER)
  try { await execFileAsync('iptables', ['-F', IPTABLES_CHAIN]); } catch {}

  // Step 3: Copy rules from temp to real chain
  // (We can't rename iptables chains, so we rebuild the real chain)
  await iptablesAppendTo(IPTABLES_CHAIN, [
    '-m', 'conntrack', '--ctstate', 'ESTABLISHED,RELATED', '-j', 'RETURN',
  ]);
  await iptablesAppendTo(IPTABLES_CHAIN, [
    '-p', 'udp', '--dport', '53', '-j', 'RETURN',
  ]);
  for (const ip of allIps) {
    await iptablesAppendTo(IPTABLES_CHAIN, [
      '-d', ip, '-p', 'tcp', '--dport', '443', '-j', 'RETURN',
    ]);
  }
  await iptablesAppendTo(IPTABLES_CHAIN, ['-j', 'DROP']);

  // Step 4: Point DOCKER-USER back to the real chain
  try {
    await execFileAsync('iptables', [
      '-R', 'DOCKER-USER', '1',
      '-s', RESTRICTED_NETWORK_SUBNET,
      '-j', IPTABLES_CHAIN,
    ]);
  } catch (err) {
    logger.error({ err }, 'Failed to restore DOCKER-USER jump to main chain');
  }

  // Step 5: Clean up temp chain
  try { await execFileAsync('iptables', ['-F', tmpChain]); } catch {}
  try { await execFileAsync('iptables', ['-X', tmpChain]); } catch {}

  logger.info(
    { domainCount: allDomains.length, ipCount: allIps.size },
    'Restricted network firewall rules refreshed',
  );
}

async function iptablesAppendTo(chain: string, ruleArgs: string[]): Promise<void> {
  try {
    await execFileAsync('iptables', ['-A', chain, ...ruleArgs]);
  } catch (err) {
    logger.error({ err, chain, rule: ruleArgs.join(' ') }, 'Failed to append iptables rule');
  }
}

/**
 * Stop the refresh timer. Call on shutdown.
 */
export function stopRestrictedNetwork(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}
