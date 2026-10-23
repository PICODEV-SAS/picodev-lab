/**
 * The wiring of the bench: Velxio's own SimulatorCanvas.
 *
 * No patch. Read-only (a challenge), it is a picture: its header (board
 * picker, add component…) is sent to a hidden slot, its zoom buttons are
 * hidden by CSS, and nothing in it takes the pointer. The canvas does not zoom
 * to fit on a desktop, so it is laid out on a large fixed surface that this
 * component scales to bring the circuit into view. Editable (free mode), it is
 * Velxio's editor as is: its header in a strip on top, its own zoom and pan.
 *
 * Over it, the sheet's probes, in the colours of their traces: the wires of a
 * probed pin drawn again in its colour, a ring or a square at the board's pin
 * (where Velxio ends a wire on it), the label at the far end of the wire,
 * where the part is.
 * A pushbutton wired to a board pin is drawn pressed while the pin is low, so
 * a press the bench makes (a coupling) shows as it does on the scene.
 *
 * The spectator page shows it too (SpectatorSchema, loaded on demand): the
 * session's circuit put into Velxio's store, a picture that nothing simulates.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { SimulatorCanvas } from '@velxio/components/simulator/SimulatorCanvas';
import { DEFAULT_BOARD_POSITION, useSimulatorStore } from '@velxio/store/useSimulatorStore';
import type { BoardKind } from '@velxio/types/board';
import { boardPinToNumber, isBoardComponent } from '@velxio/utils/boardPinMapping';
import { calculatePinPosition } from '@velxio/utils/pinPositionCalculator';
import { isBoardComponentType, stripBrandPrefix } from '@velxio/utils/exampleToBuildNetlistInput';
import { generateOrthogonalPath } from '@velxio/utils/wireUtils';
import type { PushedCircuit } from './circuit';
import { probeMarks, stagger, toView } from './palette';
import { text } from './text';
import type { BenchProbe, SetupSheet } from './types';
import { boardPinOf, partEnds, wiresOn, type BoardPins, type PlainWire } from './wiring';

type Probe = ReturnType<typeof probeMarks>[number];
type Mark = Probe & { x: number; y: number; row: number; labelled: boolean };
type Label = Probe & { x: number; y: number };
interface Overlay {
  marks: Mark[];
  labels: Label[];
  /** The canvas's world (wire coordinates) to the view, as an SVG matrix. */
  matrix: string;
  wires: Array<{ d: string; color: string; key: string }>;
}
const NONE: Overlay = { marks: [], labels: [], matrix: '', wires: [] };

// Room around the circuit; the top keeps clear of the label and the switch, the bottom of the clock.
const PAD = { top: 52, side: 16, bottom: 40 };
const BUTTONS = ['pushbutton', 'pushbutton-6mm'];

interface Props {
  boardId: string;
  /** Only the numbering is read: the spectator page has no simulator to list the pins. */
  board: Pick<BoardPins, 'number'>;
  probes: SetupSheet['probes'];
  probe: BenchProbe;
  running: boolean;
  editable: boolean;
  hidden: boolean;
}

