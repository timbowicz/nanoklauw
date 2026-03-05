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
