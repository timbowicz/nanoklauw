# Intent: container-runner.ts modifications

## What this skill adds
Mounts `~/.config/gws/` (Google Workspace CLI credentials) into the container at `/home/node/.config/gws/`. Also sets `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE` env var pointing to the mounted credentials.

## Key sections
- `buildVolumeMounts()`: conditional mount of `~/.config/gws` with RW for main, RO for others. `buildDockerArgs()`: sets `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE` env var

## Invariants
- All other mounts (session, group, global, IPC, bitwarden) must remain
- Mount security pattern: RW for main group, RO for others

## Must-keep sections
- All existing volume mount logic unchanged
- `syncSkillsToGroup()` call before mounts
