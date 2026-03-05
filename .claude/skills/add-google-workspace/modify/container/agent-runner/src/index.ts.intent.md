# Intent: agent-runner index.ts modifications

## What this skill adds
Nothing — this skill does NOT add an MCP server. gws is used via Bash, not MCP.

## Note for gmail skill users
If the gmail skill (MCP-based) is also applied, this skill's `conflicts: [gmail]` in the manifest prevents co-installation. The gws-gmail agent skill replaces the Gmail MCP server.

## Invariants
- All existing MCP servers (nanoclaw, etc.) must remain
- `mcp__*` wildcard in allowedTools stays (used by other MCP servers)
