# Intent: src/group-queue.ts modifications

## What this skill adds
Optional image references parameter on the `sendMessage` method for piping images to active containers.

## Key sections

### sendMessage method signature
- Changed: `sendMessage(groupJid: string, text: string)` → `sendMessage(groupJid: string, text: string, images?: Array<{ messageId: string; filename: string }>)`
- Added: If `images` array is provided, include it in the IPC payload so the container can read the image files from the media directory

## Invariants (must-keep)
- All queue management (enqueue, drain, retry, concurrency limits) unchanged
- Task queuing unchanged
- Process registration unchanged
- closeStdin, abortGroup unchanged
- notifyIdle unchanged
- Shutdown logic unchanged
