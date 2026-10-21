import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readLevel, saveLevel } from '../levelMemory';

describe('level memory', () => {
  let store: Record<string, string>;
  beforeEach(() => {
    store = {};
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => void (store[k] = v),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('round-trips under picodev-lab:level:<setup>', () => {
    saveLevel('setup-a', 2);
    expect(store['picodev-lab:level:setup-a']).toBe('2');
    expect(readLevel('setup-a', 4)).toBe(2);
    expect(readLevel('setup-b', 4)).toBe(0);
  });

  it('clamps to the levels of the sheet', () => {
    saveLevel('setup-a', 9);
    expect(readLevel('setup-a', 3)).toBe(2);
    saveLevel('setup-a', -1);
    expect(readLevel('setup-a', 3)).toBe(0);
  });

  it('ignores garbage', () => {
    for (const v of ['', ' ', 'abc', '1.5', 'NaN', 'Infinity', '{}']) {
      store['picodev-lab:level:setup-a'] = v;
      expect(readLevel('setup-a', 3)).toBe(0);
    }
  });

  it('survives a storage that throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    });
    expect(readLevel('setup-a', 3)).toBe(0);
    expect(() => saveLevel('setup-a', 1)).not.toThrow();
  });
});
