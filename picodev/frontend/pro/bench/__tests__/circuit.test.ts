/** The circuit in the sheet's shape, and the checks of an agent's circuit (v0.8). */
import { describe, expect, it } from 'vitest';
import { checkCircuit, circuitFits, circuitOf, pinKnown, placeFree, readCircuit, type Catalogue, type PushedCircuit } from '../circuit';

const catalogue: Catalogue = {
  kind: (type) => (type === 'wokwi-led' || type === 'wokwi-resistor' || type === 'wokwi-mystery' ? 'part' : type === 'wokwi-arduino-uno' ? 'board' : null),
  pins: (type) => (type === 'wokwi-led' ? ['A', 'C'] : type === 'wokwi-resistor' ? ['1', '2'] : null),
};
const board = ['GND.1', 'GND.2', '5V', '13', 'A0'];
const wire = (id: string, a: [string, string], b: [string, string]) => ({ id, start: { componentId: a[0], pinName: a[1] }, end: { componentId: b[0], pinName: b[1] }, color: '#000' });
const pushed = (
  wires: ReturnType<typeof wire>[],
  components: PushedCircuit['components'] = [
    { type: 'wokwi-led', id: 'led1', properties: {} },
    { type: 'wokwi-resistor', id: 'r1', x: 10, y: 20, properties: { value: '220' } },
  ],
): PushedCircuit => ({ components, wires });

