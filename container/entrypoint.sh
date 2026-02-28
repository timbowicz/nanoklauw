#!/bin/bash
set -e

# Save stdin immediately — later commands (e.g. bw) can consume stdin
cat > /tmp/input.json
chmod 600 /tmp/input.json

cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2
ln -s /app/node_modules /tmp/dist/node_modules
chmod -R a-w /tmp/dist

# Bitwarden: login and unlock if credentials are present (non-fatal)
# BW_ENABLED is set as a Docker env var; actual credentials come from stdin JSON
# All bw commands use </dev/null to avoid consuming stdin and || true to avoid set -e exits
if [ "$BW_ENABLED" = "1" ]; then
  BW_CLIENTID=$(jq -r '.secrets.BW_CLIENTID // empty' /tmp/input.json)
  BW_CLIENTSECRET=$(jq -r '.secrets.BW_CLIENTSECRET // empty' /tmp/input.json)
  BW_PASSWORD=$(jq -r '.secrets.BW_PASSWORD // empty' /tmp/input.json)
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

node /tmp/dist/index.js < /tmp/input.json
