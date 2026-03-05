# Document Index — Design Document

**Date**: 2026-03-05
**Status**: Approved

## Problem

Each agent group has a folder with files (contracts, plans, notes, PDFs, spreadsheets) plus access to Google Workspace cloud documents. Currently, agents have no awareness of this content unless it's manually referenced. Loading all files into the context window is not feasible — we need semantic search over document content with automatic RAG injection.

## Solution

A standalone document indexing skill that:
1. Watches group folders for file changes (real-time via chokidar)
2. Periodically syncs Google Workspace documents (via gws CLI)
3. Chunks, embeds, and stores document content in sqlite-vec
4. Automatically injects relevant document chunks into agent prompts (RAG)
5. Provides IPC tools for agent-driven indexing and search

## Architecture

```
groups/{name}/              ← file watcher monitors all group folders
  ├── contract.pdf
  ├── planning.md
  └── notes.txt
        │
        ▼
  [File Watcher] ──debounce──→ [Chunker + Parser]
                                      │
  [GWS Sync]  ──every 30 min──→ [Chunker + Parser]
                                      │
                                      ▼
                                [Embedder]
                                (all-MiniLM-L6-v2, 384 dims)
                                      │
                                      ▼
                                [sqlite-vec]
                                document_chunks table
                                document_chunks_vec table
                                      │
          ┌───────────────────────────┘
          ▼
    [RAG Retrieval]  ←── triggered on every agent invocation
          │
          ▼
    prompt = documentContext + memoryContext + formatMessages()
```

### New Files

- `src/document-index.ts` — chunking, embedding, indexing, search, file watching, GWS sync

### Modified Files

- `src/db.ts` — load sqlite-vec extension, document schema tables
- `src/index.ts` — start file watcher, RAG retrieval before agent invocation
- `src/ipc.ts` — `index_file` and `document_search` IPC handlers
- `src/task-scheduler.ts` — GWS document sync scheduled task

### Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `sqlite-vec` | `^0.1.7-alpha.2` | Vector search in SQLite |
| `@huggingface/transformers` | `^3.8.1` | Local embeddings (all-MiniLM-L6-v2) |
| `chokidar` | `^4.0` | File system watching |
| `pdf-parse` | `^1.1.1` | PDF text extraction |
| `mammoth` | `^1.8` | DOCX to plain text |
| `xlsx` | `^0.18` | Excel spreadsheet parsing |

## Supported File Formats

| Format | Parser | Source |
|--------|--------|--------|
| `.md`, `.txt` | Built-in | Local |
| `.pdf` | `pdf-parse` | Local + Drive |
| `.docx` | `mammoth` | Local + Drive |
| `.xlsx`, `.csv` | `xlsx` / built-in | Local + Drive |
| `.json` | Built-in | Local |
| Google Docs | `gws docs export` | Cloud |
| Google Sheets | `gws sheets export` → CSV | Cloud |
| Drive files | `gws drive download` → existing parsers | Cloud |

### Excluded

- Binary files (images, audio, video)
- Files > 10MB (configurable)
- `node_modules/`, `.git/`, `logs/` directories
- Dotfiles (`.env`, `.mcp.json`)

## Chunking Strategy

- **Chunk size**: ~500 tokens (~2000 chars) with 100 token overlap
- **Markdown/text**: split on headers (h1/h2/h3) as natural boundaries, fallback to paragraphs
- **PDF**: split on pages, then paragraphs within pages
- **CSV/XLSX**: each row/record is a chunk (with header as context)
- **JSON**: top-level entries as chunks
- Each chunk stores metadata: `{ filePath, groupFolder, chunkIndex, totalChunks, fileHash }`
- **Deduplication**: SHA-256 file hash prevents re-indexing unchanged files

## Database Schema

```sql
CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  group_folder TEXT NOT NULL,
  file_path TEXT NOT NULL,
  source TEXT NOT NULL,           -- 'local' | 'google-drive' | 'google-docs' | 'google-sheets'
  source_id TEXT,                 -- Google Drive/Docs ID (null for local)
  file_hash TEXT NOT NULL,
  file_size INTEGER,
  mime_type TEXT,
  chunk_count INTEGER DEFAULT 0,
  indexed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE document_chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id),
  group_folder TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  metadata TEXT,                  -- JSON: page number, section header, etc.
  created_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE document_chunks_vec USING vec0(
  chunk_id TEXT PRIMARY KEY,
  embedding FLOAT[384]
);
```

