import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets are NOT read here — they stay on disk and are loaded only
// where needed (container-runner.ts) to avoid leaking to child processes.
const envConfig = readEnvFile(['ASSISTANT_NAME', 'ASSISTANT_HAS_OWN_NUMBER']);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const MAIN_GROUP_FOLDER = 'main';

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const IPC_POLL_INTERVAL = 1000;

// Container user: the Dockerfile creates a 'node' user with uid/gid 1000.
// Host directories mounted into containers must be owned by this uid.
export const CONTAINER_UID = 1000;
export const CONTAINER_GID = 1000;
// IDLE_TIMEOUT must be well below CONTAINER_TIMEOUT so the graceful _close
// sentinel fires before the hard kill. container-runner.ts sets the hard kill
// deadline to Math.max(CONTAINER_TIMEOUT, IDLE_TIMEOUT + 30_000).
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '600000', 10); // 10min default
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

// Secrets that are allowed to be passed to containers via stdin
export const CONTAINER_SECRETS = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'CLAUDE_MODEL',
  'GEMINI_API_KEY',
  'HA_URL',
  'HA_TOKEN',
  'TRIBE_CLIENT_ID',
  'TRIBE_CLIENT_SECRET',
  'BW_CLIENTID',
  'BW_CLIENTSECRET',
  'BW_PASSWORD',
];

// Restricted network mode: custom Docker bridge + iptables firewall
export const RESTRICTED_NETWORK_NAME = 'nanoclaw-restricted';
export const RESTRICTED_NETWORK_SUBNET = '172.20.0.0/16';
export const RESTRICTED_ALLOWED_DOMAINS = [
  'api.anthropic.com',
  'api.tribecrm.nl',
  'auth.tribecrm.nl',
  'vault.bitwarden.eu',
  'identity.bitwarden.eu',
  'generativelanguage.googleapis.com',
];
export const RESTRICTED_DNS_REFRESH_MS = 5 * 60 * 1000; // 5 minutes

// Slack configuration
// SLACK_BOT_TOKEN, SLACK_APP_TOKEN, and SLACK_SIGNING_SECRET are read directly
// by SlackChannel from .env via readEnvFile() to keep secrets off process.env.
