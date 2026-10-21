import type { BenchProbe } from '../../types';

type Listener = (value: never, tMs: number) => void;

/**
 * A BenchProbe driven by hand: simulated time only moves when the test says
 * so. Like the real bench, a forced input is reported to the pin listeners.
 */
export function fakeProbe() {
  let now = 0;
  const listeners = new Map<string, Set<Listener>>();
  const scheduled: Array<{ at: number; pin: number; high: boolean }> = [];
  const sets: Array<{ pin: number; high: boolean; atMs?: number }> = [];

  const on = (key: string, cb: Listener) => {
    if (!listeners.has(key)) listeners.set(key, new Set());
    listeners.get(key)!.add(cb);
    return () => void listeners.get(key)!.delete(cb);
  };
  const emit = (key: string, value: unknown, t: number) => {
    now = Math.max(now, t);
    for (const cb of [...(listeners.get(key) ?? [])]) cb(value as never, t);
  };

  const probe: BenchProbe = {
    nowMs: () => now,
    onPin: (pin, cb) => on(`pin:${pin}`, cb as Listener),
    onPwm: (pin, cb) => on(`pwm:${pin}`, cb as Listener),
    onServo: (pin, cb) => on(`servo:${pin}`, cb as Listener),
    onSerial: (cb) => on('serial', cb as Listener),
    setPin: (pin, high, atMs) => {
      sets.push({ pin, high, atMs });
      if (atMs === undefined || atMs <= now) emit(`pin:${pin}`, high, now);
      else scheduled.push({ at: atMs, pin, high });
    },
  };

  return {
    probe,
    /** Every setPin call, in order. */
    sets,
    /** Moves simulated time forward, firing the forced inputs that fall due. */
    advance(to: number) {
      scheduled.sort((a, b) => a.at - b.at);
      while (scheduled.length && scheduled[0].at <= to) {
        const s = scheduled.shift()!;
        emit(`pin:${s.pin}`, s.high, s.at);
      }
      now = Math.max(now, to);
    },
    pin: (pin: number, high: boolean, t: number) => emit(`pin:${pin}`, high, t),
    pwm: (pin: number, duty: number, t = now) => emit(`pwm:${pin}`, duty, t),
    servo: (pin: number, angle: number, t = now) => emit(`servo:${pin}`, angle, t),
    serial: (text: string, t: number) => emit('serial', text, t),
    listenerCount: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
  };
}
