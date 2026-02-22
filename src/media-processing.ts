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
import { DocumentBlock, ImageBlock, NewMessage } from './types.js';

/** Map MIME types to file extensions. Defaults to 'jpg' for unknown types. */
function mimeToExt(mime: string): string {
  switch (mime) {
    case 'image/png': return 'png';
    case 'image/webp': return 'webp';
    case 'image/gif': return 'gif';
    default: return 'jpg';
  }
}

/** Detect actual image MIME type from magic bytes, falling back to declared MIME. */
function detectMimeFromBuffer(buffer: Buffer, declaredMime: string): string {
  if (buffer.length < 4) return declaredMime;
  // PNG: 89 50 4E 47
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return 'image/png';
  // JPEG: FF D8 FF
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return 'image/jpeg';
  // GIF: 47 49 46 38
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) return 'image/gif';
  // WebP: 52 49 46 46 ... 57 45 42 50
  if (buffer.length >= 12 && buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46
      && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) return 'image/webp';
  return declaredMime;
}

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

    const declaredMime = msg.message.imageMessage.mimetype || 'image/jpeg';
    const mimetype = detectMimeFromBuffer(buffer, declaredMime);
    if (mimetype !== declaredMime) {
      logger.warn({ declaredMime, actualMime: mimetype }, 'Image MIME mismatch, using detected type');
    }
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

    const ext = mimeToExt(msg.image_data.media_type);
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

// --- Document support ---

export interface DocumentRef {
  messageId: string;
  filename: string;
}

/** Max document size before base64 encoding (~25MB raw → ~33MB base64, within Claude's 32MB limit). */
const MAX_DOCUMENT_SIZE = 25 * 1024 * 1024;

/** Detect document MIME type from magic bytes, falling back to declared MIME. */
function detectDocumentMime(buffer: Buffer, declaredMime: string): string {
  if (buffer.length >= 4) {
    // PDF: %PDF
    if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) return 'application/pdf';
  }
  return declaredMime;
}

/** Map document MIME type to file extension. */
function documentMimeToExt(mime: string, filename?: string): string {
  // Prefer original extension if present
  if (filename) {
    const ext = filename.split('.').pop()?.toLowerCase();
    if (ext && ext.length <= 10) return ext;
  }
  switch (mime) {
    case 'application/pdf': return 'pdf';
    case 'text/plain': return 'txt';
    case 'application/json': return 'json';
    case 'text/csv': return 'csv';
    case 'text/xml':
    case 'application/xml': return 'xml';
    default: return 'bin';
  }
}

/**
 * Download a document from a WhatsApp message and return it as a DocumentBlock.
 * Returns null if the message has no document or download fails.
 */
export async function downloadDocument(
  msg: WAMessage,
  sock: WASocket,
): Promise<DocumentBlock | null> {
  if (!msg.message?.documentMessage) return null;

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
      logger.warn('Failed to download document: empty buffer');
      return null;
    }

    if (buffer.length > MAX_DOCUMENT_SIZE) {
      logger.warn({ size: buffer.length }, 'Document too large, skipping');
      return null;
    }

    const declaredMime = msg.message.documentMessage.mimetype || 'application/octet-stream';
    const mimetype = detectDocumentMime(buffer, declaredMime);
    const filename = msg.message.documentMessage.fileName || `document.${documentMimeToExt(mimetype)}`;

    logger.info({ size: buffer.length, mimetype, filename }, 'Downloaded document');

    return {
      type: 'document',
      media_type: mimetype,
      data: buffer.toString('base64'),
      filename,
    };
  } catch (err) {
    logger.error({ err }, 'Failed to download document');
    return null;
  }
}

/**
 * Write base64 documents from messages to the IPC media directory.
 * Also writes a .meta.json sidecar with original filename and MIME type.
 * Returns a list of document refs (messageId -> filename) for the container.
 */
export function writeDocumentFiles(
  groupFolder: string,
  messages: NewMessage[],
): DocumentRef[] {
  const refs: DocumentRef[] = [];
  const mediaDir = path.join(DATA_DIR, 'ipc', groupFolder, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });

  for (const msg of messages) {
    if (!msg.document_data) continue;

    const ext = documentMimeToExt(msg.document_data.media_type, msg.document_data.filename);
    const safeId = msg.id.replace(/[^a-zA-Z0-9._-]/g, '_');
    const filename = `doc_${safeId}.${ext}`;
    const filepath = path.join(mediaDir, filename);

    try {
      fs.writeFileSync(filepath, Buffer.from(msg.document_data.data, 'base64'));
      // Write sidecar with metadata
      fs.writeFileSync(
        `${filepath}.meta.json`,
        JSON.stringify({
          originalFilename: msg.document_data.filename,
          mimeType: msg.document_data.media_type,
        }),
      );
      // Ensure container (uid 1000) can read the files
      try { fs.chownSync(filepath, 1000, 1000); } catch {}
      try { fs.chownSync(`${filepath}.meta.json`, 1000, 1000); } catch {}
      refs.push({ messageId: msg.id, filename });
    } catch (err) {
      logger.error({ err, messageId: msg.id }, 'Failed to write document file');
    }
  }

  return refs;
}

/**
 * Remove processed document files and their sidecars after the container exits.
 */
export function cleanupDocumentFiles(
  groupFolder: string,
  refs: DocumentRef[],
): void {
  const mediaDir = path.join(DATA_DIR, 'ipc', groupFolder, 'media');

  for (const ref of refs) {
    try { fs.unlinkSync(path.join(mediaDir, ref.filename)); } catch {}
    try { fs.unlinkSync(path.join(mediaDir, `${ref.filename}.meta.json`)); } catch {}
  }
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
