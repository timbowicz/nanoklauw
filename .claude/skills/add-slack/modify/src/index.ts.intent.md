# Intent: src/index.ts modifications

## What this skill adds
Multi-channel support: replaces direct WhatsApp instantiation with channel-manager that conditionally creates WhatsApp and/or Slack channels based on `GATEWAY_CHANNEL` config.

## Key sections

### Imports (top of file)
- Added: `initializeChannels` from `./channel-manager.js` (new file added by this skill)
- Removed: direct `WhatsAppChannel` import (moved into channel-manager)
- Removed: `GATEWAY_CHANNEL`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_SIGNING_SECRET` from config imports (used internally by channel-manager)

### main() function
- Replaced: ~28 lines of inline channel instantiation with single call:
  ```typescript
  channels = await initializeChannels({ onMessage, onChatMetadata, registeredGroups, registerGroup, onAbort });
  ```
- Changed: `channels` from `const` to `let` (assigned by initializeChannels return value)

## Invariants (must-keep)
- Channel callbacks (onMessage, onChatMetadata, registeredGroups, registerGroup, onAbort) unchanged
- All other subsystems (scheduler, IPC watcher, queue, message loop) unchanged
- State management (loadState, saveState, sessions, registeredGroups) unchanged
- processGroupMessages and runAgent unchanged
- startMessageLoop unchanged
