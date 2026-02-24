# Bitwarden CLI Integration — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give agents access to a Bitwarden password vault via the `bw` CLI, with a persistent cache so vault data survives container restarts.

**Architecture:** Install `@bitwarden/cli` in the Docker image. Pass BW credentials via stdin secrets. Mount a per-group cache directory. Add a container skill teaching the agent how to use `bw` commands with agent-browser.

**Tech Stack:** Bitwarden CLI (`@bitwarden/cli`), Docker, TypeScript, Bash

---

### Task 1: Add `bitwarden` flag to ContainerConfig type

**Files:**
- Modify: `src/types.ts:30-33`

**Step 1: Add the flag**

In `src/types.ts`, add `bitwarden?: boolean` to the `ContainerConfig` interface:

```typescript
export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
  bitwarden?: boolean; // Enable Bitwarden vault access for this group
}
```

**Step 2: Verify build**

Run: `npm run build`
Expected: Clean compile, no errors.

**Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat(bitwarden): add bitwarden flag to ContainerConfig type"
```

---

### Task 2: Add Bitwarden secrets to CONTAINER_SECRETS

**Files:**
- Modify: `src/config.ts:78-86`

**Step 1: Add the three BW env vars**

In `src/config.ts`, add to the `CONTAINER_SECRETS` array:

```typescript
export const CONTAINER_SECRETS = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'HA_URL',
  'HA_TOKEN',
  'TRIBE_CLIENT_ID',
  'TRIBE_CLIENT_SECRET',
  'BW_CLIENTID',
  'BW_CLIENTSECRET',
  'BW_PASSWORD',
];
```

**Step 2: Verify build**

Run: `npm run build`
Expected: Clean compile.

**Step 3: Commit**

```bash
git add src/config.ts
git commit -m "feat(bitwarden): add BW credentials to container secrets allowlist"
```

---

### Task 3: Add persistent Bitwarden cache mount to container-runner

**Files:**
- Modify: `src/container-runner.ts:124-222` (the `buildVolumeMounts` function)

**Step 1: Add the Bitwarden mount**

In `src/container-runner.ts`, inside `buildVolumeMounts()`, add after the IPC mount block (after line 195) and before the agent-runner-src block:

```typescript
  // Bitwarden CLI cache: persistent vault data so bw doesn't re-sync from scratch
  if (group.containerConfig?.bitwarden) {
    const bwCacheDir = path.join(DATA_DIR, 'bitwarden', group.folder);
    fs.mkdirSync(bwCacheDir, { recursive: true });
    try {
      fs.chownSync(bwCacheDir, 1000, 1000);
    } catch {}
    mounts.push({
      hostPath: bwCacheDir,
      containerPath: '/home/node/.config/Bitwarden CLI',
      readonly: false,
    });
  }
