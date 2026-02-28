/**
 * Network Proxy for NanoClaw
 * Handles approval flow for non-main container network access.
 * Requests arrive via IPC, approval via WhatsApp, results written back to IPC.
 */
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';

import { RESTRICTED_ALLOWED_DOMAINS } from './config.js';
import { addToAllowlist, isAllowlisted } from './db.js';
import { resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const FETCH_TIMEOUT_MS = 30 * 1000; // 30 seconds for the actual fetch
const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 1024 * 1024; // 1MB — output is truncated to 100KB anyway

interface PendingRequest {
  requestId: string;
  groupFolder: string;
  groupName: string;
  domain: string;
  resolve: (approved: boolean) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

// Map from WhatsApp message ID to pending request
const pendingApprovals = new Map<string, PendingRequest>();

export function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * Handle an approval reply or reaction from the user.
 * Called by the message handler when it detects a reply to a pending approval message.
 */
export function handleApprovalResponse(
  messageId: string,
  approved: boolean,
): boolean {
  const pending = pendingApprovals.get(messageId);
  if (!pending) return false;
  clearTimeout(pending.timeoutHandle);
  pendingApprovals.delete(messageId);
  pending.resolve(approved);
  return true;
}

/**
 * Check if a message is a reply to a pending approval.
 * Returns the set of message IDs that are pending approval.
 */
export function getPendingApprovalIds(): Set<string> {
  return new Set(pendingApprovals.keys());
}

/**
 * Write a proxy response to the group's IPC input directory.
 */
function writeProxyResponse(
  groupFolder: string,
  requestId: string,
  status: 'approved' | 'denied',
  result?: string,
  error?: string,
): void {
  const inputDir = path.join(resolveGroupIpcPath(groupFolder), 'input');
  fs.mkdirSync(inputDir, { recursive: true });

  const response = {
    type: 'proxy_response',
    requestId,
    status,
    ...(result !== undefined ? { result } : {}),
    ...(error !== undefined ? { error } : {}),
  };

  const filename = `proxy-response-${requestId}.json`;
  const filepath = path.join(inputDir, filename);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(response, null, 2));
  fs.renameSync(tempPath, filepath);
}

/**
 * Check if a hostname resolves to a private/internal IP range.
 */
function isPrivateHost(hostname: string): boolean {
  // Block obvious private hostnames
  if (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '0.0.0.0'
  ) {
    return true;
  }
  // Block private IP ranges
  const parts = hostname.split('.').map(Number);
  if (parts.length === 4 && parts.every((p) => !isNaN(p))) {
    if (parts[0] === 10) return true; // 10.0.0.0/8
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true; // 172.16.0.0/12
    if (parts[0] === 192 && parts[1] === 168) return true; // 192.168.0.0/16
    if (parts[0] === 169 && parts[1] === 254) return true; // 169.254.0.0/16 (link-local/cloud metadata)
    if (parts[0] === 127) return true; // 127.0.0.0/8
  }
  return false;
}

/**
 * Perform HTTP(S) fetch and return the response body as text.
 */
async function fetchUrl(
  url: string,
  redirectsRemaining = MAX_REDIRECTS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    // Only allow http(s) schemes
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return reject(new Error(`Blocked non-HTTP URL scheme: ${url}`));
    }

    // Block private/internal IPs (SSRF protection)
    try {
      const parsed = new URL(url);
      if (isPrivateHost(parsed.hostname)) {
        return reject(
          new Error(`Blocked request to private host: ${parsed.hostname}`),
        );
      }
    } catch {
      return reject(new Error(`Invalid URL: ${url}`));
    }

    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: FETCH_TIMEOUT_MS }, (res) => {
      // Follow redirects with depth limit
      if (
        res.statusCode &&
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        if (redirectsRemaining <= 0) {
          return reject(new Error('Too many redirects'));
        }
        fetchUrl(res.headers.location, redirectsRemaining - 1).then(
          resolve,
          reject,
        );
        return;
      }
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      res.on('data', (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_RESPONSE_BYTES) {
          req.destroy();
          reject(new Error('Response too large'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Fetch timeout'));
    });
  });
}

/**
 * Request approval from the user and wait for response.
 * Returns a promise that resolves to true (approved) or false (denied/timeout).
 */
function requestApproval(
  requestId: string,
  groupFolder: string,
  groupName: string,
  domain: string,
  messageId: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    const timeoutHandle = setTimeout(() => {
      pendingApprovals.delete(messageId);
      logger.info(
        { requestId, domain, groupFolder },
        'Network proxy approval timed out',
      );
      resolve(false);
    }, APPROVAL_TIMEOUT_MS);

    pendingApprovals.set(messageId, {
      requestId,
      groupFolder,
      groupName,
      domain,
      resolve,
      timeoutHandle,
    });
  });
}

export interface ProxyDeps {
  sendMessageWithId: (jid: string, text: string) => Promise<string | undefined>;
  getMainChatJid: () => string | undefined;
  getGroupName: (folder: string) => string;
}

/**
 * Process a proxy_web_fetch IPC task.
 */
