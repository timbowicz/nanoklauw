# Document Search

Your workspace files are automatically indexed and searchable. Relevant document excerpts are included in your prompt when they match the user's message.

## Automatic Context

When a user asks a question, the system automatically searches through indexed documents in your group's folder and injects relevant excerpts into the prompt as `<documents>` XML blocks. You don't need to do anything to trigger this.

## Manual Search (IPC)

For deeper searches, write a JSON file to `/workspace/ipc/tasks/`:

### Search documents
```json
{
  "type": "document_search",
  "requestId": "unique-id",
  "query": "your search query",
  "top_k": 5
}
```

Response appears in `/workspace/ipc/input/res-{requestId}.json`.

### Request file indexing
If you create or receive a new document, request it to be indexed:

```json
{
  "type": "index_file",
  "path": "/workspace/group/path/to/file.pdf"
}
```

## Indexed File Types

- Text: `.md`, `.txt`
- Documents: `.pdf`, `.docx`
- Data: `.xlsx`, `.csv`, `.json`
- Google Workspace: Docs, Sheets, Drive files (synced periodically)

## Document Snapshot

Check `/workspace/ipc/document_snapshot.json` to see what's currently indexed:

```json
{
  "indexed_documents": [
    { "path": "contract.pdf", "source": "local", "chunks": 12, "updated": "2026-03-05T10:00:00Z" }
  ],
  "total_chunks": 45,
  "last_sync": "2026-03-05T10:05:00Z"
}
```
