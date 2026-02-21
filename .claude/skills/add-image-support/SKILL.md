---
name: add-image-support
description: Image receiving, processing, and sending for WhatsApp. Handles image download, transient storage, container file I/O, agent description parsing, and outbound image/document sending via IPC.
---

# Add Image Support

This skill adds end-to-end image handling to NanoClaw:

## What this skill adds

- **Image receiving**: WhatsApp image messages are downloaded, base64-encoded, and stored transiently until processed
- **Image lifecycle management** (`src/image-handler.ts`): `ImageHandler` class manages pending images through attach, pipe, prepare-for-container, and cleanup phases
- **Media processing** (`src/media-processing.ts`): File I/O for writing images to IPC directories, cleanup after container exit, image description parsing from agent output
- **Image description enrichment**: Agent can describe images using `<image-description>` XML tags; descriptions are stored in the DB for future context
- **Outbound image/document sending**: IPC handlers for `send_image` and `send_document` message types allow the agent to send images and files back to users
- **Image data in message format**: Messages with images get `has-image="true"` attribute in XML format sent to agent

## Architecture

```
WhatsApp → downloadImage() → pendingImages store → ImageHandler
  → attachToMessages() → writeImageFiles() → container reads from /workspace/ipc/media/
  → agent output with <image-description> tags → applyImageDescriptions() → DB update
  → cleanupImageFiles() after container exits

Agent → IPC send_image/send_document → handleIpcImage()/handleIpcDocument() → channel.sendImage()
```

## Files

### New files (adds)
- `src/image-handler.ts` — ImageHandler class managing transient image store
- `src/media-processing.ts` — Image download, file I/O, description parsing

### Modified files
- `src/index.ts` — ImageHandler instantiation and hook calls
- `src/types.ts` — `ImageBlock` interface, optional `sendImage`/`sendDocument` on Channel
- `src/channels/whatsapp.ts` — Image detection, download, sendImage/sendDocument methods
- `src/db.ts` — `updateMessageContent()` for image descriptions
- `src/router.ts` — `has-image` attribute in message XML
- `src/group-queue.ts` — `images` parameter in `sendMessage()`
- `src/ipc.ts` — `send_image`, `send_document` IPC handlers

## Verify

```bash
npx vitest run src/media-processing.test.ts src/formatting.test.ts
npm run build
```
