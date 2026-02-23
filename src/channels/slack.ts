import { App, LogLevel } from '@slack/bolt';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
  SendMessageOpts,
} from '../types.js';

export interface SlackChannelOpts {
  botToken: string;
  appToken: string;
  signingSecret: string;
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  onAbort: (chatJid: string) => Promise<boolean>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

type SlackIncomingMessage = {
  text?: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  channel?: string;
  ts?: string;
  thread_ts?: string;
  channel_type?: 'channel' | 'group' | 'im' | 'mpim';
  files?: Array<{ name?: string; mimetype?: string }>;
};

const SLACK_MAX_MESSAGE_LENGTH = 3900;
const MAX_OUTGOING_QUEUE = 100;
const MAX_ACTIVE_THREADS = 1000;

export function shouldIgnoreSlackMessageSubtype(subtype?: string): boolean {
  if (!subtype) return false;
  return subtype !== 'file_share';
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

export class SlackChannel implements Channel {
  name = 'slack';

  private app: App | null = null;
  private connected = false;
  private opts: SlackChannelOpts;
  private botUserId = '';
  private lastUserByChannel = new Map<string, string>();
  private lastEphemeralAtByChannel = new Map<string, number>();
  private userNameCache = new Map<string, string>();
  private lastTriggerTs = new Map<string, string>();
  private botActiveThreads = new Map<string, true>();
  private outgoingQueue: Array<{ jid: string; text: string; threadTs?: string; mentions?: string[] }> = [];

  constructor(opts: SlackChannelOpts) {
    this.opts = opts;

    if (!opts.botToken || !opts.appToken || !opts.signingSecret) {
      throw new Error(
        'Missing Slack credentials. Set SLACK_BOT_TOKEN, SLACK_APP_TOKEN, and SLACK_SIGNING_SECRET.',
      );
    }
  }

  async connect(): Promise<void> {
    this.app = new App({
      token: this.opts.botToken,
      appToken: this.opts.appToken,
      signingSecret: this.opts.signingSecret,
      socketMode: true,
      logLevel: LogLevel.WARN,
    });

    this.app.command('/abort', async ({ ack, command }) => {
      const cancelled = await this.opts.onAbort(command.channel_id);
      await ack(cancelled ? 'Abort requested.' : 'No active run to abort in this channel.');
    });

    this.app.message(async ({ message, client }) => {
      const m = message as SlackIncomingMessage;
      if (shouldIgnoreSlackMessageSubtype(m.subtype)) return;

      const chatJid = m.channel;
      const sender = m.user;
      if (!chatJid || !sender) return;

      this.lastUserByChannel.set(chatJid, sender);

      let content = m.text || '';

      // Append file attachment placeholders
      if (m.files?.length) {
        for (const f of m.files) {
          const label = f.mimetype?.startsWith('image/') ? 'Image' : 'File';
          content += `\n[${label}: ${f.name || 'unnamed'}]`;
        }
      }

      if (!content.trim()) return;

      if (this.isAbortCommand(content)) {
        const cancelled = await this.opts.onAbort(chatJid);
        await this.postEphemeralStatus(
          chatJid,
          sender,
          cancelled ? 'Abort requested.' : 'No active run to abort in this channel.',
        );
        return;
      }

      const timestamp = new Date().toISOString();
      const isDm = m.channel_type === 'im' || chatJid.startsWith('D');
      this.opts.onChatMetadata(chatJid, timestamp, undefined, 'slack', !isDm);

      const mentioned = this.botUserId
        ? content.includes(`<@${this.botUserId}>`)
        : false;

      const existing = this.opts.registeredGroups()[chatJid];
      if (!existing) {
        if (!isDm && !mentioned) return;

        const channelName = await this.resolveChannelName(chatJid, client);
        const folderBase = slugify(channelName) || `slack-${chatJid.toLowerCase()}`;
        const folder = `${folderBase}-${chatJid.toLowerCase().slice(-6)}`;

        this.opts.registerGroup(chatJid, {
          name: channelName,
          folder,
          trigger: `@${ASSISTANT_NAME}`,
          added_at: new Date().toISOString(),
          requiresTrigger: true,
        });

        logger.info({ chatJid, channelName, folder }, 'Auto-registered Slack channel as group');
      }

      // Replace bot mention with trigger
      if (mentioned) {
        content = content.replace(new RegExp(`<@${this.botUserId}>`, 'g'), '').trim();
        if (!TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Track bot-active threads
      const threadRoot = m.thread_ts || m.ts;
      if (mentioned && threadRoot) {
        this.botActiveThreads.set(threadRoot, true);
        if (this.botActiveThreads.size > MAX_ACTIVE_THREADS) {
          const oldest = this.botActiveThreads.keys().next().value;
          if (oldest) this.botActiveThreads.delete(oldest);
        }
      }

      // Auto-trigger for replies in bot-active threads
      if (!mentioned && m.thread_ts && this.botActiveThreads.has(m.thread_ts) && !TRIGGER_PATTERN.test(content)) {
        content = `@${ASSISTANT_NAME} ${content}`;
      }

      // Use thread root for replies so they stay in the same thread
      if (m.ts) this.lastTriggerTs.set(chatJid, m.thread_ts || m.ts);

      const senderName = await this.resolveUserName(sender, client);

      this.opts.onMessage(chatJid, {
        id: m.ts || `${chatJid}-${Date.now()}`,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });
    });

    await this.app.start();
    const auth = await this.app.client.auth.test();
    this.botUserId = auth.user_id || '';
    this.connected = true;

    logger.info({ botUserId: this.botUserId }, 'Connected to Slack (Socket Mode)');

    await this.flushOutgoingQueue();
  }

  async sendMessage(jid: string, text: string, opts?: SendMessageOpts): Promise<void> {
    if (!this.app) return;

    // Rewrite @userId → <@userId> for Slack-native mentions
    let mentionedText = text;
    if (opts?.mentions?.length) {
      for (const userId of opts.mentions) {
        const plain = `@${userId}`;
        if (mentionedText.includes(plain)) {
          mentionedText = mentionedText.replaceAll(plain, `<@${userId}>`);
        }
      }
    }

    const threadTs = this.lastTriggerTs.get(jid);
    try {
      if (mentionedText.length <= SLACK_MAX_MESSAGE_LENGTH) {
        await this.app.client.chat.postMessage({ channel: jid, text: mentionedText, thread_ts: threadTs });
      } else {
        for (let offset = 0; offset < mentionedText.length; offset += SLACK_MAX_MESSAGE_LENGTH) {
          const chunk = mentionedText.slice(offset, offset + SLACK_MAX_MESSAGE_LENGTH);
          await this.app.client.chat.postMessage({ channel: jid, text: chunk, thread_ts: threadTs });
        }
      }

      // Track bot's own message for conversation history (original text, not Slack-formatted)
      this.opts.onMessage(jid, {
        id: `bot-${Date.now()}`,
        chat_jid: jid,
        sender: this.botUserId || 'bot',
        sender_name: ASSISTANT_NAME,
        content: text,
        timestamp: new Date().toISOString(),
        is_from_me: true,
        is_bot_message: true,
      });
    } catch (err) {
      logger.error({ err, jid }, 'Failed to send Slack message');
      if (this.outgoingQueue.length < MAX_OUTGOING_QUEUE) {
        this.outgoingQueue.push({ jid, text, threadTs, mentions: opts?.mentions });
      }
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return /^[CDG][A-Z0-9]+$/.test(jid);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.app) {
      await this.app.stop();
      this.app = null;
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.app) return;
    const ts = this.lastTriggerTs.get(jid);
    if (!ts) return;
    try {
      if (isTyping) {
        await this.app.client.reactions.add({ channel: jid, timestamp: ts, name: 'hourglass_flowing_sand' });
      } else {
        await this.app.client.reactions.remove({ channel: jid, timestamp: ts, name: 'hourglass_flowing_sand' });
      }
    } catch {
      // Reaction failures are non-critical (message may be deleted, bot may lack permission)
    }
  }

  async syncGroupMetadata(): Promise<void> {
    // Not needed for MVP.
  }

  private isAbortCommand(text: string): boolean {
    const cleaned = text.trim().toLowerCase();
    if (cleaned === '/abort' || cleaned === 'abort') return true;
    if (this.botUserId) {
      const mentionAbort = new RegExp(`^<@${this.botUserId}>\\s+abort$`, 'i');
      if (mentionAbort.test(text.trim())) return true;
    }
    return false;
  }

  private async resolveChannelName(chatJid: string, client: App['client']): Promise<string> {
    try {
      const info = await client.conversations.info({ channel: chatJid });
      const c = info.channel as { name?: string; user?: string } | undefined;
      if (c?.name) return c.name;
      if (c?.user) return `dm-${c.user.toLowerCase()}`;
    } catch (err) {
      logger.warn({ err, chatJid }, 'Could not fetch Slack channel name, using ID fallback');
    }
    return `slack-${chatJid.toLowerCase()}`;
  }

  private async resolveUserName(userId: string, client: App['client']): Promise<string> {
    const cached = this.userNameCache.get(userId);
    if (cached) return cached;
    try {
      const result = await client.users.info({ user: userId });
      const u = result.user as { profile?: { display_name?: string }; real_name?: string; name?: string } | undefined;
      const name = u?.profile?.display_name || u?.real_name || u?.name || userId;
      this.userNameCache.set(userId, name);
      return name;
    } catch (err) {
      logger.warn({ err, userId }, 'Could not fetch Slack user name, using ID fallback');
      return userId;
    }
  }

  private async postEphemeralStatus(chatJid: string, userId: string, text: string): Promise<void> {
    if (!this.app) return;
    try {
      await this.app.client.chat.postEphemeral({
        channel: chatJid,
        user: userId,
        text,
      });
    } catch (err) {
      logger.debug({ err, chatJid, userId }, 'Failed to post Slack ephemeral status');
    }
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (!this.app || this.outgoingQueue.length === 0) return;
    const items = [...this.outgoingQueue];
    this.outgoingQueue.length = 0;
    for (const { jid, text, threadTs, mentions } of items) {
      try {
        // Rewrite @userId → <@userId> for Slack-native mentions
        let mentionedText = text;
        if (mentions?.length) {
          for (const userId of mentions) {
            const plain = `@${userId}`;
            if (mentionedText.includes(plain)) {
              mentionedText = mentionedText.replaceAll(plain, `<@${userId}>`);
            }
          }
        }

        if (mentionedText.length <= SLACK_MAX_MESSAGE_LENGTH) {
          await this.app.client.chat.postMessage({ channel: jid, text: mentionedText, thread_ts: threadTs });
        } else {
          for (let offset = 0; offset < mentionedText.length; offset += SLACK_MAX_MESSAGE_LENGTH) {
            const chunk = mentionedText.slice(offset, offset + SLACK_MAX_MESSAGE_LENGTH);
            await this.app.client.chat.postMessage({ channel: jid, text: chunk, thread_ts: threadTs });
          }
        }
        this.opts.onMessage(jid, {
          id: `bot-${Date.now()}`,
          chat_jid: jid,
          sender: this.botUserId || 'bot',
          sender_name: ASSISTANT_NAME,
          content: text,
          timestamp: new Date().toISOString(),
          is_from_me: true,
          is_bot_message: true,
        });
      } catch (err) {
        logger.error({ err, jid }, 'Failed to flush queued Slack message (dropped)');
      }
    }
  }
}
