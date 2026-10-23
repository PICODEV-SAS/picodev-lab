/**
 * The circuit of the bench as the hub sees it (live-protocol.adoc, "circuit"):
 * the shape of a setup sheet's `circuit`, the board left out and named by its
 * id in the wires. Imports nothing of Velxio: the page hands over its store and
 * its catalogue.
 */

type Plain = string | number | boolean;
export interface CircuitEnd {
  componentId: string;
  pinName: string;
}
export interface CircuitComponent {
  type: string;
  id: string;
  x: number;
  y: number;
  properties: Record<string, Plain>;
}
export interface Point {
  x: number;
  y: number;
}
export interface CircuitWire {
  id: string;
  start: CircuitEnd;
  end: CircuitEnd;
  color: string;
  /** Where the wire passes, in order (architecture 0.24); none: Velxio's automatic route. */
  waypoints?: Point[];
}
export interface Circuit {
  components: CircuitComponent[];
  wires: CircuitWire[];
}
/** A circuit pushed by an agent: a component may come without a place. */
export interface PushedCircuit {
  components: Array<Omit<CircuitComponent, 'x' | 'y'> & { x?: number; y?: number }>;
  wires: CircuitWire[];
}

export const CIRCUIT_MAX = { components: 40, wires: 120, bytes: 48 * 1024, waypoints: 16 };
const ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const DEFAULT_COLOR = '#22c55e';

/** What Velxio's store holds of a part and a wire. */
interface StoreComponent {
  id: string;
  metadataId: string;
  x: number;
  y: number;
  properties: Record<string, unknown>;
}
interface StoreWire {
  id: string;
  start: CircuitEnd;
  end: CircuitEnd;
  color: string;
  waypoints?: Point[];
  bb?: boolean;
}

/**
 * Plain properties only. `state` (and a boolean `value`) is the level the
 * simulation writes into a part while it runs (Velxio's updateComponentState):
 * not part of the circuit.
 */
function plain(props: unknown): Record<string, Plain> {
  if (!props || typeof props !== 'object') return {};
  return Object.fromEntries(
    Object.entries(props).filter(
      ([k, v]) =>
        k !== 'state' &&
        !(k === 'value' && typeof v === 'boolean') &&
        ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean' || (typeof v === 'string' && v.length <= 256)),
    ),
  ) as Record<string, Plain>;
}

/** The store's circuit in the sheet's shape; `typeOf` turns a catalogue id back into a sheet type. */
export function circuitOf(components: StoreComponent[], wires: StoreWire[], typeOf: (metadataId: string) => string): Circuit {
  return {
    components: components.map((c) => ({ type: typeOf(c.metadataId), id: c.id, x: c.x, y: c.y, properties: plain(c.properties) })),
    // The wires seating a part on a breadboard are made by the editor, never drawn.
    wires: wires
      .filter((w) => !w.bb)
      .map((w) => ({
        id: w.id,
        start: { componentId: w.start.componentId, pinName: w.start.pinName },
        end: { componentId: w.end.componentId, pinName: w.end.pinName },
        color: w.color,
        ...withPoints(w.waypoints),
      })),
  };
}

/** Within what a hub keeps of a circuit. */
export const circuitFits = (c: Circuit) =>
  c.components.length <= CIRCUIT_MAX.components && c.wires.length <= CIRCUIT_MAX.wires && new TextEncoder().encode(JSON.stringify(c)).length <= CIRCUIT_MAX.bytes;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isPoint = (v: unknown): v is Point => isObj(v) && Number.isFinite(v.x) && Number.isFinite(v.y);

/** A wire's `waypoints` as the sheet takes them (16 at most, finite x and y), or undefined: none, or not valid. */
export function waypointsOf(v: unknown): Point[] | undefined {
  if (!Array.isArray(v) || !v.length || v.length > CIRCUIT_MAX.waypoints || !v.every(isPoint)) return undefined;
  return v.map(({ x, y }) => ({ x, y }));
}
/** `{waypoints}` when `v` holds valid ones, else nothing: spread into a wire. */
const withPoints = (v: unknown) => {
  const waypoints = waypointsOf(v);
  return waypoints ? { waypoints } : {};
};

/**
 * Velxio's loadExample gives every wire no waypoints: `wires` (the store's,
 * after it) with those of `from` (the sheet's wires, unchecked), by wire id.
 */
export function withWaypoints<W extends { id: string; waypoints: Point[] }>(wires: W[], from: unknown[]): W[] {
  const points = new Map(from.flatMap((w) => (isObj(w) && typeof w.id === 'string' ? [[w.id, waypointsOf(w.waypoints)] as const] : [])));
  return wires.map((w) => {
    const waypoints = points.get(w.id);
    return waypoints ? { ...w, waypoints } : w;
  });
}

const isEnd = (v: unknown): v is CircuitEnd => isObj(v) && typeof v.componentId === 'string' && typeof v.pinName === 'string' && v.pinName.length <= 64;

