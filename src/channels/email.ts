import { ImapFlow } from 'imapflow';
import { simpleParser, ParsedMail } from 'mailparser';

import { ASSISTANT_NAME, EMAIL_POLL_INTERVAL, MAIN_GROUP_FOLDER } from '../config.js';
import { getEmailPollState, setEmailPollState } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import type {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
  SendMessageOpts,
} from '../types.js';
import { registerChannel } from './registry.js';
import type { ChannelOpts } from './registry.js';

// Maximum body length to include in the message delivered to the agent
const MAX_BODY_LENGTH = 4000;

// Backoff limits for connection errors
const MIN_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 30 * 60 * 1000; // 30 minutes

interface ImapAccount {
  id: string; // e.g. "1", "2", "3"
  host: string;
  port: number;
  user: string;
  pass: string;
  tls: boolean;
}

export interface EmailChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class EmailChannel implements Channel {
  name = 'email';

  private accounts: ImapAccount[];
  private opts: EmailChannelOpts;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private connections = new Map<string, ImapFlow>();
  private backoff = new Map<string, number>();
  private connected = false;
  private polling = false;

  constructor(opts: EmailChannelOpts, accounts: ImapAccount[]) {
    this.opts = opts;
    this.accounts = accounts;
  }

  async connect(): Promise<void> {
    this.connected = true;

    // Initialize: set last_uid to current highest UID for each account (skip backfill)
    for (const account of this.accounts) {
      const state = getEmailPollState(account.id, 'INBOX');
      if (!state) {
        await this.initializeUid(account);
      }
    }

    // Start polling
    this.pollTimer = setInterval(() => {
      if (this.polling) return;
      this.pollAllAccounts().catch((err) =>
        logger.error({ err }, 'Email poll cycle error'),
      );
    }, EMAIL_POLL_INTERVAL);

    // Run first poll immediately
    this.pollAllAccounts().catch((err) =>
      logger.error({ err }, 'Email initial poll error'),
    );

    logger.info(
      { accountCount: this.accounts.length },
      'Email channel connected',
    );
  }

