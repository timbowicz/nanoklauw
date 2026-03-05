# Google Workspace Integration — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Google Workspace (Sheets, Drive, Docs, Gmail) to NanoClaw agents via the official `gws` CLI, replace the existing Gmail MCP, and package as an upstream-compatible skill.

**Architecture:** Install `gws` binary in the container image. Copy upstream gws SKILL.md files into `container/skills/` so agents auto-discover them. Mount OAuth credentials from `~/.gws/` on the host. Remove the existing Gmail MCP server and `~/.gmail-mcp` mount.

**Tech Stack:** `@googleworkspace/cli` (npm), OAuth 2.0, Claude Agent SDK skills auto-discovery

**Design doc:** `docs/plans/2026-03-05-google-workspace-design.md`

---

### Task 1: Install gws binary in container

**Files:**
- Modify: `container/Dockerfile:40`

**Step 1: Add gws to the global npm install line in the Dockerfile**

In `container/Dockerfile`, change line 40 from:

```dockerfile
RUN npm install -g agent-browser @anthropic-ai/claude-code @bitwarden/cli
```

to:

```dockerfile
RUN npm install -g agent-browser @anthropic-ai/claude-code @bitwarden/cli @googleworkspace/cli
```

**Step 2: Rebuild the container to verify installation**

```bash
cd /root/nanoklauw/container && ./build.sh
```

**Step 3: Verify gws is available in the container**

```bash
docker run --rm nanoclaw-agent:latest gws --version
```

Expected: version output (e.g., `gws 0.4.1`)

**Step 4: Commit**

```bash
git add container/Dockerfile
git commit -m "feat: install gws CLI in agent container"
```

---

### Task 2: Add gws agent skills

These are the SKILL.md files that teach agents how to use `gws`. They go in `container/skills/` and get auto-synced to each group's `.claude/skills/` at container startup.

**Files:**
- Create: `container/skills/gws-shared/SKILL.md`
- Create: `container/skills/gws-sheets/SKILL.md`
- Create: `container/skills/gws-drive/SKILL.md`
- Create: `container/skills/gws-docs/SKILL.md`
- Create: `container/skills/gws-gmail/SKILL.md`

**Step 1: Create the gws-shared skill**

Create `container/skills/gws-shared/SKILL.md`:

```markdown
---
name: gws-shared
description: "Google Workspace CLI: authentication, global flags, and output formatting. Read this before using any gws-* skill."
allowed-tools: Bash(gws:*)
---

# gws — Shared Reference

## Authentication

gws is pre-configured with OAuth credentials. Check availability:

```bash
gws auth status 2>&1 | grep -q "authenticated" && echo "READY" || echo "NOT AVAILABLE"
```

If not available, Google Workspace is not enabled for this installation. Do not attempt to authenticate manually.

## CLI Syntax

```bash
gws <service> <resource> [sub-resource] <method> [flags]
```

## Global Flags

| Flag | Description |
|------|-------------|
| `--format <FORMAT>` | Output format: `json` (default), `table`, `yaml`, `csv` |
| `--dry-run` | Validate locally without calling the API |

## Method Flags

| Flag | Description |
|------|-------------|
| `--params '{"key": "val"}'` | URL/query parameters |
| `--json '{"key": "val"}'` | Request body |
| `-o, --output <PATH>` | Save binary responses to file |
| `--upload <PATH>` | Upload file content (multipart) |
| `--page-all` | Auto-paginate (NDJSON output) |
| `--page-limit <N>` | Max pages (default: 10) |
| `--page-delay <MS>` | Delay between pages in ms (default: 100) |

## Discovery

```bash
gws <service> --help            # Browse resources and methods
gws schema <service>.<resource>.<method>  # Inspect parameters, types, defaults
```

## Security Rules

- Never output secrets (API keys, tokens) directly
- Always confirm with user before executing write/delete commands
- Prefer `--dry-run` for destructive operations
```

**Step 2: Create the gws-sheets skill**

Create `container/skills/gws-sheets/SKILL.md`:

