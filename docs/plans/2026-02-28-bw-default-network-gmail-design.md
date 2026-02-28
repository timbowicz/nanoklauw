# Default Bitwarden, Full Network, Gmail Read-Only

Date: 2026-02-28

## Goal

Enable all agents to browse the web freely, manage passwords in Bitwarden, and use Gmail — with appropriate isolation boundaries.

## Changes

### 1. Bitwarden enabled by default for all groups

**container-runner.ts**: Remove the `if (group.containerConfig?.bitwarden)` guard around the BW cache mount. Always mount `data/bitwarden/{group.folder}/` → `/home/node/.config/Bitwarden CLI/`.

**buildContainerArgs()**: Always set `BW_ENABLED=1` env var. Remove the `bitwarden` parameter from the function signature.

The `containerConfig.bitwarden` property is removed from `ContainerConfig` — BW is always on.

### 2. Bitwarden isolation via naming convention

Agents are instructed (via the Bitwarden skill) to prefix all items with their group folder name: `{groupFolder}/Service Name`.

Update `container/skills/bitwarden/SKILL.md`:
- All create/search operations use the group folder prefix
- Agent must never access items without its own prefix
- GROUP_FOLDER env var is already available via `NANOCLAW_GROUP_FOLDER`

This is a soft boundary — the full vault is technically accessible, but the naming convention prevents cross-group access in practice.

### 3. Full network access for all groups

**container-runner.ts**: Change the default network mode from `'restricted'` to `'full'`:

```typescript
const effectiveNetworkMode = networkMode ?? 'full';
```

The restricted network infrastructure (`restricted-network.ts`, `network-proxy.ts`) stays in the codebase for optional per-group use, but is no longer the default.

**groups/global/CLAUDE.md**: Remove the "Network Access" section about `request_network_access`. Agents have full internet access by default.

### 4. Gmail mount read-only for non-main groups

**container-runner.ts**: Make the Gmail credentials mount read-only based on `isMain`:

```typescript
readonly: !isMain
```

Main group can still refresh OAuth tokens. Non-main groups can read tokens to authenticate the Gmail MCP server, but cannot exfiltrate or overwrite them.

### 5. Agent instructions in global CLAUDE.md

Add to `groups/global/CLAUDE.md`:
- Bitwarden section: available for all agents, use `{groupFolder}/` prefix, never access other groups' items
- Remove network restriction section (agents have full access now)

## Files Modified

| File | Change |
|------|--------|
| `src/types.ts` | Remove `bitwarden` from `ContainerConfig` |
| `src/container-runner.ts` | BW always mounted, network default `'full'`, Gmail readonly for non-main, simplify `buildContainerArgs` |
| `container/skills/bitwarden/SKILL.md` | Add group folder prefix convention |
| `groups/global/CLAUDE.md` | Add Bitwarden instructions, remove network restriction section |

## Security Notes

- Bitwarden isolation is convention-based, not enforced at vault level. A prompt-injected agent could theoretically read other groups' passwords. This is an accepted trade-off vs. the complexity of Bitwarden Organizations.
- Gmail tokens are read-only for non-main, preventing token exfiltration but still allowing email send/read.
- Full network removes the approval gate for outbound connections. Agents can now reach any domain without user approval.
