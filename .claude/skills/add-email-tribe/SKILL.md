# Email IMAP + Tribe CRM Integration

Polls 1-3 IMAP mailboxes, delivers emails to the main group, and instructs the agent to triage them using Tribe CRM.

## Setup

1. Add IMAP credentials to `.env` (up to 3 accounts):
   ```
   IMAP_HOST_1=imap.example.com
   IMAP_USER_1=user@example.com
   IMAP_PASS_1=password
   IMAP_PORT_1=993
   IMAP_TLS_1=true
   ```

2. Add Tribe CRM credentials to `.env` (if not already present):
   ```
   TRIBE_CLIENT_ID=your-client-id
   TRIBE_CLIENT_SECRET=your-client-secret
   ```

3. Rebuild and restart:
   ```bash
   npm run build && ./container/build.sh && systemctl restart nanoklauw
   ```

## Components

- `src/channels/email.ts` — IMAP polling channel (self-registers via registry)
- `container/skills/email-triage/SKILL.md` — Agent skill for email processing
- Tribe MCP server wired into agent-runner mcpServers config
