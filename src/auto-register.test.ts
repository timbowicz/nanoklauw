import { describe, it, expect, vi } from 'vitest';

import { slugifyGroupName, maybeAutoRegister } from './auto-register.js';
import type { RegisteredGroup } from './types.js';

function makeGroup(folder: string): RegisteredGroup {
  return { name: folder, folder, trigger: '@Andy', added_at: '', requiresTrigger: true };
}

describe('slugifyGroupName', () => {
  it('lowercases and hyphenates spaces', () => {
    expect(slugifyGroupName('Family Chat', {})).toBe('family-chat');
  });

  it('strips emoji and special characters', () => {
    expect(slugifyGroupName('Family Chat 🏠', {})).toBe('family-chat');
  });

  it('strips leading/trailing hyphens', () => {
    expect(slugifyGroupName('  --Hello World--  ', {})).toBe('hello-world');
  });

  it('truncates to 40 characters', () => {
    const long = 'a'.repeat(60);
    expect(slugifyGroupName(long, {}).length).toBeLessThanOrEqual(40);
  });

  it('avoids reserved main folder name', () => {
    const result = slugifyGroupName('main', {});
    expect(result).not.toBe('main');
    expect(result).toBe('main-2');
  });

  it('handles collision with existing folders', () => {
    const existing = { 'x@g.us': makeGroup('family-chat') };
    expect(slugifyGroupName('Family Chat', existing)).toBe('family-chat-2');
  });

  it('handles multiple collisions', () => {
    const existing = {
      'a@g.us': makeGroup('family-chat'),
      'b@g.us': makeGroup('family-chat-2'),
    };
    expect(slugifyGroupName('Family Chat', existing)).toBe('family-chat-3');
  });

  it('prefixes with group- if slug starts with non-alphanumeric', () => {
    expect(slugifyGroupName('🏠🏠🏠', {})).toMatch(/^group-/);
  });

  it('handles empty string', () => {
    const result = slugifyGroupName('', {});
    expect(result).toMatch(/^group-/);
  });
});

describe('maybeAutoRegister', () => {
  it('registers an unregistered group', () => {
    const registerGroup = vi.fn();
    maybeAutoRegister('new@g.us', 'New Group', true, {}, registerGroup);
    expect(registerGroup).toHaveBeenCalledOnce();
    expect(registerGroup.mock.calls[0][0]).toBe('new@g.us');
    expect(registerGroup.mock.calls[0][1]).toMatchObject({
      name: 'New Group',
      folder: 'new-group',
      requiresTrigger: false,
    });
  });

  it('skips already-registered group', () => {
    const registerGroup = vi.fn();
    const groups = { 'x@g.us': makeGroup('x') };
    maybeAutoRegister('x@g.us', 'X', true, groups, registerGroup);
    expect(registerGroup).not.toHaveBeenCalled();
  });

  it('skips non-groups (DMs)', () => {
    const registerGroup = vi.fn();
    maybeAutoRegister('dm@s.whatsapp.net', 'DM', false, {}, registerGroup);
    expect(registerGroup).not.toHaveBeenCalled();
  });

  it('skips when isGroup is undefined', () => {
    const registerGroup = vi.fn();
    maybeAutoRegister('x@g.us', 'Group', undefined, {}, registerGroup);
    expect(registerGroup).not.toHaveBeenCalled();
  });

  it('uses chatJid as name when name is undefined', () => {
    const registerGroup = vi.fn();
    maybeAutoRegister('abc@g.us', undefined, true, {}, registerGroup);
    expect(registerGroup).toHaveBeenCalledOnce();
    expect(registerGroup.mock.calls[0][1].name).toBe('abc@g.us');
  });
});
