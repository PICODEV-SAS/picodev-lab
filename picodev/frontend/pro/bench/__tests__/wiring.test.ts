import { describe, expect, it } from 'vitest';
import { boardPinOf, pinNumber, wiresOn, type PlainWire } from '../wiring';

const end = (componentId: string, pinName: string, x = 0, y = 0) => ({ componentId, pinName, x, y });
const wire = (id: string, a: ReturnType<typeof end>, b: ReturnType<typeof end>): PlainWire => ({ id, start: a, end: b, waypoints: [] });

// Setup A's wiring, as its sheet writes it.
const wires = [
  wire('sv-pwm', end('nano', '9', 10, 20), end('servo', 'PWM', 300, 40)),
  wire('btn-in', end('nano', 'D2', 12, 20), end('button', '1.l', 300, 200)),
  wire('btn-gnd', end('button', '2.l'), end('nano', 'GND')),
  wire('led-in', end('resistor', '1', 280, 300), end('nano', 'A0', 14, 20)),
];

describe('pinNumber', () => {
  it('reads the numbered pins of an Uno or a Nano', () => {
    expect([pinNumber('9'), pinNumber('D2'), pinNumber('A0'), pinNumber('A5')]).toEqual([9, 2, 14, 19]);
  });
  it('has no number for power pins', () => {
    expect([pinNumber('GND'), pinNumber('5V'), pinNumber('3V3')]).toEqual([null, null, null]);
  });
});

describe('wiresOn', () => {
  it('finds the wire of a probed pin and its end on the part', () => {
    expect(wiresOn(9, wires, 'nano').map(({ wire, far }) => [wire.id, far.componentId, far.x])).toEqual([['sv-pwm', 'servo', 300]]);
  });
  it('finds a wire drawn from the part to the board', () => {
    expect(wiresOn(14, wires, 'nano').map(({ far }) => far.componentId)).toEqual(['resistor']);
  });
  it('finds nothing on a pin no wire leaves', () => {
    expect(wiresOn(13, wires, 'nano')).toEqual([]);
  });
});

describe('boardPinOf', () => {
  it('gives the board pin a button is wired to, not its ground', () => {
    expect([...boardPinOf(['button'], wires, 'nano')]).toEqual([['button', 2]]);
  });
  it('does not find a button wired through another part', () => {
    expect(boardPinOf(['servo-2'], [wire('w', end('servo-2', '1'), end('resistor', '2'))], 'nano').size).toBe(0);
  });
});
