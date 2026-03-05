---
name: gws-gmail
description: "Send, read, search, and manage Gmail messages, drafts, and labels."
allowed-tools: Bash(gws:*)
---

# Gmail — gws gmail

Prerequisite: read the gws-shared skill for auth and CLI basics.

## Quick Start

```bash
# Triage: show unread inbox summary
gws gmail +triage

# Send an email
gws gmail +send --to "user@example.com" --subject "Hello" --body "Message body"

# Search messages
gws gmail users messages list --params '{"userId": "me", "q": "from:someone@example.com is:unread"}'
```

## Helper Commands

| Command | Description |
|---------|-------------|
| `gws gmail +triage` | Show unread inbox summary |
| `gws gmail +send` | Send an email |
| `gws gmail +watch` | Monitor incoming emails (NDJSON) |

## Common Operations

```bash
# List messages (returns IDs, need separate get for content)
gws gmail users messages list --params '{"userId": "me", "maxResults": 10}'

# Search messages
gws gmail users messages list --params '{"userId": "me", "q": "subject:invoice after:2026/01/01"}'

# Get message content
gws gmail users messages get --params '{"userId": "me", "id": "<MSG_ID>", "format": "full"}'

# Send an email
gws gmail +send --to "recipient@example.com" --subject "Subject" --body "Body text"

# Create a draft
gws gmail users drafts create --params '{"userId": "me"}' \
  --json '{"message": {"raw": "<base64-encoded-email>"}}'

# List labels
gws gmail users labels list --params '{"userId": "me"}'

# Modify labels (mark read/archive)
gws gmail users messages modify --params '{"userId": "me", "id": "<MSG_ID>"}' \
  --json '{"removeLabelIds": ["UNREAD"]}'

# Trash a message
gws gmail users messages trash --params '{"userId": "me", "id": "<MSG_ID>"}'

# Get user profile
gws gmail users getProfile --params '{"userId": "me"}'
```

## Search Query Syntax

Gmail search queries support:
- `from:`, `to:`, `subject:`, `has:attachment`
- `is:unread`, `is:starred`, `is:important`
- `after:YYYY/MM/DD`, `before:YYYY/MM/DD`
- `label:`, `category:primary`, `in:inbox`
- Boolean: `OR`, `-` (exclude), `()` grouping

## Discovery

```bash
gws gmail --help
gws schema gmail.users.messages.list
gws schema gmail.users.messages.send
```
