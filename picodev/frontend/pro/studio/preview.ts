/**
 * What drives the scene preview of the studio (architecture v0.20,
 * « Liaisons »): a probe for the bench's scene reader whose sources are set
 * from outside, by the page's controls or by the studio simulation.
 *
 * Unlike the bench's probe, a subscriber gets the last value at once: the
 * preview is mounted again on every change of the bindings, and a pin that no
 * longer moves must still show its level.
 */
import type { mountScene } from '../bench/engine/scene';

// ponytail: the types are read off mountScene, the only bench import the studio takes.
type ScenePreviewProbe = Parameters<typeof mountScene>[3];

export interface PreviewProbe extends ScenePreviewProbe {
  /** `source` as the sheet writes it ("pin:9"): 0|1, a duty 0..1 or degrees. */
  set(source: string, value: number): void;
  /** Every source back to 0. */
  clear(): void;
}

export function createPreviewProbe(): PreviewProbe {
  const last = new Map<string, number>();
  const subs = new Map<string, Set<(v: number) => void>>();
  const on = (source: string, cb: (v: number) => void) => {
    if (!subs.has(source)) subs.set(source, new Set());
    subs.get(source)!.add(cb);
    const v = last.get(source);
    if (v !== undefined) cb(v);
    return () => void subs.get(source)?.delete(cb);
  };
  const set = (source: string, value: number) => {
    if (last.get(source) === value) return;
    last.set(source, value);
    subs.get(source)?.forEach((cb) => cb(value));
  };
  return {
    nowMs: () => 0,
    onPin: (pin, cb) => on(`pin:${pin}`, (v) => cb(v > 0, 0)),
    onPwm: (pin, cb) => on(`pwm:${pin}`, (v) => cb(v, 0)),
    onServo: (pin, cb) => on(`servo:${pin}`, (v) => cb(v, 0)),
    onSerial: () => () => {},
    setPin: () => {},
    set,
    clear: () => [...last.keys()].forEach((s) => set(s, 0)),
  };
}

/**
 * Angle of a servo command pulse of `us` microseconds, or null when it is
 * not one. Arduino Servo.h: 544 µs = 0°, 2400 µs = 180°, 150 µs of slack.
 */
// ponytail: same constants as bench/probe.ts (pulseToAngle), not imported to keep the studio off the bench's internals.
export function servoAngle(us: number): number | null {
  if (us < 394 || us > 2550) return null;
  return Math.round(Math.max(0, Math.min(180, ((us - 544) / 1856) * 180)));
}

/** What the preview needs of Velxio's pin manager and simulator for a board. */
export interface SimPins {
  onPinChange(pin: number, cb: (pin: number, high: boolean) => void): () => void;
  onPwmChange(pin: number, cb: (pin: number, duty: number) => void): () => void;
  getPinState(pin: number): boolean;
  getPwmValue(pin: number): number;
}
export interface SimClock {
  getCurrentCycles?(): number;
  getClockHz?(): number;
}

/** Feeds `probe` from the running simulation for each of `sources`; returns the unsubscribe. */
export function followSim(pins: SimPins, sim: SimClock | undefined, sources: string[], probe: PreviewProbe): () => void {
  const us = () => ((sim?.getCurrentCycles?.() ?? NaN) / (sim?.getClockHz?.() ?? 16_000_000)) * 1e6;
  const offs = sources.map((source) => {
    const [kind, n] = source.split(':');
    const pin = Number(n);
    if (kind === 'pin') {
      probe.set(source, pins.getPinState(pin) ? 1 : 0);
      return pins.onPinChange(pin, (_p, high) => probe.set(source, high ? 1 : 0));
    }
    if (kind === 'pwm') {
      probe.set(source, pins.getPwmValue(pin));
      return pins.onPwmChange(pin, (_p, duty) => probe.set(source, duty));
    }
    if (kind !== 'servo') return () => {};
    // The width of each high pulse, on the simulated clock.
    let rise: number | undefined;
    return pins.onPinChange(pin, (_p, high) => {
      const t = us();
      if (high) return void (rise = t);
      const angle = rise === undefined ? null : servoAngle(t - rise);
      if (angle !== null) probe.set(source, angle);
    });
  });
  return () => offs.forEach((off) => off());
}
