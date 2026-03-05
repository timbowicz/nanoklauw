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
  '.md',
  '.txt',
  '.pdf',
  '.docx',
  '.xlsx',
  '.csv',
  '.json',
]);

const IGNORED_DIRS = new Set(['node_modules', '.git', 'logs', '.claude']);

// ---- State ----

let embeddingPipeline: any = null;
let vecTableInitialized = false;

// ---- Initialization ----

export async function initDocumentIndex(opts?: {
  skipModel?: boolean;
  skipVec?: boolean;
}): Promise<void> {
  const db = getDb();

  // Create the sqlite-vec virtual table if it doesn't exist
  if (!opts?.skipVec && !vecTableInitialized) {
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
      logger.error(
        { err },
        'Failed to initialize sqlite-vec for document index',
      );
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
  embeddingPipeline = await pipeline(
    'feature-extraction',
    'Xenova/all-MiniLM-L6-v2',
    {
      cache_dir: path.join(process.cwd(), 'data', 'models'),
    },
  );
  logger.info('Embedding model loaded for document index');
}

// ---- Embedding ----

export async function embed(text: string): Promise<Float32Array> {
  if (!embeddingPipeline) {
    await loadEmbeddingModel();
  }
  const output = await embeddingPipeline(text, {
    pooling: 'mean',
    normalize: true,
  });
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
      return JSON.stringify(
        JSON.parse(fs.readFileSync(filePath, 'utf-8')),
        null,
        2,
      );

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

// ---- Database Accessors ----

export function getDocumentByPath(
  groupFolder: string,
  filePath: string,
): DocumentRecord | undefined {
  const db = getDb();
  return db
    .prepare(
      'SELECT * FROM documents WHERE group_folder = ? AND file_path = ?',
    )
    .get(groupFolder, filePath) as DocumentRecord | undefined;
}

export function getDocumentBySourceId(
  groupFolder: string,
  sourceId: string,
): DocumentRecord | undefined {
  const db = getDb();
  return db
    .prepare(
      'SELECT * FROM documents WHERE group_folder = ? AND source_id = ?',
    )
    .get(groupFolder, sourceId) as DocumentRecord | undefined;
}

export function getChunksForDocument(documentId: string): ChunkRecord[] {
  const db = getDb();
  return db
    .prepare(
      'SELECT * FROM document_chunks WHERE document_id = ? ORDER BY chunk_index',
    )
    .all(documentId) as ChunkRecord[];
}

export function getDocumentsForGroup(groupFolder: string): DocumentRecord[] {
  const db = getDb();
  return db
    .prepare(
      'SELECT * FROM documents WHERE group_folder = ? ORDER BY updated_at DESC',
    )
    .all(groupFolder) as DocumentRecord[];
}

// ---- Indexing Pipeline ----

export async function indexFile(
  filePath: string,
  groupFolder: string,
  opts?: {
    skipEmbedding?: boolean;
    source?: DocumentRecord['source'];
    sourceId?: string;
  },
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
    db.prepare('DELETE FROM document_chunks WHERE document_id = ?').run(
      existing.id,
    );
    if (vecTableInitialized) {
      try {
        const chunkIds = db
          .prepare(
            'SELECT id FROM document_chunks WHERE document_id = ?',
          )
          .all(existing.id) as { id: string }[];
        for (const { id } of chunkIds) {
          db.prepare(
            'DELETE FROM document_chunks_vec WHERE chunk_id = ?',
          ).run(id);
        }
      } catch {
        /* vec table may not exist in tests */
      }
    }
  }

  const docId = existing?.id || crypto.randomUUID();

  // Upsert document record
  db.prepare(
    `INSERT OR REPLACE INTO documents (id, group_folder, file_path, source, source_id, file_hash, file_size, mime_type, chunk_count, indexed_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
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
  const insertChunk = db.prepare(
    `INSERT INTO document_chunks (id, document_id, group_folder, chunk_index, content, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

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

  logger.info(
    { filePath, groupFolder, chunks: chunks.length, source },
    'File indexed',
  );
}

async function embedChunks(documentId: string): Promise<void> {
  const db = getDb();
  const chunks = getChunksForDocument(documentId);

  const insertVec = db.prepare(
    `INSERT OR REPLACE INTO document_chunks_vec (chunk_id, embedding)
    VALUES (?, ?)`,
  );

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
      const chunkIds = db
        .prepare('SELECT id FROM document_chunks WHERE document_id = ?')
        .all(doc.id) as { id: string }[];
      for (const { id } of chunkIds) {
        db.prepare(
          'DELETE FROM document_chunks_vec WHERE chunk_id = ?',
        ).run(id);
      }
    } catch {
      /* vec table may not exist */
    }
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
    '.docx':
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx':
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.csv': 'text/csv',
    '.json': 'application/json',
  };
  return map[ext.toLowerCase()] || null;
}

export {
  CHUNK_SIZE,
  CHUNK_OVERLAP,
  MAX_FILE_SIZE,
  SUPPORTED_EXTENSIONS,
  IGNORED_DIRS,
};
