/**
 * Channel initialization and lookup.
 * Extracts multi-channel wiring from index.ts to reduce merge surface.
 */
import {
  GATEWAY_CHANNEL,
  SLACK_APP_TOKEN,
  SLACK_BOT_TOKEN,
  SLACK_SIGNING_SECRET,
} from './config.js';
import { SlackChannel } from './channels/slack.js';
import { WhatsAppChannel } from './channels/whatsapp.js';
import { logger } from './logger.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';

export interface ChannelCallbacks {
  onMessage: (chatJid: string, msg: NewMessage) => void;
  onChatMetadata: (
    chatJid: string,
    timestamp: string,
    name?: string,
    channel?: string,
    isGroup?: boolean,
  ) => void;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  onAbort: (chatJid: string) => Promise<boolean>;
}

/**
 * Create and connect channels based on GATEWAY_CHANNEL config.
 * Returns the array of connected channels.
 */
export async function initializeChannels(
  opts: ChannelCallbacks,
): Promise<Channel[]> {
  const channels: Channel[] = [];

  const enableWhatsApp =
    GATEWAY_CHANNEL === 'whatsapp' || GATEWAY_CHANNEL === 'both';
  const enableSlack =
    GATEWAY_CHANNEL === 'slack' || GATEWAY_CHANNEL === 'both';

  if (!enableWhatsApp && !enableSlack) {
    throw new Error(
      `Invalid GATEWAY_CHANNEL="${GATEWAY_CHANNEL}". Use "whatsapp", "slack", or "both".`,
    );
  }

  if (enableWhatsApp) {
    const whatsapp = new WhatsAppChannel(opts);
    channels.push(whatsapp);
    await whatsapp.connect();
  }

  if (enableSlack) {
    const slack = new SlackChannel({
      ...opts,
      botToken: SLACK_BOT_TOKEN,
      appToken: SLACK_APP_TOKEN,
      signingSecret: SLACK_SIGNING_SECRET,
    });
    channels.push(slack);
    await slack.connect();
  }

  logger.info(
    { gatewayChannel: GATEWAY_CHANNEL },
    'Gateway channels connected',
  );

  return channels;
}

/**
 * Find the channel that owns a given JID.
 */
export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}
