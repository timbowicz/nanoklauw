# Bitwarden CLI Integration Design

## Goal

Give agents access to Bitwarden password vault via the `bw` CLI so they can look up credentials for browser automation (agent-browser) and create/update entries when signing up for new services.

## Approach: CLI in container with persistent vault cache

Install `bw` in the Docker image. Pass Bitwarden credentials via the existing stdin secrets pipeline. Mount a per-group cache directory so the vault doesn't need a full re-sync on every container start.

## Components

### 1. Dockerfile

Add `@bitwarden/cli` to the global npm install line:

```dockerfile
RUN npm install -g agent-browser @anthropic-ai/claude-code @bitwarden/cli
```

### 2. Secrets (`src/config.ts`)

Add to `CONTAINER_SECRETS`:

- `BW_CLIENTID` — Bitwarden API key client ID
- `BW_CLIENTSECRET` — Bitwarden API key client secret
- `BW_PASSWORD` — Master password for vault unlock

Passed via stdin (never written to disk, never mounted as files).

### 3. Persistent vault cache (`src/container-runner.ts`)

New mount in `buildVolumeMounts()`, conditional on group config:

```
data/bitwarden/{group.folder}/ -> /home/node/.config/Bitwarden CLI/
```

- Created with `chown 1000:1000` (container runs as `node` uid 1000)
- Only mounted when group has `bitwarden: true` in container config
- Groups without the flag get no Bitwarden access or credentials

### 4. Entrypoint (`container/Dockerfile`)

Add conditional Bitwarden setup before the agent starts:

```bash
if [ -n "$BW_CLIENTID" ]; then
  bw login --apikey 2>/dev/null || true
  export BW_SESSION=$(bw unlock --passwordenv BW_PASSWORD --raw)
  bw sync
fi
```

- Login is a no-op if the cached session is still valid
- `BW_SESSION` is exported for all subsequent `bw` commands
- `bw sync` pulls latest changes from the Bitwarden cloud

### 5. Container skill (`container/skills/bitwarden/SKILL.md`)

Teaches the agent how to:

- `bw list items --search <query>` — find credentials
- `bw get password <id>` — retrieve a password
- `bw get username <id>` — retrieve a username
- `bw get totp <id>` — get TOTP code if configured
- `bw create item <json>` — create new vault entries
- `bw edit item <id> <json>` — update existing entries
- Pipe credentials into agent-browser for website logins

### 6. Group configuration

Add `bitwarden: boolean` to group container config. Controls:

- Whether the Bitwarden cache directory is mounted
- Whether BW_* secrets are passed to the container's environment
- Default: `false` (opt-in per group)

## Security considerations

- Master password is in container memory briefly but never on disk
- Consistent with existing secrets model (API keys also passed via stdin)
- Per-group isolation: each group has its own cache directory
- Containers are ephemeral; BW_SESSION token dies with the container
- Read-write vault access: agent can create/update entries

## Trade-offs

- **Latency**: First run for a group does a full vault sync. Subsequent runs only sync deltas (fast).
- **Stale cache**: If vault changes externally, the `bw sync` in the entrypoint catches up.
- **Persistent mount**: Adds one more directory to manage (`data/bitwarden/`), with the same ownership pattern as `data/sessions/` and `data/ipc/`.
