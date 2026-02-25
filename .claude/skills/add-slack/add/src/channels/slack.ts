import { App, LogLevel } from '@slack/bolt';
import type { GenericMessageEvent, BotMessageEvent } from '@slack/types';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { updateChatName } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
  SendMessageOpts,
} from '../types.js';

// Slack's chat.postMessage API limits text to ~4000 characters per call.
// Messages exceeding this are split into sequential chunks.
const MAX_MESSAGE_LENGTH = 4000;

// Maximum number of active threads to track before evicting the oldest.
const MAX_ACTIVE_THREADS = 1000;

// Maximum number of messages to buffer when disconnected.
const MAX_OUTGOING_QUEUE = 100;

// The message subtypes we process. Bolt delivers all subtypes via app.event('message');
// we filter to regular messages (GenericMessageEvent, subtype undefined), bot messages
// (BotMessageEvent, subtype 'bot_message'), and file_share messages so we can note attachments.
type HandledMessageEvent = GenericMessageEvent | BotMessageEvent;

/**
 * Returns true if the given subtype should be silently dropped.
 * Regular messages (no subtype), bot_message, and file_share are allowed through;
 * everything else (channel_join, channel_leave, etc.) is ignored.
 */
export function shouldIgnoreSlackMessageSubtype(subtype?: string): boolean {
  if (!subtype) return false;
  if (subtype === 'bot_message' || subtype === 'file_share') return false;
  return true;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

export interface SlackChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  onAbort: (chatJid: string) => Promise<boolean>;
}

export class SlackChannel implements Channel {
  name = 'slack';

  private app: App;
  private botUserId: string | undefined;
  private connected = false;
  private outgoingQueue: Array<{ jid: string; text: string; threadTs?: string; mentions?: string[] }> = [];
  private flushing = false;
  private userNameCache = new Map<string, string>();
  private lastTriggerTs = new Map<string, string>();
  private botActiveThreads = new Map<string, true>();

  private opts: SlackChannelOpts;

