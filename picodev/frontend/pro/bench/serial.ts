/**
 * The serial panel during a turn on a real bench: the board's output (v0.23),
 * kept exact, and the editor's own lines on the bench's loads (`flash`, v0.24),
 * as separate entries so they never mix into the board's text.
 */

export type FlashState = 'start' | 'ok' | 'failed';
/** `secs`: how long the load took, when its start was seen. */
export type SerialEntry = { board: string } | { flash: FlashState; secs?: number; detail?: string };
/** `since`: when the load under way started (ms, the caller's clock). */
export interface BenchSerial { entries: SerialEntry[]; since?: number }
export type BenchSerialAction =
  | { type: 'board'; text: string }
  | { type: 'flash'; state: FlashState; detail?: string; at: number }
  /** Turn start, Lancer: empty, but a load under way keeps its line (its start may come first). */
  | { type: 'reset' }
  /** Turn end: a load without an answer is closed. */
  | { type: 'clear' };

/** The board's characters kept on screen (the hub keeps 16 KiB). */
export const MAX_SERIAL = 16384;
export const emptySerial: BenchSerial = { entries: [] };

/** Keeps the last MAX_SERIAL characters of the board; the editor's lines before them go too. */
function trim(entries: SerialEntry[]): SerialEntry[] {
  let left = MAX_SERIAL;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!('board' in e)) continue;
    if (e.board.length < left) left -= e.board.length;
    else return [{ board: e.board.slice(e.board.length - left) }, ...entries.slice(i + 1)];
  }
  return entries;
}

// ponytail: the editor's lines are not counted, one per load at most (a load per 10 s).
export function serialView(s: BenchSerial, a: BenchSerialAction): BenchSerial {
  switch (a.type) {
    case 'clear':
      return emptySerial;
    case 'reset':
      return s.since === undefined ? emptySerial : { entries: [{ flash: 'start' }], since: s.since };
    case 'flash':
      if (a.state === 'start') return { entries: [...s.entries, { flash: 'start' }], since: a.at };
      return {
        entries: [
          ...s.entries,
          a.state === 'ok'
            ? { flash: 'ok', ...(s.since === undefined ? {} : { secs: Math.max(0, a.at - s.since) / 1000 }) }
            : { flash: 'failed', ...(a.detail ? { detail: a.detail } : {}) },
        ],
      };
    case 'board': {
      if (!a.text) return s;
      const last = s.entries.at(-1);
      const entries = last && 'board' in last
        ? [...s.entries.slice(0, -1), { board: last.board + a.text }]
        : [...s.entries, { board: a.text }];
      return { ...s, entries: trim(entries) };
    }
  }
}