## Search & RAG

### Automatic RAG (every agent invocation)

```typescript
async function retrieveDocumentContext(
  groupFolder: string,
  messages: NewMessage[],
  topK: number = 5
): Promise<string>
```

1. Build query string from incoming messages (max 500 chars)
2. Embed query with all-MiniLM-L6-v2
3. Vector similarity search filtered by group_folder
4. Return XML-formatted context:

```xml
<documents>
  <chunk file="planning.md" section="Q2 Goals" relevance="0.87">
    Content here...
  </chunk>
  <chunk file="contract.pdf" page="3" relevance="0.82" source="local">
    Payment terms are 30 days...
  </chunk>
  <chunk file="Budget 2026" relevance="0.79" source="google-sheets">
    Marketing budget: €45,000...
  </chunk>
</documents>
```

### Context injection order

```
prompt = documentContext + memoryContext + formatMessages(missedMessages)
```

## File Watcher

```typescript
const watcher = chokidar.watch('groups/**/*', {
  ignored: ['**/node_modules/**', '**/.git/**', '**/logs/**', '**/.*'],
  persistent: true,
  ignoreInitial: false,           // index existing files at startup
  awaitWriteFinish: { stabilityThreshold: 2000 }  // debounce
});
```

- **add**: queue for indexing
- **change**: re-index if hash differs
- **unlink**: remove document + chunks from DB
- Queue with deduplication prevents double work
- Concurrency limit: max 3 files indexing simultaneously

## Google Workspace Sync

- Runs every 30 minutes via task-scheduler
- Per group: reads `document-index.yaml` for Drive folder IDs / doc IDs to sync
- Exports to temp files → parse → chunk → embed → cleanup
- Only re-indexes if `modifiedTime` > `updated_at` in DB
- Graceful failure: logs warning on credential expiry, retries next interval

## IPC Tools

### `index_file` — Agent requests file indexing

```json
{ "type": "index_file", "path": "/workspace/group/new-report.pdf" }
```

Host resolves path to group folder, parses, chunks, and embeds the file.

### `document_search` — Agent searches documents

Request:
```json
{ "type": "document_search", "query": "payment terms client X", "top_k": 5 }
```

Response (`res-{id}.json`):
```json
{
  "results": [
    {
      "file": "contract-client-x.pdf",
      "page": 3,
      "content": "Payment terms are 30 days...",
      "relevance": 0.87,
      "source": "local"
    }
  ]
}
```

### Document Snapshot

Written to `{ipcDir}/document_snapshot.json` before each agent invocation:

```json
{
  "indexed_documents": [
    { "path": "planning.md", "source": "local", "chunks": 4, "updated": "2026-03-05T10:00:00Z" },
    { "path": "Budget 2026", "source": "google-sheets", "chunks": 12, "updated": "2026-03-05T09:30:00Z" }
  ],
  "total_chunks": 156,
  "last_sync": "2026-03-05T10:05:00Z"
}
```

## Edge Cases

| Situation | Handling |
|-----------|----------|
| File deleted | All chunks + vectors removed from DB |
| File renamed | Old path removed, new path indexed |
| Large file (>10MB) | Logged + skipped, configurable limit |
| Corrupt PDF | Error caught, file skipped with warning |
| Embedding model not loaded | Lazy-load on first indexing, cached in `data/models/` |
| Bulk file additions | Queue with concurrency limit (max 3 simultaneous) |
| Group deleted | All documents + chunks for that group cleaned up |
| GWS credentials expired | Sync fails gracefully, logs warning, retries next interval |

## Performance

- **Embedding**: ~50ms per chunk on CPU (all-MiniLM-L6-v2 is small and fast)
- **Startup**: existing files indexed in parallel, non-blocking
- **Search**: sqlite-vec is in-memory, <10ms for top-k over thousands of chunks
- **Disk**: ~1.5KB per chunk (384 floats + text)

## Skill Package Structure

```
.claude/skills/add-document-index/
├── SKILL.md
├── manifest.yaml
├── add/
│   └── src/document-index.ts
├── modify/
│   ├── src/db.ts
│   ├── src/db.ts.intent.md
│   ├── src/index.ts
│   ├── src/index.ts.intent.md
│   ├── src/ipc.ts
│   ├── src/ipc.ts.intent.md
│   ├── src/task-scheduler.ts
│   └── src/task-scheduler.ts.intent.md
└── tests/
    └── add-document-index.test.ts
```
