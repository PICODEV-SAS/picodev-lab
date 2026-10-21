/** The level reached in Défi, kept per setup in this browser (the end page of a deployment may read it). */
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