  constructor(opts: SlackChannelOpts) {
    this.opts = opts;

    // Read tokens from .env (not process.env — keeps secrets off the environment
    // so they don't leak to child processes, matching NanoClaw's security pattern)
    const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_SIGNING_SECRET']);
    const botToken = env.SLACK_BOT_TOKEN;
    const appToken = env.SLACK_APP_TOKEN;
    const signingSecret = env.SLACK_SIGNING_SECRET;

    if (!botToken || !appToken) {
      throw new Error(
        'SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set in .env',
      );
    }

    this.app = new App({
      token: botToken,
      appToken,
      signingSecret: signingSecret || undefined,
      socketMode: true,
      logLevel: LogLevel.ERROR,
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // /abort slash command — immediate acknowledgement via Slack's command API
    this.app.command('/abort', async ({ ack, command }) => {
      const jid = `slack:${command.channel_id}`;
      const cancelled = await this.opts.onAbort(jid);
      await ack(cancelled ? 'Abort requested.' : 'No active run to abort in this channel.');
    });

    // Use app.event('message') instead of app.message() to capture all
    // message subtypes including bot_message (needed to track our own output)
    this.app.event('message', async ({ event }) => {
      // Bolt's event type is the full MessageEvent union (17+ subtypes).
      // We filter on subtype first, then narrow to the two types we handle.
      const subtype = (event as { subtype?: string }).subtype;
      if (shouldIgnoreSlackMessageSubtype(subtype)) return;

      // After filtering, event is either GenericMessageEvent or BotMessageEvent
      const msg = event as HandledMessageEvent;

      const jid = `slack:${msg.channel}`;
      const timestamp = new Date(parseFloat(msg.ts) * 1000).toISOString();
      const isGroup = (msg as { channel_type?: string }).channel_type !== 'im';
      const isDm = !isGroup;

      // Build content from text + file attachment placeholders
      let content = msg.text || '';
      const files = (msg as { files?: Array<{ name?: string; mimetype?: string }> }).files;
      if (files?.length) {
        for (const f of files) {
          const label = f.mimetype?.startsWith('image/') ? 'Image' : 'File';
          content += `\n[${label}: ${f.name || 'unnamed'}]`;
        }
      }
      if (!content.trim()) return;

      const isBotMessage = !!(msg as { bot_id?: string }).bot_id || msg.user === this.botUserId;

      // Check for text-based abort command before anything else
      if (!isBotMessage && this.isAbortCommand(content)) {
        const cancelled = await this.opts.onAbort(jid);
        if (msg.user) {
          await this.postEphemeralStatus(
            jid,
            msg.user,
            cancelled ? 'Abort requested.' : 'No active run to abort in this channel.',
          );
        }
        return;
      }

      // Always report metadata for group discovery
      this.opts.onChatMetadata(jid, timestamp, undefined, 'slack', isGroup);

      // Auto-registration: DMs register immediately, channels on first @mention
      const mentioned = this.botUserId
        ? content.includes(`<@${this.botUserId}>`)
        : false;

      const existing = this.opts.registeredGroups()[jid];
      if (!existing) {
        if (!isDm && !mentioned) return; // unregistered channel, no mention -> ignore

        const channelName = await this.resolveChannelName(msg.channel);
        const folderBase = slugify(channelName) || `slack-${msg.channel.toLowerCase()}`;
        const folder = `${folderBase}-${msg.channel.toLowerCase().slice(-6)}`;

        this.opts.registerGroup(jid, {
          name: channelName,
          folder,
          trigger: `@${ASSISTANT_NAME}`,
          added_at: new Date().toISOString(),
          requiresTrigger: !isDm,
        });

        logger.info({ jid, channelName, folder }, 'Auto-registered Slack channel as group');
      }

      const userId = msg.user ?? '';
      let senderName: string;
      if (isBotMessage) {
        senderName = ASSISTANT_NAME;
      } else {
        senderName =
          (await this.resolveUserName(userId)) ||
          userId ||
          'unknown';
      }

      // Translate Slack <@UBOTID> mentions into TRIGGER_PATTERN format.
      // Slack encodes @mentions as <@U12345>, which won't match TRIGGER_PATTERN
      // (e.g., ^@<ASSISTANT_NAME>\b), so we replace the mention and prepend the trigger.
      if (this.botUserId && !isBotMessage && mentioned) {
        content = content.replace(new RegExp(`<@${this.botUserId}>`, 'g'), '').trim();
        if (!TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Track bot-active threads: when bot is @mentioned in a thread,
      // subsequent replies auto-trigger without needing @mention
      const threadRoot = (msg as { thread_ts?: string }).thread_ts || msg.ts;
      if (mentioned && threadRoot) {
        this.botActiveThreads.set(threadRoot, true);
        if (this.botActiveThreads.size > MAX_ACTIVE_THREADS) {
          const oldest = this.botActiveThreads.keys().next().value;
          if (oldest) this.botActiveThreads.delete(oldest);
        }
      }

      // Auto-trigger for replies in bot-active threads
      const threadTs = (msg as { thread_ts?: string }).thread_ts;
      if (!mentioned && !isBotMessage && threadTs && this.botActiveThreads.has(threadTs) && !TRIGGER_PATTERN.test(content)) {
        content = `@${ASSISTANT_NAME} ${content}`;
      }

      // Track trigger timestamp for threading replies
      if (mentioned && msg.ts) {
        this.lastTriggerTs.set(jid, threadTs || msg.ts);
      }

      this.opts.onMessage(jid, {
        id: msg.ts,
        chat_jid: jid,
        sender: userId || (msg as { bot_id?: string }).bot_id || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: isBotMessage,
        is_bot_message: isBotMessage,
      });
    });
  }

  async connect(): Promise<void> {
    await this.app.start();

    // Get bot's own user ID for self-message detection.
    // Resolve this BEFORE setting connected=true so that messages arriving
    // during startup can correctly detect bot-sent messages.
    try {
      const auth = await this.app.client.auth.test();
      this.botUserId = auth.user_id as string;
      logger.info({ botUserId: this.botUserId }, 'Connected to Slack');
    } catch (err) {
      logger.warn(
        { err },
        'Connected to Slack but failed to get bot user ID',
      );
    }

    this.connected = true;

    // Flush any messages queued before connection
    await this.flushOutgoingQueue();

    // Sync channel names on startup
    await this.syncChannelMetadata();
  }

  async sendMessage(jid: string, text: string, opts?: SendMessageOpts): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');

    if (!this.connected) {
      if (this.outgoingQueue.length < MAX_OUTGOING_QUEUE) {
        this.outgoingQueue.push({ jid, text, mentions: opts?.mentions });
      }
      logger.info(
        { jid, queueSize: this.outgoingQueue.length },
        'Slack disconnected, message queued',
      );
      return;
    }

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
      // Slack limits messages to ~4000 characters; split if needed
      if (mentionedText.length <= MAX_MESSAGE_LENGTH) {
        await this.app.client.chat.postMessage({ channel: channelId, text: mentionedText, ...(threadTs && { thread_ts: threadTs }) });
      } else {
        for (let i = 0; i < mentionedText.length; i += MAX_MESSAGE_LENGTH) {
          await this.app.client.chat.postMessage({
            channel: channelId,
            text: mentionedText.slice(i, i + MAX_MESSAGE_LENGTH),
            ...(threadTs && { thread_ts: threadTs }),
          });
        }
      }

      // Track bot's own message for conversation history
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

      logger.info({ jid, length: text.length }, 'Slack message sent');
    } catch (err) {
      if (this.outgoingQueue.length < MAX_OUTGOING_QUEUE) {
        this.outgoingQueue.push({ jid, text, threadTs, mentions: opts?.mentions });
      }
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send Slack message, queued',
      );
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('slack:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    await this.app.stop();
  }

  /**
   * Hourglass typing indicator — adds/removes an hourglass emoji reaction
   * on the trigger message to show the bot is working.
   */
  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    const ts = this.lastTriggerTs.get(jid);
    if (!ts) return;
    const channelId = jid.replace(/^slack:/, '');
    try {
      if (isTyping) {
        await this.app.client.reactions.add({ channel: channelId, timestamp: ts, name: 'hourglass_flowing_sand' });
      } else {
        await this.app.client.reactions.remove({ channel: channelId, timestamp: ts, name: 'hourglass_flowing_sand' });
      }
    } catch {
      // Reaction failures are non-critical (message may be deleted, bot may lack permission)
    }
  }

  /**
   * Sync channel metadata from Slack.
   * Fetches channels the bot is a member of and stores their names in the DB.
   */
  async syncChannelMetadata(): Promise<void> {
    try {
      logger.info('Syncing channel metadata from Slack...');
      let cursor: string | undefined;
      let count = 0;

      do {
        const result = await this.app.client.conversations.list({
          types: 'public_channel,private_channel',
          exclude_archived: true,
          limit: 200,
          cursor,
        });

        for (const ch of result.channels || []) {
          if (ch.id && ch.name && ch.is_member) {
            updateChatName(`slack:${ch.id}`, ch.name);
            count++;
          }
        }

        cursor = result.response_metadata?.next_cursor || undefined;
      } while (cursor);

      logger.info({ count }, 'Slack channel metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync Slack channel metadata');
    }
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

  private async resolveChannelName(channelId: string): Promise<string> {
    try {
      const info = await this.app.client.conversations.info({ channel: channelId });
      const c = info.channel as { name?: string; user?: string } | undefined;
      if (c?.name) return c.name;
      if (c?.user) return `dm-${c.user.toLowerCase()}`;
    } catch (err) {
      logger.warn({ err, channelId }, 'Could not fetch Slack channel name, using ID fallback');
    }
    return `slack-${channelId.toLowerCase()}`;
  }

  private async resolveUserName(
    userId: string,
  ): Promise<string | undefined> {
    if (!userId) return undefined;

    const cached = this.userNameCache.get(userId);
    if (cached) return cached;

    try {
      const result = await this.app.client.users.info({ user: userId });
      const name = result.user?.real_name || result.user?.name;
      if (name) this.userNameCache.set(userId, name);
      return name;
    } catch (err) {
      logger.debug({ userId, err }, 'Failed to resolve Slack user name');
      return undefined;
    }
  }

  async postEphemeralStatus(jid: string, userId: string, text: string): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');
    try {
      await this.app.client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        text,
      });
    } catch (err) {
      logger.debug({ err, jid, userId }, 'Failed to post Slack ephemeral status');
    }
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing Slack outgoing queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        const channelId = item.jid.replace(/^slack:/, '');

        // Rewrite @userId → <@userId> for Slack-native mentions
        let mentionedText = item.text;
        if (item.mentions?.length) {
          for (const userId of item.mentions) {
            const plain = `@${userId}`;
            if (mentionedText.includes(plain)) {
              mentionedText = mentionedText.replaceAll(plain, `<@${userId}>`);
            }
          }
        }

        if (mentionedText.length <= MAX_MESSAGE_LENGTH) {
          await this.app.client.chat.postMessage({
            channel: channelId,
            text: mentionedText,
            ...(item.threadTs && { thread_ts: item.threadTs }),
          });
        } else {
          for (let i = 0; i < mentionedText.length; i += MAX_MESSAGE_LENGTH) {
            await this.app.client.chat.postMessage({
              channel: channelId,
              text: mentionedText.slice(i, i + MAX_MESSAGE_LENGTH),
              ...(item.threadTs && { thread_ts: item.threadTs }),
            });
          }
        }

        // Track bot's own message for conversation history
        this.opts.onMessage(item.jid, {
          id: `bot-${Date.now()}`,
          chat_jid: item.jid,
          sender: this.botUserId || 'bot',
          sender_name: ASSISTANT_NAME,
          content: item.text,
          timestamp: new Date().toISOString(),
          is_from_me: true,
          is_bot_message: true,
        });

        logger.info(
          { jid: item.jid, length: item.text.length },
          'Queued Slack message sent',
        );
      }
    } finally {
      this.flushing = false;
    }
  }
}
