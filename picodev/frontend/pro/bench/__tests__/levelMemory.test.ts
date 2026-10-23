import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { endSession, readHints, readLevel, readSpeed, saveHints, saveLevel, saveSpeed, sessionStart } from '../levelMemory';

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
    expect(readHints('setup-a', 'l1', 3)).toBe(0);
    expect(() => saveHints('setup-a', 'l1', 1)).not.toThrow();
    expect(readSpeed([0.5, 1, 2])).toBe(1);
    expect(() => saveSpeed(2)).not.toThrow();
  });

  it('keeps the hints shown per setup and level, clamped', () => {
    saveHints('setup-a', 'l1', 2);
    saveHints('setup-a', 'l2', 1);
    expect(readHints('setup-a', 'l1', 3)).toBe(2);
    expect(readHints('setup-a', 'l2', 3)).toBe(1);
    expect(readHints('setup-a', 'l1', 1)).toBe(1);
    expect(readHints('setup-b', 'l1', 3)).toBe(0);
    store['picodev-lab:hints:setup-a'] = 'not json';
    expect(readHints('setup-a', 'l1', 3)).toBe(0);
  });

  it('keeps the speed when it is one offered', () => {
    expect(readSpeed([0.5, 1, 2])).toBe(1);
    saveSpeed(2);
    expect(readSpeed([0.5, 1, 2])).toBe(2);
    store['picodev-lab:speed'] = '3';
    expect(readSpeed([0.5, 1, 2])).toBe(1);
    store['picodev-lab:speed'] = '';
    expect(readSpeed([0.5, 1, 2])).toBe(1);
  });
});

describe('session start', () => {
  let store: Record<string, string>;
  beforeEach(() => {
    store = {};
    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => void (store[k] = v),
      removeItem: (k: string) => void delete store[k],
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('keeps the first start of the tab across reloads, per setup and mode', () => {
    expect(sessionStart('setup-a', 'challenge', 1000)).toBe(1000);
    expect(store['picodev-lab:bench-start:setup-a:challenge']).toBe('1000');
    expect(sessionStart('setup-a', 'challenge', 61000)).toBe(1000);
    expect(sessionStart('setup-a', 'free', 61000)).toBe(61000);
  });

  it('starts again after the end of the session, or on garbage or a start to come', () => {
    sessionStart('setup-a', 'free', 1000);
    endSession('setup-a', 'free');
    expect(sessionStart('setup-a', 'free', 5000)).toBe(5000);
    for (const v of ['', 'abc', '-1', '1.5', '99999']) {
      store['picodev-lab:bench-start:setup-a:free'] = v;
      expect(sessionStart('setup-a', 'free', 9000)).toBe(9000);
    }
  });

  it('survives a storage that throws', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('denied');
      },
    });
    expect(sessionStart('setup-a', 'free', 7)).toBe(7);
    expect(() => endSession('setup-a', 'free')).not.toThrow();
  });
});
