# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process that connects to WhatsApp, routes messages to Claude Agent SDK running in Docker containers. Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/whatsapp.ts` | WhatsApp connection, auth, send/receive |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/agent-browser.md` | Browser automation tool (available to all agents via Bash) |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/security-audit` | Scan a skill for vulnerabilities before installing it |
| `/update` | Pull upstream NanoClaw changes, merge with customizations, run migrations |

### Mandatory: Security audit before installing skills

**RULE**: Before installing any new skill (from a PR, URL, local path, or any other source), you MUST run the security scanner on it first:

```bash
node .claude/skills/security-audit/scanner.cjs /path/to/skill-directory
```

Workflow:
1. Fetch/download the skill files to a temporary location
2. Run the scanner against that location
3. Show the user the audit report (risk score, verdict, findings)
4. If verdict is **FAIL**: refuse to install and explain the critical findings
5. If verdict is **REVIEW_NEEDED**: show findings and ask the user for explicit confirmation before proceeding
6. If verdict is **PASS**: proceed with installation

Never skip this step, even if the user says to. The only exception is the security-audit skill itself.

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management (this server uses systemd system-level service):
```bash
systemctl status nanoklauw       # Check status
systemctl restart nanoklauw      # Restart after code changes
systemctl stop nanoklauw         # Stop
systemctl start nanoklauw        # Start
journalctl -u nanoklauw -f       # Follow logs
```

Service file: `/etc/systemd/system/nanoklauw.service` (loads `.env` via `EnvironmentFile`).

**WARNING**: There was previously a duplicate user-level service (`nanoclaw.service` via `systemctl --user`). It has been disabled. Only use the system-level `nanoklauw.service`. Running both causes duplicate WhatsApp connections, conflict errors, and double message delivery. If issues arise, verify only one node process is running: `ps aux | grep 'node.*index' | grep -v grep`

## Deploying Changes

After editing source files:
```bash
npm run build && systemctl restart nanoklauw
```

For a fully clean restart (kills orphaned containers too):
```bash
systemctl stop nanoklauw && docker kill $(docker ps -q) 2>/dev/null; sleep 3 && systemctl start nanoklauw
```

## Timezone

The server runs in UTC. The user (Tim) is in CET (UTC+1), so there is a 1-hour difference. When scheduling tasks, keep in mind that 11:00 user time = 10:00 UTC.

## Known Issues & Fixes

### Container permission errors (EACCES)

The host runs as root but containers run as `node` (uid 1000). Mounted directories must be writable by uid 1000. The code handles this automatically via `chown` in `container-runner.ts`, but if new directories appear with wrong ownership:

```bash
chown -R 1000:1000 data/sessions/ data/ipc/
```

### WhatsApp connection conflicts

`Stream Errored (conflict)` means multiple sessions are competing. Common causes:
- Two NanoClaw processes running (see duplicate service warning above)
- WhatsApp Web open in a browser
- Rapid restart loop creating overlapping connections

The reconnect logic in `whatsapp.ts` has a guard (`reconnecting` flag) and a 3-second delay to prevent cascading reconnects. If the connection keeps cycling, do a full clean restart (see above).

## Container Build Cache

To force a clean rebuild:

```bash
docker builder prune -af
./container/build.sh
```

Always verify after rebuild: `docker run -i --rm --entrypoint wc nanoclaw-agent:latest -l /app/src/index.ts`

## Upstream Compatibility & Modular Development

This fork (nanoklauw) tracks upstream [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw). Upstream uses a **skills architecture** with a full `skills-engine/` that manages merges, state, and conflict resolution. All customizations here must be structured to minimize merge conflicts with future upstream updates.

### Upstream Architecture (Summary)

Upstream NanoClaw uses a three-tier conflict resolution model:
1. **Git-native** — `git merge-file` three-way merges against a clean base (`.nanoclaw/base/`)
2. **Claude Code** — reads skill manifests and `.intent.md` files to resolve what git can't
3. **User** — only for genuine semantic ambiguity

Skills are structured packages in `.claude/skills/` with:
- `SKILL.md` — context, intent, what the skill does
- `manifest.yaml` — metadata, deps, env vars, file lists, test command
- `add/` — new files copied directly (e.g., `add/src/channels/telegram.ts`)
- `modify/` — full modified versions of core files for three-way merge
- `modify/src/file.ts.intent.md` — structured intent docs (What, Invariants, Must-keep)
- `tests/` — integration tests that run after every apply

### Rules for Adding Features

**1. Prefer the skill pattern.** If a feature can be packaged as a skill, do it. Create it under `.claude/skills/<skill-name>/` with:
- `SKILL.md` with description and instructions
- `manifest.yaml` listing `adds`, `modifies`, `structured` (npm deps, env vars)
- `add/` for new files
- `modify/` with full modified files + `.intent.md` for any core file changes
- `tests/` with integration tests

**2. Minimize core file modifications.** The files most likely to conflict with upstream are:
- `src/index.ts` (orchestrator — every channel skill modifies this)
- `src/config.ts` (every skill adds config here)
- `src/router.ts` (outbound message routing)

When modifying these files, keep changes **small and isolated** — add a clearly delimited block rather than weaving logic throughout. This makes three-way merges succeed.

**3. New functionality goes in new files.** Follow the channel pattern:
- New channel → `src/channels/<name>.ts` (self-contained)
- New integration → `src/<integration-name>.ts`
- New utility → `src/<utility-name>.ts`
- Import and wire up in `src/index.ts` with minimal glue code

**4. Follow the manifest format.** Even for local-only features, use the upstream manifest schema:
```yaml
skill: <name>
version: 1.0.0
description: "<what it does>"
core_version: 0.1.0
adds:
  - src/channels/<name>.ts
modifies:
  - src/index.ts
  - src/config.ts
structured:
  npm_dependencies:
    <package>: "<semver>"
  env_additions:
    - <ENV_VAR>
conflicts: []
depends: []
test: "npx vitest run src/channels/<name>.test.ts"
```

**5. Use intent files for core modifications.** When a skill modifies a core file, include a `<filename>.intent.md` alongside the modified file in `modify/`:
```markdown
# Intent: index.ts modifications
## What this skill adds
<brief description>
## Key sections
<what code blocks are added/changed>
## Invariants
<what must not be broken>
## Must-keep sections
<critical code that must survive merges>
```

**6. Don't reorganize or refactor upstream code.** Moving, renaming, or restructuring files that upstream owns will cause painful merge conflicts. Only modify what's necessary for the feature.

**7. Keep structured operations declarative.** npm dependencies, env vars, and docker-compose services should be declared in the manifest's `structured` section, not added manually or via post-apply scripts.

**8. Test after every change.** Skills must include tests. Run them with the command in `manifest.yaml`'s `test` field. Clean merges don't guarantee working code.

### Currently Applied Local Customizations

Track what's been modified from upstream here so future merges are predictable:
- WhatsApp channel (`src/channels/whatsapp.ts`) — customized from upstream
- IPC system (`src/ipc.ts`) — local modifications
- Container runner (`src/container-runner.ts`) — local modifications
- Router (`src/router.ts`) — local modifications
- Database (`src/db.ts`) — local modifications
- Media processing (`src/media-processing.ts`) — new file, not in upstream
- Group queue (`src/group-queue.ts`) — local modifications
- Types (`src/types.ts`) — local modifications
- Formatting tests (`src/formatting.test.ts`) — local modifications
