# Modularization Plan

Goal: reduce merge surface with upstream NanoClaw by extracting custom code from core files into dedicated modules. Each extraction should leave only minimal hook/import calls in the core file.

## Current Customization Footprint

| Category | Core files touched | Custom lines | Conflict risk |
|----------|-------------------|-------------|---------------|
| Image handling | 8 files | ~180 | **High** — touches index.ts, router.ts, types.ts, db.ts, whatsapp.ts, group-queue.ts, container-runner.ts |
| Multi-channel / Slack | 5 files | ~120 | **High** — channel array logic woven through index.ts |
| IPC media extensions | 1 file | ~64 | Medium — inline in ipc.ts |
| Group abort / preemption | 1 file | ~68 | Low — self-contained in group-queue.ts |
| Container secrets | 1 file | ~7 | Low — hardcoded list |

---

## Phase 1: Low-Risk Extractions

These are safe to do independently, each is a standalone change with no cross-dependencies.

### 1.1 Move hardcoded secrets to config

**Current:** `container-runner.ts` line ~192 has a hardcoded array:
```typescript
['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'HA_URL', 'HA_TOKEN', 'TRIBE_CLIENT_ID', 'TRIBE_CLIENT_SECRET']
```

**Target:** Add `CONTAINER_SECRETS` constant in `src/config.ts`. Import in `container-runner.ts`.

**Benefit:** Config is the expected place for this. Upstream won't touch this constant since it's new.

**Merge surface reduction:** Container-runner.ts diff shrinks by ~5 lines.

---

### 1.2 Extract channel initialization from main()

**Current:** `src/index.ts` lines ~527-554 — conditional channel instantiation based on `GATEWAY_CHANNEL`, Slack token checks, push to `channels[]`.

**Target:** New file `src/channel-manager.ts`:
```typescript
export function initializeChannels(opts: ChannelOpts): Channel[] {
  const channels: Channel[] = [];
  if (['whatsapp', 'both'].includes(GATEWAY_CHANNEL)) {
    channels.push(new WhatsAppChannel(opts));
  }
  if (['slack', 'both'].includes(GATEWAY_CHANNEL) && SLACK_BOT_TOKEN && SLACK_APP_TOKEN) {
    channels.push(new SlackChannel({ ... }));
  }
  return channels;
}

export function findChannel(channels: Channel[], jid: string): Channel | undefined {
  return channels.find(c => c.ownsJid(jid));
}
```