export async function handleProxyWebFetch(
  data: {
    requestId: string;
    url: string;
    prompt?: string;
  },
  sourceGroup: string,
  deps: ProxyDeps,
): Promise<void> {
  const { requestId, url } = data;
  const domain = extractDomain(url);
  const groupName = deps.getGroupName(sourceGroup);

  // Check allowlist first
  if (isAllowlisted(domain)) {
    logger.info(
      { requestId, domain, sourceGroup },
      'Domain allowlisted, fetching directly',
    );
    try {
      const result = await fetchUrl(url);
      // Truncate to 100KB to avoid huge IPC files
      const truncated =
        result.length > 100_000
          ? result.slice(0, 100_000) +
            '\n\n[Truncated — content exceeded 100KB]'
          : result;
      writeProxyResponse(sourceGroup, requestId, 'approved', truncated);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writeProxyResponse(
        sourceGroup,
        requestId,
        'approved',
        undefined,
        `Fetch failed: ${msg}`,
      );
    }
    return;
  }

  // Send approval request to main channel
  const mainJid = deps.getMainChatJid();
  if (!mainJid) {
    logger.error(
      { requestId },
      'No main channel JID found, denying proxy request',
    );
    writeProxyResponse(
      sourceGroup,
      requestId,
      'denied',
      undefined,
      'No main channel configured.',
    );
    return;
  }

  const approvalText = `[${groupName}] agent wants to fetch: ${url}\n\nReply yes/no or react 👍/👎 (5 min timeout)`;
  const sentId = await deps.sendMessageWithId(mainJid, approvalText);

  if (!sentId) {
    logger.error({ requestId }, 'Failed to send approval message, denying');
    writeProxyResponse(
      sourceGroup,
      requestId,
      'denied',
      undefined,
      'Failed to send approval request.',
    );
    return;
  }

  const approved = await requestApproval(
    requestId,
    sourceGroup,
    groupName,
    domain,
    sentId,
  );

  if (approved) {
    addToAllowlist(domain, sourceGroup);
    logger.info(
      { requestId, domain, sourceGroup },
      'Network proxy approved, domain allowlisted',
    );
    try {
      const result = await fetchUrl(url);
      const truncated =
        result.length > 100_000
          ? result.slice(0, 100_000) +
            '\n\n[Truncated — content exceeded 100KB]'
          : result;
      writeProxyResponse(sourceGroup, requestId, 'approved', truncated);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writeProxyResponse(
        sourceGroup,
        requestId,
        'approved',
        undefined,
        `Fetch failed: ${msg}`,
      );
    }
  } else {
    logger.info({ requestId, domain, sourceGroup }, 'Network proxy denied');
    writeProxyResponse(
      sourceGroup,
      requestId,
      'denied',
      undefined,
      `Network access to ${domain} was denied by the user.`,
    );
  }
}

/**
 * Process a request_network_access IPC task (restricted network mode).
 * If the domain is already allowlisted, approves immediately.
 * Otherwise, sends approval request to main channel.
 * On approval, adds to allowlist and refreshes iptables rules.
 */
export async function handleNetworkAccessRequest(
  data: {
    requestId: string;
    domain: string;
  },
  sourceGroup: string,
  deps: ProxyDeps,
): Promise<void> {
  const { requestId, domain } = data;
  const groupName = deps.getGroupName(sourceGroup);

  // Check allowlist first — auto-approve if already allowed (static config or DB)
  if (isAllowlisted(domain) || RESTRICTED_ALLOWED_DOMAINS.includes(domain)) {
    logger.info(
      { requestId, domain, sourceGroup },
      'Domain already allowlisted, auto-approving network access',
    );
    writeProxyResponse(sourceGroup, requestId, 'approved');
    return;
  }

  // Send approval request to main channel
  const mainJid = deps.getMainChatJid();
  if (!mainJid) {
    logger.error(
      { requestId },
      'No main channel JID found, denying network access request',
    );
    writeProxyResponse(
      sourceGroup,
      requestId,
      'denied',
      undefined,
      'No main channel configured.',
    );
    return;
  }

  const approvalText = `[${groupName}] agent requests network access to: ${domain}\n\nReply yes/no or react 👍/👎 (5 min timeout)`;
  const sentId = await deps.sendMessageWithId(mainJid, approvalText);

  if (!sentId) {
    logger.error({ requestId }, 'Failed to send approval message, denying');
    writeProxyResponse(
      sourceGroup,
      requestId,
      'denied',
      undefined,
      'Failed to send approval request.',
    );
    return;
  }

  const approved = await requestApproval(
    requestId,
    sourceGroup,
    groupName,
    domain,
    sentId,
  );

  if (approved) {
    addToAllowlist(domain, sourceGroup);
    logger.info(
      { requestId, domain, sourceGroup },
      'Network access approved, domain allowlisted',
    );

    // Refresh iptables rules so the domain is reachable immediately
    try {
      const { refreshAllowedIps } = await import('./restricted-network.js');
      await refreshAllowedIps();
    } catch (err) {
      logger.warn(
        { err },
        'Failed to refresh iptables after domain approval (rules will update on next cycle)',
      );
    }

    writeProxyResponse(sourceGroup, requestId, 'approved');
  } else {
    logger.info({ requestId, domain, sourceGroup }, 'Network access denied');
    writeProxyResponse(
      sourceGroup,
      requestId,
      'denied',
      undefined,
      `Network access to ${domain} was denied by the user.`,
    );
  }
}

/**
 * Process a proxy_web_search IPC task.
 */
export async function handleProxyWebSearch(
  data: {
    requestId: string;
    query: string;
  },
  sourceGroup: string,
  deps: ProxyDeps,
): Promise<void> {
  const { requestId, query } = data;

  // Web search is always allowed — it's a Google query, not arbitrary URL fetching
  logger.info(
    { requestId, query, sourceGroup },
    'Web search auto-approved',
  );
  try {
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    const result = await fetchUrl(searchUrl);
    const truncated =
      result.length > 100_000
        ? result.slice(0, 100_000) + '\n\n[Truncated]'
        : result;
    writeProxyResponse(sourceGroup, requestId, 'approved', truncated);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    writeProxyResponse(
      sourceGroup,
      requestId,
      'approved',
      undefined,
      `Search failed: ${msg}`,
    );
  }
}
