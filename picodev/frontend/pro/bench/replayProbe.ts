/**
 * BenchProbe over the event stream of a hub session (the spectator page).
 *
 * The owner's browser simulates and sends what its probe saw (`events`);
 * this probe hands them to the same listeners the workspace uses, so the
 * scene player and the traces work unchanged. It never simulates: `setPin`
 * does nothing, and time is the time of the last event received.
 */
import type { BenchEvent, BenchProbe } from './types';

// ponytail: per-pin history for the traces, capped; the traces show seconds, not minutes.
const MAX_SAMPLES = 2000;

export interface ReplayProbe extends BenchProbe {
  /** Replays a batch of events, in order. */
  feed(events: BenchEvent[]): void;
  /** The edges seen on a pin since the last run started, for the traces. */
  samples(pin: number): Array<{ timeMs: number; state: boolean }>;
}

export function createReplayProbe(): ReplayProbe {
  const subs = new Map<string, Set<(v: never, tMs: number) => void>>();
  const history = new Map<number, Array<{ timeMs: number; state: boolean }>>();
  let now = 0;

  const on = (key: string, cb: (v: never, tMs: number) => void) => {
    if (!subs.has(key)) subs.set(key, new Set());
    subs.get(key)!.add(cb);
    return () => void subs.get(key)?.delete(cb);
  };

  const valid = (e: BenchEvent) =>
    typeof e?.t === 'number' &&
    Number.isFinite(e.t) &&
    (e.k === 'serial' ? typeof e.v === 'string' : Number.isInteger(e.pin) && typeof e.v === 'number' && Number.isFinite(e.v));

  return {
    nowMs: () => now,
    onPin: (pin, cb) => on(`pin:${pin}`, cb as never),
    onPwm: (pin, cb) => on(`pwm:${pin}`, cb as never),
    onServo: (pin, cb) => on(`servo:${pin}`, cb as never),
    onSerial: (cb) => on('serial', cb as never),
    setPin: () => {}, // a spectator never drives the bench
    samples: (pin) => history.get(pin) ?? [],
    feed(events) {
      for (const e of events) {
        if (!valid(e)) continue; // relayed from a stranger's browser
        // The owner's clock restarts at each run: the old traces go with it.
        if (e.t < now) history.clear();
        now = e.t;
        const value = e.k === 'pin' ? e.v !== 0 : e.v;
        if (e.k === 'pin') {
          const h = history.get(e.pin!) ?? [];
          h.push({ timeMs: e.t, state: value as boolean });
          if (h.length > MAX_SAMPLES) h.splice(0, h.length - MAX_SAMPLES);
          history.set(e.pin!, h);
        }
        const key = e.k === 'serial' ? 'serial' : `${e.k}:${e.pin}`;
        subs.get(key)?.forEach((cb) => cb(value as never, e.t));
      }
    },
  };
}
