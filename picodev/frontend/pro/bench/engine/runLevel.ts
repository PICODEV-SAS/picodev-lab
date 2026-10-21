import type { BenchProbe, Lang, Level, TestResult, TestSpec } from '../types';

/**
 * Runs the tests of a challenge level against a running bench.
 *
 * Time is the simulated time of the probe, counted from the call: `at_ms`,
 * `within_ms` and `timeout_ms` are all relative to the moment runLevel is
 * called. The simulation may pause, so nothing here relies on the wall clock:
 * a light timer only polls `probe.nowMs()`.
 *
 * Every test starts `pending`, becomes `running` once simulated time moves,
 * then `passed` or `failed`, and is never re-evaluated after that. The run
 * ends at `timeout_ms`, or sooner when every test is decided.
 *
 * Readings chosen where the type comments leave room:
 *
 * - Pin before its first report: the first report after the start is an edge
 *   (the pin was at the opposite level until then); a report at the start
 *   itself only gives the initial level. A pin that has reported nothing is
 *   taken as low, the reset state of a microcontroller pin.
 * - Repeated reports of the same level are not edges.
 * - `pin_level`: the level at `at_ms`, a change at exactly `at_ms` included.
 *   Past the end of the observation, the level at the end is used.
 * - `follows`: an edge of `source` is followed when `pin` makes the expected
 *   edge within `max_delay_ms` (same instant included), or when `pin` was
 *   already at the expected level and stays there for the whole delay. It
 *   fails as soon as one edge is missed, and can only pass at the end, since
 *   every edge must be followed. An edge whose delay is cut by the end of the
 *   observation is left out: neither a failure nor counted in `min_edges`.
 *   Fewer than `min_edges` followed edges is a failure.
 * - `pulse`: a pulse is the time between an edge to `level` and the next
 *   edge, bounds included. A pulse already under way at the start, or still
 *   under way at the end, has an unknown length and is not counted. Passes as
 *   soon as `count` pulses fit.
 * - `serial_contains`: the chunks received up to `within_ms` are joined, so a
 *   text split across chunks is found; carriage returns are ignored on both
 *   sides (`println` sends "\r\n"). Fails once `within_ms` is passed.
 *
 * `done` resolves with the final results; after `cancel()` it resolves with
 * the results as they were, and `onUpdate` is not called again. The details
 * are written in `lang`.
 */
export function runLevel(
  level: Level,
  probe: BenchProbe,
  onUpdate: (results: TestResult[]) => void,
  lang: Lang = 'fr',
): { done: Promise<TestResult[]>; cancel(): void } {
  const t0 = probe.nowMs();
  const log: Log = { pins: new Map(), serial: [] };
  let results: TestResult[] = level.tests.map((t) => ({
    id: t.id,
    status: 'pending',
  }));
  let resolve!: (r: TestResult[]) => void;
  const done = new Promise<TestResult[]>((r) => {
    resolve = r;
  });

  const unsubs: Array<() => void> = [];
  const watched = new Set<number>();
  for (const { spec } of level.tests) {
    if (spec.type === 'serial_contains') continue;
    watched.add(spec.pin);
    if (spec.type === 'follows') watched.add(spec.source);
  }
  for (const pin of watched) {
    const p: PinLog = { edges: [] };
    log.pins.set(pin, p);
    unsubs.push(
      probe.onPin(pin, (high, tMs) => {
        if (tMs - t0 <= level.timeout_ms) record(p, high, tMs - t0);
      }),
    );
  }
  if (level.tests.some((t) => t.spec.type === 'serial_contains')) {
    unsubs.push(
      probe.onSerial((text, tMs) => {
        if (tMs - t0 <= level.timeout_ms) log.serial.push({ t: tMs - t0, text });
      }),
    );
  }
  // Subscribed first, so that the forced inputs are seen like any other change.
  for (const s of level.stimulus ?? []) probe.setPin(s.pin, s.level === 'high', t0 + s.at_ms);

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    unsubs.forEach((u) => u());
    resolve(results);
  };

  // ponytail: the whole log is re-read on each poll (linear in the edges seen); keep a cursor per test if a level ever watches a fast PWM pin for minutes.
  const tick = () => {
    const elapsed = probe.nowMs() - t0;
    if (elapsed <= 0) return; // not started or paused at the start: still pending
    const over = elapsed >= level.timeout_ms;
    const now = Math.min(elapsed, level.timeout_ms);
    let changed = false;
    results = results.map((r, i) => {
      if (decided(r)) return r;
      const next = {
        id: r.id,
        ...evaluate(level.tests[i].spec, log, now, over, SAY[lang]),
      };
      if (next.status !== r.status) changed = true;
      return next;
    });
    if (changed) onUpdate(results);
    if (over || results.every(decided)) stop();
  };
  const timer = setInterval(tick, POLL_MS);

  onUpdate(results);
  return { done, cancel: stop };
}

