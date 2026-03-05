# /add-document-index

Adds semantic document search with RAG to NanoClaw. Files in group folders and Google Workspace cloud documents are automatically indexed and made searchable via vector embeddings.

## What it does

1. Watches group folders for file changes (real-time via chokidar)
2. Parses files (MD, TXT, PDF, DOCX, XLSX, CSV, JSON)
3. Chunks text into ~500-token overlapping segments
4. Embeds chunks with all-MiniLM-L6-v2 (local, no API costs)
5. Stores vectors in sqlite-vec for fast similarity search
6. Automatically injects relevant document chunks into agent prompts (RAG)
7. Syncs Google Workspace documents every 30 minutes
8. Provides IPC tools for agent-driven indexing and search

## Prerequisites

- NanoClaw base install
- Google Workspace integration (optional, for cloud docs)

## Installation

The skill modifies core files. Apply with Claude Code's skill system or manually:

1. Install dependencies: `npm install sqlite-vec @huggingface/transformers chokidar pdf-parse mammoth xlsx`
2. Copy `add/src/document-index.ts` to `src/`
3. Apply modifications to `src/db.ts`, `src/index.ts`, `src/ipc.ts`
4. Copy `container/skills/document-search.md`
5. Build: `npm run build`
6. Restart: `systemctl restart nanoklauw`

## Configuration

Per-group Google Workspace sync is configured via `groups/{name}/document-index.yaml`:

```yaml
doc_ids:
  - "1abc..."  # Google Doc IDs
sheet_ids:
  - "2def..."  # Google Sheet IDs
drive_folders:
  - "3ghi..."  # Google Drive folder IDs
```
