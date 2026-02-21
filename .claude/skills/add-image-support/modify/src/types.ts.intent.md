# Intent: src/types.ts modifications

## What this skill adds
Image data type and optional image/document methods on the Channel interface.

## Key sections

### ImageBlock interface (new)
```typescript
export interface ImageBlock {
  type: 'image';
  media_type: string;
  data: string; // base64
}
```

### NewMessage interface
- Added: `image_data?: ImageBlock` — transient field, never persisted to DB

### Channel interface
- Added: `sendImage?(jid: string, image: Buffer, caption?: string): Promise<void>`
- Added: `sendDocument?(jid: string, document: Buffer, filename: string, caption?: string): Promise<void>`

## Invariants (must-keep)
- All existing interfaces unchanged (RegisteredGroup, ScheduledTask, TaskRunLog, ContainerConfig, etc.)
- All existing Channel methods unchanged (connect, sendMessage, isConnected, ownsJid, disconnect, setTyping, syncGroupMetadata)
- OnInboundMessage and OnChatMetadata callback types unchanged