/** Real milliseconds between two readings of the simulated clock. */
const POLL_MS = 50;

interface Edge {
  /** Simulated milliseconds since the start of the run. */
  t: number;
  high: boolean;
}
interface PinLog {
  /** Level before the first edge; undefined while nothing was reported. */
  initial?: boolean;
  /** Changes only, so the levels alternate. */
  edges: Edge[];
}
interface Log {
  pins: Map<number, PinLog>;
  serial: Array<{ t: number; text: string }>;
}
type Verdict = { status: 'running' } | { status: 'passed' | 'failed'; detail: string };

const RUNNING: Verdict = { status: 'running' };
const passed = (detail: string): Verdict => ({ status: 'passed', detail });
const failed = (detail: string): Verdict => ({ status: 'failed', detail });
const decided = (r: TestResult) => r.status === 'passed' || r.status === 'failed';

const name = (pin: number) => `D${pin}`;
const bit = (high: boolean) => (high ? '1' : '0');
const s = (n: number) => (n > 1 ? 's' : '');

/** The details of the verdicts; `ms` and `bit` are already written out. */
const FR = {
  ms: (n: number) => `${n.toLocaleString('fr-FR', { maximumFractionDigits: 2 })} ms`,
  isAt: (pin: string, b: string, at: string) => `${pin} est à ${b} à ${at}`,
  expected: (b: string) => `, ${b} attendu`,
  late: (who: string, src: string, d: string, max: string) => `${who} suit ${src} avec ${d} de retard, ${max} au plus attendu`,
  missed: (who: string, b: string, src: string, at: string) => `${who} n'a pas suivi le passage à ${b} de ${src} à ${at}`,
  neverChanged: (src: string) => `${src} n'a jamais changé d'état`,
  fewEdges: (n: number, src: string, who: string, min: number) => `seulement ${n} front${s(n)} de ${src} suivi${s(n)} par ${who}, ${min} attendu${s(min)}`,
  follows: (who: string, src: string, invert: boolean, d: string) => `${who} suit ${src}${invert ? ' en inversé' : ''} avec ${d} de retard`,
  on: (pin: string) => `sur ${pin}`,
  pulse: (d: string, where: string) => `impulsion de ${d} ${where}`,
  pulses: (n: number, lo: string, hi: string, where: string) => `${n} impulsions de ${lo} à ${hi} ${where}`,
  fewPulses: (n: number, where: string, need: number) => `${n} impulsion${s(n)} valide${s(n)} ${where}, ${need} attendues`,
  badPulse: (d: string, where: string, lo: string, hi: string) => `impulsion de ${d} ${where}, entre ${lo} et ${hi} attendu`,
  noPulse: (b: string, where: string) => `aucune impulsion complète à ${b} ${where}`,
  neverAt: (pin: string, b: string) => `${pin} n'est jamais passé à ${b}`,
  quote: (t: string) => `« ${t} »`,
  received: (q: string, at: string) => `${q} reçu à ${at}`,
  notReceived: (q: string, within: string) => `${q} non reçu en ${within}`,
};
type Say = typeof FR;
const EN: Say = {
  ms: (n) => `${n.toLocaleString('en-GB', { maximumFractionDigits: 2 })} ms`,
  isAt: (pin, b, at) => `${pin} is ${b} at ${at}`,
  expected: (b) => `, ${b} expected`,
  late: (who, src, d, max) => `${who} follows ${src} ${d} late, at most ${max} expected`,
  missed: (who, b, src, at) => `${who} did not follow ${src} going to ${b} at ${at}`,
  neverChanged: (src) => `${src} never changed state`,
  fewEdges: (n, src, who, min) => `only ${n} edge${s(n)} of ${src} followed by ${who}, ${min} expected`,
  follows: (who, src, invert, d) => `${who} follows ${src}${invert ? ' inverted' : ''} ${d} late`,
  on: (pin) => `on ${pin}`,
  pulse: (d, where) => `${d} pulse ${where}`,
  pulses: (n, lo, hi, where) => `${n} pulses of ${lo} to ${hi} ${where}`,
  fewPulses: (n, where, need) => `${n} valid pulse${s(n)} ${where}, ${need} expected`,
  badPulse: (d, where, lo, hi) => `${d} pulse ${where}, between ${lo} and ${hi} expected`,
  noPulse: (b, where) => `no complete pulse at ${b} ${where}`,
  neverAt: (pin, b) => `${pin} never went to ${b}`,
  quote: (t) => `“${t}”`,
  received: (q, at) => `${q} received at ${at}`,
  notReceived: (q, within) => `${q} not received within ${within}`,
};
const SAY: Record<Lang, Say> = { fr: FR, en: EN };