```markdown
---
name: gws-sheets
description: "Read, write, create, and manage Google Sheets spreadsheets. Use for any spreadsheet task."
allowed-tools: Bash(gws:*)
---

# Google Sheets — gws sheets

Prerequisite: read the gws-shared skill for auth and CLI basics.

## Quick Start

```bash
# Read values from a spreadsheet
gws sheets +read --spreadsheet-id <ID> --range "Sheet1!A1:D10"

# Append rows to a spreadsheet
gws sheets +append --spreadsheet-id <ID> --range "Sheet1" --json '{"values": [["row1col1", "row1col2"]]}'

# Create a new spreadsheet
gws sheets spreadsheets create --json '{"properties": {"title": "My Sheet"}}'
```

## Helper Commands

| Command | Description |
|---------|-------------|
| `gws sheets +read` | Read values from a range |
| `gws sheets +append` | Append rows to a spreadsheet |

## API Resources

```bash
gws sheets --help              # Browse all resources
gws sheets spreadsheets --help # Spreadsheet operations
gws sheets values --help       # Cell value operations
```

### Common Operations

```bash
# Get spreadsheet metadata (sheets, properties)
gws sheets spreadsheets get --params '{"spreadsheetId": "<ID>"}'

# Read a range of values
gws sheets values get --params '{"spreadsheetId": "<ID>", "range": "Sheet1!A1:Z100"}'

# Write values to a range
gws sheets values update --params '{"spreadsheetId": "<ID>", "range": "Sheet1!A1", "valueInputOption": "USER_ENTERED"}' \
  --json '{"values": [["Name", "Score"], ["Alice", 95], ["Bob", 87]]}'

# Append rows
gws sheets values append --params '{"spreadsheetId": "<ID>", "range": "Sheet1", "valueInputOption": "USER_ENTERED"}' \
  --json '{"values": [["New Row", 42]]}'

# Batch update (multiple operations at once)
gws sheets spreadsheets batchUpdate --params '{"spreadsheetId": "<ID>"}' \
  --json '{"requests": [{"addSheet": {"properties": {"title": "NewTab"}}}]}'

# Clear a range
gws sheets values clear --params '{"spreadsheetId": "<ID>", "range": "Sheet1!A1:Z100"}'
```

## Finding Spreadsheet IDs

The spreadsheet ID is in the URL: `https://docs.google.com/spreadsheets/d/<SPREADSHEET_ID>/edit`

If the user gives you a URL, extract the ID from between `/d/` and `/edit`.

## Discovery

```bash
gws schema sheets.spreadsheets.values.update  # See required params for update
gws schema sheets.spreadsheets.batchUpdate     # See batch update request format
```
```

**Step 3: Create the gws-drive skill**

Create `container/skills/gws-drive/SKILL.md`:

```markdown
---
name: gws-drive
description: "List, search, upload, download, and manage Google Drive files and folders."
allowed-tools: Bash(gws:*)
---

# Google Drive — gws drive

Prerequisite: read the gws-shared skill for auth and CLI basics.

## Quick Start

```bash
# List recent files
gws drive files list

# Search for files
gws drive files list --params '{"q": "name contains '\''budget'\'' and mimeType = '\''application/vnd.google-apps.spreadsheet'\''"}'

# Upload a file
gws drive +upload --file /path/to/file.csv --name "My Data" --parent <FOLDER_ID>

# Download a file
gws drive files get --params '{"fileId": "<ID>", "alt": "media"}' -o downloaded.pdf
```

## Helper Commands

| Command | Description |
|---------|-------------|
| `gws drive +upload` | Upload a file with metadata |

## Common Operations

