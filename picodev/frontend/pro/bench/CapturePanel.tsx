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

/** The recorded window of one pin; edges closer than half a pixel make a band. */
function capturePath(edges: CaptureEdge[], pin: number, initial: 0 | 1, end: number, hi: number, lo: number): string {
  const y = (v: number) => (v ? hi : lo);
  let d = `M${X0} ${y(initial)}`;
  let col = -1;
  let inCol = 0;
  let level: number = initial;
  let drawn: number = initial;
  for (const [t, p, v] of edges) {
    if (p !== pin || t > end) continue;
    const x = Math.round((X0 + (t / end) * (W - X0)) * 2) / 2;
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
            <svg className="bench-trace-logic" viewBox={`0 0 ${W} 120`} preserveAspectRatio="none" role="img" aria-label={caption(num(done.end / 1e6))}>
              {done.channels.map((c, i) => (
                <g key={c.pin}>
                  <text x="6" y={band * (i + 0.5) + 4} fontSize="11" fill="#4A5B70">
                    {c.label}
                  </text>
                  <path d={capturePath(done.rec.edges, c.pin, c.initial, done.end, band * (i + 0.28), band * (i + 0.8))} fill="none" stroke={probeColor('logic', Math.max(0, probes.findIndex((p) => p.pin === c.pin)))} strokeWidth="2" vectorEffect="non-scaling-stroke" />
                </g>
              ))}
            </svg>
            <figcaption>
              <strong>{caption(num(done.end / 1e6))}</strong>
              <span>{done.truncated ? t.captureTruncated : t.captureWindow(num(done.rec.t0Ms / 1000), num((done.rec.t0Ms + done.end / 1000) / 1000))}</span>
            </figcaption>
          </figure>
        </>
      )}
    </section>
  );
}
