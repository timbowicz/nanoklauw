# Intent: Dockerfile modifications

## What this skill adds
Adds `@googleworkspace/cli` to the global npm install line.

## Key sections
- Line 40: `npm install -g` gains `@googleworkspace/cli`

## Invariants
- All existing global packages (agent-browser, claude-code, bitwarden) must remain
- Package install order doesn't matter

## Must-keep sections
- All existing RUN, COPY, ENV instructions unchanged
