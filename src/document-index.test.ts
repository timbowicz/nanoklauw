import fs from 'fs';
import os from 'os';
import path from 'path';
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

describe('document index - embedding', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('initializes the document index module', async () => {
    const { initDocumentIndex } = await import('./document-index.js');
    // initDocumentIndex should create the vec table and load the model
    // For tests, we skip actual model loading and vec extension
    await expect(
      initDocumentIndex({ skipModel: true, skipVec: true }),
    ).resolves.not.toThrow();
  });
});

describe('document index - parsing', () => {
  it('parses markdown content', async () => {
    const { parseFile } = await import('./document-index.js');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docindex-'));
    const tmpFile = path.join(tmpDir, 'test.md');
    fs.writeFileSync(
      tmpFile,
      '# Title\n\nSome content here.\n\n## Section 2\n\nMore content.',
    );
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
    fs.writeFileSync(
      tmpFile,
      JSON.stringify({ key: 'value', nested: { a: 1 } }),
    );
    const result = await parseFile(tmpFile);
    expect(result).toContain('key');
    expect(result).toContain('value');
    fs.rmSync(tmpDir, { recursive: true });
  });
});

describe('document index - chunking', () => {
  it('chunks short text into a single chunk', async () => {
    const { chunkText } = await import('./document-index.js');
    const chunks = chunkText('Short text.');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe('Short text.');
  });

  it('chunks long text with overlap', async () => {
    const { chunkText, CHUNK_SIZE } = await import('./document-index.js');
    // Generate text longer than CHUNK_SIZE
    const longText = 'word '.repeat(1000); // ~5000 chars
    const chunks = chunkText(longText);
    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk should be <= CHUNK_SIZE (except possibly the last)
    for (let i = 0; i < chunks.length - 1; i++) {
      expect(chunks[i].length).toBeLessThanOrEqual(CHUNK_SIZE + 50);
    }
  });

  it('splits markdown on headers', async () => {
    const { chunkText } = await import('./document-index.js');
    const md =
      '# Section 1\n\nContent of section 1.\n\n# Section 2\n\nContent of section 2.';
    const chunks = chunkText(md);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toContain('Section 1');
    expect(chunks[1]).toContain('Section 2');
  });
});

describe('document index - indexing pipeline', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('indexes a text file and stores chunks in DB', async () => {
    const { indexFile, getDocumentByPath, getChunksForDocument } = await import(
      './document-index.js'
    );
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
    const { indexFile, getDocumentByPath } = await import(
      './document-index.js'
    );
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
    const { indexFile, getDocumentByPath } = await import(
      './document-index.js'
    );
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
