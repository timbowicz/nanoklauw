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
