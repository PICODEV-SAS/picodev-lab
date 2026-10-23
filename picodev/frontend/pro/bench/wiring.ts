/**
 * What the schema reads of the circuit's wires: the wires a probe listens
 * to, and the pushbuttons wired straight to a pin of the board. Pure: the
 * wires are the store's, given as plain values.
 */

export interface WireEnd {
  componentId: string;
  pinName: string;
  x: number;
  y: number;
}

export interface PlainWire {
  id: string;
  start: WireEnd;
  end: WireEnd;
  waypoints?: Array<{ x: number; y: number }>;
}

/**
 * A board's pins as its simulator numbers them (Velxio's PinManager: "A0" is
 * 14 on an Uno or a Nano, 54 on a Mega). The page builds it from Velxio's own
 * mapping (utils/boardPinMapping.ts), so every board Velxio wires is right.
 */
export interface BoardPins {
  /** The number of a pin's name; null or negative for GND, 5V… */
  number(name: string): number | null;
  /** Every numbered pin of the board, ascending. */
  pins: number[];
  /** The converter channel of each analog input, by pin number. */
  adc: Map<number, number>;
}

/** `names`: the board's pin names; `adcInputs`: its converter inputs by name (Velxio's ADC_PIN_MAP). */
export function boardPins(names: string[], number: (name: string) => number | null, adcInputs: Array<{ pinName: string; channel: number }>): BoardPins {
  const numbered = (name: string) => {
    const n = number(name);
    return n !== null && n >= 0 ? [n] : [];
  };
  return {
    number,
    pins: [...new Set(names.flatMap(numbered))].sort((a, b) => a - b),
    adc: new Map(adcInputs.flatMap(({ pinName, channel }) => numbered(pinName).map((n) => [n, channel] as const))),
  };
}

/** The end of a wire away from the board, and the wire, for each wire on the board's `pin`. */
export function wiresOn(pin: number, wires: PlainWire[], boardId: string, number: BoardPins['number']): Array<{ wire: PlainWire; far: WireEnd }> {
  return wires.flatMap((wire) => {
    const ends = [
      [wire.start, wire.end],
      [wire.end, wire.start],
    ] as const;
    const hit = ends.find(([near, far]) => near.componentId === boardId && far.componentId !== boardId && number(near.pinName) === pin);
    return hit ? [{ wire, far: hit[1] }] : [];
  });
}

/** The wires of `on` that end on a part: not on another board (`boardIds`). */
export const partEnds = (on: ReturnType<typeof wiresOn>, boardIds: string[]) => on.filter(({ far }) => !boardIds.includes(far.componentId));

/**
 * The board pin of each of `parts` wired straight to the board (a wire from
 * one of the part's pins to a numbered board pin). Wired through another
 * part, a pushbutton is not found.
 */
export function boardPinOf(parts: string[], wires: PlainWire[], boardId: string, number: BoardPins['number']): Map<string, number> {
  const found = new Map<string, number>();
  for (const w of wires) {
    for (const [near, far] of [
      [w.start, w.end],
      [w.end, w.start],
    ] as const) {
      const pin = near.componentId === boardId ? number(near.pinName) : null;
      if (pin !== null && pin >= 0 && parts.includes(far.componentId) && !found.has(far.componentId)) found.set(far.componentId, pin);
    }
  }
  return found;
}
