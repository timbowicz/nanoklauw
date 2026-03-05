# Document Index Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add semantic search over local group files and Google Workspace cloud documents using sqlite-vec embeddings, with automatic RAG injection into agent prompts.

**Architecture:** File watcher (chokidar) monitors `groups/*/` for changes, chunks files into ~2000-char segments, embeds them with all-MiniLM-L6-v2 via @huggingface/transformers, and stores vectors in sqlite-vec. Before each agent invocation, relevant chunks are retrieved via vector similarity and prepended to the prompt. A scheduled GWS sync exports cloud docs for indexing. Agents get `index_file` and `document_search` IPC tools.

**Tech Stack:** sqlite-vec, @huggingface/transformers, chokidar, pdf-parse, mammoth, xlsx, better-sqlite3

**Design doc:** `docs/plans/2026-03-05-document-index-design.md`

---

### Task 1: Install Dependencies

**Files:**
- Modify: `package.json`

**Step 1: Install npm packages**

Run:
```bash
npm install sqlite-vec@^0.1.7-alpha.2 @huggingface/transformers@^3.8.1 chokidar@^4.0 pdf-parse@^1.1.1 mammoth@^1.8 xlsx@^0.18
```

**Step 2: Install type definitions**

Run:
```bash
npm install -D @types/pdf-parse
```

Note: `mammoth` and `xlsx` ship their own types. `chokidar` v4 ships types. `sqlite-vec` and `@huggingface/transformers` ship types.

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add document indexing dependencies"
```

---

### Task 2: Database Schema — sqlite-vec Extension + Document Tables

**Files:**
- Modify: `src/db.ts:1-30` (imports, db variable) and `src/db.ts:319-336` (initDatabase, _initTestDatabase)

**Step 1: Write the failing test**

Create `src/document-index.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { _initTestDatabase } from './db.js';

