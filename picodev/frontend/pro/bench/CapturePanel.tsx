/**
 * The visitor's logic capture: the logic probes over a chosen stretch of
 * simulated time, measured in the browser with the hub's rules (capture.ts).
 * Nothing is sent to the hub; no protocol decoding (it would give away the
 * challenges). The recording downloads as a VCD file, for PulseView or GTKWave.
 *
 * During a real turn (`bench`, v0.20) the browser simulates nothing: the button
 * asks the hub for a capture on the bench's analyser (`capture_request`), and
 * the panel shows the bench's last capture for the session, measured the same way,
 * or the hub's refusal (a capture already recording, not the visitor's turn).
 */
import { useEffect, useRef, useState } from 'react';
import { CAPTURE_MAX_MS, measure, toVcd, type CaptureEdge, type Channel, type Interruption, type Recorder, type Recording } from './capture';
import type { BenchCapture } from './hub';
import { probeColor } from './palette';
import { text } from './text';
import type { SetupSheet } from './types';

type Probe = SetupSheet['probes'][number];
type State =
  | { phase: 'idle' | 'agent' | 'recording' | 'asked' | 'offline' }
  /** `bench`: the bench's capture failed (capture_error). */
  | { phase: 'interrupted'; why: Interruption | 'bench' }
  /** The hub refused the bench capture (`error`, ref `capture_request`). */
  | { phase: 'refused'; why: 'busy' | 'refused' | 'other' }
  | { phase: 'done'; rec: Recording; truncated: boolean; end: number; channels: Channel[] };

const PRESETS_MS = [100, 500, 1000, 2000, 5000, CAPTURE_MAX_MS];
const W = 300;
const X0 = 30;
/** The narrowest view, in µs: a few samples of the bench's analyser at 1 MHz. */
const MIN_SPAN_US = 10;

/** One pin between `from` and `to` (µs) of the recording; edges closer than half a pixel make a band. */
function capturePath(edges: CaptureEdge[], pin: number, initial: 0 | 1, from: number, to: number, hi: number, lo: number): string {
  const y = (v: number) => (v ? hi : lo);
  let level: number = initial;
  for (const [t, p, v] of edges) if (p === pin && t <= from) level = v; // the level where the view starts
  let d = `M${X0} ${y(level)}`;
  let col = -1;
  let inCol = 0;
  let drawn = level;
  for (const [t, p, v] of edges) {
    if (p !== pin || t <= from || t > to) continue;
    const x = Math.round((X0 + ((t - from) / (to - from)) * (W - X0)) * 2) / 2;
    if (x !== col) {
      if (level !== drawn) d += `V${y(level)}`;
      drawn = level;
      col = x;
      inCol = 0;
    }
    level = v;
    if (inCol++ >= 2) continue; // both levels are drawn in this column
    d += `H${x}V${y(v)}`;
    drawn = v;
  }
  if (level !== drawn) d += `V${y(level)}`;
  return `${d}H${W}`;
}

/** The view [from, to] (µs) zoomed by `factor` (< 1: in) around `at` (0..1 across the traces), kept inside [0, end]. */
export function zoomView([from, to]: [number, number], end: number, factor: number, at = 0.5): [number, number] {
  const span = Math.min(end, Math.max(MIN_SPAN_US, (to - from) * factor));
  const start = Math.min(end - span, Math.max(0, from + (to - from) * at - span * at));
  return [start, start + span];
}

/** The view moved by `by` µs, kept inside [0, end]. */
export function panView([from, to]: [number, number], end: number, by: number): [number, number] {
  const start = Math.min(end - (to - from), Math.max(0, from + by));
  return [start, start + (to - from)];
}

/** A real turn: the bench's last capture, and how to ask for one (false: the hub is out of reach). */
export interface BenchSide {
  capture: BenchCapture | null;
  request(pins: number[], durationMs: number): boolean;
}

