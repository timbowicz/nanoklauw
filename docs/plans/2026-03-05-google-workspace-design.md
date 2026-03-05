# Google Workspace Integration — Design

**Date:** 2026-03-05
**Status:** Approved

## Goal

Add Google Workspace access (Sheets, Drive, Docs, Gmail) to all NanoClaw agents via the official `gws` CLI. Package as an upstream-compatible skill. Replace the existing Gmail MCP server.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Tool | `gws` CLI (googleworkspace/cli) | Official Google project, CLI + skills, actively maintained |
| Integration mode | Skills + CLI (not MCP) | 100+ pre-built SKILL.md files, richer agent context than MCP tool descriptions, no sidecar process |
| Services | Sheets, Drive, Docs, Gmail | User-selected. Gmail replaces existing MCP |
| Auth | OAuth via SSH tunnel | Same pattern as Gmail setup. One-time browser flow, token auto-refreshes |
| Access | All groups | RW for main group (token refresh), RO for others |
| Gmail migration | Remove `@gongrzhe/server-gmail-autoauth-mcp` | gws-gmail skill replaces it via CLI |

## Architecture

```
Host                              Container
~/.gws/ (OAuth creds)  ──mount──▶ /home/node/.gws/
                                    ├── RW (main group)
                                    └── RO (other groups)

container/skills/gws-*  ──sync──▶ /home/node/.claude/skills/gws-*
                                    (auto-discovered by SDK)

gws binary (npm global) ──────▶  Agent calls via Bash:
                                    gws sheets spreadsheets-values get ...
                                    gws drive files list ...
                                    gws docs documents get ...
                                    gws gmail messages list ...
```

## File Changes

### Modified files

| File | Change |
|------|--------|
| `container/Dockerfile` | Install `@anthropic/gws` globally via npm |
| `container/agent-runner/src/index.ts` | Remove `gmail` MCP server entry from mcpServers config |
| `src/container-runner.ts` | Replace `~/.gmail-mcp` mount with `~/.gws` mount |

### New files

| File | Purpose |
|------|---------|
| `container/skills/gws-shared/SKILL.md` | Auth, CLI syntax, global flags reference |
| `container/skills/gws-sheets/SKILL.md` | Sheets CRUD operations |
| `container/skills/gws-drive/SKILL.md` | Drive file management |
| `container/skills/gws-docs/SKILL.md` | Docs read/write |
| `container/skills/gws-gmail/SKILL.md` | Gmail (replaces MCP) |

### Removed

| Item | What |
|------|------|
| `~/.gmail-mcp/` mount | Replaced by `~/.gws/` mount |
| Gmail MCP server config | Replaced by gws-gmail skill |

## Upstream Skill Package

```
.claude/skills/add-google-workspace/
├── SKILL.md                              # Setup guide
├── manifest.yaml                         # Metadata
├── add/
│   └── container/skills/
│       ├── gws-shared/SKILL.md
│       ├── gws-sheets/SKILL.md
│       ├── gws-drive/SKILL.md
│       ├── gws-docs/SKILL.md
│       └── gws-gmail/SKILL.md
├── modify/
│   ├── container/
│   │   ├── Dockerfile
│   │   ├── Dockerfile.intent.md
│   │   └── agent-runner/src/
│   │       ├── index.ts
│   │       └── index.ts.intent.md
│   └── src/
│       ├── container-runner.ts
│       └── container-runner.ts.intent.md
└── tests/
    └── gws.test.ts
```

## Auth Flow

1. SSH tunnel: `ssh -L 3000:localhost:3000 server`
2. On server: `gws auth login`
3. Credentials saved to `~/.gws/`
4. Container mounts `~/.gws/` → `/home/node/.gws/`

## Credential Security

- Main group: RW mount (allows token auto-refresh)
- Other groups: RO mount (prevents exfiltration)
- Secrets never passed as Docker env vars
- Same pattern as existing Gmail MCP credentials
