/**
 * Document lifecycle management.
 * Manages the transient pendingDocuments store and coordinates
 * document file I/O for container access.
 * Mirrors the pattern in image-handler.ts.
 */
import {
  writeDocumentFiles,
  cleanupDocumentFiles,
  DocumentRef,
} from './media-processing.js';
import { DocumentBlock, NewMessage } from './types.js';
import { logger } from './logger.js';

const PENDING_TTL_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 60 * 1000; // sweep every minute

interface PendingEntry<T> {
  data: T;
  storedAt: number;
}

export class DocumentHandler {
  private pendingDocuments = new Map<string, PendingEntry<DocumentBlock>>();
  private cleanupTimer: ReturnType<typeof setInterval> | undefined;

  constructor() {
    this.cleanupTimer = setInterval(
      () => this.evictStale(),
      CLEANUP_INTERVAL_MS,
    );
  }

  /** Store document data for later attachment to messages. */
  storeDocument(messageId: string, document: DocumentBlock): void {
    this.pendingDocuments.set(messageId, {
      data: document,
      storedAt: Date.now(),
    });
  }

  /**
   * Attach stored documents to messages and consume them from the pending store.
   * Used in processGroupMessages where we're committing to process these messages.
   */
  attachToMessages(messages: NewMessage[]): void {
    for (const msg of messages) {
      const entry = this.pendingDocuments.get(msg.id);
      if (entry) {
        msg.document_data = entry.data;
        this.pendingDocuments.delete(msg.id);
      }
    }
  }

  /**
   * Attach stored documents to messages WITHOUT consuming from the pending store.
   * Used in startMessageLoop's piping path where we may need to retry.
   */
  peekAttachToMessages(messages: NewMessage[]): void {
    for (const msg of messages) {
      const entry = this.pendingDocuments.get(msg.id);
      if (entry) {
        msg.document_data = entry.data;
      }
    }
  }

  /** Consume (remove) pending documents for these messages after successful pipe. */
  consumeDocuments(messages: NewMessage[]): void {
    for (const msg of messages) {
      this.pendingDocuments.delete(msg.id);
    }
  }

  /** Write document files to IPC for container access. */
  prepareForContainer(
    groupFolder: string,
    messages: NewMessage[],
  ): DocumentRef[] {
    return writeDocumentFiles(groupFolder, messages);
  }

  /** Clean up document files after container exits. */
  cleanup(groupFolder: string, refs: DocumentRef[]): void {
    cleanupDocumentFiles(groupFolder, refs);
  }

  /** Evict entries older than TTL to prevent unbounded memory growth. */
  private evictStale(): void {
    const cutoff = Date.now() - PENDING_TTL_MS;
    let evicted = 0;
    for (const [id, entry] of this.pendingDocuments) {
      if (entry.storedAt < cutoff) {
        this.pendingDocuments.delete(id);
        evicted++;
      }
    }
    if (evicted > 0) {
      logger.info(
        { evicted, remaining: this.pendingDocuments.size },
        'Evicted stale pending documents',
      );
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
