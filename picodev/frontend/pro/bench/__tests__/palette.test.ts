import { describe, expect, it } from 'vitest';
import { PALETTE, labelWidth, pinName, probeColor, probeMarks, stagger } from '../palette';

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

  it('finds the pin a board names', () => {
    expect(pinName(9, ['8', '9', 'GND.1'])).toBe('9');
    expect(pinName(9, ['D8', 'D9'])).toBe('D9');
    expect(pinName(14, ['13', 'A0'])).toBe('A0');
    expect(pinName(42, ['13', 'A0'])).toBeNull();
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