export function Schema({ boardId, board, probes, probe, running, editable, hidden }: Props) {
  const view = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const [header, setHeader] = useState<HTMLElement | null>(null);
  const [overlay, setOverlay] = useState<Overlay>(NONE);
  const components = useSimulatorStore((s) => s.components);
  const wires = useSimulatorStore((s) => s.wires) as PlainWire[];
  const t = text();

  useEffect(() => {
    const fit = () => {
      const v = view.current;
      const s = surface.current;
      if (!v || !s || !v.clientWidth) return; // folded or hidden: fitted again when shown
      if (editable) {
        if (s.style.transform) s.style.transform = '';
      } else if (!scaleToFit(v, s)) return;
      s.style.opacity = '1';
      setOverlay((old) => {
        const next = place(v, s, boardId, board, probes, useSimulatorStore.getState().wires as PlainWire[]);
        return JSON.stringify(next) === JSON.stringify(old) ? old : next;
      });
    };
    // The canvas pans on its own after mounting (and whenever it likes, or the
    // visitor does): fit again each time something moves inside, at most once per frame.
    let frame = 0;
    const later = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fit);
    };
    later();
    const resized = new ResizeObserver(later);
    if (view.current) resized.observe(view.current);
    const moved = new MutationObserver(later);
    if (surface.current) moved.observe(surface.current, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'd'] });
    return () => {
      cancelAnimationFrame(frame);
      resized.disconnect();
      moved.disconnect();
    };
  }, [header, boardId, board, probes, editable, wires]);

  // A pushbutton follows its pin: what presses it (the visitor, a coupling of the bench) shows.
  useEffect(() => {
    const ids = components.filter((c) => BUTTONS.includes(c.metadataId)).map((c) => c.id);
    const pins = boardPinOf(ids, wires, boardId, board.number);
    const press = (id: string, pressed: boolean) => {
      const el = surface.current?.querySelector(`[id="${CSS.escape(id)}"]`) as (HTMLElement & { pressed?: boolean }) | null;
      if (el && el.pressed !== pressed) el.pressed = pressed;
    };
    if (!running) {
      pins.forEach((_pin, id) => press(id, false));
      return;
    }
    const offs = [...pins].map(([id, pin]) => probe.onPin(pin, (high) => press(id, !high)));
    return () => offs.forEach((off) => off());
  }, [components, wires, boardId, board, probe, running]);

  return (
    <div ref={view} className="bench-schema" data-theme="light" data-editable={editable ? '' : undefined} role={editable ? undefined : 'img'} aria-label={t.schemaAria} hidden={hidden}>
      <div ref={setHeader} className="bench-schema-tools" hidden={!editable} />
      <div ref={surface} className="bench-schema-surface">
        {header && <SimulatorCanvas headerSlot={header} fitOnLoad={editable} />}
      </div>
      {overlay.wires.length > 0 && (
        <svg className="bench-probe-wires" aria-hidden="true">
          <g transform={overlay.matrix}>
            {overlay.wires.map((w) => (
              <path key={w.key} d={w.d} stroke={w.color} />
            ))}
          </g>
        </svg>
      )}
      {overlay.marks.map((m) => (
        <span key={m.pin} className="bench-probe-mark" data-kind={m.kind} style={{ left: m.x, top: m.y, '--c': m.color, '--row': m.row } as CSSProperties}>
          {!m.labelled && <span>{m.label}</span>}
        </span>
      ))}
      {overlay.labels.map((m) => (
        <span key={m.pin} className="bench-probe-tag" data-kind={m.kind} style={{ left: m.x, top: m.y, '--c': m.color } as CSSProperties}>
          {m.label} · {m.kind === 'scope' ? t.scope : t.logic}
        </span>
      ))}
    </div>
  );
}

