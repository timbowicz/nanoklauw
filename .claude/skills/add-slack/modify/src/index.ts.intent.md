# Intent: src/index.ts modifications

## What changed
Refactored from single WhatsApp channel to multi-channel architecture supporting Slack alongside WhatsApp. Channel initialization is delegated to `channel-manager.ts` to reduce merge surface.

## Key sections

### Imports (top of file)
- Added: `initializeChannels, findChannel` from `./channel-manager.js`
- Removed: Direct `SlackChannel` import (handled by channel-manager)
- Existing: `Channel` type from `./types.js` is already present

### Module-level state
- Kept: `const channels: Channel[] = []` — array of all active channels
- No direct `whatsapp` or `slack` variable references — use `findChannel()` instead

### processGroupMessages()
- Uses `findChannel(channels, chatJid)` lookup (already exists in base)
- Uses `channel.setTyping?.()` and `channel.sendMessage()` (already exists in base)

### startMessageLoop()
- Uses `findChannel(channels, chatJid)` per group (already exists in base)
- Uses `channel.setTyping?.()` for typing indicators (already exists in base)

### main()
- Added: `const connectedChannels = await initializeChannels(callbacks)` — delegates to channel-manager.ts
- Added: `channels.push(...connectedChannels)` — populates the shared channel array
- Changed: scheduler `sendMessage` uses `findChannel()` → `channel.sendMessage()`
- Changed: IPC `syncGroupMetadata` iterates channels that support it
- Changed: IPC `sendMessage` uses `findChannel()` → `channel.sendMessage()`

### Shutdown handler
- Changed from `await whatsapp.disconnect()` to `for (const ch of channels) await ch.disconnect()`
- Disconnects all active channels on SIGTERM/SIGINT

## Invariants
- All existing message processing logic (triggers, cursors, idle timers) is preserved
- The `runAgent` function is completely unchanged
- State management (loadState/saveState) is unchanged
- Recovery logic is unchanged
- Container runtime check is unchanged (ensureContainerSystemRunning)

## Design decisions

### channel-manager.ts delegation
Channel initialization (which channels to create, how to configure them) is in `channel-manager.ts` rather than inline in `main()`. This:
1. Reduces the merge surface of index.ts (most-conflicted file)
2. Keeps GATEWAY_CHANNEL logic isolated
3. Makes adding future channels (Telegram, etc.) trivial

### GATEWAY_CHANNEL vs SLACK_ONLY
We use `GATEWAY_CHANNEL` (whatsapp/slack/both) instead of upstream's `SLACK_ONLY` boolean. More flexible and future-proof for multi-channel setups.

## Must-keep
- The `escapeXml` and `formatMessages` re-exports
- The `_setRegisteredGroups` test helper
- The `isDirectRun` guard at bottom
- All error handling and cursor rollback logic in processGroupMessages
- The outgoing queue flush and reconnection logic (in each channel, not here)
