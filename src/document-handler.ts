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

export class DocumentHandler {
  private pendingDocuments = new Map<string, DocumentBlock>();

  /** Store document data for later attachment to messages. */
  storeDocument(messageId: string, document: DocumentBlock): void {
    this.pendingDocuments.set(messageId, document);
  }

  /**
   * Attach stored documents to messages and consume them from the pending store.
   * Used in processGroupMessages where we're committing to process these messages.
   */
  attachToMessages(messages: NewMessage[]): void {
    for (const msg of messages) {
      const docData = this.pendingDocuments.get(msg.id);
      if (docData) {
        msg.document_data = docData;
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
      const docData = this.pendingDocuments.get(msg.id);
      if (docData) {
        msg.document_data = docData;
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
}