describe('circuit (v0.8)', () => {
  it('reads the store in the sheet shape: no runtime level, no seating wire, plain properties only', () => {
    const c = circuitOf(
      [{ id: 'led1', metadataId: 'led', x: 1, y: 2, properties: { color: 'red', state: true, value: true, attrs: { a: 1 }, long: 'x'.repeat(300), n: 3 } }],
      [
        { id: 'w1', start: { componentId: 'arduino-nano', pinName: '6', x: 5, y: 5 } as never, end: { componentId: 'led1', pinName: 'A' }, color: '#f00' },
        { id: 'bb1', start: { componentId: 'led1', pinName: 'C' }, end: { componentId: 'bb', pinName: 'a1' }, color: '#000', bb: true },
      ],
      (id) => (id === 'led' ? 'wokwi-led' : `x-${id}`),
    );
    expect(c).toEqual({
      components: [{ type: 'wokwi-led', id: 'led1', x: 1, y: 2, properties: { color: 'red', n: 3 } }],
      wires: [{ id: 'w1', start: { componentId: 'arduino-nano', pinName: '6' }, end: { componentId: 'led1', pinName: 'A' }, color: '#f00' }],
    });
    expect(circuitFits(c)).toBe(true);
    expect(circuitFits({ components: Array(41).fill(c.components[0]), wires: [] })).toBe(false);
  });

  it('refuses a malformed circuit', () => {
    expect(readCircuit({ components: [] })).toMatch(/lists/);
    expect(readCircuit({ components: Array(41).fill({ type: 'wokwi-led', id: 'a' }), wires: [] })).toMatch(/too large/);
    expect(readCircuit({ components: [{ type: 'wokwi-led', id: 'bad id' }], wires: [] })).toMatch(/Invalid component/);
    expect(readCircuit({ components: [{ type: 'wokwi-led', id: 'a' }, { type: 'wokwi-led', id: 'a' }], wires: [] })).toMatch(/Duplicate/);
    expect(readCircuit({ components: [], wires: [{ id: 'w', start: { componentId: 'a' }, end: { componentId: 'b', pinName: '1' } }] })).toMatch(/Invalid wire/);
    expect(readCircuit({ components: [{ type: 'wokwi-led', id: 'a', x: 3, properties: { color: 'red', o: {} } }], wires: [wire('w', ['a', 'A'], ['b', '1'])] })).toEqual({
      components: [{ type: 'wokwi-led', id: 'a', properties: { color: 'red' } }], // one coordinate is no place
      wires: [wire('w', ['a', 'A'], ['b', '1'])],
    });
  });

  it('checks types against the catalogue and wire ends against the pins', () => {
    const ok = pushed([wire('w1', ['uno', '13'], ['r1', '1']), wire('w2', ['r1', '2'], ['led1', 'A']), wire('w3', ['led1', 'C'], ['uno', 'GND'])]);
    expect(checkCircuit(ok, 'uno', board, catalogue)).toBeNull(); // GND for GND.1, as Velxio draws it
    expect(checkCircuit(pushed([], [{ type: 'wokwi-flux', id: 'f', properties: {} }]), 'uno', board, catalogue)).toBe('Unknown component type "wokwi-flux" (component f).');
    expect(checkCircuit(pushed([], [{ type: 'wokwi-arduino-uno', id: 'u2', properties: {} }]), 'uno', board, catalogue)).toMatch(/is a board/);
    expect(checkCircuit(pushed([], [{ type: 'wokwi-led', id: 'uno', properties: {} }]), 'uno', board, catalogue)).toMatch(/board's id/);
    expect(checkCircuit(pushed([wire('w1', ['uno', '13'], ['led1', 'B'])]), 'uno', board, catalogue)).toBe('Wire w1: component led1 (wokwi-led) has no pin "B".');
    expect(checkCircuit(pushed([wire('w1', ['uno', '42'], ['led1', 'A'])]), 'uno', board, catalogue)).toBe('Wire w1: the board uno has no pin "42".');
    expect(checkCircuit(pushed([wire('w1', ['nano', '13'], ['led1', 'A'])]), 'uno', board, catalogue)).toBe('Wire w1: no component "nano".');
    // Pins that cannot be read are not checked.
    expect(checkCircuit(pushed([wire('w1', ['m', 'any'], ['uno', '13'])], [{ type: 'wokwi-mystery', id: 'm', properties: {} }]), 'uno', board, catalogue)).toBeNull();
  });

  it('knows the spellings Velxio draws', () => {
    expect(pinKnown(['D13', 'GND.1'], '13')).toBe(true);
    expect(pinKnown(['13'], 'D13')).toBe(true);
    expect(pinKnown(['GND'], 'GND.2')).toBe(true);
    expect(pinKnown(['3V3'], '3.3V')).toBe(true);
    expect(pinKnown(['A', 'C'], 'K')).toBe(false);
  });

  it('places the parts without a place in rows right of the board and of the placed parts', () => {
    const c = placeFree(
      pushed([], [
        { type: 'wokwi-led', id: 'a', properties: {} },
        { type: 'wokwi-led', id: 'b', x: 500, y: 0, properties: {} },
        ...['c', 'd', 'e'].map((id) => ({ type: 'wokwi-led', id, properties: {} })),
      ]),
      300,
      50,
    );
    expect(c.components.map((p) => [p.id, p.x, p.y])).toEqual([
      ['a', 660, 50],
      ['b', 500, 0],
      ['c', 820, 50],
      ['d', 980, 50],
      ['e', 660, 190],
    ]);
    expect(placeFree(pushed([], [{ type: 'wokwi-led', id: 'a', properties: {} }]), 300, 0).components[0]).toMatchObject({ x: 340, y: 0 });
  });

  it('places by the size of each part: no part covers another', () => {
    const sizes: Record<string, { w: number; h: number }> = { lcd: { w: 330, h: 140 }, oled: { w: 150, h: 120 }, big: { w: 600, h: 300 } };
    const parts = ['led1', 'lcd', 'led2', 'oled', 'led3', 'big', 'led4'].map((id) => ({ type: 'wokwi-led', id, properties: {} }));
    const fixed = { type: 'wokwi-led', id: 'fixed', x: 400, y: 0, properties: {} };
    const sizeOf = (p: { id: string }) => sizes[p.id] ?? (p.id === 'fixed' ? { w: 500, h: 50 } : null);
    const c = placeFree(pushed([], [...parts, fixed]), 300, 0, sizeOf);
    const box = (p: (typeof c.components)[number]) => ({ ...p, ...(sizeOf(p) ?? { w: 120, h: 100 }) });
    const boxes = c.components.map(box);
    for (const a of boxes)
      for (const b of boxes)
        if (a !== b) expect(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, `${a.id} covers ${b.id}`).toBe(true);
    expect(boxes.filter((p) => p.id !== 'fixed').every((p) => p.x >= 400 + 500 + 40)).toBe(true); // right of the placed part, by its size
    expect(boxes.find((p) => p.id === 'big')!.x).toBe(940); // too wide for any row: alone on its own
  });
});
