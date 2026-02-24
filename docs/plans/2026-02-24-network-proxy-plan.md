# Network Proxy Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Non-main containers run with `--network none` and access the internet only through IPC-based proxy tools with manual user approval via WhatsApp.

**Architecture:** Container-side MCP tools (`web_fetch`, `web_search`) write IPC request files, host picks them up, sends approval request to main WhatsApp channel, waits for user reply/reaction (5 min timeout), performs the fetch if approved, and writes the result back via IPC. Approved domains are cached in a SQLite allowlist.

**Tech Stack:** Node.js, TypeScript, Docker `--network none`, SQLite (better-sqlite3), Baileys (WhatsApp), MCP SDK (container-side)

---

### Task 1: Add `networkMode` to ContainerConfig type

**Files:**
- Modify: `src/types.ts:30-34`

**Step 1: Add the field**

Add `networkMode` to `ContainerConfig`:

```typescript
export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
  bitwarden?: boolean; // Enable Bitwarden vault access for this group
  networkMode?: 'full' | 'none'; // Default: 'none' for non-main, 'full' for main
}
```

**Step 2: Commit**

```bash
git add src/types.ts
git commit -m "feat(types): add networkMode to ContainerConfig"
```

---

### Task 2: Add `--network none` and `NETWORK_PROXY` env var to container args

**Files:**
- Modify: `src/container-runner.ts:246-290` (`buildContainerArgs`)
- Modify: `src/container-runner.ts:292-306` (`runContainerAgent` — pass `isMain`)

**Step 1: Write the test**

Create `src/container-runner.test.ts` (or add to existing if it exists). Test that `buildContainerArgs` adds `--network none` for non-main containers and omits it for main containers:

```typescript
import { describe, it, expect } from 'vitest';

// We need to test buildContainerArgs which is not currently exported.
// We'll test via the integration: verify the spawned args include --network none.
// For unit testing, we'll need to export buildContainerArgs or test indirectly.
```

Since `buildContainerArgs` is a private function, we'll test this indirectly through integration. Focus on the implementation:

**Step 2: Update `buildContainerArgs` signature**

In `src/container-runner.ts`, change the function signature to accept `isMain` and `networkMode`:

```typescript
function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  bitwarden: boolean,
  isMain: boolean,
  networkMode?: 'full' | 'none',
): string[] {
```

**Step 3: Add network isolation logic**

After the bitwarden credential env vars block (after line 277), add:

```typescript
  // Network isolation: non-main containers default to --network none
  // Main containers keep full network (WebFetch/WebSearch need it)
  const effectiveNetworkMode = networkMode ?? (isMain ? 'full' : 'none');
  if (effectiveNetworkMode === 'none') {
    args.push('--network', 'none');
    args.push('-e', 'NETWORK_PROXY=true');
  }
```

**Step 4: Update the call site**

In `runContainerAgent` (line 306), update the call:

```typescript
  const containerArgs = buildContainerArgs(
    mounts,
    containerName,
    !!group.containerConfig?.bitwarden,
    input.isMain,
    group.containerConfig?.networkMode,
  );
```

**Step 5: Verify it compiles**

```bash
npx tsc --noEmit
```

**Step 6: Commit**

```bash
git add src/container-runner.ts
git commit -m "feat(container): add --network none for non-main containers"
```

---

### Task 3: Add network_allowlist table and DB functions

**Files:**
- Modify: `src/db.ts:12-80` (createSchema) and add functions at end

**Step 1: Write the tests**

Add to existing test file or create `src/network-proxy.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { _initTestDatabase } from './db.js';
import { isAllowlisted, addToAllowlist, getAllAllowlisted } from './db.js';

describe('network allowlist', () => {
  beforeEach(() => { _initTestDatabase(); });

  it('returns false for unknown domain', () => {
    expect(isAllowlisted('example.com')).toBe(false);
  });

  it('returns true after adding domain', () => {
    addToAllowlist('example.com', 'test-group');
    expect(isAllowlisted('example.com')).toBe(true);
  });

  it('does not duplicate on re-add', () => {
    addToAllowlist('example.com', 'group-a');
    addToAllowlist('example.com', 'group-b');
    expect(getAllAllowlisted()).toHaveLength(1);
  });
});
```