```bash
# List files (default: 10 results)
gws drive files list --params '{"pageSize": 25, "fields": "files(id,name,mimeType,modifiedTime)"}'

# Search by name
gws drive files list --params '{"q": "name = '\''Report.xlsx'\''"}'

# Search in a specific folder
gws drive files list --params '{"q": "'\''<FOLDER_ID>'\'' in parents"}'

# Get file metadata
gws drive files get --params '{"fileId": "<ID>", "fields": "id,name,mimeType,size,webViewLink"}'

# Create a folder
gws drive files create --json '{"name": "New Folder", "mimeType": "application/vnd.google-apps.folder"}'

# Move a file (update parents)
gws drive files update --params '{"fileId": "<ID>", "addParents": "<NEW_FOLDER_ID>", "removeParents": "<OLD_FOLDER_ID>"}'

# Delete a file
gws drive files delete --params '{"fileId": "<ID>"}'

# Export Google Doc as PDF
gws drive files export --params '{"fileId": "<ID>", "mimeType": "application/pdf"}' -o output.pdf

# Share a file
gws drive permissions create --params '{"fileId": "<ID>"}' \
  --json '{"role": "reader", "type": "user", "emailAddress": "user@example.com"}'
```

## MIME Types for Google Docs

| Google Type | MIME Type |
|-------------|-----------|
| Spreadsheet | `application/vnd.google-apps.spreadsheet` |
| Document | `application/vnd.google-apps.document` |
| Presentation | `application/vnd.google-apps.presentation` |
| Folder | `application/vnd.google-apps.folder` |

## Discovery

```bash
gws drive --help
gws schema drive.files.list
gws schema drive.files.create
```
```

**Step 4: Create the gws-docs skill**

Create `container/skills/gws-docs/SKILL.md`:

```markdown
---
name: gws-docs
description: "Create, read, and write Google Docs documents."
allowed-tools: Bash(gws:*)
---

# Google Docs — gws docs

Prerequisite: read the gws-shared skill for auth and CLI basics.

## Quick Start

```bash
# Create a new document
gws docs documents create --json '{"title": "Meeting Notes"}'

# Read a document
gws docs documents get --params '{"documentId": "<ID>"}'

# Append text to a document
gws docs +write --document-id <ID> --text "New paragraph content"
```

## Helper Commands

| Command | Description |
|---------|-------------|
| `gws docs +write` | Append text to a document |

## Common Operations

```bash
# Create a blank document
gws docs documents create --json '{"title": "My Document"}'

# Get document content
gws docs documents get --params '{"documentId": "<ID>"}'

# Batch update (insert text, formatting, etc.)
gws docs documents batchUpdate --params '{"documentId": "<ID>"}' \
  --json '{"requests": [{"insertText": {"location": {"index": 1}, "text": "Hello World\n"}}]}'
```

## Finding Document IDs

The document ID is in the URL: `https://docs.google.com/document/d/<DOCUMENT_ID>/edit`

## Discovery

```bash
gws docs --help
gws schema docs.documents.batchUpdate
```
```

**Step 5: Create the gws-gmail skill**

Create `container/skills/gws-gmail/SKILL.md`:

```markdown
---
name: gws-gmail
description: "Send, read, search, and manage Gmail messages, drafts, and labels."
allowed-tools: Bash(gws:*)
---

# Gmail — gws gmail

Prerequisite: read the gws-shared skill for auth and CLI basics.

## Quick Start

```bash
# Triage: show unread inbox summary
gws gmail +triage

# Send an email
gws gmail +send --to "user@example.com" --subject "Hello" --body "Message body"

# Search messages
gws gmail users messages list --params '{"userId": "me", "q": "from:someone@example.com is:unread"}'
```

## Helper Commands

| Command | Description |
|---------|-------------|
| `gws gmail +triage` | Show unread inbox summary |
| `gws gmail +send` | Send an email |
| `gws gmail +watch` | Monitor incoming emails (NDJSON) |

## Common Operations

