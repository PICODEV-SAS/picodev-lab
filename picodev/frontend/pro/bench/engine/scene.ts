import type { BenchProbe, SceneBinding } from '../types';
import { watchSource } from './source';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Speed of a `spin` binding, in degrees per millisecond (one turn a second). */
const SPIN_DEG_PER_MS = 0.36;

/**
 * Parses an SVG that comes from another repository and removes everything
 * that could run code or reach another site once inserted in the page:
 *
 * - every element outside the SVG namespace (an XHTML `iframe` or `script`
 *   written straight into the SVG would otherwise become a live HTML element);
 * - `script` and `foreignObject`;
 * - animation elements that target `href` or an event attribute (SMIL can
 *   write `javascript:` into a link after the fact);
 * - every `on*` attribute;
 * - every `href` / `xlink:href` that is not a `#fragment` (so no external
 *   `use`, no link, and no embedded `data:` image either).
 *
 * Returns null when the text is not an SVG document.
 */
function parseSvg(svgText: string): Element | null {
  const root = new DOMParser().parseFromString(svgText, 'image/svg+xml').documentElement;
  if (root.namespaceURI !== SVG_NS || root.localName !== 'svg') return null;
  for (const el of [root, ...root.querySelectorAll('*')]) {
    if (
      el.namespaceURI !== SVG_NS ||
      /^(script|foreignobject)$/i.test(el.localName) ||
      /href|^on/i.test(el.getAttribute('attributeName') ?? '')
    ) {
      el.remove();
      continue;
    }
    for (const attr of [...el.attributes]) {
      const name = attr.localName.toLowerCase();
      if (name.startsWith('on') || (name === 'href' && !attr.value.trim().startsWith('#'))) {
        el.removeAttributeNode(attr);
      }
    }
  }
  return root;
}

/** Position of `value` in [min, max], clamped to 0..1. */
function ratio(value: number, min: number, max: number): number {
  if (max === min) return value >= max ? 1 : 0;
  return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

/**
 * What a binding does to its element. `visible` and `fill` take a source as
 * "high" when its value is above 0. Transforms are appended to the transform
 * the element already has, so `origin`, `dx` and `dy` are in the element's own
 * coordinates.
 */
function effect(el: SVGElement, b: SceneBinding): { apply(value: number): void; stop(): void } {
  // ponytail: one transform binding per element (the last one wins); nest <g> in the SVG to combine two.
  const base = el.getAttribute('transform') ?? '';
  const setTransform = (t: string) => el.setAttribute('transform', `${base} ${t}`.trim());
  const stop = () => {};
  switch (b.effect) {
    case 'visible':
      return {
        stop,
        apply: (v) => el.style.setProperty('display', v > 0 === (b.when === 'high') ? '' : 'none'),
      };
    case 'fill':
      return {
        stop,
        apply: (v) => el.style.setProperty('fill', v > 0 ? b.on : b.off),
      };
    case 'rotate': {
      const [ox, oy] = b.origin ?? [0, 0];
      return {
        stop,
        apply: (v) =>
          setTransform(`rotate(${b.from + ratio(v, b.min, b.max) * (b.to - b.from)} ${ox} ${oy})`),
      };
    }
    case 'translate':
      return {
        stop,
        apply: (v) => {
          const r = ratio(v, b.min, b.max);
          setTransform(`translate(${r * b.dx} ${r * b.dy})`);
        },
      };
    case 'spin': {
      const [ox, oy] = b.origin ?? [0, 0];
      let angle = 0;
      let frame: number | undefined;
      let last: number | undefined;
      const step = (ts: number) => {
        if (last !== undefined) angle = (angle + (ts - last) * SPIN_DEG_PER_MS) % 360;
        last = ts;
        setTransform(`rotate(${angle} ${ox} ${oy})`);
        frame = requestAnimationFrame(step);
      };
      const halt = () => {
        if (frame !== undefined) cancelAnimationFrame(frame);
        frame = undefined;
      };
      return {
        stop: halt,
        // Frames are only requested while the source is above the threshold;
        // below it the element stops where it is.
        apply: (v) => {
          if (v <= b.threshold) return halt();
          if (frame !== undefined) return;
          last = undefined;
          frame = requestAnimationFrame(step);
        },
      };
    }
    default:
      console.warn(`bench scene: unknown effect "${(b as { effect: string }).effect}"`);
      return { stop, apply: () => {} };
  }
}

/**
 * Shows the scene of a setup in `container` and animates it from the probe.
 *
 * The SVG is sanitised (see parseSvg) before it is inserted. Each binding is
 * applied to the element whose id is `target`, first with the source at 0,
 * then each time the source changes. A target that is not in the SVG is
 * warned about once and skipped. Returns the cleanup: stops following the
 * probe, stops the animations and empties the container.
 */
export function mountScene(
  container: HTMLElement,
  svgText: string,
  bindings: SceneBinding[],
  probe: BenchProbe,
): () => void {
  const parsed = parseSvg(svgText);
  if (!parsed) {
    console.warn('bench scene: the scene is not an SVG document');
    container.replaceChildren();
    return () => {};
  }
  const svg = container.ownerDocument.importNode(parsed, true);
  container.replaceChildren(svg);

  const byId = new Map<string, Element>();
  for (const el of [svg, ...svg.querySelectorAll('[id]')])
    if (el.id && !byId.has(el.id)) byId.set(el.id, el);

  const cleanups: Array<() => void> = [];
  const warned = new Set<string>();
  for (const b of bindings) {
    const el = byId.get(b.target);
    if (!el) {
      if (!warned.has(b.target)) console.warn(`bench scene: no element with id "${b.target}"`);
      warned.add(b.target);
      continue;
    }
    const { apply, stop } = effect(el as SVGElement, b);
    apply(0);
    cleanups.push(watchSource(probe, b.source, apply), stop);
  }
  return () => {
    cleanups.forEach((c) => c());
    container.replaceChildren();
  };
}