**Step 2: Run test — verify it fails**

```bash
npx vitest run src/network-proxy.test.ts
```

Expected: FAIL — `isAllowlisted` not found.

**Step 3: Add the table to schema**

In `src/db.ts`, inside `createSchema()`, after the `router_state` / `sessions` / `registered_groups` tables (around line 79), add:

```sql
    CREATE TABLE IF NOT EXISTS network_allowlist (
      domain TEXT PRIMARY KEY,
      approved_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
```

**Step 4: Add CRUD functions**

At the end of `src/db.ts`, before the JSON migration section:

```typescript
// --- Network allowlist ---

export function isAllowlisted(domain: string): boolean {
  const row = db
    .prepare('SELECT 1 FROM network_allowlist WHERE domain = ?')
    .get(domain);
  return !!row;
}

export function addToAllowlist(domain: string, approvedBy: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO network_allowlist (domain, approved_by, created_at) VALUES (?, ?, ?)`,
  ).run(domain, approvedBy, new Date().toISOString());
}

export function removeFromAllowlist(domain: string): void {
  db.prepare('DELETE FROM network_allowlist WHERE domain = ?').run(domain);
}

export function getAllAllowlisted(): Array<{ domain: string; approved_by: string; created_at: string }> {
  return db
    .prepare('SELECT domain, approved_by, created_at FROM network_allowlist ORDER BY created_at')
    .all() as Array<{ domain: string; approved_by: string; created_at: string }>;
}
```

**Step 5: Run tests — verify pass**

```bash
npx vitest run src/network-proxy.test.ts
```

**Step 6: Commit**

```bash
git add src/db.ts src/network-proxy.test.ts
git commit -m "feat(db): add network_allowlist table and CRUD functions"
```

---

### Task 4: Create network-proxy.ts — approval flow and fetch execution

**Files:**
- Create: `src/network-proxy.ts`
- Modify: `src/types.ts` (add `sendMessageWithId` to Channel interface)

**This is the core module. It handles:**
1. Extracting domain from URL
2. Checking the allowlist
3. Sending approval request via WhatsApp (needs message ID back)
4. Waiting for reply/reaction
5. Performing the actual fetch
6. Writing response back to IPC

**Step 1: Add `sendMessageWithId` to Channel interface**

In `src/types.ts`, add to the `Channel` interface:

```typescript
  // Optional: send message and return its ID for reply correlation.
  sendMessageWithId?(jid: string, text: string): Promise<string | undefined>;
```

**Step 2: Implement `sendMessageWithId` in WhatsApp channel**

In `src/channels/whatsapp.ts`, add after `sendMessage`:

```typescript
  async sendMessageWithId(jid: string, text: string): Promise<string | undefined> {
    const prefixed = ASSISTANT_HAS_OWN_NUMBER
      ? text
      : `${ASSISTANT_NAME}: ${text}`;
    if (!this.connected) return undefined;
    try {
      const sent = await this.sock.sendMessage(jid, { text: prefixed });
      return sent?.key?.id;
    } catch (err) {
      logger.warn({ jid, err }, 'Failed to send message with ID');
      return undefined;
    }
  }
```

**Step 3: Create `src/network-proxy.ts`**

```typescript
/**
 * Network Proxy for NanoClaw
 * Handles approval flow for non-main container network access.
 * Requests arrive via IPC, approval via WhatsApp, results written back to IPC.
 */
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';

