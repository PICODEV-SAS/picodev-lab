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

/** The Arduino number of a board pin's name: "9" and "D9" are 9, "A0" is 14 (Uno, Nano). Null for GND, 5V… */
export function pinNumber(name: string): number | null {
  const m = /^(D|A)?(\d+)$/.exec(name);
  if (!m) return null;
  const n = Number(m[2]);
  return m[1] === 'A' ? n + 14 : n;
}

/** The end of a wire away from the board, and the wire, for each wire on the board's `pin`. */
export function wiresOn(pin: number, wires: PlainWire[], boardId: string): Array<{ wire: PlainWire; far: WireEnd }> {
  return wires.flatMap((wire) => {
    const ends = [
      [wire.start, wire.end],
      [wire.end, wire.start],
    ] as const;
    const hit = ends.find(([near, far]) => near.componentId === boardId && far.componentId !== boardId && pinNumber(near.pinName) === pin);
    return hit ? [{ wire, far: hit[1] }] : [];
  });
}

/**
 * The board pin of each of `parts` wired straight to the board (a wire from
 * one of the part's pins to a numbered board pin). Wired through another
 * part, a pushbutton is not found.
 */
export function boardPinOf(parts: string[], wires: PlainWire[], boardId: string): Map<string, number> {
  const found = new Map<string, number>();
  for (const w of wires) {
    for (const [near, far] of [
      [w.start, w.end],
      [w.end, w.start],
    ] as const) {
      const pin = near.componentId === boardId ? pinNumber(near.pinName) : null;
      if (pin !== null && parts.includes(far.componentId) && !found.has(far.componentId)) found.set(far.componentId, pin);
    }
  }
  return found;
}
