# Default Bitwarden, Full Network, Gmail Read-Only — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable all agents to browse the web freely, manage passwords in Bitwarden with per-group isolation, and use Gmail — with read-only token protection for non-main groups.

**Architecture:** Remove the opt-in bitwarden flag, make BW cache mount and BW_ENABLED unconditional. Change network default from restricted to full. Make Gmail mount read-only for non-main. Update agent instructions accordingly.

**Tech Stack:** TypeScript, Docker volume mounts, Bitwarden CLI

---

### Task 1: Remove `bitwarden` from ContainerConfig type

**Files:**
- Modify: `src/types.ts:30-35`

**Step 1: Edit types.ts**

Remove the `bitwarden` line from `ContainerConfig`:

```typescript
// Before (lines 30-35):
export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
  bitwarden?: boolean; // Enable Bitwarden vault access for this group
  networkMode?: 'full' | 'restricted' | 'none'; // Default: 'restricted' for non-main, 'full' for main
}

// After:
export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
  networkMode?: 'full' | 'restricted' | 'none'; // Default: 'full' for all groups
}
```

**Step 2: Verify build**

Run: `cd /root/nanoklauw && npx tsc --noEmit`
Expected: May show errors in container-runner.ts (those are fixed in Task 2)

**Step 3: Commit**

```bash
git add src/types.ts
git commit -m "refactor: remove bitwarden flag from ContainerConfig (now always-on)"
```

---

### Task 2: Update container-runner.ts — BW always on, network full, Gmail read-only

**Files:**
- Modify: `src/container-runner.ts:198-228` (Gmail + BW mount)
- Modify: `src/container-runner.ts:275-332` (buildContainerArgs)
- Modify: `src/container-runner.ts:361-367` (call site)

**Step 1: Make BW cache mount unconditional**

In `buildVolumeMounts()`, replace the conditional BW mount (lines 216-228) with unconditional:

```typescript
// Before (lines 216-228):
  // Bitwarden CLI cache: persistent vault data so bw doesn't re-sync from scratch
  if (group.containerConfig?.bitwarden) {
    const bwCacheDir = path.join(DATA_DIR, 'bitwarden', group.folder);
    fs.mkdirSync(bwCacheDir, { recursive: true });
    try {
      fs.chownSync(bwCacheDir, CONTAINER_UID, CONTAINER_GID);
    } catch {}
    mounts.push({
      hostPath: bwCacheDir,
      containerPath: '/home/node/.config/Bitwarden CLI',
      readonly: false,
    });
  }

// After:
  // Bitwarden CLI cache: persistent vault data so bw doesn't re-sync from scratch.
  // Always mounted — all groups have Bitwarden access.
  const bwCacheDir = path.join(DATA_DIR, 'bitwarden', group.folder);
  fs.mkdirSync(bwCacheDir, { recursive: true });
  try {
    fs.chownSync(bwCacheDir, CONTAINER_UID, CONTAINER_GID);
  } catch {}
  mounts.push({
    hostPath: bwCacheDir,
    containerPath: '/home/node/.config/Bitwarden CLI',
    readonly: false,
  });
```

**Step 2: Make Gmail mount read-only for non-main**

In `buildVolumeMounts()`, change the Gmail mount (lines 198-207):