function record(p: PinLog, high: boolean, t: number): void {
  if (t <= 0) {
    p.initial = high;
    return;
  }
  if (p.initial === undefined) p.initial = !high;
  const last = p.edges.at(-1);
  if ((last ? last.high : p.initial) !== high) p.edges.push({ t, high });
}

function levelAt(p: PinLog, t: number): boolean {
  let high = p.initial ?? false;
  for (const e of p.edges) {
    if (e.t > t) break;
    high = e.high;
  }
  return high;
}

/**
 * The verdict of one test from what was seen up to `now`. Assumes the probe
 * has delivered every event older than `now`; a deadline is therefore only
 * closed once `now` is strictly past it. With `over`, the verdict is final.
 */
function evaluate(spec: TestSpec, log: Log, now: number, over: boolean, say: Say): Verdict {
  const ms = say.ms;
  switch (spec.type) {
    case 'pin_level': {
      if (now <= spec.at_ms && !over) return RUNNING;
      const at = Math.min(spec.at_ms, now);
      const high = levelAt(log.pins.get(spec.pin)!, at);
      const want = spec.level === 'high';
      return high === want
        ? passed(say.isAt(name(spec.pin), bit(high), ms(at)))
        : failed(say.isAt(name(spec.pin), bit(high), ms(at)) + say.expected(bit(want)));
    }

    case 'follows': {
      const src = log.pins.get(spec.source)!.edges;
      const pin = log.pins.get(spec.pin)!;
      const out = pin.edges;
      const who = `${name(spec.pin)}`;
      let j = 0;
      let followed = 0;
      let worst = 0;
      for (const e of src) {
        const want = spec.invert ? !e.high : e.high;
        const deadline = e.t + spec.max_delay_ms;
        while (j < out.length && out[j].t < e.t) j++;
        let k = j;
        while (k < out.length && out[k].t <= deadline && out[k].high !== want) k++;
        if (k < out.length && out[k].t <= deadline) {
          followed++;
          worst = Math.max(worst, out[k].t - e.t);
          continue;
        }
        if (deadline >= now) continue; // still open, or cut by the end
        const before = j > 0 ? out[j - 1].high : (pin.initial ?? false);
        if (k === j && before === want) {
          followed++; // already there, and stayed
          continue;
        }
        const late = out.slice(k).find((o) => o.high === want);
        return failed(
          late
            ? say.late(who, name(spec.source), ms(late.t - e.t), ms(spec.max_delay_ms))
            : say.missed(who, bit(e.high), name(spec.source), ms(e.t)),
        );
      }
      if (!over) return RUNNING;
      const min = spec.min_edges ?? 2;
      if (src.length === 0) return failed(say.neverChanged(name(spec.source)));
      if (followed < min) {
        return failed(say.fewEdges(followed, name(spec.source), who, min));
      }
      return passed(say.follows(who, name(spec.source), !!spec.invert, ms(worst)));
    }

    case 'pulse': {
      const want = spec.level === 'high';
      const need = spec.count ?? 1;
      const p = log.pins.get(spec.pin)!;
      const durations: number[] = [];
      p.edges.forEach((e, i) => {
        const next = p.edges[i + 1];
        if (e.high === want && next) durations.push(next.t - e.t);
      });
      const good = durations.filter((d) => d >= spec.min_ms && d <= spec.max_ms);
      const where = say.on(name(spec.pin));
      if (good.length >= need) {
        return passed(
          need === 1
            ? say.pulse(ms(good[0]), where)
            : say.pulses(good.length, ms(Math.min(...good)), ms(Math.max(...good)), where),
        );
      }
      if (!over) return RUNNING;
      if (good.length > 0) {
        return failed(say.fewPulses(good.length, where, need));
      }
      if (durations.length > 0) {
        return failed(say.badPulse(ms(durations.at(-1)!), where, ms(spec.min_ms), ms(spec.max_ms)));
      }
      return failed(
        p.initial === want || p.edges.some((e) => e.high === want)
          ? say.noPulse(bit(want), where)
          : say.neverAt(name(spec.pin), bit(want)),
      );
    }

    case 'serial_contains': {
      const clean = (text: string) => text.replaceAll('\r', '');
      const wanted = clean(spec.text);
      const shown = say.quote(spec.text.trim());
      let received = '';
      for (const chunk of log.serial) {
        if (chunk.t > spec.within_ms) break;
        received += clean(chunk.text);
        if (received.includes(wanted)) return passed(say.received(shown, ms(chunk.t)));
      }
      if (now <= spec.within_ms && !over) return RUNNING;
      return failed(say.notReceived(shown, ms(Math.min(spec.within_ms, now))));
    }
  }
}
