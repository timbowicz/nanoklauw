import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';

import makeWASocket, {
  Browsers,
  DisconnectReason,
  WASocket,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';

import {
  ASSISTANT_HAS_OWN_NUMBER,
  ASSISTANT_NAME,
  STORE_DIR,
} from '../config.js';
import {
  getLastGroupSync,
  getLatestMessage,
  setLastGroupSync,
  storeReaction,
  updateChatName,
  updateRegisteredGroupName,
} from '../db.js';
import { logger } from '../logger.js';
import { downloadDocument, downloadImage } from '../media-processing.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
  SendMessageOpts,
} from '../types.js';
import { registerChannel } from './registry.js';
import type { ChannelOpts } from './registry.js';

const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface WhatsAppChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  onReaction?: (originalMessageId: string, approved: boolean) => void;
}

const BASE_RECONNECT_MS = 2_000;
const MAX_RECONNECT_MS = 5 * 60_000; // 5 minutes
const CONNECT_TIMEOUT_MS = 30_000; // 30s — don't block startup forever
const MAX_OUTGOING_QUEUE = 100;

export class WhatsAppChannel implements Channel {
  name = 'whatsapp';

  private sock!: WASocket;
  private connected = false;
  private reconnecting = false;
  private reconnectAttempt = 0;
  private lidToPhoneMap: Record<string, string> = {};
  private outgoingQueue: Array<{
    jid: string;
    text: string;
    mentions?: string[];
  }> = [];
  private flushing = false;
  private groupSyncTimerStarted = false;

  private opts: WhatsAppChannelOpts;

  constructor(opts: WhatsAppChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    const connected = new Promise<void>((resolve, reject) => {
      this.connectInternal(resolve).catch(reject);
    });
    const timeout = new Promise<void>((resolve) => {
      setTimeout(() => {
        logger.warn(
          'WhatsApp connect timed out, continuing startup — reconnect will keep trying in the background',
        );
        resolve();
      }, CONNECT_TIMEOUT_MS);
    });
    await Promise.race([connected, timeout]);
  }

  /**
   * Harden permissions on WhatsApp auth files (600) and directories (700)
   * to prevent other users on the system from reading session credentials.
   */
  private hardenAuthPermissions(authDir: string): void {
    try {
      fs.chmodSync(authDir, 0o700);
      for (const entry of fs.readdirSync(authDir)) {
        const full = path.join(authDir, entry);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          fs.chmodSync(full, 0o700);
          // Handle subdirectories (e.g. keys/)
          for (const sub of fs.readdirSync(full)) {
            const subFull = path.join(full, sub);
            const subStat = fs.statSync(subFull);
            fs.chmodSync(subFull, subStat.isDirectory() ? 0o700 : 0o600);
          }
        } else {
          fs.chmodSync(full, 0o600);
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to harden auth file permissions');
    }
  }

  private async connectInternal(onFirstOpen?: () => void): Promise<void> {
    // Clean up previous socket to prevent ghost socket accumulation (memory leak).
    // Each reconnect creates a new socket; without cleanup, the old socket's event
    // listeners, signal key store caches, and internal Baileys buffers remain in
    // memory indefinitely, causing OOM after ~40h of uptime.
    // See: https://github.com/qwibitai/nanoclaw/issues/595
    if (this.sock) {
      try {
        this.sock.ev.removeAllListeners('connection.update');
        this.sock.ev.removeAllListeners('creds.update');
        this.sock.ev.removeAllListeners('messages.upsert');
        this.sock.ev.removeAllListeners('messages.reaction');
        this.sock.end(undefined);
      } catch (err) {
        logger.debug({ err }, 'Error cleaning up previous socket');
      }
    }

    const authDir = path.join(STORE_DIR, 'auth');
    fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    this.hardenAuthPermissions(authDir);

    const { version } = await fetchLatestWaWebVersion({}).catch((err) => {
      logger.warn(
        { err },
        'Failed to fetch latest WA Web version, using default',
      );
      return { version: undefined };
    });
    this.sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      printQRInTerminal: false,
      logger,
      browser: Browsers.macOS('Chrome'),
    });

