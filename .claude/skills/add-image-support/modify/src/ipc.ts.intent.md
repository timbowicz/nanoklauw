# Intent: src/ipc.ts modifications

## What this skill adds
IPC handlers for outbound image and document sending, allowing the container agent to send images and files back to users.

## Key sections

### IpcDeps interface
- Added: `sendImage: (jid: string, image: Buffer, caption?: string) => Promise<void>`
- Added: `sendDocument: (jid: string, document: Buffer, filename: string, caption?: string) => Promise<void>`

### handleIpcImage function (new, extracted from inline)
Handles `send_image` IPC messages:
- Authorization check via `canAccessJid()`
- Resolves container-relative path to host path via `resolveIpcPath()`
- Reads image file, sends via `deps.sendImage()`, cleans up file

### handleIpcDocument function (new, extracted from inline)
Handles `send_document` IPC messages:
- Same authorization and path resolution pattern as image handler
- Reads file, sends via `deps.sendDocument()`, cleans up file

### createIpcDeps factory (new)
Builds IpcDeps from channels array, wrapping `findChannel` + channel methods into the deps interface. Extracts ~24 lines of inline closures from index.ts main().

### processIpcFiles message dispatch
- Added: `send_image` case → `handleIpcImage()`
- Added: `send_document` case → `handleIpcDocument()`

## Invariants (must-keep)
- Text message handling (`type: 'message'`) unchanged
- Task IPC processing (schedule_task, pause_task, etc.) unchanged
- Per-group namespace scanning unchanged
- Error handling and error directory logic unchanged
- IPC watcher polling interval unchanged
