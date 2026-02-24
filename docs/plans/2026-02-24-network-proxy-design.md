# Network Proxy for Non-Main Containers

## Problem

All containers currently have unrestricted network access. A prompt-injected non-main agent can exfiltrate mounted filesystem data, API credentials, or conversation context to external servers.

## Solution

Non-main containers run with `--network none` (kernel-level network isolation). When an agent needs internet access, it uses IPC-based proxy tools that route through the host with manual user approval via WhatsApp. Approved domains are allowlisted for future requests.

## Design

### 1. Network Isolation

- Add `--network none` to Docker args for non-main containers in `buildContainerArgs()` (`src/container-runner.ts`)
- Add `networkMode?: 'full' | 'none'` to `ContainerConfig` in `src/types.ts` for per-group override
- Main container unchanged (keeps full network for WebFetch/WebSearch)
- Pass `NETWORK_PROXY=true` env var to non-main containers so the agent-runner knows to register proxy tools

### 2. Container-Side Proxy Tools

In `container/agent-runner/src/ipc-mcp-stdio.ts`, register two MCP tools when `NETWORK_PROXY=true`:

- **`web_fetch`** — params: `url`, `prompt`. Writes request JSON to `/workspace/ipc/tasks/`, polls `/workspace/ipc/input/` for response.
- **`web_search`** — params: `query`. Same IPC pattern.

Request format:
```json
{
  "type": "proxy_web_fetch",
  "requestId": "unique-id",
  "url": "https://example.com/page",
  "prompt": "extract the main content",
  "timestamp": "ISO-8601"
}
```

Tools poll for a response file named `proxy-response-{requestId}.json` in the input directory. Timeout: 6 minutes (exceeds the 5-min approval window so the agent gets a proper denial rather than a generic timeout).

### 3. Host-Side Approval Flow

New task types in `src/ipc.ts`: `proxy_web_fetch` and `proxy_web_search`.

Flow:
1. Read request from group's `tasks/` directory
2. Extract domain from URL (or use query for search)
3. Check domain allowlist in SQLite — if allowed, skip to step 6
4. Send approval request to main WhatsApp channel: `"[GroupName] agent wants to fetch: https://example.com/path — Reply yes/no or react with thumbs up/down"`
5. Wait up to 5 minutes for reply or reaction on that message. Timeout = deny.
6. If approved: add domain to allowlist, perform fetch/search on host, write result to group's `ipc/input/proxy-response-{requestId}.json`
7. If denied: write denial response to same path

### 4. Domain Allowlist

New SQLite table `network_allowlist`:

| Column | Type | Purpose |
|--------|------|---------|
| domain | TEXT PRIMARY KEY | Allowed domain (e.g., `example.com`) |
| approved_by | TEXT | Group folder that triggered first approval |
| created_at | TEXT | ISO-8601 timestamp |

Global scope — once approved, any non-main group can access the domain without re-asking.

### 5. Approval Message Correlation

- Store pending requests in an in-memory `Map<whatsappMessageId, { resolve, reject, timeoutHandle, requestId, groupFolder }>`
- On incoming message/reaction to main channel: check if it references a pending request message ID
- Reply "yes"/"y" or reaction thumbs-up = approve
- Reply "no"/"n" or reaction thumbs-down = deny
- On timeout: auto-deny and clean up

### 6. Response Format

Written to `/workspace/ipc/input/proxy-response-{requestId}.json`:

Approved:
```json
{
  "type": "proxy_response",
  "requestId": "unique-id",
  "status": "approved",
  "result": "fetched content or search results"
}
```

Denied/timeout:
```json
{
  "type": "proxy_response",
  "requestId": "unique-id",
  "status": "denied",
  "error": "Network access to example.com was denied by the user."
}
```

## Files Changed

| File | Change |
|------|--------|
| `src/types.ts` | Add `networkMode` to `ContainerConfig` |
| `src/container-runner.ts` | Add `--network none` for non-main, pass `NETWORK_PROXY` env var |
| `src/ipc.ts` | Handle `proxy_web_fetch` and `proxy_web_search` task types |
| `src/db.ts` | Add `network_allowlist` table, CRUD functions |
| `src/network-proxy.ts` | New file: approval flow, fetch execution, allowlist checks |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | Add `web_fetch` and `web_search` proxy tools |

## Non-Goals

- No per-group allowlists (global is sufficient for now)
- No partial URL matching (domain-level only)
- No proxy for arbitrary Bash `curl`/`wget` (blocked by `--network none`, agent gets an error)
