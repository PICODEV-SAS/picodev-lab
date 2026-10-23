/**
 * The logic capture of the bench, shared by the agent (hub.ts, logicCapture)
 * and the visitor (CapturePanel): one recorder per probe, one recording at a
 * time, and the hub's measures ported so that both sides give the same numbers.
 */
import type { BenchProbe, SetupSheet } from './types';

export const CAPTURE_MAX_MS = 10_000;
// A hub keeps 200 000 edges: the recording stops one edge past it, and the measures mark it truncated.
export const CAPTURE_MAX_EDGES = 200_000;
const POLL_MS = 50; // real ms between two readings of the simulated clock

/** `[t_us, pin, v]`: simulated µs since the start of the recording. */
export type CaptureEdge = [number, number, 0 | 1];
export type Interruption = 'replaced' | 'hidden' | 'stop' | 'relaunch';

export interface Recording {
  pins: number[];
  durationMs: number;
  initial: Record<string, 0 | 1>;
  /** Simulated ms at the start of the recording, to place it on the page's clock. */
  t0Ms: number;
  /** Integer and non-decreasing t_us, level changes only, at most CAPTURE_MAX_EDGES + 1. */
  edges: CaptureEdge[];
}

export interface Recorder {
  /** The pins the setup sheet probes. */
  readonly probed: ReadonlySet<number>;
  /** A recording is in progress. */
  busy(): boolean;
  /**
   * Records `pins` over `durationMs` of simulated time from now, replacing the
   * recording in progress (whose owner hears `replaced`). The returned function
   * drops this recording without a word, if it is still the current one.
   */
  record(pins: number[], durationMs: number, done: (rec: Recording) => void, interrupted: (why: Interruption) => void): () => void;
  /** The simulation was stopped, or started again: the levels are forgotten, a recording is lost. */
  halted(reason: 'stop' | 'relaunch'): void;
  close(): void;
}

/**
 * The level of each probe pin is followed all along, for `initial`; a pin
 * that has reported nothing since the simulation started is low, as in runLevel.
 */
export function createRecorder(sheet: SetupSheet, probe: BenchProbe): Recorder {
  const probed = new Set(sheet.probes.map((p) => p.pin));
  const levels = new Map<number, 0 | 1>();
  interface Cur extends Omit<Recording, 't0Ms'> {
    t0: number;
    pinSet: Set<number>;
    done: (rec: Recording) => void;
    interrupted: (why: Interruption) => void;
    timer?: ReturnType<typeof setTimeout>;
  }
  let cur: Cur | null = null;

  const end = (why?: Interruption) => {
    const rec = cur;
    if (!rec) return;
    clearTimeout(rec.timer);
    cur = null;
    if (why) rec.interrupted(why);
    else rec.done({ pins: rec.pins, durationMs: rec.durationMs, initial: rec.initial, t0Ms: rec.t0, edges: rec.edges });
  };

  const poll = () => {
    if (!cur) return;
    if (probe.nowMs() - cur.t0 >= cur.durationMs) return end();
    cur.timer = setTimeout(poll, POLL_MS);
  };

  const offs = [...probed].map((pin) =>
    probe.onPin(pin, (high, tMs) => {
      const v = high ? 1 : 0;
      if ((levels.get(pin) ?? 0) === v) return;
      levels.set(pin, v);
      const rec = cur;
      if (!rec || !rec.pinSet.has(pin) || tMs < rec.t0 || tMs - rec.t0 > rec.durationMs) return;
      // Rounding (or an input reported a little late) must not make time go back.
      const us = Math.max(Math.round((tMs - rec.t0) * 1000), rec.edges.at(-1)?.[0] ?? 0);
      rec.edges.push([us, pin, v]);
      if (rec.edges.length > CAPTURE_MAX_EDGES) end();
    }),
  );

  // The simulation runs on animation frames, which a hidden tab no longer gets.
  const onVisibility = () => {
    if (document.hidden) end('hidden');
  };
  document.addEventListener('visibilitychange', onVisibility);

  return {
    probed,
    busy: () => cur !== null,
    record(pins, durationMs, done, interrupted) {
      end('replaced');
      const rec: Cur = {
        pins,
        durationMs,
        initial: Object.fromEntries(pins.map((p) => [String(p), levels.get(p) ?? 0])),
        edges: [],
        t0: probe.nowMs(),
        pinSet: new Set(pins),
        done,
        interrupted,
      };
      cur = rec;
      poll();
      return () => {
        if (cur !== rec) return;
        clearTimeout(rec.timer);
        cur = null;
      };
    },
    halted(reason) {
      levels.clear(); // the next run starts from the reset state
      end(reason);
    },
    close() {
      if (cur) clearTimeout(cur.timer);
      cur = null;
      offs.forEach((off) => off());
      document.removeEventListener('visibilitychange', onVisibility);
    },
  };
}

// ── Measures: the same as the hub's (capture_chunk, live-protocol.adoc), keep them in step ──

