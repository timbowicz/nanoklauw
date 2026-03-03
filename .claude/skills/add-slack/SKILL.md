---
name: add-slack
description: Add Slack as an input channel without removing WhatsApp. Uses the pluggable channel registry for auto-detection. Supports auto-registration for Slack channels/DMs, ephemeral status updates, and /abort to cancel long-running processing.
---

# Add Slack Channel

This skill adds Slack support to NanoClaw using the pluggable channel registry pattern, then walks through interactive setup.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `slack` is in `applied_skills`, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

**Do they already have a Slack app configured?** If yes, collect the Bot Token and App Token now. If no, we'll create one in Phase 3.

## Phase 2: Apply Code Changes

Run the skills engine to apply this skill's code package. The package files are in this directory alongside this SKILL.md.

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

Or call `initSkillsSystem()` from `skills-engine/migrate.ts`.

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-slack
```

This deterministically:
- Adds `src/channels/slack.ts` (SlackChannel class implementing Channel interface, with self-registration via `registerChannel()`)
- Adds `src/channels/slack.test.ts` (unit tests)
- Three-way merges `src/channels/index.ts` to add the Slack import for self-registration
- Installs the `@slack/bolt` npm dependency
- Updates `.env.example` with `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_SIGNING_SECRET`
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent files:
- `modify/src/channels/index.ts.intent.md` — what changed for the barrel file

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass (including the new slack tests) and build must be clean before proceeding.

## Phase 3: Setup

### Create Slack App (if needed)

If the user doesn't have a Slack app, share [SLACK_SETUP.md](SLACK_SETUP.md) which has step-by-step instructions with screenshots guidance, troubleshooting, and a token reference table.

Alternatively, import the app manifest at `references/slack-app-manifest.yaml` in Slack App settings for quick setup.

Quick summary of what's needed:
1. Create a Slack app at [api.slack.com/apps](https://api.slack.com/apps)
2. Enable Socket Mode and generate an App-Level Token (`xapp-...`)
3. Subscribe to bot events: `message.channels`, `message.groups`, `message.im`
4. Add OAuth scopes: `chat:write`, `channels:history`, `groups:history`, `im:history`, `channels:read`, `groups:read`, `users:read`
5. Install to workspace and copy the Bot Token (`xoxb-...`)

Wait for the user to provide both tokens.

### Configure environment

Add to `.env`:

```bash
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token
SLACK_SIGNING_SECRET=your-signing-secret
```

Channels auto-detect from credentials: if Slack tokens are present in `.env`, the Slack channel starts automatically. No `GATEWAY_CHANNEL` setting needed.

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

The container reads environment from `data/env/env`, not `.env` directly.

### Build and restart

```bash
npm run build
systemctl restart nanoklauw
```

## Phase 4: Registration

Slack channels auto-register on first interaction:
- **DMs**: Register immediately on first message
- **Public/private channels**: Register on first @mention of the bot

No manual registration needed. The bot creates a group folder with a slugified channel name.

### Manual registration (if needed)

For manual control, use the IPC register flow. The JID format is `slack:<channel-id>`:

```typescript
registerGroup("slack:<channel-id>", {
  name: "<channel-name>",
  folder: "slack_<channel-name>",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: true,
});
```

## Phase 5: Verify

### Test the connection

Tell the user:

> Send a message in a Slack channel where the bot is present:
> - @mention the bot to trigger auto-registration and get a response
> - In DMs, any message works
>
> The bot should respond within a few seconds.

### Check logs if needed

```bash
journalctl -u nanoklauw -f
```

## Troubleshooting

### Bot not responding

1. Check `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, and `SLACK_SIGNING_SECRET` are set in `.env`
2. Check channel is registered: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'slack:%'"`
3. Service is running: `systemctl status nanoklauw`

### Bot connected but not receiving messages

1. Verify Socket Mode is enabled in the Slack app settings
2. Verify the bot is subscribed to the correct events (`message.channels`, `message.groups`, `message.im`)
3. Verify the bot has been added to the channel
4. Check that the bot has the required OAuth scopes

### /abort not working

1. Check the `/abort` slash command is configured in the Slack app settings
2. Text fallback: type `abort` or `@bot abort` as a regular message
3. Check logs for abort handling errors

### Getting channel ID

If the channel ID is needed:
- In Slack desktop: right-click channel -> **Copy link** -> extract the `C...` ID from the URL
- In Slack web: the URL shows `https://app.slack.com/client/TXXXXXXX/C0123456789`
- Via API: `curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" "https://slack.com/api/conversations.list" | jq '.channels[] | {id, name}'`

## After Setup

The Slack channel supports:
- **Public channels** — Bot must be added to the channel
- **Private channels** — Bot must be invited to the channel
- **Direct messages** — Users can DM the bot directly
- **Multi-channel** — Both WhatsApp and Slack run simultaneously when credentials are present
- **Auto-registration** — Channels register on first bot mention, DMs on first message
- **/abort** — Cancel active processing via slash command or text
- **Hourglass typing** — Emoji reaction on trigger message while processing
- **Thread tracking** — Bot-active threads auto-trigger on replies

## Known Limitations

- **Message splitting is naive** — Long messages are split at a fixed 4000-character boundary, which may break mid-word or mid-sentence.
- **No file/image handling** — File uploads are noted as placeholders (`[Image: name]`, `[File: name]`) but not forwarded as binary data.
- **Channel metadata sync is unbounded** — `syncChannelMetadata()` paginates through all channels but has no upper bound or timeout.
