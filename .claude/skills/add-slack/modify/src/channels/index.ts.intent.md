# Intent: channels/index.ts modifications

## What this skill adds
Adds the Slack channel import to the barrel file so it self-registers on startup.

## Key sections
- Added `import './slack.js'` line

## Invariants
- The WhatsApp import must remain
- Order of imports doesn't matter (registration order = discovery order)

## Must-keep sections
- `import './whatsapp.js'` — core channel