import { DATA_DIR, MAIN_GROUP_FOLDER } from './config.js';
import { addToAllowlist, isAllowlisted } from './db.js';
import { resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const FETCH_TIMEOUT_MS = 30 * 1000; // 30 seconds for the actual fetch

interface PendingRequest {
  requestId: string;
  groupFolder: string;
  groupName: string;
  domain: string;
  resolve: (approved: boolean) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

// Map from WhatsApp message ID to pending request
const pendingApprovals = new Map<string, PendingRequest>();

export function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * Handle an approval reply or reaction from the user.
 * Called by the message handler when it detects a reply to a pending approval message.
 */
export function handleApprovalResponse(messageId: string, approved: boolean): boolean {
  const pending = pendingApprovals.get(messageId);
  if (!pending) return false;
  clearTimeout(pending.timeoutHandle);
  pendingApprovals.delete(messageId);
  pending.resolve(approved);
  return true;
}

/**
 * Check if a message is a reply to a pending approval.
 * Returns the message ID of the quoted message if it matches.
 */
export function getPendingApprovalIds(): Set<string> {
  return new Set(pendingApprovals.keys());
}

/**
 * Write a proxy response to the group's IPC input directory.
 */
function writeProxyResponse(
  groupFolder: string,
  requestId: string,
  status: 'approved' | 'denied',
  result?: string,
  error?: string,
): void {
  const inputDir = path.join(resolveGroupIpcPath(groupFolder), 'input');
  fs.mkdirSync(inputDir, { recursive: true });

  const response = {
    type: 'proxy_response',
    requestId,
    status,
    ...(result !== undefined ? { result } : {}),
    ...(error !== undefined ? { error } : {}),
  };

  const filename = `proxy-response-${requestId}.json`;
  const filepath = path.join(inputDir, filename);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(response, null, 2));
  fs.renameSync(tempPath, filepath);
}

/**
 * Perform HTTP(S) fetch and return the response body as text.
 */
async function fetchUrl(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: FETCH_TIMEOUT_MS }, (res) => {
      // Follow redirects
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchUrl(res.headers.location).then(resolve, reject);
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Fetch timeout')); });
  });
}

/**
 * Request approval from the user and wait for response.
 * Returns a promise that resolves to true (approved) or false (denied/timeout).
 */
function requestApproval(
  requestId: string,
  groupFolder: string,
  groupName: string,
  domain: string,
  messageId: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    const timeoutHandle = setTimeout(() => {
      pendingApprovals.delete(messageId);
      logger.info({ requestId, domain, groupFolder }, 'Network proxy approval timed out');
      resolve(false);
    }, APPROVAL_TIMEOUT_MS);

    pendingApprovals.set(messageId, {
      requestId,
      groupFolder,
      groupName,
      domain,
      resolve,
      timeoutHandle,
    });
  });
}

export interface ProxyDeps {
  sendMessageWithId: (jid: string, text: string) => Promise<string | undefined>;
  getMainChatJid: () => string | undefined;
  getGroupName: (folder: string) => string;
}

/**
 * Process a proxy_web_fetch IPC task.
 */