```typescript
// Before (lines 198-207):
  // Gmail credentials directory (for Gmail MCP inside the container)
  const homeDir = os.homedir();
  const gmailDir = path.join(homeDir, '.gmail-mcp');
  if (fs.existsSync(gmailDir)) {
    mounts.push({
      hostPath: gmailDir,
      containerPath: '/home/node/.gmail-mcp',
      readonly: false, // MCP may need to refresh OAuth tokens
    });
  }

// After:
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

**Step 3: Simplify buildContainerArgs — remove bitwarden param, always set BW_ENABLED, change network default**

```typescript
// Before (lines 275-332):
function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  bitwarden: boolean,
  isMain: boolean,
  networkMode?: 'full' | 'restricted' | 'none',
): string[] {
  // ... (args setup lines 282-314 stay the same) ...

  // Bitwarden credentials are passed via stdin JSON (input.secrets) alongside
  // other secrets — NOT as Docker env vars (which are visible via docker inspect).
  // The container entrypoint extracts them from /tmp/input.json before bw login.
  if (bitwarden) {
    args.push('-e', 'BW_ENABLED=1');
  }

  // Network isolation: non-main containers default to restricted network
  // Main containers keep full network (WebFetch/WebSearch need it)
  const effectiveNetworkMode = networkMode ?? (isMain ? 'full' : 'restricted');

// After:
function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  isMain: boolean,
  networkMode?: 'full' | 'restricted' | 'none',
): string[] {
  // ... (args setup lines 282-314 stay the same) ...

  // Bitwarden is always enabled. Credentials are passed via stdin JSON (input.secrets),
  // NOT as Docker env vars (which are visible via docker inspect).
  args.push('-e', 'BW_ENABLED=1');

  // Network: all containers default to full network access.
  // Per-group override via containerConfig.networkMode still supported.
  const effectiveNetworkMode = networkMode ?? 'full';
```

**Step 4: Update the call site in runContainerAgent**

```typescript
// Before (lines 361-367):
  const containerArgs = buildContainerArgs(
    mounts,
    containerName,
    !!group.containerConfig?.bitwarden,
    input.isMain,
    group.containerConfig?.networkMode,
  );

// After:
  const containerArgs = buildContainerArgs(
    mounts,
    containerName,
    input.isMain,
    group.containerConfig?.networkMode,
  );
```

**Step 5: Verify build**

Run: `cd /root/nanoklauw && npx tsc --noEmit`
Expected: PASS (no errors)

**Step 6: Run tests**

Run: `cd /root/nanoklauw && npx vitest run src/container-runner.test.ts`
Expected: PASS (tests don't reference bitwarden config)

**Step 7: Commit**

```bash
git add src/container-runner.ts
git commit -m "feat: BW always-on, full network default, Gmail read-only for non-main"
```

---

### Task 3: Update Bitwarden skill with group folder prefix convention

**Files:**
- Modify: `container/skills/bitwarden/SKILL.md`

**Step 1: Rewrite SKILL.md with prefix convention**

Replace the full file with updated content that:
- References `$NANOCLAW_GROUP_FOLDER` for the prefix
- Updates all search/create/update examples to use `$NANOCLAW_GROUP_FOLDER/` prefix
- Adds explicit isolation rule: never access items without your group prefix
- Keeps the existing structure (prerequisites, lookup, login, create, update, generate, sync)

Key changes to examples:

```bash
# Search — always filter by group prefix
GROUP_PREFIX="$NANOCLAW_GROUP_FOLDER"
bw list items --search "$GROUP_PREFIX/" --session "$BW_SESSION" | jq '[.[] | select(.name | startswith("'"$GROUP_PREFIX"'/"))]'

# Create — always prefix the name
bw get template item | jq \
  --arg name "$GROUP_PREFIX/New Service" \
  ...
```

Add to Important section:
```
- ALWAYS prefix item names with your group folder: `$NANOCLAW_GROUP_FOLDER/Service Name`
- NEVER search for or access items that don't start with your group prefix
- This ensures each group's credentials are isolated from other groups
```

**Step 2: Commit**

```bash
git add container/skills/bitwarden/SKILL.md
git commit -m "feat: add group folder prefix convention to Bitwarden skill"
```

---

### Task 4: Update global CLAUDE.md — remove network restriction, add Bitwarden info

**Files:**
- Modify: `groups/global/CLAUDE.md:55-69` (Network Access section)

**Step 1: Replace Network Access section with Bitwarden section**

Remove lines 55-69 (the entire "## Network Access" section) and replace with a Bitwarden section:

```markdown
## Password Management (Bitwarden)

You have access to a shared Bitwarden vault via the `bw` CLI. Your credentials are isolated by group folder prefix.

- All items you create MUST be named `$NANOCLAW_GROUP_FOLDER/Service Name` (e.g., `werk/github.com`)
- Only search for and access items that start with your group prefix
- Never access items belonging to other groups
- Use the bitwarden skill (`/bitwarden`) for detailed usage instructions
- Never log or display passwords — pipe them directly into `agent-browser fill` commands
```

**Step 2: Commit**

```bash
git add groups/global/CLAUDE.md
git commit -m "feat: add Bitwarden instructions, remove network restriction docs"
```

---

### Task 5: Build and verify

**Step 1: Build TypeScript**

Run: `cd /root/nanoklauw && npm run build`
Expected: PASS

**Step 2: Run all tests**

Run: `cd /root/nanoklauw && npx vitest run`
Expected: PASS

**Step 3: Squash into single commit (optional)**

If all tasks committed separately, optionally squash into one feature commit:

```bash
git commit -m "feat: enable Bitwarden for all groups, full network, Gmail read-only

- Bitwarden CLI always mounted with per-group cache directory
- Group folder prefix convention for vault item isolation
- Network default changed from restricted to full for all containers
- Gmail credentials mount read-only for non-main groups
- Updated agent instructions in global CLAUDE.md"
```
