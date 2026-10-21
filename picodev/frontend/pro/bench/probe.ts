/**
 * BenchProbe over Velxio's in-browser simulator.
 *
 * Velxio is not patched: the probe hooks the simulator INSTANCE of the board.
 *  - `onPinChangeWithTime` and `onSerialData` are single slots the store
 *    already uses, so they are chained, never replaced;
 *  - `setPinState` is how every input level reaches the MCU (the SPICE
 *    solve, a part, a scheduled change, this probe). It never reports back,
 *    so the instance method is wrapped: an input edge is then seen by the
 *    listeners and by the oscilloscope like an output edge;
 *  - a pin forced here is claimed through `hold` (Velxio's partPinOwnership,
 *    wired by the page), or the next SPICE solve of the wiring would
 *    overwrite it. This file imports nothing of Velxio, like ./engine.
 */
import type { BenchProbe } from './types';

/** What the probe needs of a Velxio simulator (AVRSimulator has all of it). */
export interface ProbedSim {
  getCurrentCycles?(): number;
  getClockHz?(): number;
  setPinState(pin: number, state: boolean): void;
  schedulePinChange?(pin: number, state: boolean, atCycle: number): void;
  onPinChangeWithTime: ((pin: number, state: boolean, timeMs: number) => void) | null;
  onSerialData: ((ch: string) => void) | null;
}

export interface ProbedPins {
  onPwmChange(pin: number, cb: (pin: number, duty: number, timeMs?: number) => void): () => void;
}

/** Keeps the forced pins away from the SPICE solve. */
export interface PinHold {
  claim(pin: number): void;
  releaseAll(): void;
}

// Arduino Servo.h: 544 µs = 0°, 2400 µs = 180° (same constants as Velxio's
// servo part). The tolerance absorbs the interrupt latency of the library.
const SERVO_MIN_US = 544;
const SERVO_MAX_US = 2400;
const SERVO_TOLERANCE_US = 150;

/** Angle of a servo command pulse, or null when the pulse is not one. */
export function pulseToAngle(us: number): number | null {
  if (us < SERVO_MIN_US - SERVO_TOLERANCE_US || us > SERVO_MAX_US + SERVO_TOLERANCE_US) return null;
  const angle = ((us - SERVO_MIN_US) / (SERVO_MAX_US - SERVO_MIN_US)) * 180;
  return Math.round(Math.max(0, Math.min(180, angle)));
}

export interface SimProbe extends BenchProbe {
  /** Forget levels and release the forced pins: call before each run and on stop. */
  reset(): void;
  /** Unhook the simulator. */
  dispose(): void;
}

export function createProbe(sim: ProbedSim, pins: ProbedPins, hold: PinHold): SimProbe {
  type Subs<T> = Map<number, Set<T>>;
  const pinSubs: Subs<(high: boolean, tMs: number) => void> = new Map();
  const servoSubs: Subs<(angle: number, tMs: number) => void> = new Map();
  const serialSubs = new Set<(text: string, tMs: number) => void>();
  const level = new Map<number, boolean>();
  const inputLevel = new Map<number, boolean>();
  const riseMs = new Map<number, number>();

  const msPerCycle = 1000 / (sim.getClockHz?.() ?? 16_000_000);
  const nowMs = () => (sim.getCurrentCycles?.() ?? 0) * msPerCycle;

  const subscribe = <T>(subs: Subs<T>, pin: number, cb: T) => {
    if (!subs.has(pin)) subs.set(pin, new Set());
    subs.get(pin)!.add(cb);
    return () => void subs.get(pin)?.delete(cb);
  };

  const emitPin = (pin: number, high: boolean, tMs: number) => {
    if (level.get(pin) === high) return;
    level.set(pin, high);
    pinSubs.get(pin)?.forEach((cb) => cb(high, tMs));
    if (high) return void riseMs.set(pin, tMs);
    const rise = riseMs.get(pin);
    const angle = rise === undefined ? null : pulseToAngle((tMs - rise) * 1000);
    if (angle !== null) servoSubs.get(pin)?.forEach((cb) => cb(angle, tMs));
  };

  const prevPinTime = sim.onPinChangeWithTime;
  const pinTime = (pin: number, state: boolean, tMs: number) => {
    prevPinTime?.(pin, state, tMs);
    emitPin(pin, state, tMs);
  };
  sim.onPinChangeWithTime = pinTime;

  const prevSerial = sim.onSerialData;
  const serial = (ch: string) => {
    prevSerial?.(ch);
    if (serialSubs.size) {
      const t = nowMs();
      serialSubs.forEach((cb) => cb(ch, t));
    }
  };
  sim.onSerialData = serial;

  const setPinState = sim.setPinState;
  sim.setPinState = (pin, state) => {
    setPinState.call(sim, pin, state);
    if (inputLevel.get(pin) === state) return;
    inputLevel.set(pin, state);
    sim.onPinChangeWithTime?.(pin, state, nowMs());
  };

  return {
    nowMs,
    onPin: (pin, cb) => subscribe(pinSubs, pin, cb),
    onServo: (pin, cb) => subscribe(servoSubs, pin, cb),
    onPwm: (pin, cb) => pins.onPwmChange(pin, (_pin, duty, tMs) => cb(duty, tMs ?? nowMs())),
    onSerial: (cb) => {
      serialSubs.add(cb);
      return () => void serialSubs.delete(cb);
    },
    setPin(pin, high, atMs) {
      hold.claim(pin);
      if (atMs !== undefined && atMs > nowMs() && sim.schedulePinChange) {
        sim.schedulePinChange(pin, high, Math.round(atMs / msPerCycle));
      } else {
        sim.setPinState(pin, high);
      }
    },
    reset() {
      level.clear();
      inputLevel.clear();
      riseMs.clear();
      hold.releaseAll();
    },
    dispose() {
      hold.releaseAll();
      pinSubs.clear();
      servoSubs.clear();
      serialSubs.clear();
      // Someone may have chained after us (Velxio's Interconnect wraps
      // onSerialData): only put back a slot that is still ours.
      if (sim.onPinChangeWithTime === pinTime) sim.onPinChangeWithTime = prevPinTime;
      if (sim.onSerialData === serial) sim.onSerialData = prevSerial;
      delete (sim as { setPinState?: unknown }).setPinState; // back to the class method
    },
  };
}