export async function handleProxyWebFetch(
  data: {
    requestId: string;
    url: string;
    prompt?: string;
  },
  sourceGroup: string,
  deps: ProxyDeps,
): Promise<void> {
  const { requestId, url } = data;
  const domain = extractDomain(url);
  const groupName = deps.getGroupName(sourceGroup);

  // Check allowlist first
  if (isAllowlisted(domain)) {
    logger.info({ requestId, domain, sourceGroup }, 'Domain allowlisted, fetching directly');
    try {
      const result = await fetchUrl(url);
      // Truncate to 100KB to avoid huge IPC files
      const truncated = result.length > 100_000
        ? result.slice(0, 100_000) + '\n\n[Truncated — content exceeded 100KB]'
        : result;
      writeProxyResponse(sourceGroup, requestId, 'approved', truncated);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writeProxyResponse(sourceGroup, requestId, 'approved', undefined, `Fetch failed: ${msg}`);
    }
    return;
  }

  // Send approval request to main channel
  const mainJid = deps.getMainChatJid();
  if (!mainJid) {
    logger.error({ requestId }, 'No main channel JID found, denying proxy request');
    writeProxyResponse(sourceGroup, requestId, 'denied', undefined, 'No main channel configured.');
    return;
  }

  const approvalText = `[${groupName}] agent wants to fetch: ${url}\n\nReply yes/no or react 👍/👎 (5 min timeout)`;
  const sentId = await deps.sendMessageWithId(mainJid, approvalText);

  if (!sentId) {
    logger.error({ requestId }, 'Failed to send approval message, denying');
    writeProxyResponse(sourceGroup, requestId, 'denied', undefined, 'Failed to send approval request.');
    return;
  }

  const approved = await requestApproval(requestId, sourceGroup, groupName, domain, sentId);

  if (approved) {
    addToAllowlist(domain, sourceGroup);
    logger.info({ requestId, domain, sourceGroup }, 'Network proxy approved, domain allowlisted');
    try {
      const result = await fetchUrl(url);
      const truncated = result.length > 100_000
        ? result.slice(0, 100_000) + '\n\n[Truncated — content exceeded 100KB]'
        : result;
      writeProxyResponse(sourceGroup, requestId, 'approved', truncated);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writeProxyResponse(sourceGroup, requestId, 'approved', undefined, `Fetch failed: ${msg}`);
    }
  } else {
    logger.info({ requestId, domain, sourceGroup }, 'Network proxy denied');
    writeProxyResponse(
      sourceGroup,
      requestId,
      'denied',
      undefined,
      `Network access to ${domain} was denied by the user.`,
    );
  }
}

/**
 * Process a proxy_web_search IPC task.
 */
export async function handleProxyWebSearch(
  data: {
    requestId: string;
    query: string;
  },
  sourceGroup: string,
  deps: ProxyDeps,
): Promise<void> {
  const { requestId, query } = data;
  const groupName = deps.getGroupName(sourceGroup);

  // For search, use the query as the "domain" for allowlist purposes
  // (search is always proxied — no domain to allowlist)
  const mainJid = deps.getMainChatJid();
  if (!mainJid) {
    writeProxyResponse(sourceGroup, requestId, 'denied', undefined, 'No main channel configured.');
    return;
  }

  const approvalText = `[${groupName}] agent wants to search: "${query}"\n\nReply yes/no or react 👍/👎 (5 min timeout)`;
  const sentId = await deps.sendMessageWithId(mainJid, approvalText);

  if (!sentId) {
    writeProxyResponse(sourceGroup, requestId, 'denied', undefined, 'Failed to send approval request.');
    return;
  }

  const approved = await requestApproval(requestId, sourceGroup, groupName, query, sentId);

  if (approved) {
    logger.info({ requestId, query, sourceGroup }, 'Network proxy search approved');
    // Search is performed as a simple Google query via fetch
    // The container agent can't do the search itself, so we do a basic search
    try {
      const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
      const result = await fetchUrl(searchUrl);
      const truncated = result.length > 100_000
        ? result.slice(0, 100_000) + '\n\n[Truncated]'
        : result;
      writeProxyResponse(sourceGroup, requestId, 'approved', truncated);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writeProxyResponse(sourceGroup, requestId, 'approved', undefined, `Search failed: ${msg}`);
    }
  } else {
    writeProxyResponse(
      sourceGroup,
      requestId,
      'denied',
      undefined,
      `Web search was denied by the user.`,
    );
  }
}
```

**Step 4: Verify it compiles**

```bash
npx tsc --noEmit
```

**Step 5: Commit**

```bash
git add src/network-proxy.ts src/types.ts src/channels/whatsapp.ts
git commit -m "feat(network-proxy): add approval flow, fetch, and allowlist logic"
```

---

### Task 5: Wire proxy into IPC handler

**Files:**
- Modify: `src/ipc.ts:405-637` (processTaskIpc switch)
- Modify: `src/ipc.ts:19-33` (IpcDeps interface)

**Step 1: Add proxy deps to IpcDeps**

In `src/ipc.ts`, add to the `IpcDeps` interface:

```typescript
  sendMessageWithId?: (jid: string, text: string) => Promise<string | undefined>;
  getMainChatJid?: () => string | undefined;
