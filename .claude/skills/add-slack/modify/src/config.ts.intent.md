# Intent: src/config.ts modifications

## What changed
Added GATEWAY_CHANNEL configuration export for multi-channel support. This replaces upstream's SLACK_ONLY boolean with a 3-way mode selector.

## Key sections
- **readEnvFile call**: Must include `GATEWAY_CHANNEL` in the keys array. NanoClaw does NOT load `.env` into `process.env` — all `.env` values must be explicitly requested via `readEnvFile()`.
- **GATEWAY_CHANNEL**: String enum from `process.env` or `envConfig`, values: `whatsapp` (default), `slack`, `both`. Controls which channels are initialized in `channel-manager.ts`.
- **Note**: SLACK_BOT_TOKEN, SLACK_APP_TOKEN, and SLACK_SIGNING_SECRET are NOT read here. They are read directly by SlackChannel via `readEnvFile()` in `slack.ts` to keep secrets off the config module entirely (same pattern as ANTHROPIC_API_KEY in container-runner.ts).

## Invariants
- All existing config exports remain unchanged
- New Slack key is added to the `readEnvFile` call alongside existing keys
- New export is appended at the end of the file
- No existing behavior is modified — Slack config is additive only
- Both `process.env` and `envConfig` are checked (same pattern as `ASSISTANT_NAME`)

## Must-keep
- All existing exports (`ASSISTANT_NAME`, `POLL_INTERVAL`, `TRIGGER_PATTERN`, etc.)
- The `readEnvFile` pattern — ALL config read from `.env` must go through this function
- The `escapeRegex` helper and `TRIGGER_PATTERN` construction