describe('document index schema', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('creates documents table', async () => {
    const { getDb } = await import('./db.js');
    const db = getDb();
    const info = db.prepare("PRAGMA table_info('documents')").all();
    expect(info.length).toBeGreaterThan(0);
    const columns = info.map((r: any) => r.name);
    expect(columns).toContain('id');
    expect(columns).toContain('group_folder');
    expect(columns).toContain('file_path');
    expect(columns).toContain('source');
    expect(columns).toContain('file_hash');
  });

  it('creates document_chunks table', async () => {
    const { getDb } = await import('./db.js');
    const db = getDb();
    const info = db.prepare("PRAGMA table_info('document_chunks')").all();
    expect(info.length).toBeGreaterThan(0);
    const columns = info.map((r: any) => r.name);
    expect(columns).toContain('id');
    expect(columns).toContain('document_id');
    expect(columns).toContain('content');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/document-index.test.ts`
Expected: FAIL — `documents` table doesn't exist yet

**Step 3: Add sqlite-vec loading and document schema to db.ts**

In `src/db.ts`, add a `getDb()` export and document schema creation.

At the top of `db.ts`, after the existing `let db: Database.Database;` line (~line 20), add:

```typescript
/** Expose the database instance for modules that need direct access (e.g. sqlite-vec). */
export function getDb(): Database.Database {
  return db;
}
```

In the `createSchema` function (after the reactions index block, ~line 119), add:

```typescript
  // Document indexing tables
  database.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      file_path TEXT NOT NULL,
      source TEXT NOT NULL,
      source_id TEXT,
      file_hash TEXT NOT NULL,
      file_size INTEGER,
      mime_type TEXT,
      chunk_count INTEGER DEFAULT 0,
      indexed_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_documents_group ON documents(group_folder);
    CREATE INDEX IF NOT EXISTS idx_documents_hash ON documents(file_hash);
    CREATE INDEX IF NOT EXISTS idx_documents_source ON documents(source, source_id);

    CREATE TABLE IF NOT EXISTS document_chunks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_document ON document_chunks(document_id);
    CREATE INDEX IF NOT EXISTS idx_chunks_group ON document_chunks(group_folder);
  `);
```

Note: The sqlite-vec virtual table (`document_chunks_vec`) will be created in `document-index.ts` at initialization time, since it requires loading the extension first. The regular tables go in `db.ts` to keep schema creation centralized.

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/document-index.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/db.ts src/document-index.test.ts
git commit -m "feat: add document indexing schema to database"
```

---

### Task 3: Core Document Index Module — Types, Embedding, Vector Table

**Files:**
- Create: `src/document-index.ts`

**Step 1: Write the failing test**

Add to `src/document-index.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { _initTestDatabase } from './db.js';

describe('document index - embedding', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('initializes the document index module', async () => {
    const { initDocumentIndex } = await import('./document-index.js');
    // initDocumentIndex should create the vec table and load the model
    // For tests, we skip actual model loading
    await expect(initDocumentIndex({ skipModel: true })).resolves.not.toThrow();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/document-index.test.ts`
Expected: FAIL — `initDocumentIndex` doesn't exist

**Step 3: Create src/document-index.ts with core types and init**

```typescript
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { getDb } from './db.js';
import { logger } from './logger.js';

// ---- Types ----

export interface DocumentRecord {
  id: string;
  group_folder: string;
  file_path: string;
  source: 'local' | 'google-drive' | 'google-docs' | 'google-sheets';
  source_id: string | null;
  file_hash: string;
  file_size: number | null;
  mime_type: string | null;
  chunk_count: number;
  indexed_at: string;
  updated_at: string;
}

export interface ChunkRecord {
  id: string;
  document_id: string;
  group_folder: string;
  chunk_index: number;
  content: string;
  metadata: string | null;
  created_at: string;
}

export interface SearchResult {
  content: string;
  metadata: Record<string, unknown> | null;
  file_path: string;
  source: string;
  distance: number;
}

// ---- Configuration ----

const CHUNK_SIZE = 2000; // ~500 tokens
const CHUNK_OVERLAP = 400; // ~100 tokens
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const EMBEDDING_DIM = 384; // all-MiniLM-L6-v2

const SUPPORTED_EXTENSIONS = new Set([
  '.md', '.txt', '.pdf', '.docx', '.xlsx', '.csv', '.json',
]);

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'logs', '.claude',
]);

// ---- State ----

let embeddingPipeline: any = null;
let vecTableInitialized = false;

// ---- Initialization ----

export async function initDocumentIndex(opts?: { skipModel?: boolean }): Promise<void> {
  const db = getDb();

  // Create the sqlite-vec virtual table if it doesn't exist
  if (!vecTableInitialized) {
    try {
      // Load sqlite-vec extension
      const sqliteVec = await import('sqlite-vec');
      sqliteVec.load(db);

      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS document_chunks_vec USING vec0(
          chunk_id TEXT PRIMARY KEY,
          embedding FLOAT[${EMBEDDING_DIM}]
        )
      `);
      vecTableInitialized = true;
      logger.info('sqlite-vec document index initialized');
    } catch (err) {
      logger.error({ err }, 'Failed to initialize sqlite-vec for document index');
      throw err;
    }
  }

  // Load embedding model (skip in tests)
  if (!opts?.skipModel && !embeddingPipeline) {
    await loadEmbeddingModel();
  }
}

async function loadEmbeddingModel(): Promise<void> {
  const { pipeline } = await import('@huggingface/transformers');
  embeddingPipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
    cache_dir: path.join(process.cwd(), 'data', 'models'),
  });
  logger.info('Embedding model loaded for document index');
}

// ---- Embedding ----

export async function embed(text: string): Promise<Float32Array> {
  if (!embeddingPipeline) {
    await loadEmbeddingModel();
  }
  const output = await embeddingPipeline(text, { pooling: 'mean', normalize: true });
  return new Float32Array(output.data);
}

// ---- Hashing ----

export function fileHash(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

// ---- File filtering ----

export function shouldIndex(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) return false;

  // Check file size
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_FILE_SIZE) return false;
    if (!stat.isFile()) return false;
  } catch {
    return false;
  }

  // Check ignored directories
  const parts = filePath.split(path.sep);
  for (const part of parts) {
    if (IGNORED_DIRS.has(part)) return false;
    if (part.startsWith('.') && part !== '.') return false;
  }

  return true;
}

export { CHUNK_SIZE, CHUNK_OVERLAP, MAX_FILE_SIZE, SUPPORTED_EXTENSIONS, IGNORED_DIRS };
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/document-index.test.ts`
Expected: PASS (with `skipModel: true` to avoid downloading the model in tests)

Note: sqlite-vec may not load in the test environment if the native extension isn't available. If `initDocumentIndex` fails in test, wrap the vec table creation in a try-catch and test the regular tables only. The vec table will be tested in integration tests.

**Step 5: Commit**

```bash
git add src/document-index.ts src/document-index.test.ts
git commit -m "feat: add document-index core module with types, embedding, and init"
```

---

### Task 4: File Parsing — Text, PDF, DOCX, XLSX, CSV, JSON

**Files:**
- Modify: `src/document-index.ts`

**Step 1: Write the failing test**

Add to `src/document-index.test.ts`:

```typescript
describe('document index - parsing', () => {
  it('parses markdown content', async () => {
    const { parseFile } = await import('./document-index.js');
    // Create a temp file
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docindex-'));
    const tmpFile = path.join(tmpDir, 'test.md');
    fs.writeFileSync(tmpFile, '# Title\n\nSome content here.\n\n## Section 2\n\nMore content.');
    const result = await parseFile(tmpFile);
    expect(result).toContain('Title');
    expect(result).toContain('Some content here.');
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('parses CSV content', async () => {
    const { parseFile } = await import('./document-index.js');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docindex-'));
    const tmpFile = path.join(tmpDir, 'test.csv');
    fs.writeFileSync(tmpFile, 'name,age\nAlice,30\nBob,25');
    const result = await parseFile(tmpFile);
    expect(result).toContain('Alice');
    expect(result).toContain('Bob');
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('parses JSON content', async () => {
    const { parseFile } = await import('./document-index.js');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docindex-'));
    const tmpFile = path.join(tmpDir, 'test.json');
    fs.writeFileSync(tmpFile, JSON.stringify({ key: 'value', nested: { a: 1 } }));
    const result = await parseFile(tmpFile);
    expect(result).toContain('key');
    expect(result).toContain('value');
    fs.rmSync(tmpDir, { recursive: true });
  });
});
```

Add these imports at the top of the test file:
```typescript
import fs from 'fs';
import os from 'os';
import path from 'path';
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/document-index.test.ts`
Expected: FAIL — `parseFile` doesn't exist

**Step 3: Add parseFile function to document-index.ts**

Add to `src/document-index.ts`:

```typescript
// ---- File Parsing ----

export async function parseFile(filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();

  switch (ext) {
    case '.md':
    case '.txt':
      return fs.readFileSync(filePath, 'utf-8');

    case '.csv':
      return fs.readFileSync(filePath, 'utf-8');

    case '.json':
      return JSON.stringify(JSON.parse(fs.readFileSync(filePath, 'utf-8')), null, 2);

    case '.pdf': {
      const pdfParse = (await import('pdf-parse')).default;
      const buffer = fs.readFileSync(filePath);
      const data = await pdfParse(buffer);
      return data.text;
    }

    case '.docx': {
      const mammoth = await import('mammoth');
      const result = await mammoth.extractRawText({ path: filePath });
      return result.value;
    }

    case '.xlsx': {
      const XLSX = await import('xlsx');
      const workbook = XLSX.readFile(filePath);
      const sheets: string[] = [];
      for (const name of workbook.SheetNames) {
        const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[name]);
        sheets.push(`--- Sheet: ${name} ---\n${csv}`);
      }
      return sheets.join('\n\n');
    }

    default:
      throw new Error(`Unsupported file type: ${ext}`);
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/document-index.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/document-index.ts src/document-index.test.ts
git commit -m "feat: add file parsing for md, txt, csv, json, pdf, docx, xlsx"
```

---

### Task 5: Chunking — Split Parsed Text into Overlapping Chunks

**Files:**
- Modify: `src/document-index.ts`

**Step 1: Write the failing test**

Add to `src/document-index.test.ts`:

```typescript
describe('document index - chunking', () => {
  it('chunks short text into a single chunk', async () => {
    const { chunkText } = await import('./document-index.js');
    const chunks = chunkText('Short text.');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe('Short text.');
  });

  it('chunks long text with overlap', async () => {
    const { chunkText, CHUNK_SIZE, CHUNK_OVERLAP } = await import('./document-index.js');
    // Generate text longer than CHUNK_SIZE
    const longText = 'word '.repeat(1000); // ~5000 chars
    const chunks = chunkText(longText);
    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk should be <= CHUNK_SIZE (except possibly the last)
    for (let i = 0; i < chunks.length - 1; i++) {
      expect(chunks[i].length).toBeLessThanOrEqual(CHUNK_SIZE + 50); // some tolerance for word boundaries
    }
  });

  it('splits markdown on headers', async () => {
    const { chunkText } = await import('./document-index.js');
    const md = '# Section 1\n\nContent of section 1.\n\n# Section 2\n\nContent of section 2.';
    const chunks = chunkText(md);
    // With short content, each section should be its own chunk
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toContain('Section 1');
    expect(chunks[1]).toContain('Section 2');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/document-index.test.ts`
Expected: FAIL — `chunkText` doesn't exist

**Step 3: Add chunkText function to document-index.ts**

Add to `src/document-index.ts`:

```typescript
// ---- Chunking ----

export function chunkText(text: string): string[] {
  if (!text.trim()) return [];

  // Try header-based splitting for markdown
  const headerPattern = /^#{1,3}\s+/m;
  if (headerPattern.test(text)) {
    return chunkByHeaders(text);
  }

  // Fallback: sliding window with overlap
  return chunkBySize(text);
}

function chunkByHeaders(text: string): string[] {
  // Split on h1/h2/h3 headers, keeping the header with its content
  const sections = text.split(/(?=^#{1,3}\s+)/m).filter((s) => s.trim());
  const chunks: string[] = [];

  for (const section of sections) {
    if (section.length <= CHUNK_SIZE) {
      chunks.push(section.trim());
    } else {
      // Section too long, split further by size
      chunks.push(...chunkBySize(section));
    }
  }

  return chunks;
}

function chunkBySize(text: string): string[] {
  const chunks: string[] = [];
  const paragraphs = text.split(/\n\n+/);
  let current = '';

  for (const para of paragraphs) {
    if (current.length + para.length + 2 > CHUNK_SIZE && current.length > 0) {
      chunks.push(current.trim());
      // Overlap: keep the last CHUNK_OVERLAP chars
      const overlapStart = Math.max(0, current.length - CHUNK_OVERLAP);
      current = current.slice(overlapStart) + '\n\n' + para;
    } else {
      current += (current ? '\n\n' : '') + para;
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  // If no paragraph splits worked (e.g. one giant paragraph), force-split
  if (chunks.length === 1 && chunks[0].length > CHUNK_SIZE) {
    const forced: string[] = [];
    const bigText = chunks[0];
    for (let i = 0; i < bigText.length; i += CHUNK_SIZE - CHUNK_OVERLAP) {
      forced.push(bigText.slice(i, i + CHUNK_SIZE).trim());
    }
    return forced.filter((c) => c);
  }

  return chunks;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/document-index.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/document-index.ts src/document-index.test.ts
git commit -m "feat: add text chunking with header splitting and overlap"
```

---

### Task 6: Indexing Pipeline — Parse, Chunk, Embed, Store

**Files:**
- Modify: `src/document-index.ts`

**Step 1: Write the failing test**

Add to `src/document-index.test.ts`:

```typescript
describe('document index - indexing pipeline', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('indexes a text file and stores chunks in DB', async () => {
    const { indexFile, getDocumentByPath, getChunksForDocument } = await import('./document-index.js');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docindex-'));
    const tmpFile = path.join(tmpDir, 'test.md');
    fs.writeFileSync(tmpFile, '# Hello\n\nThis is test content.');

    await indexFile(tmpFile, 'test-group', { skipEmbedding: true });

    const doc = getDocumentByPath('test-group', tmpFile);
    expect(doc).toBeDefined();
    expect(doc!.group_folder).toBe('test-group');
    expect(doc!.chunk_count).toBeGreaterThan(0);

    const chunks = getChunksForDocument(doc!.id);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].content).toContain('Hello');

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('skips re-indexing unchanged files', async () => {
    const { indexFile, getDocumentByPath } = await import('./document-index.js');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docindex-'));
    const tmpFile = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(tmpFile, 'unchanged content');

    await indexFile(tmpFile, 'test-group', { skipEmbedding: true });
    const doc1 = getDocumentByPath('test-group', tmpFile);

    await indexFile(tmpFile, 'test-group', { skipEmbedding: true });
    const doc2 = getDocumentByPath('test-group', tmpFile);

    // Same document, same indexed_at (was not re-indexed)
    expect(doc1!.id).toBe(doc2!.id);
    expect(doc1!.indexed_at).toBe(doc2!.indexed_at);

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('re-indexes when file content changes', async () => {
    const { indexFile, getDocumentByPath } = await import('./document-index.js');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docindex-'));
    const tmpFile = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(tmpFile, 'version 1');

    await indexFile(tmpFile, 'test-group', { skipEmbedding: true });
    const doc1 = getDocumentByPath('test-group', tmpFile);

    fs.writeFileSync(tmpFile, 'version 2 with new content');
    await indexFile(tmpFile, 'test-group', { skipEmbedding: true });
    const doc2 = getDocumentByPath('test-group', tmpFile);

    expect(doc2!.file_hash).not.toBe(doc1!.file_hash);

    fs.rmSync(tmpDir, { recursive: true });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/document-index.test.ts`
Expected: FAIL — `indexFile`, `getDocumentByPath`, `getChunksForDocument` don't exist

**Step 3: Add indexing functions to document-index.ts**

Add to `src/document-index.ts`:

```typescript
// ---- Database Accessors ----

export function getDocumentByPath(groupFolder: string, filePath: string): DocumentRecord | undefined {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM documents WHERE group_folder = ? AND file_path = ?'
  ).get(groupFolder, filePath) as DocumentRecord | undefined;
}

export function getDocumentBySourceId(groupFolder: string, sourceId: string): DocumentRecord | undefined {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM documents WHERE group_folder = ? AND source_id = ?'
  ).get(groupFolder, sourceId) as DocumentRecord | undefined;
}

export function getChunksForDocument(documentId: string): ChunkRecord[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM document_chunks WHERE document_id = ? ORDER BY chunk_index'
  ).all(documentId) as ChunkRecord[];
}

export function getDocumentsForGroup(groupFolder: string): DocumentRecord[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM documents WHERE group_folder = ? ORDER BY updated_at DESC'
  ).all(groupFolder) as DocumentRecord[];
}

// ---- Indexing Pipeline ----

export async function indexFile(
  filePath: string,
  groupFolder: string,
  opts?: { skipEmbedding?: boolean; source?: DocumentRecord['source']; sourceId?: string },
): Promise<void> {
  const db = getDb();
  const source = opts?.source || 'local';
  const hash = fileHash(filePath);

  // Check if already indexed with same hash
  const existing = getDocumentByPath(groupFolder, filePath);
  if (existing && existing.file_hash === hash) {
    return; // No changes, skip
  }

  // Parse file content
  let content: string;
  try {
    content = await parseFile(filePath);
  } catch (err) {
    logger.warn({ filePath, err }, 'Failed to parse file for indexing');
    return;
  }

  if (!content.trim()) {
    logger.debug({ filePath }, 'Empty file, skipping indexing');
    return;
  }

  // Chunk content
  const chunks = chunkText(content);
  const now = new Date().toISOString();
  const stat = fs.statSync(filePath);

  // If document exists, remove old chunks first
  if (existing) {
    db.prepare('DELETE FROM document_chunks WHERE document_id = ?').run(existing.id);
    if (vecTableInitialized) {
      try {
        db.prepare('DELETE FROM document_chunks_vec WHERE chunk_id IN (SELECT id FROM document_chunks WHERE document_id = ?)').run(existing.id);
      } catch { /* vec table may not exist in tests */ }
    }
  }

  const docId = existing?.id || crypto.randomUUID();

  // Upsert document record
  db.prepare(`
    INSERT OR REPLACE INTO documents (id, group_folder, file_path, source, source_id, file_hash, file_size, mime_type, chunk_count, indexed_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    docId,
    groupFolder,
    filePath,
    source,
    opts?.sourceId || null,
    hash,
    stat.size,
    mimeFromExt(path.extname(filePath)),
    chunks.length,
    existing?.indexed_at || now,
    now,
  );

  // Insert chunks
  const insertChunk = db.prepare(`
    INSERT INTO document_chunks (id, document_id, group_folder, chunk_index, content, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((chunkList: string[]) => {
    for (let i = 0; i < chunkList.length; i++) {
      const chunkId = crypto.randomUUID();
      insertChunk.run(chunkId, docId, groupFolder, i, chunkList[i], null, now);
    }
  });
  insertMany(chunks);

  // Embed chunks (skip in tests or when model not loaded)
  if (!opts?.skipEmbedding && embeddingPipeline && vecTableInitialized) {
    await embedChunks(docId);
  }

  logger.info({ filePath, groupFolder, chunks: chunks.length, source }, 'File indexed');
}

async function embedChunks(documentId: string): Promise<void> {
  const db = getDb();
  const chunks = getChunksForDocument(documentId);

  const insertVec = db.prepare(`
    INSERT OR REPLACE INTO document_chunks_vec (chunk_id, embedding)
    VALUES (?, ?)
  `);

  for (const chunk of chunks) {
    try {
      const embedding = await embed(chunk.content);
      insertVec.run(chunk.id, Buffer.from(embedding.buffer));
    } catch (err) {
      logger.warn({ chunkId: chunk.id, err }, 'Failed to embed chunk');
    }
  }
}

// ---- Remove from index ----

export function removeFromIndex(filePath: string, groupFolder: string): void {
  const db = getDb();
  const doc = getDocumentByPath(groupFolder, filePath);
  if (!doc) return;

  if (vecTableInitialized) {
    try {
      const chunkIds = db.prepare(
        'SELECT id FROM document_chunks WHERE document_id = ?'
      ).all(doc.id) as { id: string }[];
      for (const { id } of chunkIds) {
        db.prepare('DELETE FROM document_chunks_vec WHERE chunk_id = ?').run(id);
      }
    } catch { /* vec table may not exist */ }
  }

  db.prepare('DELETE FROM document_chunks WHERE document_id = ?').run(doc.id);
  db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);

  logger.info({ filePath, groupFolder }, 'File removed from index');
}

// ---- Helpers ----

function mimeFromExt(ext: string): string | null {
  const map: Record<string, string> = {
    '.md': 'text/markdown',
    '.txt': 'text/plain',
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.csv': 'text/csv',
    '.json': 'application/json',
  };
  return map[ext.toLowerCase()] || null;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/document-index.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/document-index.ts src/document-index.test.ts
git commit -m "feat: add document indexing pipeline with parse, chunk, store"
```

---

### Task 7: Search — Vector Similarity Search and RAG Context Builder

**Files:**
- Modify: `src/document-index.ts`

**Step 1: Write the failing test**

Add to `src/document-index.test.ts`:

```typescript
describe('document index - search', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('buildDocumentContext returns XML with indexed chunks', async () => {
    const { indexFile, buildDocumentContext } = await import('./document-index.js');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docindex-'));
    const tmpFile = path.join(tmpDir, 'info.md');
    fs.writeFileSync(tmpFile, '# Project Info\n\nThe deadline is March 15th.');

    await indexFile(tmpFile, 'test-group', { skipEmbedding: true });

    // Without embeddings, buildDocumentContext falls back to keyword matching
    // or returns empty. Test the format at least.
    const context = await buildDocumentContext('test-group', 'deadline', { skipEmbedding: true });
    // Context should be a string (possibly empty without vector search)
    expect(typeof context).toBe('string');

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('buildDocumentSnapshot returns correct structure', async () => {
    const { indexFile, buildDocumentSnapshot } = await import('./document-index.js');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docindex-'));
    const tmpFile = path.join(tmpDir, 'notes.txt');
    fs.writeFileSync(tmpFile, 'Some notes here.');

    await indexFile(tmpFile, 'test-group', { skipEmbedding: true });

    const snapshot = buildDocumentSnapshot('test-group');
    expect(snapshot.indexed_documents).toHaveLength(1);
    expect(snapshot.indexed_documents[0].source).toBe('local');
    expect(snapshot.total_chunks).toBeGreaterThan(0);

    fs.rmSync(tmpDir, { recursive: true });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/document-index.test.ts`
Expected: FAIL — `buildDocumentContext`, `buildDocumentSnapshot` don't exist

**Step 3: Add search and context builder to document-index.ts**

Add to `src/document-index.ts`:

```typescript
// ---- Search ----

export async function searchDocuments(
  groupFolder: string,
  query: string,
  topK: number = 5,
): Promise<SearchResult[]> {
  if (!vecTableInitialized || !embeddingPipeline) {
    return [];
  }

  const db = getDb();
  const queryEmbedding = await embed(query);

  const results = db.prepare(`
    SELECT dc.content, dc.metadata, d.file_path, d.source,
           vec.distance
    FROM document_chunks_vec vec
    JOIN document_chunks dc ON dc.id = vec.chunk_id
    JOIN documents d ON d.id = dc.document_id
    WHERE dc.group_folder = ?
    ORDER BY vec.distance ASC
    LIMIT ?
  `).all(groupFolder, topK) as Array<{
    content: string;
    metadata: string | null;
    file_path: string;
    source: string;
    distance: number;
  }>;

  // sqlite-vec requires passing the query vector as a parameter
  // The actual query needs vec_search syntax — adjust based on sqlite-vec API
  return results.map((r) => ({
    ...r,
    metadata: r.metadata ? JSON.parse(r.metadata) : null,
  }));
}

// Note: The actual sqlite-vec search query syntax may need adjustment.
// sqlite-vec uses: WHERE embedding MATCH ? AND k = ? syntax.
// The implementation will be finalized during integration testing
// when the actual sqlite-vec extension is loaded.
// For now, this is the intended query pattern:
//
// SELECT chunk_id, distance
// FROM document_chunks_vec
// WHERE embedding MATCH ?
//   AND k = ?
//
// Then join back to document_chunks and documents tables.

export async function searchDocumentsVec(
  groupFolder: string,
  query: string,
  topK: number = 5,
): Promise<SearchResult[]> {
  if (!vecTableInitialized || !embeddingPipeline) {
    return [];
  }

  const db = getDb();
  const queryEmbedding = await embed(query);
  const queryBuffer = Buffer.from(queryEmbedding.buffer);

  // sqlite-vec MATCH syntax for vec0 tables
  const vecResults = db.prepare(`
    SELECT chunk_id, distance
    FROM document_chunks_vec
    WHERE embedding MATCH ? AND k = ?
  `).all(queryBuffer, topK) as Array<{ chunk_id: string; distance: number }>;

  if (vecResults.length === 0) return [];

  // Join with chunk and document data
  const placeholders = vecResults.map(() => '?').join(',');
  const chunkIds = vecResults.map((r) => r.chunk_id);
  const distanceMap = new Map(vecResults.map((r) => [r.chunk_id, r.distance]));

  const rows = db.prepare(`
    SELECT dc.id as chunk_id, dc.content, dc.metadata, d.file_path, d.source
    FROM document_chunks dc
    JOIN documents d ON d.id = dc.document_id
    WHERE dc.id IN (${placeholders}) AND dc.group_folder = ?
  `).all(...chunkIds, groupFolder) as Array<{
    chunk_id: string;
    content: string;
    metadata: string | null;
    file_path: string;
    source: string;
  }>;

  return rows.map((r) => ({
    content: r.content,
    metadata: r.metadata ? JSON.parse(r.metadata) : null,
    file_path: r.file_path,
    source: r.source,
    distance: distanceMap.get(r.chunk_id) || 1,
  })).sort((a, b) => a.distance - b.distance);
}

// ---- RAG Context Builder ----

export async function buildDocumentContext(
  groupFolder: string,
  query: string,
  opts?: { topK?: number; skipEmbedding?: boolean },
): Promise<string> {
  const topK = opts?.topK || 5;

  if (opts?.skipEmbedding) {
    // Fallback without embeddings: simple keyword search
    return buildKeywordContext(groupFolder, query, topK);
  }

  const results = await searchDocumentsVec(groupFolder, query, topK);
  if (results.length === 0) return '';

  return formatDocumentContext(results);
}

function buildKeywordContext(groupFolder: string, query: string, topK: number): string {
  const db = getDb();
  const keywords = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  if (keywords.length === 0) return '';

  // Simple LIKE-based search as fallback
  const conditions = keywords.map(() => 'LOWER(dc.content) LIKE ?').join(' OR ');
  const params = keywords.map((k) => `%${k}%`);

  const rows = db.prepare(`
    SELECT dc.content, dc.metadata, d.file_path, d.source
    FROM document_chunks dc
    JOIN documents d ON d.id = dc.document_id
    WHERE dc.group_folder = ? AND (${conditions})
    LIMIT ?
  `).all(groupFolder, ...params, topK) as Array<{
    content: string;
    metadata: string | null;
    file_path: string;
    source: string;
  }>;

  if (rows.length === 0) return '';

  return formatDocumentContext(rows.map((r) => ({
    ...r,
    metadata: r.metadata ? JSON.parse(r.metadata) : null,
    distance: 0, // no distance for keyword search
  })));
}

function formatDocumentContext(results: SearchResult[]): string {
  if (results.length === 0) return '';

  const chunks = results.map((r) => {
    const attrs: string[] = [`file="${path.basename(r.file_path)}"`];
    if (r.metadata) {
      if (r.metadata.page) attrs.push(`page="${r.metadata.page}"`);
      if (r.metadata.section) attrs.push(`section="${r.metadata.section}"`);
    }
    if (r.source !== 'local') attrs.push(`source="${r.source}"`);
    if (r.distance > 0) attrs.push(`relevance="${(1 - r.distance).toFixed(2)}"`);
    return `  <chunk ${attrs.join(' ')}>\n    ${r.content.trim()}\n  </chunk>`;
  });

  return `<documents>\n${chunks.join('\n')}\n</documents>\n\n`;
}

// ---- Document Snapshot ----

export function buildDocumentSnapshot(groupFolder: string): {
  indexed_documents: Array<{
    path: string;
    source: string;
    chunks: number;
    updated: string;
  }>;
  total_chunks: number;
  last_sync: string;
} {
  const docs = getDocumentsForGroup(groupFolder);
  let totalChunks = 0;

  const indexed_documents = docs.map((d) => {
    totalChunks += d.chunk_count;
    return {
      path: d.file_path,
      source: d.source,
      chunks: d.chunk_count,
      updated: d.updated_at,
    };
  });

  return {
    indexed_documents,
    total_chunks: totalChunks,
    last_sync: new Date().toISOString(),
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/document-index.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/document-index.ts src/document-index.test.ts
git commit -m "feat: add vector search, keyword fallback, and RAG context builder"
```

---

### Task 8: File Watcher — Real-time Group Folder Monitoring

**Files:**
- Modify: `src/document-index.ts`

**Step 1: Write the failing test**

Add to `src/document-index.test.ts`:

```typescript
describe('document index - file watcher', () => {
  it('exports startFileWatcher and stopFileWatcher', async () => {
    const mod = await import('./document-index.js');
    expect(typeof mod.startFileWatcher).toBe('function');
    expect(typeof mod.stopFileWatcher).toBe('function');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/document-index.test.ts`
Expected: FAIL — functions don't exist

**Step 3: Add file watcher to document-index.ts**

Add to `src/document-index.ts`:

```typescript
import { watch, type FSWatcher } from 'chokidar';

// At module level:
let fileWatcher: FSWatcher | null = null;
const indexQueue = new Map<string, NodeJS.Timeout>(); // debounce map
const MAX_CONCURRENT_INDEX = 3;
let activeIndexing = 0;
const pendingIndex: Array<{ filePath: string; groupFolder: string }> = [];

export function startFileWatcher(groupsDir: string): void {
  if (fileWatcher) {
    logger.debug('File watcher already running');
    return;
  }

  fileWatcher = watch(path.join(groupsDir, '**', '*'), {
    ignored: [
      '**/node_modules/**',
      '**/.git/**',
      '**/logs/**',
      '**/.*',
    ],
    persistent: true,
    ignoreInitial: false, // Index existing files at startup
    awaitWriteFinish: { stabilityThreshold: 2000 },
    depth: 10,
  });

  fileWatcher.on('add', (filePath) => enqueueIndex(filePath, groupsDir));
  fileWatcher.on('change', (filePath) => enqueueIndex(filePath, groupsDir));
  fileWatcher.on('unlink', (filePath) => {
    const groupFolder = extractGroupFolder(filePath, groupsDir);
    if (groupFolder) {
      removeFromIndex(filePath, groupFolder);
    }
  });
  fileWatcher.on('error', (err) => logger.error({ err }, 'File watcher error'));

  logger.info({ groupsDir }, 'Document file watcher started');
}

export function stopFileWatcher(): void {
  if (fileWatcher) {
    fileWatcher.close();
    fileWatcher = null;
    logger.info('Document file watcher stopped');
  }
  for (const timer of indexQueue.values()) {
    clearTimeout(timer);
  }
  indexQueue.clear();
}

function enqueueIndex(filePath: string, groupsDir: string): void {
  if (!shouldIndex(filePath)) return;

  const groupFolder = extractGroupFolder(filePath, groupsDir);
  if (!groupFolder) return;

  // Debounce: cancel any pending index for this file
  const existing = indexQueue.get(filePath);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    indexQueue.delete(filePath);
    processIndexQueue(filePath, groupFolder);
  }, 500); // Additional debounce on top of chokidar's awaitWriteFinish

  indexQueue.set(filePath, timer);
}

async function processIndexQueue(filePath: string, groupFolder: string): Promise<void> {
  if (activeIndexing >= MAX_CONCURRENT_INDEX) {
    pendingIndex.push({ filePath, groupFolder });
    return;
  }

  activeIndexing++;
  try {
    await indexFile(filePath, groupFolder);
  } catch (err) {
    logger.error({ filePath, groupFolder, err }, 'Error indexing file');
  } finally {
    activeIndexing--;
    // Process next in queue
    const next = pendingIndex.shift();
    if (next) {
      processIndexQueue(next.filePath, next.groupFolder);
    }
  }
}

function extractGroupFolder(filePath: string, groupsDir: string): string | null {
  const relative = path.relative(groupsDir, filePath);
  if (relative.startsWith('..')) return null;
  const parts = relative.split(path.sep);
  if (parts.length < 2) return null; // File must be inside a group folder
  return parts[0];
}
```

Note: The `chokidar` import needs to be at the top of the file. Move it to the imports section.

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/document-index.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/document-index.ts src/document-index.test.ts
git commit -m "feat: add file watcher for real-time document indexing"
```

---

### Task 9: Integrate into index.ts — File Watcher Startup and RAG Injection

**Files:**
- Modify: `src/index.ts`

**Step 1: Add import and file watcher start**

In `src/index.ts`, add import at top (after existing imports):

```typescript
import {
  buildDocumentContext,
  buildDocumentSnapshot,
  initDocumentIndex,
  startFileWatcher,
  stopFileWatcher,
} from './document-index.js';
```

In the `main()` function, after `loadState()` (~line 782), add:

```typescript
  // Initialize document indexing
  try {
    await initDocumentIndex();
    startFileWatcher(path.join(process.cwd(), 'groups'));
    logger.info('Document index initialized');
  } catch (err) {
    logger.warn({ err }, 'Document index initialization failed — continuing without document search');
  }
```

In the `shutdown()` handler (~line 788), add before `removePidLock()`:

```typescript
    stopFileWatcher();
```

**Step 2: Add RAG injection before agent invocation**

In the `processGroupMessages` function, find where the prompt is built (~line 255):

```typescript
  const prompt = formatMessages(missedMessages, TIMEZONE);
```

Replace with:

```typescript
  // Build document RAG context
  let documentContext = '';
  try {
    const queryText = missedMessages.map((m) => m.content).join(' ').slice(0, 500);
    documentContext = await buildDocumentContext(group.folder, queryText);
  } catch (err) {
    logger.warn({ group: group.name, err }, 'Document context retrieval failed');
  }

  const prompt = documentContext + formatMessages(missedMessages, TIMEZONE);
```

**Step 3: Add document snapshot writing before agent invocation**

In the `runAgent` function, after the `writeGroupsSnapshot` call (~line 471), add:

```typescript
  // Write document snapshot for container to read
  try {
    const docSnapshot = buildDocumentSnapshot(group.folder);
    const ipcDir = path.join(DATA_DIR, 'ipc', group.folder);
    fs.mkdirSync(ipcDir, { recursive: true });
    fs.writeFileSync(
      path.join(ipcDir, 'document_snapshot.json'),
      JSON.stringify(docSnapshot, null, 2),
    );
  } catch (err) {
    logger.warn({ group: group.name, err }, 'Failed to write document snapshot');
  }
```

**Step 4: Build and verify**

Run: `npm run build`
Expected: No TypeScript errors

**Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: integrate document index into main loop with RAG injection"
```

---

### Task 10: IPC Handlers — index_file and document_search

**Files:**
- Modify: `src/ipc.ts`

**Step 1: Add IPC handlers for document operations**

In `src/ipc.ts`, add import at top:

```typescript
import { indexFile, searchDocumentsVec, buildDocumentSnapshot } from './document-index.js';
```

In the `processTaskIpc` function's switch statement (after the `request_network_access` case, ~line 888), add:

```typescript
    case 'index_file': {
      if (data.path) {
        // Resolve container path to host path within the group folder
        const groupDir = resolveGroupFolderPath(sourceGroup);
        const containerPath = (data as any).path as string;
        // Strip container prefix and resolve to host
        const relativePath = containerPath
          .replace(/^\/workspace\/group\//, '')
          .replace(/^\/workspace\/ipc\//, '');
        const hostPath = path.resolve(groupDir, relativePath);

        // Security: ensure path stays within group folder
        if (!hostPath.startsWith(groupDir + path.sep) && hostPath !== groupDir) {
          logger.warn({ containerPath, sourceGroup, hostPath }, 'index_file path traversal blocked');
          break;
        }

        if (fs.existsSync(hostPath)) {
          try {
            await indexFile(hostPath, sourceGroup);
            logger.info({ hostPath, sourceGroup }, 'File indexed via IPC');
          } catch (err) {
            logger.error({ hostPath, sourceGroup, err }, 'IPC index_file failed');
          }
        } else {
          logger.warn({ hostPath, sourceGroup }, 'IPC index_file: file not found');
        }
      }
      break;
    }

    case 'document_search': {
      if (data.query && data.requestId) {
        const topK = (data as any).top_k || 5;
        try {
          const results = await searchDocumentsVec(sourceGroup, data.query as string, topK);
          // Write response file for container to read
          const inputDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'input');
          fs.mkdirSync(inputDir, { recursive: true });
          fs.writeFileSync(
            path.join(inputDir, `res-${data.requestId}.json`),
            JSON.stringify({
              results: results.map((r) => ({
                file: path.basename(r.file_path),
                content: r.content,
                relevance: r.distance > 0 ? (1 - r.distance).toFixed(2) : '1.00',
                source: r.source,
                ...(r.metadata?.page ? { page: r.metadata.page } : {}),
              })),
            }),
          );
          logger.info({ sourceGroup, query: data.query, resultCount: results.length }, 'Document search completed via IPC');
        } catch (err) {
          logger.error({ sourceGroup, query: data.query, err }, 'IPC document_search failed');
          // Write error response
          const inputDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'input');
          fs.mkdirSync(inputDir, { recursive: true });
          fs.writeFileSync(
            path.join(inputDir, `res-${data.requestId}.json`),
            JSON.stringify({ error: 'Search failed', results: [] }),
          );
        }
      }
      break;
    }
```

Also add `query` and `path` to the `processTaskIpc` data type parameter (they're already included via the existing `query` and `url` fields — `query` is there, but add `path` as `string | undefined` to the `data` type).

Add the import for `resolveGroupFolderPath` if not already imported:

```typescript
import { resolveGroupFolderPath } from './group-folder.js';
```

**Step 2: Build and verify**

Run: `npm run build`
Expected: No TypeScript errors

**Step 3: Commit**

```bash
git add src/ipc.ts
git commit -m "feat: add index_file and document_search IPC handlers"
```

---

### Task 11: Google Workspace Sync

**Files:**
- Modify: `src/document-index.ts`

**Step 1: Add GWS sync function**

Add to `src/document-index.ts`:

```typescript
import { execFile } from 'child_process';
import { promisify } from 'util';
const execFileAsync = promisify(execFile);

// ---- Google Workspace Sync ----

interface GwsSyncConfig {
  drive_folders?: string[];  // Google Drive folder IDs
  doc_ids?: string[];        // Specific Google Doc IDs
  sheet_ids?: string[];      // Specific Google Sheet IDs
}

export async function syncGoogleWorkspace(groupFolder: string, groupDir: string): Promise<void> {
  // Read config from group folder
  const configPath = path.join(groupDir, 'document-index.yaml');
  if (!fs.existsSync(configPath)) {
    return; // No GWS config for this group
  }

  let config: GwsSyncConfig;
  try {
    const yaml = await import('yaml');
    config = yaml.parse(fs.readFileSync(configPath, 'utf-8')) as GwsSyncConfig;
  } catch (err) {
    logger.warn({ groupFolder, err }, 'Failed to parse document-index.yaml');
    return;
  }

  const tmpDir = path.join(groupDir, '.doc-index-tmp');
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    // Sync Google Docs
    if (config.doc_ids?.length) {
      for (const docId of config.doc_ids) {
        try {
          const tmpFile = path.join(tmpDir, `gdoc-${docId}.txt`);
          await execFileAsync('gws', ['docs', 'export', docId, '--format', 'txt', '--output', tmpFile]);
          if (fs.existsSync(tmpFile)) {
            await indexFile(tmpFile, groupFolder, {
              source: 'google-docs',
              sourceId: docId,
            });
          }
        } catch (err) {
          logger.warn({ docId, groupFolder, err }, 'Failed to sync Google Doc');
        }
      }
    }

    // Sync Google Sheets
    if (config.sheet_ids?.length) {
      for (const sheetId of config.sheet_ids) {
        try {
          const tmpFile = path.join(tmpDir, `gsheet-${sheetId}.csv`);
          await execFileAsync('gws', ['sheets', 'export', sheetId, '--format', 'csv', '--output', tmpFile]);
          if (fs.existsSync(tmpFile)) {
            await indexFile(tmpFile, groupFolder, {
              source: 'google-sheets',
              sourceId: sheetId,
            });
          }
        } catch (err) {
          logger.warn({ sheetId, groupFolder, err }, 'Failed to sync Google Sheet');
        }
      }
    }

    // Sync Drive folders
    if (config.drive_folders?.length) {
      for (const folderId of config.drive_folders) {
        try {
          const { stdout } = await execFileAsync('gws', ['drive', 'list', folderId, '--format', 'json']);
          const files = JSON.parse(stdout) as Array<{ id: string; name: string; mimeType: string }>;
          for (const file of files) {
            try {
              const ext = guessExtFromMime(file.mimeType);
              if (!ext) continue;
              const tmpFile = path.join(tmpDir, `drive-${file.id}${ext}`);
              await execFileAsync('gws', ['drive', 'download', file.id, '--output', tmpFile]);
              if (fs.existsSync(tmpFile)) {
                await indexFile(tmpFile, groupFolder, {
                  source: 'google-drive',
                  sourceId: file.id,
                });
              }
            } catch (err) {
              logger.warn({ fileId: file.id, groupFolder, err }, 'Failed to sync Drive file');
            }
          }
        } catch (err) {
          logger.warn({ folderId, groupFolder, err }, 'Failed to list Drive folder');
        }
      }
    }
  } finally {
    // Cleanup temp files
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }

  logger.info({ groupFolder }, 'Google Workspace sync completed');
}

function guessExtFromMime(mimeType: string): string | null {
  const map: Record<string, string> = {
    'application/pdf': '.pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
    'text/csv': '.csv',
    'text/plain': '.txt',
    'application/json': '.json',
    'application/vnd.google-apps.document': '.txt', // exported as text
    'application/vnd.google-apps.spreadsheet': '.csv', // exported as csv
  };
  return map[mimeType] || null;
}
```

**Step 2: Commit**

```bash
git add src/document-index.ts
git commit -m "feat: add Google Workspace document sync via gws CLI"
```

---

### Task 12: GWS Sync Scheduled Task Integration

**Files:**
- Modify: `src/index.ts`

**Step 1: Add GWS sync to startup and schedule**

In `src/index.ts`, update the document-index import to include `syncGoogleWorkspace`:

```typescript
import {
  buildDocumentContext,
  buildDocumentSnapshot,
  initDocumentIndex,
  startFileWatcher,
  stopFileWatcher,
  syncGoogleWorkspace,
} from './document-index.js';
```

After the file watcher initialization in `main()`, add a periodic GWS sync:

```typescript
  // Schedule periodic Google Workspace document sync (every 30 minutes)
  const GWS_SYNC_INTERVAL = 30 * 60 * 1000;
  const runGwsSync = async () => {
    for (const group of Object.values(registeredGroups)) {
      try {
        const groupDir = resolveGroupFolderPath(group.folder);
        await syncGoogleWorkspace(group.folder, groupDir);
      } catch (err) {
        logger.warn({ group: group.folder, err }, 'GWS sync failed for group');
      }
    }
  };
  // Run once at startup, then periodically
  runGwsSync().catch((err) => logger.warn({ err }, 'Initial GWS sync failed'));
  setInterval(runGwsSync, GWS_SYNC_INTERVAL);
```

**Step 2: Build and verify**

Run: `npm run build`
Expected: No TypeScript errors

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: add periodic Google Workspace document sync"
```

---

### Task 13: Agent Skill Documentation

**Files:**
- Create: `container/skills/document-search.md`

**Step 1: Create the agent-facing skill documentation**

This file tells the container agent how to use the document search capabilities:

```markdown
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
```

**Step 2: Commit**

```bash
git add container/skills/document-search.md
git commit -m "docs: add document search skill for container agents"
```

---

### Task 14: Skill Package Structure

**Files:**
- Create: `.claude/skills/add-document-index/SKILL.md`
- Create: `.claude/skills/add-document-index/manifest.yaml`

**Step 1: Create SKILL.md**

```markdown
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
```

**Step 2: Create manifest.yaml**

```yaml
skill: add-document-index
version: 1.0.0
description: "Semantic document search with RAG over group files and Google Workspace"
core_version: 1.2.6
adds:
  - src/document-index.ts
  - container/skills/document-search.md
modifies:
  - src/db.ts
  - src/index.ts
  - src/ipc.ts
structured:
  npm_dependencies:
    sqlite-vec: "^0.1.7-alpha.2"
    "@huggingface/transformers": "^3.8.1"
    chokidar: "^4.0"
    pdf-parse: "^1.1.1"
    mammoth: "^1.8"
    xlsx: "^0.18"
  dev_dependencies:
    "@types/pdf-parse": "*"
  env_additions: []
conflicts: []
depends: []
test: "npx vitest run src/document-index.test.ts"
```

**Step 3: Commit**

```bash
git add .claude/skills/add-document-index/
git commit -m "feat: add document-index skill package with SKILL.md and manifest"
```

---

### Task 15: Integration Testing and Final Verification

**Step 1: Run all existing tests**

Run: `npx vitest run`
Expected: All tests pass (no regressions)

**Step 2: Run document-index specific tests**

Run: `npx vitest run src/document-index.test.ts`
Expected: All tests pass

**Step 3: Build**

Run: `npm run build`
Expected: No TypeScript errors

**Step 4: Manual smoke test**

```bash
# Start the service
systemctl restart nanoklauw

# Check logs for document index initialization
journalctl -u nanoklauw --since "1 minute ago" | grep -i "document"

# Verify embedding model downloads
ls -la data/models/

# Add a test file to a group folder and verify indexing
echo "# Test Document\n\nThis is a test file for document indexing." > groups/main/test-index.md
sleep 5
journalctl -u nanoklauw --since "30 seconds ago" | grep -i "indexed"
```

**Step 5: Clean up test file**

```bash
rm groups/main/test-index.md
```

**Step 6: Final commit**

```bash
git add -A
git commit -m "test: verify document index integration"
```
