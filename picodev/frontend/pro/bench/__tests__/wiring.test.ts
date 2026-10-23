import { describe, expect, it } from 'vitest';
// Velxio's own mapping, as the page hands it over.
import { boardPinToNumber } from '../../../../../frontend/src/utils/boardPinMapping';
import { boardPinOf, boardPins, partEnds, wiresOn, type PlainWire } from '../wiring';

const end = (componentId: string, pinName: string, x = 0, y = 0) => ({ componentId, pinName, x, y });
const wire = (id: string, a: ReturnType<typeof end>, b: ReturnType<typeof end>): PlainWire => ({ id, start: a, end: b, waypoints: [] });

// Setup A's wiring, as its sheet writes it.
const wires = [
  wire('sv-pwm', end('nano', '9', 10, 20), end('servo', 'PWM', 300, 40)),
  wire('btn-in', end('nano', 'D2', 12, 20), end('button', '1.l', 300, 200)),
  wire('btn-gnd', end('button', '2.l'), end('nano', 'GND')),
  wire('led-in', end('resistor', '1', 280, 300), end('nano', 'A0', 14, 20)),
];

const analog = (n: number) => Array.from({ length: n }, (_, channel) => ({ pinName: `A${channel}`, channel }));
const named = (kind: string, names: string[], adc: number) => boardPins(names, (n) => boardPinToNumber(kind, n), analog(adc));
const nano = named('arduino-nano', ['GND.1', '5V', ...Array.from({ length: 14 }, (_, i) => String(i)), ...analog(8).map((a) => a.pinName)], 8);
const mega = named('arduino-mega', ['GND.1', '5V', '3.3V', ...Array.from({ length: 54 }, (_, i) => String(i)), ...analog(16).map((a) => a.pinName)], 16);
const number = nano.number;

describe('boardPins', () => {
  it('numbers an Uno or a Nano: A0 is 14, power pins have none', () => {
    expect(['9', 'D2', 'A0', 'A7'].map(number)).toEqual([9, 2, 14, 21]);
    expect(nano.pins).toEqual(Array.from({ length: 22 }, (_, i) => i));
    expect([...nano.adc]).toEqual(analog(8).map(({ channel }) => [14 + channel, channel]));
  });
  it('numbers a Mega: A0 is 54, its converter channel 0', () => {
    expect(['13', 'A0', 'A15', 'GND.1', '3.3V'].map(mega.number)).toEqual([13, 54, 69, -1, -1]);
    expect(mega.pins).toHaveLength(70);
    expect([mega.adc.get(54), mega.adc.get(69), mega.adc.get(14)]).toEqual([0, 15, undefined]);
  });
  it('numbers an ATtiny85 by its port: PB5 is 5, on converter channel 0', () => {
    const tiny = boardPins(['GND', 'VCC', 'PB0', 'PB1', 'PB2', 'PB3', 'PB4', 'PB5'], (n) => boardPinToNumber('attiny85', n), [
      { pinName: 'PB5', channel: 0 },
      { pinName: 'PB2', channel: 1 },
    ]);
    expect(tiny.pins).toEqual([0, 1, 2, 3, 4, 5]);
    expect([...tiny.adc]).toEqual([[5, 0], [2, 1]]);
  });
  it('leaves out an analog input the board does not number', () => {
    expect(boardPins(['13'], () => null, analog(2)).adc.size).toBe(0);
  });
});

describe('wiresOn', () => {
  it('finds the wire of a probed pin and its end on the part', () => {
    expect(wiresOn(9, wires, 'nano', number).map(({ wire, far }) => [wire.id, far.componentId, far.x])).toEqual([['sv-pwm', 'servo', 300]]);
  });
  it('finds a wire drawn from the part to the board', () => {
    expect(wiresOn(14, wires, 'nano', number).map(({ far }) => far.componentId)).toEqual(['resistor']);
  });
  it('finds nothing on a pin no wire leaves', () => {
    expect(wiresOn(13, wires, 'nano', number)).toEqual([]);
  });
});

describe('boardPinOf', () => {
  it('gives the board pin a button is wired to, not its ground', () => {
    expect([...boardPinOf(['button'], wires, 'nano', number)]).toEqual([['button', 2]]);
  });
  it('does not find a button wired through another part', () => {
    expect(boardPinOf(['servo-2'], [wire('w', end('servo-2', '1'), end('resistor', '2'))], 'nano', number).size).toBe(0);
  });
});

describe('partEnds', () => {
  it('leaves out a wire that runs to another board (a controller), keeps one to a part', () => {
    const on = wiresOn(19, [wire('scl', end('nano', 'A5', 1, 1), end('ctrl', 'A5', 500, 400)), wire('pull', end('nano', 'A5'), end('resistor', '1', 300, 300))], 'nano', number);
    expect(on.map(({ far }) => far.componentId)).toEqual(['ctrl', 'resistor']);
    expect(partEnds(on, ['nano', 'ctrl']).map(({ far }) => far.componentId)).toEqual(['resistor']);
  });
});
