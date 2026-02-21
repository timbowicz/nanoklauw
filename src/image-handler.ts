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

export class ImageHandler {
  private pendingImages = new Map<string, ImageBlock>();

  /** Store image data for later attachment to messages. */
  storeImage(messageId: string, image: ImageBlock): void {
    this.pendingImages.set(messageId, image);
  }

  /**
   * Attach stored images to messages and consume them from the pending store.
   * Used in processGroupMessages where we're committing to process these messages.
   */
  attachToMessages(messages: NewMessage[]): void {
    for (const msg of messages) {
      const imgData = this.pendingImages.get(msg.id);
      if (imgData) {
        msg.image_data = imgData;
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
      const imgData = this.pendingImages.get(msg.id);
      if (imgData) {
        msg.image_data = imgData;
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
  prepareForContainer(
    groupFolder: string,
    messages: NewMessage[],
  ): ImageRef[] {
    return writeImageFiles(groupFolder, messages);
  }

  /** Clean up image files after container exits. */
  cleanup(groupFolder: string, refs: ImageRef[]): void {
    cleanupImageFiles(groupFolder, refs);
  }
}