/** Scales the read-only surface to bring every part into view; false while the canvas has none yet. */
function scaleToFit(v: HTMLElement, s: HTMLElement): boolean {
  // Boards and parts are custom elements (wokwi-led, wokwi-arduino-nano…);
  // Velxio's own markers of a board disappear while it runs.
  const parts = [...s.querySelectorAll<HTMLElement>('*')].filter((el) => el.tagName.includes('-'));
  if (!parts.length) return false;
  const origin = s.getBoundingClientRect();
  const k0 = origin.width / s.offsetWidth; // the scale currently applied
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  parts.forEach((el) => {
    const r = el.getBoundingClientRect();
    x1 = Math.min(x1, (r.left - origin.left) / k0);
    y1 = Math.min(y1, (r.top - origin.top) / k0);
    x2 = Math.max(x2, (r.right - origin.left) / k0);
    y2 = Math.max(y2, (r.bottom - origin.top) / k0);
  });
  const w = v.clientWidth - 2 * PAD.side;
  const h = v.clientHeight - PAD.top - PAD.bottom;
  const k = Math.min(w / (x2 - x1), h / (y2 - y1), 1);
  const dx = PAD.side + w / 2 - (k * (x1 + x2)) / 2;
  const dy = PAD.top + h / 2 - (k * (y1 + y2)) / 2;
  const transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) scale(${k.toFixed(3)})`;
  if (s.style.transform !== transform) s.style.transform = transform;
  return true;
}

/** Where each probe is in the view, now; a pin the board does not name is not marked. */
function place(v: HTMLElement, s: HTMLElement, boardId: string, board: Props['board'], probes: SetupSheet['probes'], wires: PlainWire[]): Overlay {
  const el = s.querySelector<HTMLElement>(`[id="${CSS.escape(boardId)}"]`);
  const info = (el as { pinInfo?: Array<{ name: string }> } | null)?.pinInfo;
  const at = useSimulatorStore.getState().boards.find((b) => b.id === boardId);
  // Everything is placed in the canvas's world (wire coordinates), which its
  // wire layer maps to the screen: the canvas's zoom and pan, ours, a rotation.
  const ctm = s.querySelector<SVGSVGElement>('svg.wire-layer')?.getScreenCTM() ?? null;
  if (!el || !Array.isArray(info) || !at || !ctm) return NONE;
  const o = v.getBoundingClientRect();
  const mx = { a: ctm.a, b: ctm.b, c: ctm.c, d: ctm.d, e: ctm.e - o.left, f: ctm.f - o.top };
  const out: Overlay = { ...NONE, marks: [], labels: [], wires: [] };
  const boardIds = useSimulatorStore.getState().boards.map((b) => b.id);
  out.matrix = `matrix(${[mx.a, mx.b, mx.c, mx.d, mx.e, mx.f].map((n) => +n.toFixed(3)).join(' ')})`;
  const marks = probeMarks(probes).flatMap((p) => {
    const name = info.find((i) => board.number(i.name) === p.pin)?.name;
    // Where Velxio ends a wire on that pin (utils/pinPositionCalculator.ts).
    const pin = name === undefined ? null : calculatePinPosition(boardId, name, at.x, at.y);
    if (!pin) return [];
    const on = wiresOn(p.pin, wires, boardId, board.number);
    on.forEach(({ wire }) => out.wires.push({ key: `${p.pin}-${wire.id}`, color: p.color, d: generateOrthogonalPath(wire.start, wire.waypoints ?? [], wire.end) }));
    // The label where the wire ends on a part; the farthest end when the pin has several.
    // A wire to another board (a controller) has no part to name: the label stays by its pin.
    const far = partEnds(on, boardIds).map(({ far }) => toView(mx, far.x, far.y)).sort((a, b) => b.x - a.x)[0];
    if (far) out.labels.push({ ...p, ...far });
    return [{ ...p, labelled: !!far, ...toView(mx, pin.x, pin.y) }];
  });
  out.marks = stagger(marks.filter((m) => !m.labelled)).concat(marks.filter((m) => m.labelled).map((m) => ({ ...m, row: 0 })));
  return out;
}

/**
 * The schema of the spectator page: `circuit` (the session's, or the sheet's)
 * on a board of `kind`, as loadExample would put it, and Schema read-only over it.
 */
export function SpectatorSchema({ kind, circuit, ...props }: Omit<Props, 'boardId' | 'board' | 'editable'> & { kind: string; circuit: PushedCircuit }) {
  const key = JSON.stringify(circuit); // a new state carries an equal circuit most of the time
  useEffect(() => {
    const sim = useSimulatorStore.getState();
    sim.boards.forEach((b) => sim.removeBoard(b.id));
    // The id loadExample gives the only board, so the owner's wire ends name it already.
    const id = sim.addBoard(kind as BoardKind, DEFAULT_BOARD_POSITION.x, DEFAULT_BOARD_POSITION.y, kind);
    sim.setActiveBoardId(id);
    const end = (e: PushedCircuit['wires'][number]['start']) => ({ ...e, componentId: isBoardComponent(e.componentId) ? id : e.componentId, x: 0, y: 0 });
    sim.setComponents(
      circuit.components
        .filter((c) => !isBoardComponentType(c.type))
        .map((c) => ({ id: c.id, metadataId: stripBrandPrefix(c.type), x: c.x ?? 0, y: c.y ?? 0, properties: c.properties })),
    );
    sim.setWires(circuit.wires.map((w) => ({ id: w.id, start: end(w.start), end: end(w.end), color: w.color, waypoints: w.waypoints ?? [] })));
    sim.recalculateAllWirePositions();
  }, [kind, key]); // eslint-disable-line react-hooks/exhaustive-deps
  // Velxio's numbering of the board, as the bench page's (BenchPage boardPins).
  const board = useMemo(() => ({ number: (name: string) => boardPinToNumber(kind, name) }), [kind]);
  return <Schema boardId={kind} board={board} editable={false} {...props} />;
}
