---
name: reactions
description: React to WhatsApp messages with emoji. Use when acknowledging a message, showing progress, or giving quick feedback.
---

# Reactions

React to messages with emoji using the `mcp__nanoclaw__react_to_message` tool.

## When to use

- **Always** react with 👀 when you start processing a message (so the user knows you've seen it)
- Quick acknowledgment when a full text reply isn't needed
- Expressing agreement, approval, or emotion about a specific message
- User explicitly asks you to react

## How to use

### React to the latest message

Omit `message_id` to react to the most recent message in the chat.

### Remove a reaction

Send an empty string emoji to remove your reaction.

## Common emoji

| Emoji | When to use |
|-------|-------------|
| 👀 | I've seen your message, working on it |
| 👍 | Acknowledgment, approval |
| ✅ | Task done, confirmed |
| ❤️ | Appreciation |
| 🔥 | Impressive, exciting |
| 🎉 | Celebration, congrats |
