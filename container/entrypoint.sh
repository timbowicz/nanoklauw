#!/bin/bash
set -e

# Read stdin into memory — never write secrets to disk.
# The JSON contains secrets (API keys) that the Node process needs.
INPUT=$(cat)

cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2
ln -s /app/node_modules /tmp/dist/node_modules
chmod -R a-w /tmp/dist

# Bitwarden: login and unlock if credentials are present (non-fatal)
# BW_ENABLED is set as a Docker env var; actual credentials come from stdin JSON
# All bw commands use </dev/null to avoid consuming stdin and || true to avoid set -e exits
if [ "$BW_ENABLED" = "1" ]; then
  BW_CLIENTID=$(printf '%s' "$INPUT" | jq -r '.secrets.BW_CLIENTID // empty')
  BW_CLIENTSECRET=$(printf '%s' "$INPUT" | jq -r '.secrets.BW_CLIENTSECRET // empty')
  BW_PASSWORD=$(printf '%s' "$INPUT" | jq -r '.secrets.BW_PASSWORD // empty')
  export BW_CLIENTID BW_CLIENTSECRET BW_PASSWORD

  if [ -n "$BW_CLIENTID" ]; then
    bw config server ${BW_SERVER:-https://vault.bitwarden.eu} </dev/null 2>/dev/null || true
    if bw login --apikey </dev/null 2>/dev/null; then
      BW_SESSION=$(bw unlock --passwordenv BW_PASSWORD --raw </dev/null 2>/dev/null) && export BW_SESSION && bw sync </dev/null 2>/dev/null || echo "Warning: Bitwarden unlock failed" >&2
    else
      echo "Warning: Bitwarden login failed" >&2
    fi
    # Clear credentials from environment after login
    unset BW_CLIENTID BW_CLIENTSECRET BW_PASSWORD
  fi
fi

# Pipe input to node via stdin. exec replaces the shell process.
# Secrets are held only in memory (bash variable + node sdkEnv), never on disk.
printf '%s' "$INPUT" | exec node /tmp/dist/index.js