  async sendMessage(
    _jid: string,
    _text: string,
    _opts?: SendMessageOpts,
  ): Promise<void> {
    // Email channel is read-only — outbound messages go via other channels
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('email:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    const entries = Array.from(this.connections.entries());
    for (const [id, client] of entries) {
      try {
        await client.logout();
      } catch {
        logger.debug({ accountId: id }, 'IMAP logout error (expected on shutdown)');
      }
    }
    this.connections.clear();
  }

  private async initializeUid(account: ImapAccount): Promise<void> {
    let client: ImapFlow | undefined;
    try {
      client = this.createClient(account);
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');
      try {
        const status = await client.status('INBOX', { uidNext: true });
        const highestUid = (status.uidNext ?? 1) - 1;
        setEmailPollState(account.id, 'INBOX', Math.max(0, highestUid));
        logger.info(
          { accountId: account.id, user: account.user, lastUid: highestUid },
          'Email account initialized (skipping existing messages)',
        );
      } finally {
        lock.release();
      }
      // Store this connection for reuse
      this.connections.set(account.id, client);
    } catch (err) {
      logger.error(
        { err, accountId: account.id, user: account.user },
        'Failed to initialize email account UID',
      );
      if (client) {
        try { await client.logout(); } catch { /* ignore */ }
      }
    }
  }

  private createClient(account: ImapAccount): ImapFlow {
    return new ImapFlow({
      host: account.host,
      port: account.port,
      secure: account.tls,
      auth: {
        user: account.user,
        pass: account.pass,
      },
      logger: false,
    });
  }

  private async getClient(account: ImapAccount): Promise<ImapFlow | null> {
    const existing = this.connections.get(account.id);
    if (existing && existing.usable) {
      return existing;
    }

    // Check backoff
    const backoffMs = this.backoff.get(account.id) || 0;
    if (backoffMs > 0) {
      this.backoff.set(
        account.id,
        Math.min(backoffMs * 2, MAX_BACKOFF_MS),
      );
    }

    try {
      const client = this.createClient(account);
      await client.connect();
      this.connections.set(account.id, client);
      this.backoff.delete(account.id);
      return client;
    } catch (err) {
      logger.warn(
        { err, accountId: account.id, user: account.user },
        'IMAP connection failed',
      );
      if (!this.backoff.has(account.id)) {
        this.backoff.set(account.id, MIN_BACKOFF_MS);
      }
      return null;
    }
  }

  private async pollAllAccounts(): Promise<void> {
    this.polling = true;
    try {
      for (const account of this.accounts) {
        // Skip if in backoff
        const backoffMs = this.backoff.get(account.id);
        if (backoffMs) {
          // Decay backoff each cycle
          const newBackoff = Math.max(0, backoffMs - EMAIL_POLL_INTERVAL);
          if (newBackoff > 0) {
            this.backoff.set(account.id, newBackoff);
            continue;
          } else {
            this.backoff.delete(account.id);
          }
        }

        try {
          await this.pollAccount(account);
        } catch (err) {
          logger.error(
            { err, accountId: account.id, user: account.user },
            'Error polling email account',
          );
          // Drop the broken connection
          const conn = this.connections.get(account.id);
          if (conn) {
            try { await conn.logout(); } catch { /* ignore */ }
            this.connections.delete(account.id);
          }
          this.backoff.set(
            account.id,
            Math.min(
              (this.backoff.get(account.id) || MIN_BACKOFF_MS) * 2,
              MAX_BACKOFF_MS,
            ),
          );
        }
      }
    } finally {
      this.polling = false;
    }
  }

  private async pollAccount(account: ImapAccount): Promise<void> {
    const client = await this.getClient(account);
    if (!client) return;

    const state = getEmailPollState(account.id, 'INBOX');
    const lastUid = state?.last_uid ?? 0;

    const lock = await client.getMailboxLock('INBOX');
    try {
      // Fetch messages with UID > last tracked UID
      const range = `${lastUid + 1}:*`;
      let highestUid = lastUid;
      let count = 0;

      for await (const msg of client.fetch(range, {
        uid: true,
        envelope: true,
        source: true,
      })) {
        // ImapFlow may return the last UID even if it equals lastUid
        if (msg.uid <= lastUid) continue;

        if (msg.uid > highestUid) highestUid = msg.uid;
        count++;

        try {
          if (!msg.source) {
            logger.warn({ accountId: account.id, uid: msg.uid }, 'Email has no source');
            continue;
          }
          const parsed = await simpleParser(msg.source, {});
          this.deliverEmail(account, parsed, msg.uid);
        } catch (parseErr) {
          logger.warn(
            { err: parseErr, accountId: account.id, uid: msg.uid },
            'Failed to parse email',
          );
        }
      }

      if (highestUid > lastUid) {
        setEmailPollState(account.id, 'INBOX', highestUid);
      }

      if (count > 0) {
        logger.info(
          { accountId: account.id, user: account.user, count, highestUid },
          'Polled new emails',
        );
      }
    } finally {
      lock.release();
    }
  }

  private deliverEmail(
    account: ImapAccount,
    parsed: ParsedMail,
    uid: number,
  ): void {
    const from = parsed.from?.text || 'unknown';
    const subject = parsed.subject || '(no subject)';
    const date = parsed.date?.toISOString() || new Date().toISOString();

    // Extract body text, prefer plain text over HTML
    let body = parsed.text || '';
    if (!body && parsed.html) {
      // Simple HTML-to-text: strip tags
      body = parsed.html
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ')
        .trim();
    }

    if (body.length > MAX_BODY_LENGTH) {
      body = body.slice(0, MAX_BODY_LENGTH) + '\n[... truncated]';
    }

    // Build structured message
    const content = [
      `[Email] From: ${from}`,
      `Account: ${account.user}`,
      `Subject: ${subject}`,
      `Date: ${date}`,
      '',
      body,
    ].join('\n');

    // Find the main group JID to deliver to
    const mainJid = this.findMainJid();
    if (!mainJid) {
      logger.warn('No main group registered, cannot deliver email');
      return;
    }

    const messageId = `email:${account.id}:${uid}`;

    // Report metadata
    this.opts.onChatMetadata(mainJid, date, undefined, 'email', true);

    // Deliver as message with trigger prefix so agent processes it
    this.opts.onMessage(mainJid, {
      id: messageId,
      chat_jid: mainJid,
      sender: `email:${account.user}`,
      sender_name: `Email (${account.user})`,
      content: `@${ASSISTANT_NAME} ${content}`,
      timestamp: date,
      is_from_me: false,
      is_bot_message: false,
    });
  }

  private findMainJid(): string | undefined {
    const groups = this.opts.registeredGroups();
    const mainEntry = Object.entries(groups).find(
      ([, g]) => g.folder === MAIN_GROUP_FOLDER,
    );
    return mainEntry?.[0];
  }
}

/**
 * Parse IMAP account configs from env vars.
 * Supports IMAP_HOST_1..IMAP_HOST_3, IMAP_USER_1..IMAP_USER_3, etc.
 */
export function parseImapAccounts(): ImapAccount[] {
  const keys: string[] = [];
  for (let i = 1; i <= 3; i++) {
    keys.push(
      `IMAP_HOST_${i}`,
      `IMAP_USER_${i}`,
      `IMAP_PASS_${i}`,
      `IMAP_PORT_${i}`,
      `IMAP_TLS_${i}`,
    );
  }
  const env = readEnvFile(keys);

  const accounts: ImapAccount[] = [];
  for (let i = 1; i <= 3; i++) {
    const host = env[`IMAP_HOST_${i}`];
    const user = env[`IMAP_USER_${i}`];
    const pass = env[`IMAP_PASS_${i}`];
    if (!host || !user || !pass) continue;

    accounts.push({
      id: String(i),
      host,
      user,
      pass,
      port: parseInt(env[`IMAP_PORT_${i}`] || '993', 10),
      tls: env[`IMAP_TLS_${i}`] !== 'false',
    });
  }

  return accounts;
}

// Self-register via channel registry
registerChannel('email', (opts: ChannelOpts) => {
  const accounts = parseImapAccounts();
  if (accounts.length === 0) return null;

  logger.info(
    { accounts: accounts.map((a) => a.user) },
    'Email channel: found IMAP accounts',
  );

  return new EmailChannel(
    {
      onMessage: opts.onMessage,
      onChatMetadata: opts.onChatMetadata,
      registeredGroups: opts.registeredGroups,
    },
    accounts,
  );
});
