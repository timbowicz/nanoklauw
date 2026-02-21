# Intent: src/config.ts modifications

## What this skill adds
Slack-specific environment variable configuration and multi-channel gateway mode.

## Key sections

### .env reading (top of file)
- Added: `'GATEWAY_CHANNEL'`, `'SLACK_BOT_TOKEN'`, `'SLACK_APP_TOKEN'`, `'SLACK_SIGNING_SECRET'` to `readEnvFile()` call

### Exports
- Added: `GATEWAY_CHANNEL` — controls which channels to activate (`'whatsapp'` | `'slack'` | `'both'`), defaults to `'whatsapp'`
- Added: `SLACK_BOT_TOKEN` — Slack Bot User OAuth Token (`xoxb-...`)
- Added: `SLACK_APP_TOKEN` — Slack App-Level Token for Socket Mode (`xapp-...`)
- Added: `SLACK_SIGNING_SECRET` — Slack Signing Secret for request verification

## Invariants (must-keep)
- All existing config exports unchanged (ASSISTANT_NAME, POLL_INTERVAL, paths, container config, etc.)
- `readEnvFile` call format unchanged — just more keys in the array
- Timezone, trigger pattern, container settings all unchanged
