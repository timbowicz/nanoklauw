---
name: memory-tools
description: Store, update, remove, and search persistent memories across conversations using IPC-based memory tools
---

# Memory Tools

You have a three-layer memory system for storing and retrieving information across conversations.

## Memory Layers

1. **Core Memories** — Discrete facts, preferences, and instructions. Always injected into your context automatically.
2. **Conversation Memory** — Past message chunks embedded for semantic retrieval. Automatic — no action needed.
3. **Archival Memory** — Session summaries for deep historical recall.

## Available Tools

All memory operations use IPC files written to `/workspace/ipc/memory/`.

### memory_add — Store a new fact

```json
{
  "type": "memory_add",
  "category": "preference",
  "content": "Tim prefers dark mode in all applications"
}
```

Categories are free-form strings. Common categories: `preference`, `fact`, `instruction`, `context`, `person`.

### memory_update — Update an existing memory

```json
{
  "type": "memory_update",
  "memoryId": "uuid-of-existing-memory",
  "content": "Tim now prefers light mode"
}
```

Use the memory snapshot (`/workspace/ipc/memory_snapshot.json`) to find memory IDs.

### memory_remove — Delete a memory

```json
{
  "type": "memory_remove",
  "memoryId": "uuid-of-existing-memory"
}
```

### memory_search — Search across all memory layers

```json
{
  "type": "memory_search",
  "query": "What does Tim prefer for UI themes?",
  "scope": "all",
  "limit": 10,
  "requestId": "search-001"
}
```

- `scope`: `"all"` (default), `"facts"`, or `"conversations"`
- `limit`: max results (1-50, default 10)
- `requestId`: required, used to read the response

Response will be written to `/workspace/ipc/input/res-{requestId}.json`.

## Memory Snapshot

Before each invocation, a snapshot of your core memories is written to `/workspace/ipc/memory_snapshot.json`. Use this to see existing memory IDs for update/remove operations.

## Best Practices

- Store important facts the user tells you (preferences, names, context)
- Update memories when information changes rather than creating duplicates
- Use descriptive categories to organize memories
- Search memory when you need to recall past context
- Memory is per-group isolated — each group has its own memory space
