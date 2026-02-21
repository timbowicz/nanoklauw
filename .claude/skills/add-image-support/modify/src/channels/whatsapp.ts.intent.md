# Intent: src/channels/whatsapp.ts modifications

## What this skill adds
Image detection on inbound messages, image download via Baileys, and outbound sendImage/sendDocument methods.

## Key sections

### Imports (top of file)
- Added: `downloadImage` from `../media-processing.js`

### messages.upsert handler (inside connectInternal)
- Added: Image detection check for `msg.message?.imageMessage`
- Added: `downloadImage(msg, this.sock)` call when image detected
- Added: Pass `image_data` field to `onMessage` callback when image is downloaded
- Added: Default content `'[Image]'` when image has no caption

### sendImage method (new)
- Implements `Channel.sendImage(jid, image, caption?)` using Baileys' `sendMessage` with `image` content type

### sendDocument method (new)
- Implements `Channel.sendDocument(jid, document, filename, caption?)` using Baileys' `sendMessage` with `document` content type

## Invariants (must-keep)
- Connection lifecycle (connect, reconnect, disconnect, retry logic) unchanged
- LID translation unchanged
- Text message handling unchanged
- ExtendedTextMessage handling unchanged
- Outgoing message queue unchanged
- Group metadata sync unchanged
- sendMessage prefix logic unchanged
- setTyping, ownsJid, isConnected unchanged
