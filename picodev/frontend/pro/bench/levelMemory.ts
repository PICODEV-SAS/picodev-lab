/**
 * What this browser keeps of the bench, every access wrapped (storage may be refused):
 * the level reached in Défi, per setup (the end page of a deployment may read it),
 * the hints shown, per setup and level, the simulation speed, and this tab's session start.
 */
const levelKey = (setupId: string) => `picodev-lab:level:${setupId}`;

/** The saved level index, clamped to the sheet's levels; 0 when nothing usable is stored. */
export function readLevel(setupId: string, levelCount: number): number {
  let raw: string | null;
  try {
    raw = localStorage.getItem(levelKey(setupId));
  } catch {
    return 0; // storage refused (private mode): start at level 1
  }
  const n = Number(raw);
  if (raw === null || raw.trim() === '' || !Number.isInteger(n)) return 0;
  return Math.max(0, Math.min(n, levelCount - 1));
}

export function saveLevel(setupId: string, index: number) {
  try {
    localStorage.setItem(levelKey(setupId), String(index));
  } catch {
    // storage full or refused: the level is not kept
  }
}

/** When this tab's session on a setup and mode began, so that a reload or a change of language keeps counting. */
const startKey = (setupId: string, mode: string) => `picodev-lab:bench-start:${setupId}:${mode}`;

/** The start of the session (ms since the epoch): the one kept for this tab, or now, then kept. */
export function sessionStart(setupId: string, mode: string, now = Date.now()): number {
  try {
    const kept = Number(sessionStorage.getItem(startKey(setupId, mode)));
    if (Number.isInteger(kept) && kept > 0 && kept <= now) return kept;
    sessionStorage.setItem(startKey(setupId, mode), String(now));
  } catch {
    // storage refused: the session counts from the page load
  }
  return now;
}

/** Ends the session: the next visit of the setup in this tab counts from zero. */
export function endSession(setupId: string, mode: string) {
  try {
    sessionStorage.removeItem(startKey(setupId, mode));
  } catch {
    // storage refused: nothing was kept
  }
}
const hintsKey = (setupId: string) => `picodev-lab:hints:${setupId}`;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage full or refused: not kept
  }
}

function hintsOf(setupId: string): Record<string, number> {
  try {
    const v: unknown = JSON.parse(read(hintsKey(setupId)) ?? '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/** The hints already shown for a level, clamped to its hints. */
export function readHints(setupId: string, levelId: string, hintCount: number): number {
  const n = hintsOf(setupId)[levelId];
  return Number.isInteger(n) ? Math.max(0, Math.min(n, hintCount)) : 0;
}

export function saveHints(setupId: string, levelId: string, shown: number) {
  write(hintsKey(setupId), JSON.stringify({ ...hintsOf(setupId), [levelId]: shown }));
}

const SPEED_KEY = 'picodev-lab:speed';

/** The speed chosen last, if it is one of `speeds`; 1 otherwise. */
export function readSpeed(speeds: number[]): number {
  const raw = read(SPEED_KEY);
  const n = Number(raw);
  return raw !== null && speeds.includes(n) ? n : 1;
}

export const saveSpeed = (speed: number) => write(SPEED_KEY, String(speed));
