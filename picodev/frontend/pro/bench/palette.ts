/**
 * The colours of the probes, one palette for every view of them: the marks on
 * the schema, the live traces and the logic capture. A probe's colour is its
 * rank among the probes of its kind, as the traces draw them.
 */
import type { SetupSheet } from './types';

type Probe = SetupSheet['probes'][number];

export const PALETTE = { scope: ['#F6C26B', '#8DB7F0', '#9FD5B3'], logic: ['#1D6FB8', '#B8433E', '#3E6B4F', '#0A2440'] };

/** The colour of the i-th probe of a kind. */
export const probeColor = (kind: Probe['kind'], i: number) => PALETTE[kind][i % PALETTE[kind].length];

/** Every probe of the sheet with its colour. */
export function probeMarks(probes: Probe[]): Array<Probe & { color: string }> {
  const seen = { scope: 0, logic: 0 };
  return probes.map((p) => ({ ...p, color: probeColor(p.kind, seen[p.kind]++) }));
}

/**
 * The name a board's `pinInfo` gives an Arduino pin number: "9", or "D9",
 * or "A0" for 14 and up (Uno, Nano). Null when the board has no such pin.
 * ponytail: Uno/Nano numbering; a Mega's A0 (54) is found only if its pinInfo says "54".
 */
export function pinName(pin: number, names: string[]): string | null {
  return [String(pin), `D${pin}`, pin >= 14 ? `A${pin - 14}` : ''].find((n) => n && names.includes(n)) ?? null;
}

/** The width a mark's label takes, in px (11 px mono, 6 px padding each side). */
export const labelWidth = (label: string) => label.length * 7 + 14;

/**
 * A row for each label, so labels of neighbouring pins never cover each
 * other: in x order, each label takes the lowest row where it overlaps no
 * label already placed there (row 0 sits right above the pin).
 */
export function stagger<M extends { x: number; label: string }>(marks: M[], gap = 4): Array<M & { row: number }> {
  const rows: number[] = []; // the right edge of the last label of each row
  return [...marks]
    .sort((a, b) => a.x - b.x)
    .map((m) => {
      const w = labelWidth(m.label);
      const left = m.x - w / 2;
      let row = rows.findIndex((right) => right + gap <= left);
      if (row < 0) row = rows.length;
      rows[row] = left + w;
      return { ...m, row };
    });
}