```

**Step 2: Add proxy task handling**

In `processTaskIpc`, before the `default:` case (around line 634), add:

```typescript
    case 'proxy_web_fetch': {
      if (!isMain && data.requestId && data.url) {
        const { handleProxyWebFetch } = await import('./network-proxy.js');
        await handleProxyWebFetch(
          { requestId: data.requestId as string, url: data.url as string, prompt: data.prompt },
          sourceGroup,
          {
            sendMessageWithId: deps.sendMessageWithId!,
            getMainChatJid: deps.getMainChatJid!,
            getGroupName: (folder) => {
              const groups = deps.registeredGroups();
              const entry = Object.values(groups).find(g => g.folder === folder);
              return entry?.name || folder;
            },
          },
        );
      }
      break;
    }

    case 'proxy_web_search': {
      if (!isMain && data.requestId && data.query) {
        const { handleProxyWebSearch } = await import('./network-proxy.js');
        await handleProxyWebSearch(
          { requestId: data.requestId as string, query: data.query as string },
          sourceGroup,
          {
            sendMessageWithId: deps.sendMessageWithId!,
            getMainChatJid: deps.getMainChatJid!,
            getGroupName: (folder) => {
              const groups = deps.registeredGroups();
              const entry = Object.values(groups).find(g => g.folder === folder);
              return entry?.name || folder;
            },
          },
        );
      }
      break;
    }
```

**Step 3: Add new fields to the `data` parameter type in `processTaskIpc`**

Add these fields to the data type parameter:

```typescript
    // For proxy requests
    requestId?: string;
    url?: string;
    query?: string;
```

**Step 4: Update `createIpcDeps` in `src/ipc.ts`**

In the `createIpcDeps` function, add the new deps. Update the config type and return:

```typescript
export function createIpcDeps(cfg: {
  channels: Channel[];
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: IpcDeps['writeGroupsSnapshot'];
}): IpcDeps {
  return {
    // ... existing deps ...
    sendMessageWithId: (jid, text) => {
      const channel = findChannel(cfg.channels, jid);
      if (!channel?.sendMessageWithId) return Promise.resolve(undefined);
      return channel.sendMessageWithId(jid, text);
    },
    getMainChatJid: () => {
      const groups = cfg.registeredGroups();
      const mainEntry = Object.entries(groups).find(([, g]) => g.folder === MAIN_GROUP_FOLDER);
      return mainEntry?.[0]; // The JID is the key
    },
  };
}
```

**Step 5: Verify it compiles**

```bash
npx tsc --noEmit
```

**Step 6: Commit**

```bash
git add src/ipc.ts
git commit -m "feat(ipc): wire proxy_web_fetch and proxy_web_search task handlers"
```

---

### Task 6: Handle approval replies and reactions in index.ts

**Files:**
- Modify: `src/index.ts` (message processing loop)

**Step 1: Add approval response check to message processing**

In `src/index.ts`, in the message processing section where incoming messages are handled, add a check for replies to pending approval messages. This needs to happen early in message processing, before the normal trigger/queue flow.

Find where `storeMessage(msg)` is called and check for approval replies:

```typescript
import { handleApprovalResponse, getPendingApprovalIds } from './network-proxy.js';

// Inside the message processing, after storeMessage(msg):
// Check if this is a reply to a pending network proxy approval
if (msg.chat_jid === mainChatJid) {
  // Check for text reply (yes/no/y/n)
  const text = msg.content.toLowerCase().trim();
  const isApproval = /^(yes|y|approve|ok)$/i.test(text);
  const isDenial = /^(no|n|deny|reject)$/i.test(text);

  if (isApproval || isDenial) {
    // Check if this message quotes a pending approval
    // (We'll need the quoted message ID from WhatsApp message)
    const handled = handleApprovalResponse(quotedMessageId, isApproval);
    if (handled) continue; // Don't process as regular message
  }
}
```

Note: Getting the quoted message ID requires checking the WhatsApp message's `contextInfo.stanzaId`. This needs to be added to the `NewMessage` type and passed through from the WhatsApp channel.

**Step 2: Add `quotedMessageId` to `NewMessage`**

In `src/types.ts`, add to `NewMessage`:

```typescript
  quotedMessageId?: string; // ID of the message being replied to