type Pulses = { count: number; min_ms: number | null; max_ms: number | null };
export interface Channel {
  pin: number;
  label: string;
  edges: number;
  initial: 0 | 1;
  high_ms: number;
  low_ms: number;
  pulses: { high: Pulses; low: Pulses };
  /** Only when periodic: at least three rising edges, the intervals between them within 5 % of their mean (1 µs at least). */
  period_ms?: number;
  duty?: number;
}

// Python's round(x, n): the same digits but for an exact binary tie.
// No Math.min(...p): 200 000 arguments overflow the stack.
const min = (p: number[]) => p.reduce((a, b) => (b < a ? b : a));
const max = (p: number[]) => p.reduce((a, b) => (b > a ? b : a));
const round = (x: number, n: number) => Number(x.toFixed(n));
const ms = (us: number) => round(us / 1000, 3);

/**
 * Measures of one pin over [0, end] µs; `times` are its edges, each toggling the level.
 * A pulse is a level between two edges: the first and last levels, cut by the window, are not pulses.
 */
export function channel(pin: number, label: string, initial: 0 | 1, times: number[], end: number): Channel {
  const bounds = [0, ...times, end];
  const total = [0, 0];
  const pulses: [number[], number[]] = [[], []];
  for (let k = 0; k < bounds.length - 1; k++) {
    const level = initial ^ (k & 1);
    const d = bounds[k + 1] - bounds[k];
    total[level] += d;
    if (k > 0 && k < times.length) pulses[level].push(d);
  }
  const stat = (p: number[]): Pulses => ({ count: p.length, min_ms: p.length ? ms(min(p)) : null, max_ms: p.length ? ms(max(p)) : null });
  const out: Channel = { pin, label, edges: times.length, initial, high_ms: ms(total[1]), low_ms: ms(total[0]), pulses: { high: stat(pulses[1]), low: stat(pulses[0]) } };
  const rises = times.map((_, k) => k).filter((k) => (initial ^ (k & 1)) === 0); // edge k leaves level initial ^ (k & 1)
  const periods = rises.slice(1).map((b, i) => times[b] - times[rises[i]]);
  if (periods.length >= 2) {
    const span = times[rises.at(-1)!] - times[rises[0]];
    const mean = span / periods.length;
    if (span > 0 && max(periods) - min(periods) <= Math.max(1, 0.05 * mean)) {
      out.period_ms = ms(mean);
      out.duty = round(rises.slice(0, -1).reduce((s, k) => s + times[k + 1] - times[k], 0) / span, 4);
    }
  }
  return out;
}

/** What a hub would make of this recording: the same edges kept, the same window, the same measures. */
/** `end`: the window measured, in µs. */
export function measure(rec: Omit<Recording, 't0Ms'>, label: (pin: number) => string): { truncated: boolean; end: number; channels: Channel[] } {
  const index = new Map(rec.pins.map((p, i) => [p, i]));
  const level = rec.pins.map((p) => rec.initial[String(p)]);
  const times: number[][] = rec.pins.map(() => []);
  const end = rec.durationMs * 1000;
  let kept = 0;
  let last = 0;
  let truncated = false;
  for (const [t, pin, v] of rec.edges) {
    const i = index.get(pin);
    if (i === undefined || t > end || v === level[i]) continue;
    if (kept >= CAPTURE_MAX_EDGES) {
      truncated = true;
      break;
    }
    times[i].push(t);
    level[i] = v;
    kept++;
    last = t;
  }
  // Truncated: the window measured ends at the last edge kept, not at the duration.
  const windowEnd = truncated ? last : end;
  return { truncated, end: windowEnd, channels: rec.pins.map((p, i) => channel(p, label(p), rec.initial[String(p)], times[i], windowEnd)) };
}

/**
 * The recording as a Value Change Dump (IEEE 1364), the file PulseView and
 * GTKWave open: one wire per pin, its level at #0, then every edge, in µs of
 * simulated time from the start of the recording; the last timestamp is the window's end.
 */
export function toVcd(rec: Recording, label: (pin: number) => string): string {
  const code = (i: number) => String.fromCharCode(33 + i); // '!', '"', '#'…: a few pins at most
  const index = new Map(rec.pins.map((p, i) => [p, i]));
  const end = rec.durationMs * 1000;
  const out = [
    '$version Picodev Lab $end',
    '$timescale 1us $end',
    '$scope module bench $end',
    ...rec.pins.map((p, i) => `$var wire 1 ${code(i)} ${label(p).replace(/[^A-Za-z0-9_]/g, '_') || `D${p}`} $end`),
    '$upscope $end',
    '$enddefinitions $end',
    '#0',
    '$dumpvars',
    ...rec.pins.map((p, i) => `${rec.initial[String(p)] ?? 0}${code(i)}`),
    '$end',
  ];
  let at = 0;
  for (const [t, pin, v] of rec.edges) {
    const i = index.get(pin);
    if (i === undefined || t > end) continue;
    if (t !== at) out.push(`#${(at = t)}`);
    out.push(`${v}${code(i)}`);
  }
  if (end > at) out.push(`#${end}`);
  return out.join('\n') + '\n';
}
