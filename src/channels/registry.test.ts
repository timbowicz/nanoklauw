import { describe, it, expect, beforeEach } from 'vitest';

// Use dynamic import to get a fresh module for each test
// since the registry is module-level state
let registerChannel: typeof import('./registry.js').registerChannel;
let getChannelFactory: typeof import('./registry.js').getChannelFactory;
let getRegisteredChannelNames: typeof import('./registry.js').getRegisteredChannelNames;

describe('Channel Registry', () => {
  beforeEach(async () => {
    // Re-import to get fresh module state
    const mod = await import('./registry.js');
    registerChannel = mod.registerChannel;
    getChannelFactory = mod.getChannelFactory;
    getRegisteredChannelNames = mod.getRegisteredChannelNames;
  });

  it('registers and retrieves a channel factory', () => {
    const factory = () => null;
    registerChannel('test', factory);
    expect(getChannelFactory('test')).toBe(factory);
  });

  it('returns undefined for unknown channel', () => {
    expect(getChannelFactory('nonexistent')).toBeUndefined();
  });

  it('lists registered channel names', () => {
    registerChannel('alpha', () => null);
    registerChannel('beta', () => null);
    const names = getRegisteredChannelNames();
    expect(names).toContain('alpha');
    expect(names).toContain('beta');
  });

  it('overwrites a channel factory on re-registration', () => {
    const first = () => null;
    const second = () => null;
    registerChannel('overwrite', first);
    registerChannel('overwrite', second);
    expect(getChannelFactory('overwrite')).toBe(second);
  });
});
