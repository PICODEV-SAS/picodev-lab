/**
 * The visitor's arrangement of the workspace: the order and width of the
 * columns, the order and height of the parts of the « Vue » tab. Moved with a
 * grip (dragged, or the arrow keys on it), resized with the separator after a
 * section (dragged, the arrow keys, a double click puts the size back), folded
 * to its name with the button of its header. Kept in
 * this browser under LAYOUT_KEY; a missing or broken record is the default.
 */
import { useEffect, useState, type DragEvent, type KeyboardEvent, type PointerEvent } from 'react';

export const COLUMNS = ['agent', 'level', 'code', 'hub'] as const;
export const PARTS = ['view', 'traces', 'capture', 'serial'] as const;
export type Column = (typeof COLUMNS)[number];
export type Part = (typeof PARTS)[number];
export type Section = Column | Part;
type Axis = 'x' | 'y';

export interface Layout {
  columns: Column[];
  parts: Part[];
  /** Width of a column, height of a part, in CSS pixels; absent: the page's own size. */
  size: Partial<Record<Section, number>>;
  /** The sections folded to their name, in no particular order. */
  folded: Section[];
}

const LAYOUT_KEY = 'picodev-lab:bench-layout';
export const MIN_SIZE = 120;
const MAX_SIZE = 4000;
const STEP = 24;

/** The stored record, checked: an order holds each section once, a size is a number in [MIN_SIZE, MAX_SIZE], `folded` known sections. */
export function readLayout(raw: string | null): Layout {
  let v: { columns?: unknown; parts?: unknown; size?: Record<string, unknown>; folded?: unknown } | null = null;
  try {
    v = JSON.parse(raw ?? 'null');
  } catch {
    // the default below
  }
  const order = <T extends string>(ids: readonly T[], got: unknown): T[] =>
    Array.isArray(got) && got.length === ids.length && ids.every((id) => got.includes(id)) ? [...(got as T[])] : [...ids];
  const size: Layout['size'] = {};
  for (const id of [...COLUMNS, ...PARTS]) {
    const n = v?.size?.[id];
    if (typeof n === 'number' && n >= MIN_SIZE && n <= MAX_SIZE) size[id] = Math.round(n);
  }
  const folded = Array.isArray(v?.folded) ? [...COLUMNS, ...PARTS].filter((id) => (v!.folded as unknown[]).includes(id)) : [];
  return { columns: order(COLUMNS, v?.columns), parts: order(PARTS, v?.parts), size, folded };
}

/** `order` with `id` put at the place of `target`: before it when moving back, after it when moving on. */
export function moveTo<T>(order: T[], id: T, target: T): T[] {
  if (id === target || !order.includes(id) || !order.includes(target)) return order;
  const rest = order.filter((x) => x !== id);
  const at = rest.indexOf(target) + (order.indexOf(id) < order.indexOf(target) ? 1 : 0);
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}

/** One step of `id` among the sections shown: the absent ones are skipped. */
export function step<T>(order: T[], id: T, by: -1 | 1, shown: T[]): T[] {
  const seq = order.filter((x) => shown.includes(x));
  const other = seq[seq.indexOf(id) + by];
  return other === undefined ? order : moveTo(order, id, other);
}

export function useLayout() {
  const [layout, setLayout] = useState(() => {
    try {
      return readLayout(localStorage.getItem(LAYOUT_KEY));
    } catch {
      return readLayout(null);
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    } catch {
      // private mode: the layout lasts for the page
    }
  }, [layout]);
  return {
    layout,
    setColumns: (columns: Column[]) => setLayout((l) => ({ ...l, columns })),
    setParts: (parts: Part[]) => setLayout((l) => ({ ...l, parts })),
    setSize: (id: Section, n: number | undefined) => setLayout((l) => ({ ...l, size: { ...l.size, [id]: n === undefined ? undefined : Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(n))) } })),
    toggleFold: (id: Section) => setLayout((l) => ({ ...l, folded: l.folded.includes(id) ? l.folded.filter((x) => x !== id) : [...l.folded, id] })),
    reset: () => setLayout(readLayout(null)),
  };
}

// One drag type per group: a part never lands among the columns.
const dragType = (axis: Axis) => `application/x-picodev-bench-${axis}`;