Move `findChannel` from `router.ts` into this file too (it's channel-management, not routing).

**Residual in index.ts:** ~3 lines:
```typescript
import { initializeChannels } from './channel-manager.js';
const channels = initializeChannels(channelOpts);
```

**Residual in router.ts:** Remove `findChannel` (upstream may not have it anyway).

**Merge surface reduction:** index.ts diff shrinks by ~28 lines, router.ts by ~6 lines.

---

### 1.3 Extract IPC callback wiring from main()

**Current:** `src/index.ts` lines ~574-598 — builds `IpcDeps` object with closures over `findChannel`, channel methods, registered groups.

**Target:** Move to `src/ipc.ts` as a factory function:
```typescript
export function createIpcDeps(channels: Channel[], getGroups: () => Map<string, RegisteredGroup>): IpcDeps {
  return {
    sendMessage: async (jid, text) => { findChannel(channels, jid)?.sendMessage(jid, text); },
    sendImage: async (jid, image, caption) => { findChannel(channels, jid)?.sendImage?.(jid, image, caption); },
    sendDocument: async (jid, doc, filename, caption) => { findChannel(channels, jid)?.sendDocument?.(jid, doc, filename, caption); },
    // ... other deps
  };
}
```

**Residual in index.ts:** ~2 lines:
```typescript
const ipcDeps = createIpcDeps(channels, () => registeredGroups);
startIpcWatcher(ipcDeps);
```

**Merge surface reduction:** index.ts diff shrinks by ~24 lines.

---

### 1.4 Extract image description parsing

**Current:** `src/index.ts` lines ~212-228 — in the `onOutput` callback inside `processGroupMessages`, parses `<image-description>` XML tags from agent output and calls `updateMessageContent()`.

**Target:** Add to `src/media-processing.ts`:
```typescript
export function applyImageDescriptions(
  missedMessages: NewMessage[],
  agentOutput: string,
  chatJid: string,
): void {
  for (const m of missedMessages) {
    if (!m.image_data) continue;
    const pattern = new RegExp(`<image-description[^>]*message-id="${escapeRegex(m.id)}"[^>]*>([\\s\\S]*?)</image-description>`);
    const match = agentOutput.match(pattern);
    if (match) {
      const enriched = buildImageDescription(m.content, match[1].trim());
      updateMessageContent(m.id, chatJid, enriched);
    }
  }
}
```

**Residual in index.ts:** ~2 lines:
```typescript
applyImageDescriptions(missedMessages, text, chatJid);
```

**Merge surface reduction:** index.ts diff shrinks by ~16 lines.

---

## Phase 2: Medium-Risk Extractions

These touch more interconnected code. Do them after Phase 1 is stable.

### 2.1 Extract image lifecycle from processGroupMessages

**Current:** `src/index.ts` has image handling woven throughout `processGroupMessages()`:
- Line ~165-171: attach pending image data to messages from transient store
- Line ~174: call `writeImageFiles()`
- Line ~252-254: call `cleanupImageFiles()`

And in `startMessageLoop()`:
- Lines ~419-449: image piping state machine (pipe to active container vs. new container, conditional write, cleanup)

**Target:** New file `src/image-handler.ts`:
```typescript
// Manages the pendingImages transient store
export class ImageHandler {
  private pendingImages = new Map<string, ImageBlock>();

  /** Store image data for later attachment */
  storeImage(messageId: string, image: ImageBlock): void;

  /** Attach stored images to messages before processing */
  attachToMessages(messages: NewMessage[]): void;

  /** Write image files to IPC for container access, return refs */
  prepareForContainer(groupFolder: string, messages: NewMessage[]): ImageRef[];

  /** Clean up image files after container exits */
  cleanup(groupFolder: string, refs: ImageRef[]): void;

  /** Handle image piping to active container */
  tryPipeToActiveContainer(
    queue: GroupQueue,
    group: RegisteredGroup,
    messages: NewMessage[],
    chatJid: string,
  ): { piped: boolean; imageRefs: ImageRef[] };
}
```

**Residual in index.ts:** ~10 lines total:
```typescript
const imageHandler = new ImageHandler();
// In message callback:
if (imageData) imageHandler.storeImage(msg.id, imageData);
// In processGroupMessages:
imageHandler.attachToMessages(messagesToSend);
const imageRefs = imageHandler.prepareForContainer(group.folder, messagesToSend);
// After container exits:
imageHandler.cleanup(group.folder, imageRefs);
```

**Merge surface reduction:** index.ts diff shrinks by ~70 lines (the single biggest win).

---

### 2.2 Split IPC message-type handlers

**Current:** `src/ipc.ts` lines ~76-156 — inline switch cases for `message`, `send_image`, `send_document` with repeated auth pattern.

**Target:** Extract in same file (no new file needed):
```typescript
function canAccessJid(sourceGroup: string, targetFolder: string | undefined, isMain: boolean): boolean {
  return isMain || (!!targetFolder && targetFolder === sourceGroup);
}

async function handleIpcMessage(data: any, sourceGroup: string, isMain: boolean, deps: IpcDeps): Promise<void> { ... }
async function handleIpcImage(data: any, sourceGroup: string, isMain: boolean, deps: IpcDeps): Promise<void> { ... }
async function handleIpcDocument(data: any, sourceGroup: string, isMain: boolean, deps: IpcDeps): Promise<void> { ... }
```

**Benefit:** Each handler is independently testable. Adding new IPC types (e.g., `send_audio`) follows a clear pattern.

**Merge surface reduction:** Minimal for upstream compat, but improves maintainability.

---

### 2.3 Extract container directory setup

**Current:** `container-runner.ts` lines ~104-163 — session directory creation, settings.json writing, skills sync, IPC namespace setup.

**Target:** Extract to functions in the same file:
```typescript
function setupSessionDirectory(groupFolder: string): string { ... }
function syncSkillsToGroup(sessionDir: string): void { ... }
function setupGroupIpcNamespace(groupFolder: string): string { ... }
```

**Benefit:** `buildVolumeMounts()` becomes a clear orchestrator calling these helpers. Easier to modify one concern without touching others.

---

## Phase 3: Skill Alignment

These align the codebase with upstream's skill architecture for future compatibility.

### 3.1 Update add-slack skill modify/ files

The `.claude/skills/add-slack/` skill has `modify/` files that may be stale (they were authored against an older version of the core files). After Phase 1 and 2 extractions, regenerate:
- `.claude/skills/add-slack/modify/src/index.ts` — should only contain the minimal channel-manager import
- `.claude/skills/add-slack/modify/src/config.ts` — Slack env vars

Also update the manifest to reference `src/channel-manager.ts` as an `adds` file.

### 3.2 Create add-image-support skill structure

Package image handling as a skill for documentation/tracking purposes:
```
.claude/skills/add-image-support/
  SKILL.md
  manifest.yaml
  add/
    src/image-handler.ts
    src/media-processing.ts        # already exists
  modify/
    src/index.ts                   # minimal hooks only
    src/index.ts.intent.md
    src/types.ts                   # ImageBlock, sendImage, sendDocument
    src/types.ts.intent.md
    src/channels/whatsapp.ts       # image detection + sendImage/sendDocument
    src/channels/whatsapp.ts.intent.md
    src/db.ts                      # updateMessageContent
    src/db.ts.intent.md
    src/router.ts                  # has-image attribute
    src/router.ts.intent.md
    src/group-queue.ts             # images param in sendMessage
    src/group-queue.ts.intent.md
    src/ipc.ts                     # send_image, send_document handlers
    src/ipc.ts.intent.md
  tests/
    image-handling.test.ts
```

Manifest:
```yaml
skill: image-support
version: 1.0.0
description: "Image receiving, processing, and sending for WhatsApp"
core_version: 0.1.0
adds:
  - src/image-handler.ts
  - src/media-processing.ts
modifies:
  - src/index.ts
  - src/types.ts
  - src/channels/whatsapp.ts
  - src/db.ts
  - src/router.ts
  - src/group-queue.ts
  - src/ipc.ts
structured:
  npm_dependencies: {}
  env_additions: []
conflicts: []
depends: []
test: "npx vitest run src/media-processing.test.ts"
```

### 3.3 Create add-voice-transcription skill alignment

The existing `.claude/skills/add-voice-transcription/` skill already follows the pattern. Verify its `modify/` files are up to date after the image handling extraction.

---

## Execution Order

```
Phase 1 (independent, do in any order):
  1.1 Secrets to config         ← trivial, do first as warmup
  1.2 Channel manager           ← reduces index.ts by ~34 lines
  1.3 IPC deps factory          ← reduces index.ts by ~24 lines
  1.4 Image description parsing ← reduces index.ts by ~16 lines

Phase 2 (after Phase 1):
  2.1 Image handler class       ← reduces index.ts by ~70 lines (biggest win)
  2.2 IPC handler split         ← improves extensibility
  2.3 Container setup helpers   ← improves readability

Phase 3 (after Phase 2):
  3.1 Update add-slack skill    ← sync with new structure
  3.2 Create image-support skill ← document the integration
  3.3 Verify voice-transcription ← ensure compatibility
```

## Expected Result

After all phases, `src/index.ts` custom code drops from ~154 lines to ~20 lines of imports and hook calls. The remaining core-file modifications are:
- `src/types.ts`: `ImageBlock` interface + optional channel methods (~13 lines, unlikely to conflict)
- `src/config.ts`: env var declarations (~14 lines, additive only)
- `src/router.ts`: `has-image` attribute (~2 lines)
- `src/db.ts`: `updateMessageContent()` (~8 lines, additive only)

All business logic lives in new files (`channel-manager.ts`, `image-handler.ts`, `media-processing.ts`, `channels/slack.ts`) that upstream doesn't touch.
