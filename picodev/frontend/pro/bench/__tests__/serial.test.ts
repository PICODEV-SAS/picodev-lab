import { describe, expect, it } from 'vitest';
import { emptySerial, MAX_SERIAL, serialView, type BenchSerial, type BenchSerialAction } from '../serial';

const run = (actions: BenchSerialAction[], from: BenchSerial = emptySerial) => actions.reduce(serialView, from);

describe('serial panel of a real turn', () => {
  it('keeps the board text exact, the load lines apart, with the load time', () => {
    const s = run([
      { type: 'flash', state: 'start', at: 1000 },
      { type: 'board', text: 'boot' },
      { type: 'flash', state: 'ok', at: 3450 },
      { type: 'board', text: 'Hel' },
      { type: 'board', text: 'lo\n' },
      { type: 'flash', state: 'start', at: 5000 },
      { type: 'flash', state: 'failed', detail: 'avrdude: timeout', at: 6000 },
      { type: 'flash', state: 'failed', at: 7000 },
    ]);
    expect(s.entries).toEqual([
      { flash: 'start' },
      { board: 'boot' },
      { flash: 'ok', secs: 2.45 },
      { board: 'Hello\n' },
      { flash: 'start' },
      { flash: 'failed', detail: 'avrdude: timeout' },
      { flash: 'failed' },
    ]);
    expect(s.since).toBeUndefined();
  });

  it('an ok without its start has no time', () => {
    expect(run([{ type: 'flash', state: 'ok', at: 10 }]).entries).toEqual([{ flash: 'ok' }]);
  });

  it('keeps the last 16 384 characters of the board, and drops the lines before them', () => {
    const s = run([
      { type: 'board', text: 'a'.repeat(10) },
      { type: 'flash', state: 'start', at: 0 },
      { type: 'flash', state: 'ok', at: 1 },
      { type: 'board', text: 'b'.repeat(MAX_SERIAL - 5) },
      { type: 'flash', state: 'start', at: 2 },
      { type: 'flash', state: 'ok', at: 3 },
      { type: 'board', text: 'c'.repeat(5) },
    ]);
    expect(s.entries).toEqual([{ board: 'b'.repeat(MAX_SERIAL - 5) }, { flash: 'start' }, { flash: 'ok', secs: 0.001 }, { board: 'ccccc' }]);
    const full = run([{ type: 'board', text: 'x' }, { type: 'board', text: 'y'.repeat(MAX_SERIAL) }]);
    expect(full.entries).toEqual([{ board: 'y'.repeat(MAX_SERIAL) }]);
    expect(run([{ type: 'board', text: 'z'.repeat(MAX_SERIAL + 3) }]).entries).toEqual([{ board: 'z'.repeat(MAX_SERIAL) }]);
  });

  it('reset empties but keeps a load under way; clear closes it', () => {
    const loading = run([{ type: 'board', text: 'old' }, { type: 'flash', state: 'start', at: 100 }]);
    const reset = serialView(loading, { type: 'reset' });
    expect(reset.entries).toEqual([{ flash: 'start' }]);
    expect(serialView(reset, { type: 'flash', state: 'ok', at: 1100 }).entries).toEqual([{ flash: 'start' }, { flash: 'ok', secs: 1 }]);
    expect(serialView(run([{ type: 'board', text: 'old' }]), { type: 'reset' })).toEqual(emptySerial);
    expect(serialView(loading, { type: 'clear' })).toEqual(emptySerial);
  });
});
