# Intent: src/router.ts modifications

## What this skill adds
Image indicator attribute in the XML message format sent to the agent.

## Key sections

### formatMessages function
- Added: `if (m.image_data) attrs.push('has-image="true"')` — signals to the agent that this message contains an image, so it can generate a description

## Invariants (must-keep)
- escapeXml unchanged
- Other message attributes (id, sender, time) unchanged
- stripInternalTags unchanged
- formatOutbound unchanged
- routeOutbound unchanged
- findChannel unchanged
