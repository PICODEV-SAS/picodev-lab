import { describe, expect, it } from 'vitest';
import { PALETTE, labelWidth, probeColor, probeMarks, stagger, toView } from '../palette';

describe('probe palette', () => {
  it('colours a probe by its rank among the probes of its kind, as the traces draw them', () => {
    const marks = probeMarks([
      { pin: 2, label: 'D2', kind: 'logic' },
      { pin: 9, label: 'D9', kind: 'scope' },
      { pin: 6, label: 'D6', kind: 'logic' },
      { pin: 3, label: 'D3', kind: 'scope' },
    ]);
    expect(marks.map((m) => m.color)).toEqual([PALETTE.logic[0], PALETTE.scope[0], PALETTE.logic[1], PALETTE.scope[1]]);
    expect(marks[1]).toEqual({ pin: 9, label: 'D9', kind: 'scope', color: PALETTE.scope[0] });
    expect(probeColor('scope', PALETTE.scope.length)).toBe(PALETTE.scope[0]); // wraps around
  });

});

describe('toView', () => {
  it('follows a rotated, scaled and moved world', () => {
    // A quarter turn, twice as big, moved by (100, 50): (10, 0) lands at (100, 70).
    expect(toView({ a: 0, b: 2, c: -2, d: 0, e: 100, f: 50 }, 10, 0)).toEqual({ x: 100, y: 70 });
    expect(toView({ a: 0, b: 2, c: -2, d: 0, e: 100, f: 50 }, 0, 10)).toEqual({ x: 80, y: 50 });
  });
});

describe('stagger', () => {
  it('lifts the label of a neighbouring pin to the next row, and back down when there is room', () => {
    const rows = stagger([{ x: 100, label: 'D10' }, { x: 90, label: 'D9' }, { x: 300, label: 'D2' }, { x: 110, label: 'D11' }]);
    expect(rows.map((m) => [m.label, m.row])).toEqual([['D9', 0], ['D10', 1], ['D11', 2], ['D2', 0]]);
  });
  it('keeps labels far apart on row 0', () => {
    const w = labelWidth('D9');
    expect(stagger([{ x: 0, label: 'D9' }, { x: w + 4, label: 'D8' }]).map((m) => m.row)).toEqual([0, 0]);
  });
});
