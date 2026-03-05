---
name: add-google-workspace
description: "Add Google Workspace (Sheets, Drive, Docs, Gmail) to NanoClaw agents via the official gws CLI"
---

# Add Google Workspace Integration

Adds Google Workspace capabilities (Sheets, Drive, Docs, Gmail) to NanoClaw agents using the official `gws` CLI (`@googleworkspace/cli`).

## Phase 1: Pre-flight

Check if already applied:

```bash
docker run --rm --entrypoint gws nanoclaw-agent:latest --version 2>/dev/null && echo "ALREADY INSTALLED" || echo "NOT INSTALLED"
```

If already installed, skip to Phase 3 (OAuth) or Phase 5 (verify).

## Phase 2: Apply Code Changes

### 2a. Container — install gws globally

In `container/Dockerfile`, add `@googleworkspace/cli` to the global npm install line:

```dockerfile
RUN npm install -g agent-browser @anthropic-ai/claude-code @bitwarden/cli @googleworkspace/cli
```

### 2b. Container runner — mount credentials

In `src/container-runner.ts`, in `buildVolumeMounts()`, add a mount for `~/.config/gws/`:

```typescript
const gwsDir = path.join(os.homedir(), '.config', 'gws');
if (fs.existsSync(gwsDir)) {
  mounts.push({
    hostPath: gwsDir,
    containerPath: '/home/node/.config/gws',
    readonly: !isMain,
  });
}
```

Main group gets read-write (for OAuth token refresh), others get read-only.

In `buildDockerArgs()`, add the credentials env var:

```typescript
args.push('-e', 'GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/home/node/.config/gws/credentials.json');
```

**Important:** After `gws auth login`, the credentials are stored encrypted (`credentials.enc`). You must decrypt them to `credentials.json` for the container to use:

```bash
gws auth export > ~/.config/gws/credentials.json
```

Note: `gws auth export` masks secrets by default. If the file contains masked values, decrypt manually using the `.encryption_key`.

### 2c. Agent skills

Copy the 5 gws skill files from `add/container/skills/` into `container/skills/`:
- `gws-shared/SKILL.md` — auth, CLI basics, global flags
- `gws-sheets/SKILL.md` — spreadsheet operations
- `gws-drive/SKILL.md` — file management
- `gws-docs/SKILL.md` — document operations
- `gws-gmail/SKILL.md` — email operations

### 2d. Remove Gmail MCP (if present)

If the `gmail` MCP skill is applied, remove the `gmail` entry from `mcpServers` in `container/agent-runner/src/index.ts`. The gws-gmail agent skill replaces it.

## Phase 3: OAuth Setup

### 3a. GCP Project

Use existing GCP project or create one. Enable these APIs:
- Google Sheets API
- Google Drive API
- Google Docs API
- Gmail API

Create an OAuth 2.0 client (Desktop app type).

### 3b. Authenticate gws

If the server is headless, set up an SSH tunnel first:
```bash
# From your local machine:
ssh -L 3000:localhost:3000 server
```

Then run:
```bash
gws auth login
```

This creates `~/.gws/` with OAuth tokens. Verify:
```bash
gws auth status
```

## Phase 4: Build and Restart

```bash
cd container && ./build.sh
cd .. && npm run build && systemctl restart nanoklauw
```

## Phase 5: Verify

Test from the host:
```bash
gws gmail +triage
gws drive files list --params '{"pageSize": 3}'
```

Test from WhatsApp/Slack by sending a message like "List my recent Google Drive files".

Check logs:
```bash
journalctl -u nanoklauw -f
```

## Troubleshooting

### gws not found in container
Rebuild: `cd container && ./build.sh`

### Auth errors
Check `~/.config/gws/` exists and has `credentials.json` (plain, not just `.enc`). Re-run `gws auth login` if needed.

### Permission errors on gws mount
```bash
chown -R 1000:1000 ~/.config/gws
```

## Removal

1. Remove `@googleworkspace/cli` from `container/Dockerfile`
2. Remove `~/.config/gws` mount and `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE` env var from `src/container-runner.ts`
3. Delete `container/skills/gws-*/`
4. Rebuild container and restart