export function CapturePanel({ recorder, probes, running, bench }: { recorder: Recorder; probes: Probe[]; running: boolean; bench?: BenchSide }) {
  const t = text(); // the page re-renders every second: a language switch shows here too
  const [durationMs, setDurationMs] = useState(1000);
  const [local, setState] = useState<State>({ phase: 'idle' });
  /** What the bench sent last, measured once per capture. */
  const [benchState, setBenchState] = useState<State>({ phase: 'idle' });
  const [seen, setSeen] = useState<BenchCapture | null>(null);
  const cancel = useRef<() => void>(() => {});
  useEffect(() => () => cancel.current(), []);

  const num = (n: number, digits = 3) => n.toLocaleString(t.locale, { maximumFractionDigits: digits });
  const dur = (ms: number | null | undefined) => (ms == null ? '—' : ms < 1 ? `${num(ms * 1000, 0)} µs` : `${num(ms)} ms`);
  const span = (p: Channel['pulses']['high']) => (p.count ? `${dur(p.min_ms)} / ${dur(p.max_ms)}` : '—');
  const freq = (periodMs?: number) => {
    if (!periodMs) return '—';
    const hz = 1000 / periodMs;
    return hz >= 1000 ? `${num(hz / 1000, 2)} kHz` : `${num(hz, 2)} Hz`;
  };

  const label = (pin: number) => probes.find((p) => p.pin === pin)?.label ?? `D${pin}`;
  if (bench && bench.capture !== seen) {
    setSeen(bench.capture);
    const c = bench.capture;
    setBenchState(!c ? { phase: 'idle' } : c.phase === 'done' ? { phase: 'done', rec: c.rec, ...measure(c.rec, label) } : c.phase === 'failed' ? { phase: 'interrupted', why: 'bench' } : c.phase === 'refused' ? { phase: 'refused', why: c.why } : { phase: 'asked' });
  }
  const state = bench ? benchState : local;

  function download(rec: Recording) {
    const href = URL.createObjectURL(new Blob([toVcd(rec, label)], { type: 'text/plain' }));
    const a = Object.assign(document.createElement('a'), { href, download: 'capture.vcd' });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 10_000);
  }

  function capture() {
    if (bench) {
      const pins = probes.map((p) => p.pin);
      return setBenchState({ phase: bench.request(pins, durationMs) ? 'asked' : 'offline' });
    }
    // The agent's capture wins: the page never interrupts it.
    if (recorder.busy()) return setState({ phase: 'agent' });
    setState({ phase: 'recording' });
    cancel.current = recorder.record(
      probes.map((p) => p.pin),
      durationMs,
      (rec) => setState({ phase: 'done', rec, ...measure(rec, label) }),
      (why) => setState({ phase: 'interrupted', why }),
    );
  }

  const recording = state.phase === 'recording';
  // An interruption is said until the next capture, even once the simulation is stopped.
  const note =
    state.phase === 'interrupted'
      ? t.captureInterrupted[state.why]
      : state.phase === 'refused'
        ? t.captureRefused[state.why]
        : state.phase === 'asked'
          ? t.captureAsked
          : state.phase === 'offline'
            ? t.hubOffline
            : bench
              ? ''
              : !running
                ? t.captureNeedsRun
                : recording
                  ? t.captureRecording(num(durationMs / 1000))
                  : state.phase === 'agent'
                    ? t.captureAgent
                    : '';
  const done = state.phase === 'done' ? state : null;
  // The part of the capture on screen (µs): all of it until zoomed; a new capture shows all of it again.
  const [zoom, setZoom] = useState<[number, number] | null>(null);
  const [zoomOf, setZoomOf] = useState(done);
  if (zoomOf !== done) {
    setZoomOf(done);
    setZoom(null);
  }
  const win: [number, number] = done && zoom ? zoom : [0, done?.end || 1];
  const winNow = useRef(win);
  winNow.current = win;
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; win: [number, number] } | null>(null);
  /** From a pointer's x to 0..1 across the traces (the labels' margin excluded). */
  const across = (clientX: number) => {
    const r = svg.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (((clientX - r.left) / r.width) * W - X0) / (W - X0)));
  };
  // The wheel zooms around the pointer (a sideways swipe pans): a passive React listener could not keep the page still.
  useEffect(() => {
    const el = svg.current;
    if (!el || !done) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const [from, to] = winNow.current;
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) setZoom(panView(winNow.current, done.end, (e.deltaX / el.getBoundingClientRect().width) * (to - from)));
      else setZoom(zoomView(winNow.current, done.end, e.deltaY < 0 ? 0.8 : 1.25, across(e.clientX)));
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [done]);
  const zoomBy = (factor: number) => done && setZoom(zoomView(win, done.end, factor));
  const panBy = (share: number) => done && setZoom(panView(win, done.end, share * (win[1] - win[0])));
  const zoomed = !!done && (win[0] > 0 || win[1] < done.end);
  const rows: Array<[string, (c: Channel) => string | number]> = [
    [t.captureRows.edges, (c) => c.edges],
    [t.captureRows.period, (c) => dur(c.period_ms)],
    [t.captureRows.frequency, (c) => freq(c.period_ms)],
    [t.captureRows.duty, (c) => (c.duty === undefined ? '—' : c.duty.toLocaleString(t.locale, { style: 'percent', maximumFractionDigits: 1 }))],
    [t.captureRows.high, (c) => span(c.pulses.high)],
    [t.captureRows.low, (c) => span(c.pulses.low)],
  ];
  const band = 120 / Math.max(probes.length, 1);
  // A real turn records on the bench: nothing is simulated.
  const caption = (s: string) => (bench ? t.captureCaptionBench(s) : t.captureCaption(s));

  return (
    <section className="bench-capture" aria-labelledby="bench-capture-title">
      <div className="bench-capture-bar">
        <h3 id="bench-capture-title">{t.capture}</h3>
        <label>
          {bench ? t.captureDurationBench : t.captureDuration}
          <select value={durationMs} onChange={(e) => setDurationMs(Number(e.target.value))} disabled={recording}>
            {PRESETS_MS.map((ms) => (
              <option key={ms} value={ms}>
                {num(ms / 1000)} s
              </option>
            ))}
          </select>
        </label>
        {/* A bench capture asked stays retryable: an answer may never come. */}
        <button type="button" className="bench-btn" onClick={capture} disabled={bench ? false : !running || recording} aria-busy={recording || state.phase === 'asked'} aria-describedby="bench-capture-note">
          {t.captureRun}
        </button>
        {done && (
          <button type="button" className="bench-btn" onClick={() => download(done.rec)} title={t.captureDownloadTitle}>
            {t.captureDownload}
          </button>
        )}
        <span id="bench-capture-note" role="status">
          {note}
        </span>
      </div>

      {done && (
        <>
          <div className="bench-capture-table">
            {/* A column per channel: four at most, where seven measures would not fit across. */}
            <table>
              <thead>
                <tr>
                  <td />
                  {done.channels.map((c) => (
                    <th key={c.pin} scope="col">
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(([name, value]) => (
                  <tr key={name}>
                    <th scope="row">{name}</th>
                    {done.channels.map((c) => (
                      <td key={c.pin}>{value(c)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <figure className="bench-trace">
            <svg
              ref={svg}
              className="bench-trace-logic bench-capture-zoom"
              viewBox={`0 0 ${W} 120`}
              preserveAspectRatio="none"
              role="img"
              aria-label={`${caption(num(done.end / 1e6))} · ${t.captureZoomHint}`}
              tabIndex={0}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                drag.current = { x: e.clientX, win };
              }}
              onPointerMove={(e) => {
                const d = drag.current;
                if (!d) return;
                const width = e.currentTarget.getBoundingClientRect().width * ((W - X0) / W);
                setZoom(panView(d.win, done.end, (-(e.clientX - d.x) / width) * (d.win[1] - d.win[0])));
              }}
              onPointerUp={() => (drag.current = null)}
              onPointerCancel={() => (drag.current = null)}
              onDoubleClick={() => setZoom(null)}
              onKeyDown={(e) => {
                const act: Record<string, () => void> = { ArrowLeft: () => panBy(-0.25), ArrowRight: () => panBy(0.25), '+': () => zoomBy(0.5), '=': () => zoomBy(0.5), '-': () => zoomBy(2), '0': () => setZoom(null), Home: () => setZoom(null) };
                if (!act[e.key]) return;
                e.preventDefault();
                act[e.key]();
              }}
            >
              <title>{t.captureZoomHint}</title>
              {done.channels.map((c, i) => (
                <g key={c.pin}>
                  <text x="6" y={band * (i + 0.5) + 4} fontSize="11" fill="#4A5B70">
                    {c.label}
                  </text>
                  <path d={capturePath(done.rec.edges, c.pin, c.initial, win[0], win[1], band * (i + 0.28), band * (i + 0.8))} fill="none" stroke={probeColor('logic', Math.max(0, probes.findIndex((p) => p.pin === c.pin)))} strokeWidth="2" vectorEffect="non-scaling-stroke" />
                </g>
              ))}
            </svg>
            <figcaption>
              <strong>{caption(num(done.end / 1e6))}</strong>
              {/* Session time of what is on screen: down to the µs once zoomed under 10 ms. */}
              <span>{done.truncated && !zoomed ? t.captureTruncated : t.captureWindow(num((done.rec.t0Ms + win[0] / 1000) / 1000, win[1] - win[0] < 10_000 ? 6 : 3), num((done.rec.t0Ms + win[1] / 1000) / 1000, win[1] - win[0] < 10_000 ? 6 : 3))}</span>
            </figcaption>
            <div className="bench-capture-zoombar">
              <button type="button" className="bench-btn" onClick={() => zoomBy(0.5)} disabled={win[1] - win[0] <= MIN_SPAN_US} aria-label={t.captureZoomIn}>
                +
              </button>
              <button type="button" className="bench-btn" onClick={() => zoomBy(2)} disabled={!zoomed} aria-label={t.captureZoomOut}>
                −
              </button>
              <button type="button" className="bench-btn" onClick={() => setZoom(null)} disabled={!zoomed}>
                {t.captureZoomFit}
              </button>
              <span>{t.captureZoomHint}</span>
            </div>
          </figure>
        </>
      )}
    </section>
  );
}
