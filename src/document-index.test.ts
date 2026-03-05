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
