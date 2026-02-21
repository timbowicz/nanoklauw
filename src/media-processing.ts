/**
 * Media processing for WhatsApp images.
 * Downloads images via Baileys, writes them to IPC for container access,
 * and provides helpers for building image descriptions.
 */
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import type { WAMessage, WASocket } from '@whiskeysockets/baileys';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { updateMessageContent } from './db.js';
import { logger } from './logger.js';
import { ImageBlock, NewMessage } from './types.js';

/**
 * Download an image from a WhatsApp message and return it as base64.
 * Returns null if the message has no image or download fails.
 */
export async function downloadImage(
  msg: WAMessage,
  sock: WASocket,
): Promise<ImageBlock | null> {
  if (!msg.message?.imageMessage) return null;

  try {
    const buffer = (await downloadMediaMessage(
      msg,
      'buffer',
      {},
      {
        logger: console as any,
        reuploadRequest: sock.updateMediaMessage,
      },
    )) as Buffer;

    if (!buffer || buffer.length === 0) {
      logger.warn('Failed to download image: empty buffer');
      return null;
    }

    const mimetype = msg.message.imageMessage.mimetype || 'image/jpeg';
    logger.info({ size: buffer.length, mimetype }, 'Downloaded image');

    return {
      type: 'image',
      media_type: mimetype,
      data: buffer.toString('base64'),
    };
  } catch (err) {
    logger.error({ err }, 'Failed to download image');
    return null;
  }
}

export interface ImageRef {
  messageId: string;
  filename: string;
}

/**
 * Write base64 images from messages to the IPC media directory.
 * Returns a list of image refs (messageId -> filename) for the container.
 */
export function writeImageFiles(
  groupFolder: string,
  messages: NewMessage[],
): ImageRef[] {
  const refs: ImageRef[] = [];
  const mediaDir = path.join(DATA_DIR, 'ipc', groupFolder, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });

  for (const msg of messages) {
    if (!msg.image_data) continue;

    const ext = msg.image_data.media_type === 'image/png' ? 'png' : 'jpg';
    const safeId = msg.id.replace(/[^a-zA-Z0-9._-]/g, '_');
    const filename = `${safeId}.${ext}`;
    const filepath = path.join(mediaDir, filename);

    try {
      fs.writeFileSync(filepath, Buffer.from(msg.image_data.data, 'base64'));
      // Ensure container (uid 1000) can read the file
      try { fs.chownSync(filepath, 1000, 1000); } catch {}
      refs.push({ messageId: msg.id, filename });
    } catch (err) {
      logger.error({ err, messageId: msg.id }, 'Failed to write image file');
    }
  }

  return refs;
}

/**
 * Remove processed image files after the container exits.
 */
export function cleanupImageFiles(
  groupFolder: string,
  refs: ImageRef[],
): void {
  const mediaDir = path.join(DATA_DIR, 'ipc', groupFolder, 'media');

  for (const ref of refs) {
    try {
      fs.unlinkSync(path.join(mediaDir, ref.filename));
    } catch {
      // File may already be cleaned up
    }
  }
}

/**
 * Build enriched content string for DB storage after description is generated.
 * Example: "[Image: A sunset over the ocean] Check out this view!"
 */
export function buildImageDescription(
  caption: string,
  description: string,
): string {
  if (caption) {
    return `[Image: ${description}] ${caption}`;
  }
  return `[Image: ${description}]`;
}

/**
 * Parse <image-description> tags from agent output, store enriched descriptions
 * in the DB, and return output with description tags stripped.
 */
export function applyImageDescriptions(
  missedMessages: NewMessage[],
  agentOutput: string,
  chatJid: string,
): string {
  const descRegex =
    /<image-description\s+message-id="([^"]+)">([\s\S]*?)<\/image-description>/g;
  let match;
  while ((match = descRegex.exec(agentOutput)) !== null) {
    const [, msgId, description] = match;
    const msg = missedMessages.find((m) => m.id === msgId);
    if (msg) {
      const enriched = buildImageDescription(
        msg.content === '[Image]' ? '' : msg.content,
        description.trim(),
      );
      updateMessageContent(msgId, chatJid, enriched);
      logger.info(
        { msgId, description: description.trim().slice(0, 100) },
        'Image description stored',
      );
    }
  }
  // Strip image-description tags from user-facing output
  return agentOutput
    .replace(
      /<image-description\s+message-id="[^"]*">[\s\S]*?<\/image-description>/g,
      '',
    )
    .trim();
}