/** A `circuit` message, checked for shape (it comes from a stranger); a string says why it is refused. */
export function readCircuit(msg: Record<string, unknown>): PushedCircuit | string {
  const { components, wires } = msg;
  if (!Array.isArray(components) || !Array.isArray(wires)) return 'Invalid circuit: components and wires must be lists.';
  if (components.length > CIRCUIT_MAX.components || wires.length > CIRCUIT_MAX.wires)
    return `Circuit too large: at most ${CIRCUIT_MAX.components} components and ${CIRCUIT_MAX.wires} wires.`;
  const ids = new Set<string>();
  const out: PushedCircuit = { components: [], wires: [] };
  for (const c of components) {
    if (!isObj(c) || typeof c.type !== 'string' || !c.type || c.type.length > 64 || typeof c.id !== 'string' || !ID_RE.test(c.id))
      return 'Invalid component: each needs a type and an id matching [A-Za-z0-9_.-]{1,64}.';
    if (ids.has(c.id)) return `Duplicate id "${c.id}".`;
    ids.add(c.id);
    const placed = Number.isFinite(c.x) && Number.isFinite(c.y);
    out.components.push({ type: c.type, id: c.id, ...(placed && { x: c.x as number, y: c.y as number }), properties: plain(c.properties) });
  }
  const wireIds = new Set<string>();
  for (const w of wires) {
    if (!isObj(w) || typeof w.id !== 'string' || !ID_RE.test(w.id) || !isEnd(w.start) || !isEnd(w.end))
      return 'Invalid wire: each needs an id matching [A-Za-z0-9_.-]{1,64}, a start and an end {componentId, pinName}.';
    if (wireIds.has(w.id)) return `Duplicate wire id "${w.id}".`;
    wireIds.add(w.id);
    const color = typeof w.color === 'string' && w.color.length <= 32 ? w.color : DEFAULT_COLOR;
    out.wires.push({ id: w.id, start: { componentId: w.start.componentId, pinName: w.start.pinName }, end: { componentId: w.end.componentId, pinName: w.end.pinName }, color, ...withPoints(w.waypoints) });
  }
  return out;
}

/**
 * Whether `pin` names one of `names`, with the spellings Velxio's wire
 * placement also accepts (utils/pinPositionCalculator.ts: GND for GND.1, D13
 * for 13…): a wire it can draw is a wire it accepts.
 */
export function pinKnown(names: string[], pin: string): boolean {
  const has = new Set(names);
  const candidates = [pin, `${pin}.1`];
  const dot = pin.match(/^(.+)\.\d+$/);
  if (dot) candidates.push(dot[1]);
  if (pin === '3.3V') candidates.push('3V3', '3V3.1', '3V');
  if (pin === '3V3') candidates.push('3V3.1', '3.3V', '3V');
  if (pin === '5V') candidates.push('5V.1', 'VBUS', 'VIN');
  if (pin === 'GND2') candidates.push('GND.2');
  const d = pin.match(/^D(\d+)$/);
  if (d) candidates.push(d[1], `GP${d[1]}`);
  if (/^\d+$/.test(pin)) candidates.push(`D${pin}`, `GP${pin}`);
  return candidates.some((c) => has.has(c));
}

/** What the editor knows of its parts. */
export interface Catalogue {
  /** `board` for a board of the catalogue, null for a type it does not have. */
  kind(type: string): 'part' | 'board' | null;
  /** The pin names of a part, or null when they cannot be read (its wires are not checked). */
  pins(type: string, properties: Record<string, Plain>): string[] | null;
}

/** Why the editor cannot build this circuit, or null when it can. */
export function checkCircuit(c: PushedCircuit, boardId: string, boardPins: string[] | null, catalogue: Catalogue): string | null {
  const byId = new Map(c.components.map((p) => [p.id, p]));
  for (const p of c.components) {
    if (p.id === boardId) return `Component id "${p.id}" is the board's id.`;
    const kind = catalogue.kind(p.type);
    if (!kind) return `Unknown component type "${p.type}" (component ${p.id}).`;
    if (kind === 'board') return `"${p.type}" is a board: the board is not a component (component ${p.id}).`;
  }
  const pinsOf = new Map<string, string[] | null>();
  for (const w of c.wires) {
    for (const end of [w.start, w.end]) {
      const part = byId.get(end.componentId);
      if (end.componentId !== boardId && !part) return `Wire ${w.id}: no component "${end.componentId}".`;
      if (!pinsOf.has(end.componentId)) pinsOf.set(end.componentId, part ? catalogue.pins(part.type, part.properties) : boardPins);
      const pins = pinsOf.get(end.componentId);
      if (pins && !pinKnown(pins, end.pinName)) return `Wire ${w.id}: ${part ? `component ${part.id} (${part.type})` : `the board ${boardId}`} has no pin "${end.pinName}".`;
    }
  }
  return null;
}

/** The room a part takes on the canvas, in px. */
export interface Size {
  w: number;
  h: number;
}
const PLACE = { gap: 40, row: 480, size: { w: 120, h: 100 } };

/**
 * Places the parts without `x`/`y` to the right of everything else (the
 * board, from `boardRight`, and the parts that have a place), in rows: left to
 * right, a part that would pass `PLACE.row` starting the next row under the
 * tallest of the current one. `size` is a part's room, measured by the page;
 * a part it cannot measure counts as PLACE.size.
 */
export function placeFree(c: PushedCircuit, boardRight: number, top: number, size: (p: PushedCircuit['components'][number]) => Size | null = () => null): Circuit {
  const room = (p: PushedCircuit['components'][number]) => size(p) ?? PLACE.size;
  const placed = (p: PushedCircuit['components'][number]) => p.x !== undefined && p.y !== undefined;
  const left = Math.max(boardRight, ...c.components.filter(placed).map((p) => p.x! + room(p).w)) + PLACE.gap;
  let x = left;
  let y = top;
  let rowH = 0;
  const components = c.components.map((p) => {
    if (placed(p)) return { ...p, x: p.x!, y: p.y! };
    const { w, h } = room(p);
    if (x > left && x + w > left + PLACE.row) {
      x = left;
      y += rowH + PLACE.gap;
      rowH = 0;
    }
    const at = { ...p, x, y };
    x += w + PLACE.gap;
    rowH = Math.max(rowH, h);
    return at;
  });
  return { components, wires: c.wires };
}