/** The handle that moves a section: dragged onto another section of its group, or the arrow keys. */
export function Grip({ id, axis, label, onStep }: { id: Section; axis: Axis; label: string; onStep: (by: -1 | 1) => void }) {
  const keys: Record<string, -1 | 1> = axis === 'x' ? { ArrowLeft: -1, ArrowRight: 1 } : { ArrowUp: -1, ArrowDown: 1 };
  return (
    <button
      type="button"
      className="bench-grip"
      draggable
      aria-label={label}
      title={label}
      onDragStart={(e) => {
        e.dataTransfer.setData(dragType(axis), id);
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setDragImage(e.currentTarget.parentElement!, e.nativeEvent.offsetX, e.nativeEvent.offsetY);
      }}
      onKeyDown={(e) => {
        const by = keys[e.key];
        if (!by) return;
        e.preventDefault();
        onStep(by);
        // The section moved in the page: keep the focus on its grip.
        const self = e.currentTarget;
        requestAnimationFrame(() => self.focus());
      }}
    >
      <svg width="18" height="8" viewBox="0 0 18 8" aria-hidden="true">
        <path d="M2 2h2M8 2h2M14 2h2M2 6h2M8 6h2M14 6h2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    </button>
  );
}

/** The button that folds a section to its name, or unfolds it. */
export function Fold({ axis, folded, label, onToggle }: { axis: Axis; folded: boolean; label: string; onToggle: () => void }) {
  // Points the way the section opens: down (or right, for a column) when folded.
  const d = axis === 'x' ? (folded ? 'M6 3l5 5-5 5' : 'M10 3L5 8l5 5') : folded ? 'M3 6l5 5 5-5' : 'M3 10l5-5 5 5';
  return (
    <button type="button" className="bench-fold" aria-expanded={!folded} aria-label={label} title={label} onClick={onToggle}>
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={d} />
      </svg>
    </button>
  );
}

/**
 * What a section needs to receive a dragged one of its group. In the capture
 * phase: Monaco, under the code column, would take the drop for itself.
 */
export function dropZone(axis: Axis, onDrop: (dragged: Section) => void) {
  const ours = (e: DragEvent<HTMLElement>) => e.dataTransfer.types.includes(dragType(axis));
  return {
    onDragOverCapture: (e: DragEvent<HTMLElement>) => {
      if (!ours(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      e.currentTarget.dataset.drop = '';
    },
    onDragLeave: (e: DragEvent<HTMLElement>) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) delete e.currentTarget.dataset.drop;
    },
    onDropCapture: (e: DragEvent<HTMLElement>) => {
      if (!ours(e)) return;
      e.preventDefault();
      e.stopPropagation();
      delete e.currentTarget.dataset.drop;
      onDrop(e.dataTransfer.getData(dragType(axis)) as Section);
    },
  };
}

/** The separator after a section: sets its width (`x`) or its height (`y`). */
export function Splitter({ axis, label, size, of, onSize }: { axis: Axis; label: string; size?: number; of: () => HTMLElement | null; onSize: (n: number | undefined) => void }) {
  const measure = () => {
    const box = of()?.getBoundingClientRect();
    return box ? (axis === 'x' ? box.width : box.height) : MIN_SIZE;
  };
  const start = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const from = measure();
    const at = axis === 'x' ? e.clientX : e.clientY;
    const sep = e.currentTarget;
    sep.setPointerCapture(e.pointerId);
    sep.onpointermove = (ev) => onSize(from + (axis === 'x' ? ev.clientX : ev.clientY) - at);
    sep.onpointerup = sep.onpointercancel = () => (sep.onpointermove = null);
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const by = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];
    if (by) {
      e.preventDefault();
      onSize(measure() + by * STEP);
    } else if (e.key === 'Enter') onSize(undefined);
  };
  return (
    <div
      className="bench-splitter"
      data-axis={axis}
      role="separator"
      tabIndex={0}
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-label={label}
      title={label}
      aria-valuemin={MIN_SIZE}
      aria-valuemax={MAX_SIZE}
      aria-valuenow={size ?? Math.round(measure())}
      onPointerDown={start}
      onKeyDown={key}
      onDoubleClick={() => onSize(undefined)}
    />
  );
}
