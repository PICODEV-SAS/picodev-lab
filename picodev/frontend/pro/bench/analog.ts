/**
 * The analog capture of the bench (live-protocol.adoc, "analog capture"):
 * the voltage of some board pins, sampled on the simulated clock of the
 * processor (a clock event every clock / rate_hz cycles), not on the frames of
 * the page. Agent only; imports nothing of Velxio.
 */
import type { Interruption } from './capture';
import type { BenchProbe } from './types';
import type { BoardPins } from './wiring';

export const ANALOG_MAX = { pins: 4, ms: 10_000, minHz: 100, maxHz: 10_000, samples: 200_000 };

/** What the sampler needs of a Velxio simulator (AVRSimulator has all of it). */
export interface AnalogSim {
  getADC?(): { channelValues: number[]; avcc?: number } | null;
  addClockEvent?(callback: () => void, cycles: number): boolean;
  getCurrentCycles?(): number;
  getClockHz?(): number;
}

/** Row `k` is the instant k / rate_hz: one integer millivolt value per pin, in the order asked. */
export type AnalogRows = number[][];

export interface Sampler {
  /** The pins it can sample: every numbered pin of the board. */
  pins: number[];
  /**
   * Samples `pins` from now, replacing the sampling in progress (whose owner
   * hears `replaced`). Null when the board cannot be sampled; else a function
   * that drops this sampling without a word. `t0Ms`: the simulated ms of row 0.
   */
  sample(pins: number[], durationMs: number, rateHz: number, done: (rows: AnalogRows, t0Ms: number) => void, interrupted: (why: Interruption) => void): (() => void) | null;
  /** The simulation was stopped, or started again: the levels are forgotten, a sampling is lost. */
  halted(reason: 'stop' | 'relaunch'): void;
  close(): void;
}

/** Rows of a capture: the instants k / rate_hz within the duration, one at least. */
export const analogRows = (durationMs: number, rateHz: number) => Math.max(1, Math.floor((durationMs * rateHz) / 1000));

/**
 * The level of every digital pin is followed all along (a pin that has said
 * nothing since the start is low, as for the logic capture); an input of the
 * converter reads the voltage the circuit applies to it (AVRADC channelValues).
 */
export function createSampler(sim: () => AnalogSim | null, probe: BenchProbe, board: BoardPins): Sampler {
  const levels = new Map<number, 0 | 1>();
  const offs = board.pins.map((pin) => probe.onPin(pin, (high) => levels.set(pin, high ? 1 : 0)));
  type Cur = { done: (rows: AnalogRows, t0Ms: number) => void; interrupted: (why: Interruption) => void };
  let cur: Cur | null = null;

  const end = (why: Interruption) => {
    const c = cur;
    cur = null;
    c?.interrupted(why);
  };
  const onVisibility = () => {
    if (document.hidden) end('hidden');
  };
  document.addEventListener('visibilitychange', onVisibility);

  return {
    pins: board.pins,
    sample(pins, durationMs, rateHz, done, interrupted) {
      const s = sim();
      const adc = s?.getADC?.();
      if (!s?.addClockEvent || !s.getCurrentCycles || !adc) return null;
      end('replaced');
      const c: Cur = { done, interrupted };
      cur = c;
      const clock = s.getClockHz?.() ?? 16_000_000;
      const vcc = (adc.avcc ?? 5) * 1000;
      const total = analogRows(durationMs, rateHz);
      const t0 = s.getCurrentCycles();
      const rows: AnalogRows = [];
      const mv = (pin: number) => {
        const ch = board.adc.get(pin);
        return Math.round(ch !== undefined ? (Number(adc.channelValues[ch]) || 0) * 1000 : (levels.get(pin) ?? 0) * vcc);
      };
      const take = () => {
        if (cur !== c) return; // dropped: the clock event fires once more, for nothing
        rows.push(pins.map(mv));
        if (rows.length >= total) {
          cur = null;
          return done(rows, (t0 * 1000) / clock);
        }
        // Each instant from t0, so that rounding never drifts.
        const at = t0 + Math.round((rows.length * clock) / rateHz);
        if (!s.addClockEvent!(take, Math.max(1, at - s.getCurrentCycles!()))) end('stop');
      };
      take();
      return () => {
        if (cur === c) cur = null;
      };
    },
    halted(reason) {
      levels.clear(); // the next run starts from the reset state
      end(reason);
    },
    close() {
      cur = null;
      offs.forEach((off) => off());
      document.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