```

**Step 2: Verify build**

Run: `npm run build`
Expected: Clean compile.

**Step 3: Commit**

```bash
git add src/container-runner.ts
git commit -m "feat(bitwarden): mount persistent vault cache per group"
```

---

### Task 4: Add Bitwarden env vars to container args

**Files:**
- Modify: `src/container-runner.ts:232-269` (the `buildContainerArgs` function)

**Step 1: Pass BW env vars into the container**

The secrets are passed via stdin, but `BW_CLIENTID`, `BW_CLIENTSECRET`, and `BW_PASSWORD` also need to be available as environment variables for the entrypoint script (which runs before the Node agent reads stdin). Add after the telemetry env vars block in `buildContainerArgs()`:

Actually — the entrypoint reads stdin into a temp file and then runs the Node process. The BW login happens in the entrypoint *before* Node starts, so BW credentials need to be actual `-e` env vars on the container, not just stdin JSON.

Add a `bitwarden` parameter to `buildContainerArgs`:

```typescript
function buildContainerArgs(mounts: VolumeMount[], containerName: string, bitwarden: boolean): string[] {
```

And after the telemetry env vars block (after `args.push('-e', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1');`):

```typescript
  // Bitwarden credentials for entrypoint login/unlock
  if (bitwarden) {
    const secrets = readSecrets();
    if (secrets.BW_CLIENTID) args.push('-e', `BW_CLIENTID=${secrets.BW_CLIENTID}`);
    if (secrets.BW_CLIENTSECRET) args.push('-e', `BW_CLIENTSECRET=${secrets.BW_CLIENTSECRET}`);
    if (secrets.BW_PASSWORD) args.push('-e', `BW_PASSWORD=${secrets.BW_PASSWORD}`);
  }
```

Update the call site in `runContainerAgent()` (around line 285):

```typescript
  const containerArgs = buildContainerArgs(mounts, containerName, !!input.bitwarden);
```

Wait — `buildContainerArgs` doesn't have access to the group. Simpler: pass the boolean from the caller.

Update the call site:

```typescript
  const containerArgs = buildContainerArgs(mounts, containerName, !!group.containerConfig?.bitwarden);
```

**Step 2: Verify build**

Run: `npm run build`
Expected: Clean compile.

**Step 3: Commit**

```bash
git add src/container-runner.ts
git commit -m "feat(bitwarden): pass BW credentials as env vars for entrypoint"
```

---

### Task 5: Update Dockerfile — install Bitwarden CLI

**Files:**
- Modify: `container/Dockerfile:38`

**Step 1: Add @bitwarden/cli to npm global install**

Change line 38 from:

```dockerfile
RUN npm install -g agent-browser @anthropic-ai/claude-code
```

To:

```dockerfile
RUN npm install -g agent-browser @anthropic-ai/claude-code @bitwarden/cli
```

**Step 2: Commit**

```bash
git add container/Dockerfile
git commit -m "feat(bitwarden): install Bitwarden CLI in container image"
```

---

### Task 6: Update entrypoint to conditionally login/unlock Bitwarden

**Files:**
- Modify: `container/Dockerfile:61` (the entrypoint script)

**Step 1: Add Bitwarden login to entrypoint**

Replace the `RUN printf` line (line 61) with an updated entrypoint that includes conditional Bitwarden setup. The entrypoint is a single-line printf, so the replacement is:

```dockerfile
RUN printf '#!/bin/bash\nset -e\ncd /app && npx tsc --outDir /tmp/dist 2>&1 >&2\nln -s /app/node_modules /tmp/dist/node_modules\nchmod -R a-w /tmp/dist\n\n# Bitwarden: login and unlock if credentials are present\nif [ -n "$BW_CLIENTID" ]; then\n  bw login --apikey 2>/dev/null || true\n  export BW_SESSION=$(bw unlock --passwordenv BW_PASSWORD --raw)\n  bw sync 2>/dev/null\nfi\n\ncat > /tmp/input.json\nnode /tmp/dist/index.js < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh
```

This adds between the TypeScript compile and the `cat > /tmp/input.json`:
1. Check if `BW_CLIENTID` is set
2. Login with API key (no-op if already logged in from cache)
3. Unlock vault and export `BW_SESSION`
4. Sync latest vault data

**Step 2: Commit**

```bash
git add container/Dockerfile
git commit -m "feat(bitwarden): add conditional vault login to container entrypoint"
```

---

### Task 7: Create the Bitwarden container skill

**Files:**
- Create: `container/skills/bitwarden/SKILL.md`

**Step 1: Write the skill file**

```markdown
---
name: bitwarden
description: Look up, create, and manage passwords in Bitwarden vault. Use with agent-browser for website logins. Available when BW_SESSION is set.
allowed-tools: Bash(bw:*)
---

# Bitwarden Password Manager

## Prerequisites

Bitwarden is pre-configured when `BW_SESSION` is set. Check availability:

```bash
bw status | grep -q '"status":"unlocked"' && echo "READY" || echo "NOT AVAILABLE"
```

If not available, Bitwarden is not enabled for this group. Do not attempt to login manually.

## Look up credentials

```bash
# Search by name or URL
bw list items --search "example.com" --session "$BW_SESSION"

# Get specific fields
bw get username <item-id> --session "$BW_SESSION"
bw get password <item-id> --session "$BW_SESSION"
bw get totp <item-id> --session "$BW_SESSION"    # If TOTP is configured
bw get uri <item-id> --session "$BW_SESSION"
```

## Login to a website with agent-browser

1. Look up credentials:
   ```bash
   ITEM=$(bw list items --search "example.com" --session "$BW_SESSION" | jq '.[0]')
   USERNAME=$(echo "$ITEM" | jq -r '.login.username')
   PASSWORD=$(bw get password "$(echo "$ITEM" | jq -r '.id')" --session "$BW_SESSION")
   ```

2. Use agent-browser to fill the login form:
   ```bash
   agent-browser open "https://example.com/login"
   agent-browser snapshot -i
   agent-browser fill @username_ref "$USERNAME"
   agent-browser fill @password_ref "$PASSWORD"
   agent-browser click @submit_ref
   ```

3. Handle TOTP if needed:
   ```bash
   TOTP=$(bw get totp "<item-id>" --session "$BW_SESSION")
   agent-browser fill @totp_ref "$TOTP"
   agent-browser click @verify_ref
   ```

## Create new credentials

```bash
# Create a login item
bw get template item | jq \
  --arg name "New Service" \
  --arg user "user@example.com" \
  --arg pass "generated-password" \
  --arg uri "https://newservice.com" \
  '.name=$name | .type=1 | .login={username:$user,password:$pass,uris:[{uri:$uri}]}' \
  | bw encode | bw create item --session "$BW_SESSION"
```

## Update credentials

```bash
# Get current item, modify, and save
bw get item <item-id> --session "$BW_SESSION" \
  | jq '.login.password = "new-password"' \
  | bw encode | bw edit item <item-id> --session "$BW_SESSION"
```

## Generate a password

```bash
bw generate --length 20 --uppercase --lowercase --number --special
```

## Sync vault

```bash
bw sync --session "$BW_SESSION"
```

## Important

- Always pass `--session "$BW_SESSION"` to every `bw` command
- Never log or display passwords in output — use them directly in agent-browser fill commands
- After creating or updating items, run `bw sync` to push changes
- Passwords from `bw get password` are raw strings (no JSON wrapping)
```

**Step 2: Commit**

```bash
git add container/skills/bitwarden/SKILL.md
git commit -m "feat(bitwarden): add container skill for vault operations"
```

---

### Task 8: Rebuild container and test

**Step 1: Rebuild the container image**

```bash
docker builder prune -af
./container/build.sh
```

**Step 2: Verify bw is installed**

```bash
docker run --rm --entrypoint bw nanoclaw-agent:latest --version
```

Expected: Prints a Bitwarden CLI version number.

**Step 3: Verify entrypoint has Bitwarden block**

```bash
docker run --rm --entrypoint cat nanoclaw-agent:latest /app/entrypoint.sh
```

Expected: Should contain the `if [ -n "$BW_CLIENTID" ]` block.

**Step 4: Build TypeScript**

```bash
npm run build
```

Expected: Clean compile.

**Step 5: Commit everything and push**

```bash
git add -A
git commit -m "feat(bitwarden): complete integration with persistent vault cache"
git push
```

---

### Task 9: Add Bitwarden credentials to .env

**Step 1: Add BW credentials to .env**

The user needs to add these to their `.env` file:

```
BW_CLIENTID=user.xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
BW_CLIENTSECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxx
BW_PASSWORD=your-master-password
```

These can be generated from Bitwarden Web Vault > Account Settings > Security > Keys > API Key.

**Step 2: Enable Bitwarden for a group**

Update the group's container config in the database. This can be done via IPC or directly:

The agent (or user) sets `containerConfig.bitwarden = true` for the desired group.

**Step 3: Restart service**

```bash
systemctl restart nanoklauw
```

**Step 4: Test end-to-end**

Send a message to an enabled group asking the agent to look up a credential in Bitwarden. Verify it can access the vault.