```bash
# List messages (returns IDs, need separate get for content)
gws gmail users messages list --params '{"userId": "me", "maxResults": 10}'

# Search messages
gws gmail users messages list --params '{"userId": "me", "q": "subject:invoice after:2026/01/01"}'

# Get message content
gws gmail users messages get --params '{"userId": "me", "id": "<MSG_ID>", "format": "full"}'

# Send an email
gws gmail +send --to "recipient@example.com" --subject "Subject" --body "Body text"

# Create a draft
gws gmail users drafts create --params '{"userId": "me"}' \
  --json '{"message": {"raw": "<base64-encoded-email>"}}'

# List labels
gws gmail users labels list --params '{"userId": "me"}'

# Modify labels (mark read/archive)
gws gmail users messages modify --params '{"userId": "me", "id": "<MSG_ID>"}' \
  --json '{"removeLabelIds": ["UNREAD"]}'

# Trash a message
gws gmail users messages trash --params '{"userId": "me", "id": "<MSG_ID>"}'

# Get user profile
gws gmail users getProfile --params '{"userId": "me"}'
```

## Search Query Syntax

Gmail search queries support:
- `from:`, `to:`, `subject:`, `has:attachment`
- `is:unread`, `is:starred`, `is:important`
- `after:YYYY/MM/DD`, `before:YYYY/MM/DD`
- `label:`, `category:primary`, `in:inbox`
- Boolean: `OR`, `-` (exclude), `()` grouping

## Discovery

```bash
gws gmail --help
gws schema gmail.users.messages.list
gws schema gmail.users.messages.send
```
```

**Step 6: Commit the skills**

```bash
git add container/skills/gws-shared/ container/skills/gws-sheets/ container/skills/gws-drive/ container/skills/gws-docs/ container/skills/gws-gmail/
git commit -m "feat: add gws agent skills for Sheets, Drive, Docs, Gmail"
```

---

### Task 3: Mount gws credentials into container

Replace the `~/.gmail-mcp` mount with `~/.gws` in the container runner.

**Files:**
- Modify: `src/container-runner.ts:199-210`

**Step 1: Replace the Gmail credential mount with gws credential mount**

In `src/container-runner.ts`, replace lines 199-210:

```typescript
  // Gmail credentials directory (for Gmail MCP inside the container).
  // Read-only for non-main groups to prevent token exfiltration.
  // Main group needs read-write for OAuth token refresh.
  const homeDir = os.homedir();
  const gmailDir = path.join(homeDir, '.gmail-mcp');
  if (fs.existsSync(gmailDir)) {
    mounts.push({
      hostPath: gmailDir,
      containerPath: '/home/node/.gmail-mcp',
      readonly: !isMain,
    });
  }
```

with:

```typescript
  // Google Workspace CLI credentials directory (for gws inside the container).
  // Read-only for non-main groups to prevent token exfiltration.
  // Main group needs read-write for OAuth token refresh.
  const homeDir = os.homedir();
  const gwsDir = path.join(homeDir, '.gws');
  if (fs.existsSync(gwsDir)) {
    mounts.push({
      hostPath: gwsDir,
      containerPath: '/home/node/.gws',
      readonly: !isMain,
    });
  }
```

**Step 2: Build to verify**

```bash
npm run build
```

Expected: clean build, no errors.

**Step 3: Commit**

```bash
git add src/container-runner.ts
git commit -m "feat: mount gws credentials instead of gmail-mcp"
```

---

### Task 4: Remove Gmail MCP server from agent runner

**Files:**
- Modify: `container/agent-runner/src/index.ts:622-625`

**Step 1: Remove the gmail MCP server entry**

In `container/agent-runner/src/index.ts`, remove these lines from the `mcpServers` object (lines 622-625):

```typescript
        gmail: {
          command: 'npx',
          args: ['-y', '@gongrzhe/server-gmail-autoauth-mcp'],
        },
