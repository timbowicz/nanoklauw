---
name: bitwarden
description: Look up, create, and manage passwords in Bitwarden vault. Use with agent-browser for website logins. Available when BW_SESSION is set.
allowed-tools: Bash(bw:*)
---

# Bitwarden Password Manager

## Prerequisites

Bitwarden is pre-configured when `BW_SESSION` is set. Check availability:

```bash
bw status | grep -q '"status":"unlocked"' && echo "READY" || echo "NOT AVAILABLE"
```

If not available, Bitwarden is not enabled for this group. Do not attempt to login manually.

## Look up credentials

```bash
# Search by name or URL
bw list items --search "example.com" --session "$BW_SESSION"

# Get specific fields
bw get username <item-id> --session "$BW_SESSION"
bw get password <item-id> --session "$BW_SESSION"
bw get totp <item-id> --session "$BW_SESSION"    # If TOTP is configured
bw get uri <item-id> --session "$BW_SESSION"
```

## Login to a website with agent-browser

1. Look up credentials:
   ```bash
   ITEM=$(bw list items --search "example.com" --session "$BW_SESSION" | jq '.[0]')
   USERNAME=$(echo "$ITEM" | jq -r '.login.username')
   PASSWORD=$(bw get password "$(echo "$ITEM" | jq -r '.id')" --session "$BW_SESSION")
   ```

2. Use agent-browser to fill the login form:
   ```bash
   agent-browser open "https://example.com/login"
   agent-browser snapshot -i
   agent-browser fill @username_ref "$USERNAME"
   agent-browser fill @password_ref "$PASSWORD"
   agent-browser click @submit_ref
   ```

3. Handle TOTP if needed:
   ```bash
   TOTP=$(bw get totp "<item-id>" --session "$BW_SESSION")
   agent-browser fill @totp_ref "$TOTP"
   agent-browser click @verify_ref
   ```

## Create new credentials

```bash
# Create a login item
bw get template item | jq \
  --arg name "New Service" \
  --arg user "user@example.com" \
  --arg pass "generated-password" \
  --arg uri "https://newservice.com" \
  '.name=$name | .type=1 | .login={username:$user,password:$pass,uris:[{uri:$uri}]}' \
  | bw encode | bw create item --session "$BW_SESSION"
```

## Update credentials

```bash
# Get current item, modify, and save
bw get item <item-id> --session "$BW_SESSION" \
  | jq '.login.password = "new-password"' \
  | bw encode | bw edit item <item-id> --session "$BW_SESSION"
```

## Generate a password

```bash
bw generate --length 20 --uppercase --lowercase --number --special
```

## Sync vault

```bash
bw sync --session "$BW_SESSION"
```

## Important

- Always pass `--session "$BW_SESSION"` to every `bw` command
- Never log or display passwords in output — use them directly in agent-browser fill commands
- After creating or updating items, run `bw sync` to push changes
- Passwords from `bw get password` are raw strings (no JSON wrapping)
