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
 * (its `pinInfo`), the label at the far end of the wire, where the part is.
 * A pushbutton wired to a board pin is drawn pressed while the pin is low, so
 * a press the bench makes (a coupling) shows as it does on the scene.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { SimulatorCanvas } from '@velxio/components/simulator/SimulatorCanvas';
import { useSimulatorStore } from '@velxio/store/useSimulatorStore';
import { generateOrthogonalPath } from '@velxio/utils/wireUtils';
import { pinName, probeMarks, stagger } from './palette';
import { text } from './text';
import type { BenchProbe, SetupSheet } from './types';
import { boardPinOf, wiresOn, type PlainWire } from './wiring';

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
  probes: SetupSheet['probes'];
  probe: BenchProbe;
  running: boolean;
  editable: boolean;
  hidden: boolean;
}

export function Schema({ boardId, probes, probe, running, editable, hidden }: Props) {
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
        const next = place(v, s, boardId, probes, useSimulatorStore.getState().wires as PlainWire[]);
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
  }, [header, boardId, probes, editable, wires]);

  // A pushbutton follows its pin: what presses it (the visitor, a coupling of the bench) shows.
  useEffect(() => {
    const ids = components.filter((c) => BUTTONS.includes(c.metadataId)).map((c) => c.id);
    const pins = boardPinOf(ids, wires, boardId);
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
  }, [components, wires, boardId, probe, running]);

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
function place(v: HTMLElement, s: HTMLElement, boardId: string, probes: SetupSheet['probes'], wires: PlainWire[]): Overlay {
  const board = s.querySelector<HTMLElement>(`[id="${CSS.escape(boardId)}"]`);
  const info = (board as { pinInfo?: Array<{ name: string; x: number; y: number }> } | null)?.pinInfo;
  if (!board || !Array.isArray(info) || !board.offsetWidth) return NONE;
  const r = board.getBoundingClientRect();
  const o = v.getBoundingClientRect();
  const k = r.width / board.offsetWidth; // the canvas's zoom and ours; ponytail: a rotated board is not handled
  const names = info.map((p) => p.name);
  // The wires' coordinates are the canvas's world: its wire layer maps them to the screen.
  const ctm = s.querySelector<SVGSVGElement>('svg.wire-layer')?.getScreenCTM() ?? null;
  const toView = (x: number, y: number) => (ctm ? { x: Math.round(ctm.a * x + ctm.c * y + ctm.e - o.left), y: Math.round(ctm.b * x + ctm.d * y + ctm.f - o.top) } : null);
  const out: Overlay = { ...NONE, marks: [], labels: [], wires: [] };
  if (ctm) out.matrix = `matrix(${[ctm.a, ctm.b, ctm.c, ctm.d, ctm.e - o.left, ctm.f - o.top].map((n) => +n.toFixed(3)).join(' ')})`;
  const marks = probeMarks(probes).flatMap((m) => {
    const name = pinName(m.pin, names);
    const pin = name === null ? undefined : info.find((p) => p.name === name);
    if (!pin) return [];
    const on = ctm ? wiresOn(m.pin, wires, boardId) : [];
    on.forEach(({ wire }) => out.wires.push({ key: `${m.pin}-${wire.id}`, color: m.color, d: generateOrthogonalPath(wire.start, wire.waypoints ?? [], wire.end) }));
    // The label where the wire ends on a part; the farthest end when the pin has several.
    const far = on.map(({ far }) => toView(far.x, far.y)!).sort((a, b) => b.x - a.x)[0];
    if (far) out.labels.push({ ...m, ...far });
    return [{ ...m, labelled: !!far, x: Math.round(r.left - o.left + pin.x * k), y: Math.round(r.top - o.top + pin.y * k) }];
  });
  out.marks = stagger(marks.filter((m) => !m.labelled)).concat(marks.filter((m) => m.labelled).map((m) => ({ ...m, row: 0 })));
  return out;
}