```

The `mcpServers` object should now only contain `nanoclaw` (and any other non-gmail entries).

**Step 2: Rebuild the container**

```bash
cd /root/nanoklauw/container && ./build.sh
```

**Step 3: Commit**

```bash
git add container/agent-runner/src/index.ts
git commit -m "refactor: remove Gmail MCP server, replaced by gws-gmail skill"
```

---

### Task 5: Update global CLAUDE.md to reference gws capabilities

**Files:**
- Modify: `groups/global/CLAUDE.md`

**Step 1: Read the current global CLAUDE.md**

```bash
cat groups/global/CLAUDE.md
```

**Step 2: Update capability references**

Find the section that lists capabilities (email/Gmail references) and update to reflect that email is now handled via `gws gmail` CLI instead of MCP tools. Replace any `mcp__gmail__*` references with `gws gmail` commands.

If there's a line like:
```
- Email (Gmail): read, search, send, draft via Gmail tools
```

Update to:
```
- Google Workspace: Sheets, Drive, Docs, Gmail via `gws` CLI (see gws-* skills)
```

**Step 3: Commit**

```bash
git add groups/global/CLAUDE.md
git commit -m "docs: update global CLAUDE.md for gws integration"
```

---

### Task 6: Build upstream-compatible skill package

Package everything as a NanoClaw skill for upstream PR.

**Files:**
- Create: `.claude/skills/add-google-workspace/SKILL.md`
- Create: `.claude/skills/add-google-workspace/manifest.yaml`
- Create: `.claude/skills/add-google-workspace/add/container/skills/gws-shared/SKILL.md` (copy)
- Create: `.claude/skills/add-google-workspace/add/container/skills/gws-sheets/SKILL.md` (copy)
- Create: `.claude/skills/add-google-workspace/add/container/skills/gws-drive/SKILL.md` (copy)
- Create: `.claude/skills/add-google-workspace/add/container/skills/gws-docs/SKILL.md` (copy)
- Create: `.claude/skills/add-google-workspace/add/container/skills/gws-gmail/SKILL.md` (copy)
- Create: `.claude/skills/add-google-workspace/modify/container/Dockerfile` (full copy with gws added)
- Create: `.claude/skills/add-google-workspace/modify/container/Dockerfile.intent.md`
- Create: `.claude/skills/add-google-workspace/modify/container/agent-runner/src/index.ts.intent.md`
- Create: `.claude/skills/add-google-workspace/modify/src/container-runner.ts.intent.md`

**Step 1: Create the manifest**

Create `.claude/skills/add-google-workspace/manifest.yaml`:

```yaml
skill: google-workspace
version: 1.0.0
description: "Google Workspace integration (Sheets, Drive, Docs, Gmail) via official gws CLI"
core_version: 0.1.0
adds:
  - container/skills/gws-shared/SKILL.md
  - container/skills/gws-sheets/SKILL.md
  - container/skills/gws-drive/SKILL.md
  - container/skills/gws-docs/SKILL.md
  - container/skills/gws-gmail/SKILL.md
modifies:
  - container/Dockerfile
  - src/container-runner.ts
structured:
  npm_dependencies: {}
  env_additions: []
conflicts:
  - gmail
depends: []
test: "docker run --rm nanoclaw-agent:latest gws --version"
```

**Step 2: Create the SKILL.md (setup guide)**

Create `.claude/skills/add-google-workspace/SKILL.md` with setup phases:
- Phase 1: Pre-flight (check if already applied)
- Phase 2: Apply code changes (run apply-skill or manual)
- Phase 3: OAuth setup (GCP project, `gws auth login` via SSH tunnel)
- Phase 4: Build and restart
- Phase 5: Verify (test `gws sheets`, `gws drive`, `gws gmail` from agent)
- Troubleshooting and removal sections

Pattern this after the existing `add-gmail/SKILL.md`.

**Step 3: Create intent files**

Create `modify/container/Dockerfile.intent.md`:
```markdown
# Intent: Dockerfile modifications

## What this skill adds
Adds `@googleworkspace/cli` to the global npm install line.

## Key sections
- Line 40: `npm install -g` gains `@googleworkspace/cli`

## Invariants
- All existing global packages (agent-browser, claude-code, bitwarden) must remain
- Package install order doesn't matter

## Must-keep sections
- All existing RUN, COPY, ENV instructions unchanged
```

Create `modify/src/container-runner.ts.intent.md`:
```markdown
# Intent: container-runner.ts modifications

