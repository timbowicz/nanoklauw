# Intent: src/db.ts modifications

## What this skill adds
A function to update stored message content after image description enrichment.

## Key sections

### updateMessageContent function (new)
```typescript
export function updateMessageContent(id: string, chatJid: string, content: string): void
```
Updates the `content` column of a stored message by `(id, chat_jid)` primary key. Used after the agent generates an image description to enrich `[Image]` content with `[Image: description] caption`.

## Invariants (must-keep)
- Schema unchanged (no new tables or columns)
- All existing query functions unchanged
- storeMessage, storeMessageDirect unchanged
- Migration logic unchanged