    this.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        const msg =
          'WhatsApp authentication required. Run /setup in Claude Code.';
        logger.error(msg);
        exec(
          `osascript -e 'display notification "${msg}" with title "NanoClaw" sound name "Basso"'`,
        );
        setTimeout(() => process.exit(1), 1000);
      }

      if (connection === 'close') {
        this.connected = false;
        const reason = (
          lastDisconnect?.error as { output?: { statusCode?: number } }
        )?.output?.statusCode;
        const shouldReconnect = reason !== DisconnectReason.loggedOut;
        logger.info(
          {
            reason,
            shouldReconnect,
            queuedMessages: this.outgoingQueue.length,
          },
          'Connection closed',
        );

        if (shouldReconnect) {
          if (this.reconnecting) {
            logger.debug('Reconnect already in progress, skipping');
            return;
          }
          this.reconnecting = true;
          const delayMs = Math.min(
            BASE_RECONNECT_MS * Math.pow(2, this.reconnectAttempt),
            MAX_RECONNECT_MS,
          );
          this.reconnectAttempt++;
          logger.info(
            { attempt: this.reconnectAttempt, delayMs },
            'Reconnecting after delay...',
          );
          setTimeout(() => {
            this.connectInternal().catch((err) => {
              logger.error({ err }, 'Failed to reconnect');
              this.reconnecting = false;
            });
          }, delayMs);
        } else {
          logger.info('Logged out. Run /setup to re-authenticate.');
          process.exit(0);
        }
      } else if (connection === 'open') {
        this.connected = true;
        this.reconnecting = false;
        this.reconnectAttempt = 0;
        logger.info('Connected to WhatsApp');

        // Announce availability so WhatsApp relays subsequent presence updates (typing indicators)
        this.sock.sendPresenceUpdate('available').catch((err) => {
          logger.warn({ err }, 'Failed to send presence update');
        });

        // Build LID to phone mapping from auth state for self-chat translation
        if (this.sock.user) {
          const phoneUser = this.sock.user.id.split(':')[0];
          const lidUser = this.sock.user.lid?.split(':')[0];
          if (lidUser && phoneUser) {
            this.lidToPhoneMap[lidUser] = `${phoneUser}@s.whatsapp.net`;
            logger.debug({ lidUser, phoneUser }, 'LID to phone mapping set');
          }
        }

        // Flush any messages queued while disconnected
        this.flushOutgoingQueue().catch((err) =>
          logger.error({ err }, 'Failed to flush outgoing queue'),
        );

        // Sync group metadata on startup (respects 24h cache)
        this.syncGroupMetadata().catch((err) =>
          logger.error({ err }, 'Initial group sync failed'),
        );
        // Set up daily sync timer (only once)
        if (!this.groupSyncTimerStarted) {
          this.groupSyncTimerStarted = true;
          setInterval(() => {
            this.syncGroupMetadata().catch((err) =>
              logger.error({ err }, 'Periodic group sync failed'),
            );
          }, GROUP_SYNC_INTERVAL_MS);
        }

        // Signal first connection to caller
        if (onFirstOpen) {
          onFirstOpen();
          onFirstOpen = undefined;
        }
      }
    });

    this.sock.ev.on('creds.update', async () => {
      await saveCreds();
      this.hardenAuthPermissions(authDir);
    });

    this.sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const msg of messages) {
        try {
          if (!msg.message) continue;
          // Unwrap container types (viewOnceMessageV2, ephemeralMessage,
          // editedMessage, etc.) so that conversation, extendedTextMessage,
          // imageMessage, etc. are accessible at the top level.
          const normalized = normalizeMessageContent(msg.message);
          if (!normalized) continue;
          const rawJid = msg.key.remoteJid;
          if (!rawJid || rawJid === 'status@broadcast') continue;

          // Handle reactions: deliver as approval responses for pending proxy requests.
          // Reactions have reactionMessage with .key (original message) and .text (emoji).
          const reaction = msg.message?.reactionMessage;
          if (reaction?.key?.id && reaction.text) {
            const emoji = reaction.text;
            const isApproval = ['👍', '✅', '👌'].includes(emoji);
            const isDenial = ['👎', '❌', '🚫'].includes(emoji);
            if (isApproval || isDenial) {
              this.opts.onReaction?.(reaction.key.id, isApproval);
            }
            continue;
          }

          // Translate LID JID to phone JID if applicable
          const chatJid = await this.translateJid(rawJid);

          const timestamp = new Date(
            Number(msg.messageTimestamp) * 1000,
          ).toISOString();

          // Always notify about chat metadata for group discovery
          const isGroup = chatJid.endsWith('@g.us');
          this.opts.onChatMetadata(
            chatJid,
            timestamp,
            undefined,
            'whatsapp',
            isGroup,
          );

          // Only deliver full message for registered groups
          const groups = this.opts.registeredGroups();
          if (groups[chatJid]) {
            const hasImage = !!normalized.imageMessage;
            const hasDocument = !!normalized.documentMessage;
            const documentFilename =
              normalized.documentMessage?.fileName || 'document';
            let content =
              normalized.conversation ||
              normalized.extendedTextMessage?.text ||
              normalized.imageMessage?.caption ||
              normalized.videoMessage?.caption ||
              normalized.documentMessage?.caption ||
              (hasImage ? '[Image]' : '') ||
              (hasDocument ? `[Document: ${documentFilename}]` : '');

            // WhatsApp sends @mentions as LID numbers (e.g. @199768257069133)
            // instead of display names. Replace the bot's own LID mention with
            // @AssistantName so the trigger pattern can match.
            if (this.sock.user?.lid) {
              const lidUser = this.sock.user.lid.split(':')[0];
              if (lidUser) {
                content = content.replace(
                  new RegExp(`@${lidUser}\\b`, 'g'),
                  `@${ASSISTANT_NAME}`,
                );
              }
            }

            // Skip protocol messages with no text content (encryption keys, read receipts, etc.)
            if (!content) continue;

            const sender = msg.key.participant || msg.key.remoteJid || '';
            const senderName = msg.pushName || sender.split('@')[0];

            const fromMe = msg.key.fromMe || false;
            // Detect bot messages: with own number, fromMe is reliable
            // since only the bot sends from that number.
            // With shared number, bot messages carry the assistant name prefix
            // (even in DMs/self-chat) so we check for that.
            const isBotMessage = ASSISTANT_HAS_OWN_NUMBER
              ? fromMe
              : content.startsWith(`${ASSISTANT_NAME}:`);

            // Extract quoted message ID for reply correlation (network proxy approvals)
            const quotedMessageId =
              msg.message?.extendedTextMessage?.contextInfo?.stanzaId ||
              undefined;

            // Download media if present (non-blocking — failure just skips the media)
            const imageData = hasImage
              ? await downloadImage(msg, this.sock)
              : null;
            const documentData = hasDocument
              ? await downloadDocument(msg, this.sock)
              : null;

            this.opts.onMessage(chatJid, {
              id: msg.key.id || '',
              chat_jid: chatJid,
              sender,
              sender_name: senderName,
              content,
              timestamp,
              is_from_me: fromMe,
              is_bot_message: isBotMessage,
              ...(quotedMessageId ? { quotedMessageId } : {}),
              ...(imageData ? { image_data: imageData } : {}),
              ...(documentData ? { document_data: documentData } : {}),
            });
          }
        } catch (err) {
          logger.error(
            { err, msgId: msg.key?.id, remoteJid: msg.key?.remoteJid },
            'Failed to process message in messages.upsert',
          );
        }
      }
    });

    // Listen for message reactions
    this.sock.ev.on('messages.reaction', async (reactions) => {
      for (const { key, reaction } of reactions) {
        try {
          const messageId = key.id;
          if (!messageId) continue;

          const rawChatJid = key.remoteJid;
          if (!rawChatJid || rawChatJid === 'status@broadcast') continue;

          const chatJid = await this.translateJid(rawChatJid);

          const groups = this.opts.registeredGroups();
          if (!groups[chatJid]) continue;

          const reactorJid =
            reaction.key?.participant || reaction.key?.remoteJid || '';
          const emoji = reaction.text || '';
          const timestamp = reaction.senderTimestampMs
            ? new Date(Number(reaction.senderTimestampMs)).toISOString()
            : new Date().toISOString();

          storeReaction({
            message_id: messageId,
            message_chat_jid: chatJid,
            reactor_jid: reactorJid,
            reactor_name: reactorJid.split('@')[0],
            emoji,
            timestamp,
          });

          logger.info(
            {
              chatJid,
              messageId: messageId.slice(0, 10) + '...',
              reactor: reactorJid.split('@')[0],
              emoji: emoji || '(removed)',
            },
            emoji ? 'Reaction added' : 'Reaction removed',
          );
        } catch (err) {
          logger.error({ err }, 'Failed to process reaction');
        }
      }
    });
  }

  async sendMessage(
    jid: string,
    text: string,
    opts?: SendMessageOpts,
  ): Promise<void> {
    // Prefix bot messages with assistant name so users know who's speaking.
    // On a shared number, prefix is also needed in DMs (including self-chat)
    // to distinguish bot output from user messages.
    // Skip only when the assistant has its own dedicated phone number.
    const prefixed = ASSISTANT_HAS_OWN_NUMBER
      ? text
      : `${ASSISTANT_NAME}: ${text}`;

    const mentions = opts?.mentions;

    if (!this.connected) {
      if (this.outgoingQueue.length >= MAX_OUTGOING_QUEUE) {
        logger.warn(
          { jid, queueSize: this.outgoingQueue.length },
          'WA outgoing queue full, dropping oldest message',
        );
        this.outgoingQueue.shift();
      }
      this.outgoingQueue.push({ jid, text: prefixed, mentions });
      logger.info(
        { jid, length: prefixed.length, queueSize: this.outgoingQueue.length },
        'WA disconnected, message queued',
      );
      return;
    }
    try {
      const resolved = mentions?.length
        ? await this.resolveMentions(jid, prefixed, mentions)
        : undefined;
      if (resolved) {
        await this.sock.sendMessage(jid, {
          text: resolved.text,
          mentions: resolved.resolvedJids,
        });
      } else {
        await this.sock.sendMessage(jid, { text: prefixed });
      }
      logger.info({ jid, length: prefixed.length }, 'Message sent');
    } catch (err) {
      // If send fails, queue it for retry on reconnect
      if (this.outgoingQueue.length >= MAX_OUTGOING_QUEUE) {
        logger.warn({ jid }, 'WA outgoing queue full, dropping oldest message');
        this.outgoingQueue.shift();
      }
      this.outgoingQueue.push({ jid, text: prefixed, mentions });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send, message queued',
      );
    }
  }

  async sendMessageWithId(
    jid: string,
    text: string,
  ): Promise<string | undefined> {
    const prefixed = ASSISTANT_HAS_OWN_NUMBER
      ? text
      : `${ASSISTANT_NAME}: ${text}`;
    if (!this.connected) return undefined;
    try {
      const sent = await this.sock.sendMessage(jid, { text: prefixed });
      return sent?.key?.id ?? undefined;
    } catch (err) {
      logger.warn({ jid, err }, 'Failed to send message with ID');
      return undefined;
    }
  }

  async sendImage(jid: string, image: Buffer, caption?: string): Promise<void> {
    if (!this.connected) {
      logger.warn({ jid }, 'WA disconnected, cannot send image');
      return;
    }
    try {
      await this.sock.sendMessage(jid, {
        image,
        caption: caption || undefined,
      });
      logger.info(
        { jid, size: image.length, hasCaption: !!caption },
        'Image sent',
      );
    } catch (err) {
      logger.warn({ jid, err }, 'Failed to send image');
    }
  }

  async sendDocument(
    jid: string,
    document: Buffer,
    filename: string,
    caption?: string,
  ): Promise<void> {
    if (!this.connected) {
      logger.warn({ jid }, 'WA disconnected, cannot send document');
      return;
    }
    try {
      const mimetype = filename.endsWith('.pdf')
        ? 'application/pdf'
        : filename.endsWith('.txt')
          ? 'text/plain'
          : 'application/octet-stream';
      await this.sock.sendMessage(jid, {
        document,
        mimetype,
        fileName: filename,
        caption: caption || undefined,
      });
      logger.info(
        { jid, size: document.length, filename, hasCaption: !!caption },
        'Document sent',
      );
    } catch (err) {
      logger.warn({ jid, err }, 'Failed to send document');
    }
  }

  async sendReaction(
    chatJid: string,
    messageKey: {
      id: string;
      remoteJid: string;
      fromMe?: boolean;
      participant?: string;
    },
    emoji: string,
  ): Promise<void> {
    if (!this.connected) {
      logger.warn({ chatJid, emoji }, 'Cannot send reaction - not connected');
      throw new Error('Not connected to WhatsApp');
    }
    try {
      await this.sock.sendMessage(chatJid, {
        react: { text: emoji, key: messageKey },
      });
      logger.info(
        {
          chatJid,
          messageId: messageKey.id?.slice(0, 10) + '...',
          emoji: emoji || '(removed)',
        },
        emoji ? 'Reaction sent' : 'Reaction removed',
      );
    } catch (err) {
      logger.error({ chatJid, emoji, err }, 'Failed to send reaction');
      throw err;
    }
  }

  async reactToLatestMessage(chatJid: string, emoji: string): Promise<void> {
    const latest = getLatestMessage(chatJid);
    if (!latest) {
      throw new Error(`No messages found for chat ${chatJid}`);
    }
    const messageKey = {
      id: latest.id,
      remoteJid: chatJid,
      fromMe: latest.fromMe,
      participant: latest.sender,
    };
    await this.sendReaction(chatJid, messageKey, emoji);
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith('@g.us') || jid.endsWith('@s.whatsapp.net');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.sock?.end(undefined);
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    try {
      const status = isTyping ? 'composing' : 'paused';
      logger.debug({ jid, status }, 'Sending presence update');
      await this.sock.sendPresenceUpdate(status, jid);
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to update typing status');
    }
  }

  /**
   * Sync group metadata from WhatsApp.
   * Fetches all participating groups and stores their names in the database.
   * Called on startup, daily, and on-demand via IPC.
   */
  async syncGroupMetadata(force = false): Promise<void> {
    if (!force) {
      const lastSync = getLastGroupSync();
      if (lastSync) {
        const lastSyncTime = new Date(lastSync).getTime();
        if (Date.now() - lastSyncTime < GROUP_SYNC_INTERVAL_MS) {
          logger.debug({ lastSync }, 'Skipping group sync - synced recently');
          return;
        }
      }
    }

    try {
      logger.info('Syncing group metadata from WhatsApp...');
      const groups = await this.sock.groupFetchAllParticipating();

      const registeredGroups = this.opts.registeredGroups();
      let count = 0;
      for (const [jid, metadata] of Object.entries(groups)) {
        if (metadata.subject) {
          updateChatName(jid, metadata.subject);
          // Also update registered_groups name if it was set to the JID at auto-registration
          const reg = registeredGroups[jid];
          if (reg && reg.name !== metadata.subject) {
            if (updateRegisteredGroupName(jid, metadata.subject)) {
              reg.name = metadata.subject;
              logger.debug(
                { jid, name: metadata.subject },
                'Updated registered group name',
              );
            }
          }
          count++;
        }
      }

      setLastGroupSync();
      logger.info({ count }, 'Group metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync group metadata');
    }
  }

  /**
   * Resolve phone-number mentions to WhatsApp JIDs for clickable @mentions.
   * For groups, fetches participant metadata to map phone numbers to JIDs.
   * Returns resolved JIDs and rewritten text, or undefined on failure.
   */
  private async resolveMentions(
    chatJid: string,
    text: string,
    mentions: string[],
  ): Promise<{ resolvedJids: string[]; text: string } | undefined> {
    try {
      const resolvedJids: string[] = [];
      let rewritten = text;

      if (chatJid.endsWith('@g.us')) {
        // Build phone→JID map from group participants
        const metadata = await this.sock.groupMetadata(chatJid);
        const phoneToJid = new Map<string, string>();
        for (const p of metadata.participants) {
          // p.id is the participant JID (e.g. "1234567890@s.whatsapp.net" or LID)
          const phoneFromId = p.id.split('@')[0].split(':')[0];
          phoneToJid.set(phoneFromId, p.id);
        }

        // Also use reversed lidToPhoneMap as fallback
        const lidToPhone = this.lidToPhoneMap;
        for (const [lid, phoneJid] of Object.entries(lidToPhone)) {
          const phone = phoneJid.split('@')[0];
          if (!phoneToJid.has(phone)) {
            // Find participant with this LID
            for (const p of metadata.participants) {
              const pLid = p.id.split('@')[0].split(':')[0];
              if (pLid === lid) {
                phoneToJid.set(phone, p.id);
              }
            }
          }
        }

        for (const mention of mentions) {
          const cleaned = mention.replace(/[^0-9]/g, '');
          const jid = phoneToJid.get(cleaned);
          if (jid) {
            resolvedJids.push(jid);
            // Rewrite @phone to @resolvedId for clickable display
            rewritten = rewritten.replaceAll(
              `@${mention}`,
              `@${jid.split('@')[0].split(':')[0]}`,
            );
          } else {
            // Fall back to constructing a JID from the phone number
            const fallbackJid = `${cleaned}@s.whatsapp.net`;
            resolvedJids.push(fallbackJid);
          }
        }
      } else {
        // DM/solo chat: construct JIDs directly from phone numbers
        for (const mention of mentions) {
          const cleaned = mention.replace(/[^0-9]/g, '');
          resolvedJids.push(`${cleaned}@s.whatsapp.net`);
        }
      }

      return resolvedJids.length > 0
        ? { resolvedJids, text: rewritten }
        : undefined;
    } catch (err) {
      logger.warn(
        { err, chatJid, mentionCount: mentions.length },
        'Failed to resolve mentions, sending without',
      );
      return undefined;
    }
  }

  private async translateJid(jid: string): Promise<string> {
    if (!jid.endsWith('@lid')) return jid;
    const lidUser = jid.split('@')[0].split(':')[0];

    // Check local cache first
    const cached = this.lidToPhoneMap[lidUser];
    if (cached) {
      logger.debug(
        { lidJid: jid, phoneJid: cached },
        'Translated LID to phone JID (cached)',
      );
      return cached;
    }

    // Query Baileys' signal repository for the mapping
    try {
      const pn = await this.sock.signalRepository?.lidMapping?.getPNForLID(jid);
      if (pn) {
        const phoneJid = `${pn.split('@')[0].split(':')[0]}@s.whatsapp.net`;
        this.lidToPhoneMap[lidUser] = phoneJid;
        logger.info(
          { lidJid: jid, phoneJid },
          'Translated LID to phone JID (signalRepository)',
        );
        return phoneJid;
      }
    } catch (err) {
      logger.debug({ err, jid }, 'Failed to resolve LID via signalRepository');
    }

    return jid;
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing outgoing message queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        // Send directly — queued items are already prefixed by sendMessage
        const resolved = item.mentions?.length
          ? await this.resolveMentions(item.jid, item.text, item.mentions)
          : undefined;
        if (resolved) {
          await this.sock.sendMessage(item.jid, {
            text: resolved.text,
            mentions: resolved.resolvedJids,
          });
        } else {
          await this.sock.sendMessage(item.jid, { text: item.text });
        }
        logger.info(
          { jid: item.jid, length: item.text.length },
          'Queued message sent',
        );
      }
    } finally {
      this.flushing = false;
    }
  }
}

registerChannel('whatsapp', (opts: ChannelOpts) => {
  const authDir = path.join(STORE_DIR, 'auth');
  try {
    if (!fs.existsSync(authDir) || fs.readdirSync(authDir).length === 0)
      return null;
  } catch {
    return null;
  }
  return new WhatsAppChannel(opts);
});
