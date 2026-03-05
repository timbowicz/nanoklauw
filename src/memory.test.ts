import { describe, it, expect, beforeEach } from 'vitest';
import { _initTestDatabase, getDb } from './db.js';
import {
  initMemorySchema,
  addCoreMemory,
  updateCoreMemory,
  removeCoreMemory,
  getCoreMemories,
  buildMemorySnapshot,
  retrieveMemoryContext,
} from './memory.js';

describe('memory schema', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('creates memory tables without error', () => {
    expect(() => initMemorySchema()).not.toThrow();
  });

  it('creates core_memories table', () => {
    initMemorySchema();
    const db = getDb();
    const info = db.prepare("PRAGMA table_info('core_memories')").all();
    expect(info.length).toBeGreaterThan(0);
    const columns = (info as any[]).map((r) => r.name);
    expect(columns).toContain('id');
    expect(columns).toContain('group_folder');
    expect(columns).toContain('category');
    expect(columns).toContain('content');
    expect(columns).toContain('is_pinned');
  });

  it('creates conversation_chunks table', () => {
    initMemorySchema();
    const db = getDb();
    const info = db.prepare("PRAGMA table_info('conversation_chunks')").all();
    expect(info.length).toBeGreaterThan(0);
    const columns = (info as any[]).map((r) => r.name);
    expect(columns).toContain('id');
    expect(columns).toContain('group_folder');
    expect(columns).toContain('chat_jid');
    expect(columns).toContain('content');
  });

  it('creates archival_memories table', () => {
    initMemorySchema();
    const db = getDb();
    const info = db.prepare("PRAGMA table_info('archival_memories')").all();
    expect(info.length).toBeGreaterThan(0);
    const columns = (info as any[]).map((r) => r.name);
    expect(columns).toContain('id');
    expect(columns).toContain('group_folder');
    expect(columns).toContain('content');
    expect(columns).toContain('session_id');
  });
});

describe('core memory CRUD', () => {
  beforeEach(() => {
    _initTestDatabase();
    initMemorySchema();
  });

  it('adds and retrieves a core memory', () => {
    const id = addCoreMemory('test-group', 'preference', 'Likes dark mode');
    expect(id).toBeTruthy();
    const memories = getCoreMemories('test-group');
    expect(memories.length).toBe(1);
    expect(memories[0].content).toBe('Likes dark mode');
    expect(memories[0].category).toBe('preference');
  });

  it('filters by category', () => {
    addCoreMemory('test-group', 'preference', 'Likes dark mode');
    addCoreMemory('test-group', 'fact', 'Lives in Amsterdam');
    addCoreMemory('test-group', 'preference', 'Prefers TypeScript');

    const prefs = getCoreMemories('test-group', 'preference');
    expect(prefs.length).toBe(2);

    const facts = getCoreMemories('test-group', 'fact');
    expect(facts.length).toBe(1);
    expect(facts[0].content).toBe('Lives in Amsterdam');
  });

  it('updates a core memory', () => {
    const id = addCoreMemory('test-group', 'preference', 'Likes dark mode');
    updateCoreMemory(id, 'Now prefers light mode');

    const memories = getCoreMemories('test-group');
    expect(memories.length).toBe(1);
    expect(memories[0].content).toBe('Now prefers light mode');
  });

  it('removes a core memory', () => {
    const id = addCoreMemory('test-group', 'preference', 'Likes dark mode');
    expect(getCoreMemories('test-group').length).toBe(1);

    removeCoreMemory(id);
    expect(getCoreMemories('test-group').length).toBe(0);
  });

  it('isolates memories by group', () => {
    addCoreMemory('group-a', 'fact', 'Fact for A');
    addCoreMemory('group-b', 'fact', 'Fact for B');

    expect(getCoreMemories('group-a').length).toBe(1);
    expect(getCoreMemories('group-b').length).toBe(1);
    expect(getCoreMemories('group-a')[0].content).toBe('Fact for A');
  });
});

describe('buildMemorySnapshot', () => {
  beforeEach(() => {
    _initTestDatabase();
    initMemorySchema();
  });

  it('returns empty snapshot for empty group', () => {
    const snapshot = buildMemorySnapshot('test-group');
    expect(snapshot.coreMemories).toEqual([]);
  });

  it('includes core memories in snapshot', () => {
    addCoreMemory('test-group', 'fact', 'Test fact');
    const snapshot = buildMemorySnapshot('test-group');
    expect(snapshot.coreMemories.length).toBe(1);
    expect(snapshot.coreMemories[0].content).toBe('Test fact');
    expect(snapshot.coreMemories[0].category).toBe('fact');
    expect(typeof snapshot.coreMemories[0].id).toBe('string');
  });
});

describe('retrieveMemoryContext', () => {
  beforeEach(() => {
    _initTestDatabase();
    initMemorySchema();
  });

  it('returns empty string when no memories exist', async () => {
    const context = await retrieveMemoryContext('test-group', [
      {
        id: '1',
        chat_jid: 'test',
        sender: 's',
        sender_name: 'User',
        content: 'Hello',
        timestamp: new Date().toISOString(),
        is_from_me: false,
      },
    ]);
    expect(context).toBe('');
  });

  it('returns empty string for empty messages', async () => {
    const context = await retrieveMemoryContext('test-group', []);
    expect(context).toBe('');
  });

  it('includes core memories in context', async () => {
    addCoreMemory('test-group', 'fact', 'User lives in Amsterdam');

    const context = await retrieveMemoryContext('test-group', [
      {
        id: '1',
        chat_jid: 'test',
        sender: 's',
        sender_name: 'User',
        content: 'Where do I live?',
        timestamp: new Date().toISOString(),
        is_from_me: false,
      },
    ]);
    expect(context).toContain('User lives in Amsterdam');
    expect(context).toContain('<memory type="core">');
  });
});
