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

export {
  CHUNK_SIZE,
  CHUNK_OVERLAP,
  MAX_FILE_SIZE,
  SUPPORTED_EXTENSIONS,
  IGNORED_DIRS,
};
