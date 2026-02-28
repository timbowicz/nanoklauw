/**
 * Image lifecycle management.
 * Manages the transient pendingImages store and coordinates
 * image file I/O for container access.
 */
import {
  writeImageFiles,
  cleanupImageFiles,
  ImageRef,
} from './media-processing.js';
import { ImageBlock, NewMessage } from './types.js';
import { logger } from './logger.js';

const PENDING_TTL_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 60 * 1000; // sweep every minute

interface PendingEntry<T> {
  data: T;
  storedAt: number;
}

export class ImageHandler {
  private pendingImages = new Map<string, PendingEntry<ImageBlock>>();
  private cleanupTimer: ReturnType<typeof setInterval> | undefined;

  constructor() {
    this.cleanupTimer = setInterval(() => this.evictStale(), CLEANUP_INTERVAL_MS);
  }

  /** Store image data for later attachment to messages. */
  storeImage(messageId: string, image: ImageBlock): void {
    this.pendingImages.set(messageId, { data: image, storedAt: Date.now() });
  }

  /**
   * Attach stored images to messages and consume them from the pending store.
   * Used in processGroupMessages where we're committing to process these messages.
   */
  attachToMessages(messages: NewMessage[]): void {
    for (const msg of messages) {
      const entry = this.pendingImages.get(msg.id);
      if (entry) {
        msg.image_data = entry.data;
        this.pendingImages.delete(msg.id);
      }
    }
  }

  /**
   * Attach stored images to messages WITHOUT consuming from the pending store.
   * Used in startMessageLoop's piping path where we may need to retry.
   */
  peekAttachToMessages(messages: NewMessage[]): void {
    for (const msg of messages) {
      const entry = this.pendingImages.get(msg.id);
      if (entry) {
        msg.image_data = entry.data;
      }
    }
  }

  /** Consume (remove) pending images for these messages after successful pipe. */
  consumeImages(messages: NewMessage[]): void {
    for (const msg of messages) {
      this.pendingImages.delete(msg.id);
    }
  }

  /** Write image files to IPC for container access. */
  prepareForContainer(groupFolder: string, messages: NewMessage[]): ImageRef[] {
    return writeImageFiles(groupFolder, messages);
  }

  /** Clean up image files after container exits. */
  cleanup(groupFolder: string, refs: ImageRef[]): void {
    cleanupImageFiles(groupFolder, refs);
  }

  /** Evict entries older than TTL to prevent unbounded memory growth. */
  private evictStale(): void {
    const cutoff = Date.now() - PENDING_TTL_MS;
    let evicted = 0;
    for (const [id, entry] of this.pendingImages) {
      if (entry.storedAt < cutoff) {
        this.pendingImages.delete(id);
        evicted++;
      }
    }
    if (evicted > 0) {
      logger.info({ evicted, remaining: this.pendingImages.size }, 'Evicted stale pending images');
    }
  }

  /** Stop the cleanup timer (for graceful shutdown). */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }
}
