# Intent: src/index.ts modifications

## What this skill adds
Image lifecycle hooks: transient image storage on inbound messages, image attachment/preparation before container processing, image description parsing from agent output, and cleanup after container exit.

## Key sections

### Imports (top of file)
- Added: `ImageHandler` from `./image-handler.js`
- Added: `applyImageDescriptions`, `ImageRef` from `./media-processing.js`
- Removed: `writeImageFiles`, `cleanupImageFiles`, `buildImageDescription` (moved into ImageHandler / media-processing)
- Removed: `updateMessageContent` from db.js (now used internally by applyImageDescriptions)

### Module-level state
- Added: `const imageHandler = new ImageHandler()`
- Removed: `const pendingImages = new Map<string, ImageBlock>()` (managed by ImageHandler)

### onMessage callback (inside main → channelOpts)
- Added: `if (msg.image_data) imageHandler.storeImage(msg.id, msg.image_data)` before storeMessage

### processGroupMessages
- Changed: `pendingImages.get/delete` loop → `imageHandler.attachToMessages(missedMessages)`
- Changed: `writeImageFiles()` → `imageHandler.prepareForContainer(group.folder, missedMessages)`
- Changed: `cleanupImageFiles()` → `imageHandler.cleanup(group.folder, imageRefs)`

### Streaming output callback (inside processGroupMessages → runAgent onOutput)
- Changed: Inline `<image-description>` XML parsing + updateMessageContent loop → single call: `text = applyImageDescriptions(missedMessages, text, chatJid)`

### startMessageLoop (piping path)
- Changed: `pendingImages.get` loop → `imageHandler.peekAttachToMessages(messagesToSend)`
- Changed: `writeImageFiles()` → `imageHandler.prepareForContainer()`
- Changed: `cleanupImageFiles()` → `imageHandler.cleanup()`
- Changed: `pendingImages.delete` loop → `imageHandler.consumeImages(messagesToSend)`

## Invariants (must-keep)
- Message loop polling logic unchanged
- Trigger pattern matching unchanged
- Queue interaction (enqueueMessageCheck, sendMessage, closeStdin) unchanged
- runAgent function unchanged (still receives imageRefs parameter)
- Session tracking, state save/load unchanged
- Graceful shutdown unchanged
- Recovery logic unchanged