## What this skill adds
Mounts `~/.gws/` (Google Workspace CLI credentials) into the container at `/home/node/.gws/`.

## Key sections
- `buildVolumeMounts()`: conditional mount of `~/.gws` with RW for main, RO for others

## Invariants
- All other mounts (session, group, global, IPC, bitwarden) must remain
- Mount security pattern: RW for main group, RO for others

## Must-keep sections
- All existing volume mount logic unchanged
- `syncSkillsToGroup()` call before mounts
```

Create `modify/container/agent-runner/src/index.ts.intent.md`:
```markdown
# Intent: agent-runner index.ts modifications

## What this skill adds
Nothing — this skill does NOT add an MCP server. gws is used via Bash, not MCP.

## Note for gmail skill users
If the gmail skill (MCP-based) is also applied, this skill's `conflicts: [gmail]` in the manifest prevents co-installation. The gws-gmail agent skill replaces the Gmail MCP server.

## Invariants
- All existing MCP servers (nanoclaw, etc.) must remain
- `mcp__*` wildcard in allowedTools stays (used by other MCP servers)
```

**Step 4: Copy agent skill files into add/ directory**

```bash
mkdir -p .claude/skills/add-google-workspace/add/container/skills
cp -r container/skills/gws-shared .claude/skills/add-google-workspace/add/container/skills/
cp -r container/skills/gws-sheets .claude/skills/add-google-workspace/add/container/skills/
cp -r container/skills/gws-drive .claude/skills/add-google-workspace/add/container/skills/
cp -r container/skills/gws-docs .claude/skills/add-google-workspace/add/container/skills/
cp -r container/skills/gws-gmail .claude/skills/add-google-workspace/add/container/skills/
```

**Step 5: Commit**

```bash
git add .claude/skills/add-google-workspace/
git commit -m "feat: add upstream-compatible google-workspace skill package"
```

---

### Task 7: OAuth setup and end-to-end verification

**Files:** None (runtime setup)

**Step 1: Set up GCP OAuth (if not already done)**

The existing GCP project (`nanoklauw-488721`) can be reused. Enable the following APIs:
- Google Sheets API
- Google Drive API
- Google Docs API
- Gmail API (already enabled)

Create a new OAuth client (Desktop app) or reuse the existing one.

**Step 2: Run gws auth**

```bash
# SSH tunnel from MacBook (if headless server)
# ssh -L 3000:localhost:3000 server

gws auth login
```

This creates `~/.gws/` with OAuth tokens.

**Step 3: Verify gws works on host**

```bash
gws gmail +triage
gws drive files list --params '{"pageSize": 3}'
gws sheets +read --spreadsheet-id <any-known-sheet-id> --range "A1:A5"
```

**Step 4: Clear stale session data and rebuild**

```bash
rm -r data/sessions/*/agent-runner-src 2>/dev/null || true
cd /root/nanoklauw/container && ./build.sh
cd /root/nanoklauw && npm run build && systemctl restart nanoklauw
```

**Step 5: Test from WhatsApp/Slack**

Send a message like: "List my recent Google Drive files" or "Create a new spreadsheet called Test"

Check logs:
```bash
journalctl -u nanoklauw -f
```

---

### Task 8: Clean up old Gmail MCP artifacts

**Files:** None (cleanup)

**Step 1: Remove old Gmail MCP credentials (after verifying gws works)**

```bash
# Keep a backup first
cp -r ~/.gmail-mcp ~/.gmail-mcp.bak
```

**Step 2: Uninstall old Gmail MCP package from container**

The `@gongrzhe/server-gmail-autoauth-mcp` is called via `npx -y` (not installed globally), so no uninstall needed. It was removed from agent-runner in Task 4.

**Step 3: Remove old Gmail MCP credential reference from memory**

Update `/root/.claude/projects/-root-nanoklauw/memory/MEMORY.md` to replace Gmail MCP references with gws.

**Step 4: Final commit**

```bash
git add -A
git commit -m "chore: clean up Gmail MCP references after gws migration"
```