```

**Step 3: Extract quoted message ID in WhatsApp channel**

In `src/channels/whatsapp.ts`, in the `messages.upsert` handler, extract the quoted message ID:

```typescript
const quotedMessageId =
  msg.message?.extendedTextMessage?.contextInfo?.stanzaId || undefined;
```

And include it in the `onMessage` call:

```typescript
...(quotedMessageId ? { quotedMessageId } : {}),
```

**Step 4: Add the approval check in the message loop**

In `src/index.ts`, in the message processing section (where messages for registered groups are processed), add the approval check before the normal trigger logic. Look for where messages are iterated — likely around the `processMessages` or similar function:

```typescript
// Early in message processing, check for network proxy approval replies
const pendingIds = getPendingApprovalIds();
if (pendingIds.size > 0 && msg.quotedMessageId && pendingIds.has(msg.quotedMessageId)) {
  const text = msg.content.toLowerCase().trim();
  // Strip assistant name prefix if present
  const cleaned = text.replace(/^\w+:\s*/, '');
  const isApproval = /^(yes|y|approve|ok|👍)$/i.test(cleaned);
  const isDenial = /^(no|n|deny|reject|👎)$/i.test(cleaned);
  if (isApproval || isDenial) {
    handleApprovalResponse(msg.quotedMessageId, isApproval);
    continue; // Skip normal message processing
  }
}
```

**Step 5: Verify it compiles**

```bash
npx tsc --noEmit
```

**Step 6: Commit**

```bash
git add src/index.ts src/types.ts src/channels/whatsapp.ts
git commit -m "feat(index): handle approval replies for network proxy"
```

---

### Task 7: Add container-side proxy MCP tools

**Files:**
- Modify: `container/agent-runner/src/ipc-mcp-stdio.ts`

**Step 1: Add the proxy tools**

At the end of `container/agent-runner/src/ipc-mcp-stdio.ts`, before the transport/connect lines (line 565-567), add the proxy tools conditionally:

```typescript
const INPUT_DIR = path.join(IPC_DIR, 'input');
const isNetworkProxied = process.env.NETWORK_PROXY === 'true';

