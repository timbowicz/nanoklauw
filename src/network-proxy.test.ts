import { describe, it, expect, beforeEach } from 'vitest';
import { _initTestDatabase } from './db.js';
import { isAllowlisted, addToAllowlist, getAllAllowlisted } from './db.js';

describe('network allowlist', () => {
  beforeEach(() => { _initTestDatabase(); });

  it('returns false for unknown domain', () => {
    expect(isAllowlisted('example.com')).toBe(false);
  });

  it('returns true after adding domain', () => {
    addToAllowlist('example.com', 'test-group');
    expect(isAllowlisted('example.com')).toBe(true);
  });

  it('does not duplicate on re-add', () => {
    addToAllowlist('example.com', 'group-a');
    addToAllowlist('example.com', 'group-b');
    expect(getAllAllowlisted()).toHaveLength(1);
  });
});
