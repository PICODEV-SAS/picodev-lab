/**
 * The wiring of the bench: Velxio's own SimulatorCanvas, shown as a picture.
 *
 * No patch: its header (board picker, add component…) is sent to a hidden
 * slot, its zoom buttons are hidden by CSS, and it takes no pointer, so the
 * circuit of the sheet cannot be edited. The canvas does not zoom to fit on a
 * desktop, so it is laid out on a large fixed surface that this component
 * scales to bring the circuit into view. The sheet's probes are marked over
 * it, at the board's pins (its `pinInfo`), in the colours of their traces.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { SimulatorCanvas } from '@velxio/components/simulator/SimulatorCanvas';
import { pinName, probeMarks, stagger } from './palette';
import { text } from './text';
import type { SetupSheet } from './types';

type Mark = ReturnType<typeof probeMarks>[number] & { x: number; y: number; row: number };

// Room around the circuit; the top keeps clear of the label and the switch, and of the probes' legend.
const PAD = { top: 48, side: 16, bottom: 14 };
const LEGEND = 52; // the legend's line, and the labels of marks on the top edge of the circuit

export function Schema({ boardId, probes }: { boardId: string; probes: SetupSheet['probes'] }) {
  const view = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const [header, setHeader] = useState<HTMLElement | null>(null);
  const [marks, setMarks] = useState<Mark[]>([]);
  const t = text();

  useEffect(() => {
    const fit = () => {
      const v = view.current;
      const s = surface.current;
      if (!v || !s || !v.clientWidth) return; // folded or hidden: fitted again when shown
      // Boards and parts are custom elements (wokwi-led, wokwi-arduino-nano…);
      // Velxio's own markers of a board disappear while it runs.
      const parts = [...s.querySelectorAll<HTMLElement>('*')].filter((el) => el.tagName.includes('-'));
      if (!parts.length) return;
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
      const top = PAD.top + (probes.length ? LEGEND : 0);
      const h = v.clientHeight - top - PAD.bottom;
      const k = Math.min(w / (x2 - x1), h / (y2 - y1), 1);
      const dx = PAD.side + w / 2 - (k * (x1 + x2)) / 2;
      const dy = top + h / 2 - (k * (y1 + y2)) / 2;
      const transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) scale(${k.toFixed(3)})`;
      if (s.style.transform !== transform) s.style.transform = transform;
      s.style.opacity = '1';
      setMarks((old) => {
        const next = place(v, s, boardId, probes);
        return JSON.stringify(next) === JSON.stringify(old) ? old : next;
      });
    };
    // The canvas pans on its own after mounting (and whenever it likes):
    // fit again each time something moves inside, at most once per frame.
    let frame = 0;
    const later = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fit);
    };
    const resized = new ResizeObserver(later);
    if (view.current) resized.observe(view.current);
    const moved = new MutationObserver(later);
    if (surface.current) moved.observe(surface.current, { subtree: true, childList: true, attributes: true, attributeFilter: ['style'] });
    return () => {
      cancelAnimationFrame(frame);
      resized.disconnect();
      moved.disconnect();
    };
  }, [header, boardId, probes]);

  return (
    <div ref={view} className="bench-schema" data-theme="light" role="img" aria-label={t.schemaAria}>
      <div ref={setHeader} hidden />
      <div ref={surface} className="bench-schema-surface">
        {header && <SimulatorCanvas headerSlot={header} />}
      </div>
      {marks.map((m) => (
        <span key={m.pin} className="bench-probe-mark" data-kind={m.kind} style={{ left: m.x, top: m.y, '--c': m.color, '--row': m.row } as CSSProperties}>
          <span>{m.label}</span>
        </span>
      ))}
      {probes.length > 0 && (
        <ul className="bench-probe-legend" aria-label={t.probesLegend}>
          {probeMarks(probes).map((m) => (
            <li key={m.pin} data-kind={m.kind} style={{ '--c': m.color } as CSSProperties}>
              {m.label} · {m.kind === 'scope' ? t.scope : t.logic}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Where each probe's pin is in the view, now; a pin the board does not name is not marked. */
function place(v: HTMLElement, s: HTMLElement, boardId: string, probes: SetupSheet['probes']): Mark[] {
  const board = s.querySelector<HTMLElement>(`[id="${CSS.escape(boardId)}"]`);
  const info = (board as { pinInfo?: Array<{ name: string; x: number; y: number }> } | null)?.pinInfo;
  if (!board || !Array.isArray(info) || !board.offsetWidth) return [];
  const r = board.getBoundingClientRect();
  const o = v.getBoundingClientRect();
  const k = r.width / board.offsetWidth; // the canvas's zoom and ours; ponytail: a rotated board is not handled
  const names = info.map((p) => p.name);
  return stagger(probeMarks(probes).flatMap((m) => {
    const name = pinName(m.pin, names);
    const pin = name === null ? undefined : info.find((p) => p.name === name);
    return pin ? [{ ...m, x: Math.round(r.left - o.left + pin.x * k), y: Math.round(r.top - o.top + pin.y * k) }] : [];
  }));
}