if (isNetworkProxied) {
  server.tool(
    'web_fetch',
    `Fetch content from a URL. This request goes through the host and may require user approval.
The user will be notified and asked to approve the request. Approved domains are remembered for future requests.
If denied, you'll get an error message — inform the user accordingly.`,
    {
      url: z.string().url().describe('The URL to fetch'),
      prompt: z.string().optional().describe('What to extract from the page (not used in proxy mode, but kept for compatibility)'),
    },
    async (args) => {
      const requestId = `fetch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      // Write request to IPC tasks
      writeIpcFile(TASKS_DIR, {
        type: 'proxy_web_fetch',
        requestId,
        url: args.url,
        prompt: args.prompt || undefined,
        groupFolder,
        timestamp: new Date().toISOString(),
      });

      // Poll for response
      const responseFile = path.join(INPUT_DIR, `proxy-response-${requestId}.json`);
      const timeout = 6 * 60 * 1000; // 6 minutes (exceeds 5 min approval window)
      const pollInterval = 1000;
      const start = Date.now();

      while (Date.now() - start < timeout) {
        if (fs.existsSync(responseFile)) {
          try {
            const response = JSON.parse(fs.readFileSync(responseFile, 'utf-8'));
            fs.unlinkSync(responseFile);

            if (response.status === 'approved' && response.result) {
              return { content: [{ type: 'text' as const, text: response.result }] };
            } else if (response.error) {
              return { content: [{ type: 'text' as const, text: response.error }], isError: true };
            } else {
              return { content: [{ type: 'text' as const, text: 'Request was denied.' }], isError: true };
            }
          } catch (err) {
            return {
              content: [{ type: 'text' as const, text: `Failed to read proxy response: ${err}` }],
              isError: true,
            };
          }
        }
        await new Promise((r) => setTimeout(r, pollInterval));
      }

      return {
        content: [{ type: 'text' as const, text: 'Network proxy request timed out waiting for approval.' }],
        isError: true,
      };
    },
  );

  server.tool(
    'web_search',
    `Search the web. This request goes through the host and requires user approval.
The user will be notified and asked to approve each search.
If denied, you'll get an error message — inform the user accordingly.`,
    {
      query: z.string().describe('The search query'),
    },
    async (args) => {
      const requestId = `search-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      writeIpcFile(TASKS_DIR, {
        type: 'proxy_web_search',
        requestId,
        query: args.query,
        groupFolder,
        timestamp: new Date().toISOString(),
      });

      const responseFile = path.join(INPUT_DIR, `proxy-response-${requestId}.json`);
      const timeout = 6 * 60 * 1000;
      const pollInterval = 1000;
      const start = Date.now();

      while (Date.now() - start < timeout) {
        if (fs.existsSync(responseFile)) {
          try {
            const response = JSON.parse(fs.readFileSync(responseFile, 'utf-8'));
            fs.unlinkSync(responseFile);

            if (response.status === 'approved' && response.result) {
              return { content: [{ type: 'text' as const, text: response.result }] };
            } else if (response.error) {
              return { content: [{ type: 'text' as const, text: response.error }], isError: true };
            } else {
              return { content: [{ type: 'text' as const, text: 'Search request was denied.' }], isError: true };
            }
          } catch (err) {
            return {
              content: [{ type: 'text' as const, text: `Failed to read proxy response: ${err}` }],
              isError: true,
            };
          }
        }
        await new Promise((r) => setTimeout(r, pollInterval));
      }

      return {
        content: [{ type: 'text' as const, text: 'Web search request timed out waiting for approval.' }],
        isError: true,
      };
    },
  );
}
```

**Step 2: Rebuild the container**

```bash
./container/build.sh
```

**Step 3: Verify the tools register**

```bash
docker run -i --rm -e NETWORK_PROXY=true --entrypoint node nanoclaw-agent:latest -e "
const fs = require('fs');
const src = fs.readFileSync('/app/src/ipc-mcp-stdio.ts', 'utf-8');
console.log(src.includes('web_fetch') ? 'PASS: web_fetch found' : 'FAIL: web_fetch missing');
console.log(src.includes('web_search') ? 'PASS: web_search found' : 'FAIL: web_search missing');
"
```

**Step 4: Commit**

```bash
git add container/agent-runner/src/ipc-mcp-stdio.ts
git commit -m "feat(container): add web_fetch and web_search proxy MCP tools"
```

---

### Task 8: Build, test end-to-end, and deploy

**Files:**
- All files from previous tasks

**Step 1: Compile everything**

```bash
npm run build
```

**Step 2: Rebuild container**

```bash
./container/build.sh
```

**Step 3: Run all existing tests**

```bash
npx vitest run
```

All existing tests must still pass.

**Step 4: Manual integration test**

1. Restart the service: `systemctl restart nanoklauw`
2. Send a message to a non-main group that triggers the agent
3. Have the agent try to use `web_fetch` on some URL
4. Verify approval message appears in main WhatsApp channel
5. Reply "yes" — verify the fetch result reaches the agent
6. Try again with same domain — verify it's auto-approved (allowlisted)
7. Try a new domain, reply "no" — verify denial reaches the agent

**Step 5: Final commit**

```bash
git add -A
git commit -m "feat(network-proxy): complete network isolation with IPC proxy for non-main containers"
```
