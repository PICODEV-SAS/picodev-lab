/**
 * AVRSimulator.pause(): the loop stops like stop(), but what is scheduled
 * ahead (pin changes, serial input) is kept for start() to go on with.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AVRSimulator } from '../simulation/AVRSimulator';
import { PinManager } from '../simulation/PinManager';

// One frame per start(), no re-entrancy (as in AVRSimulator.test.ts).
beforeEach(() => {
  let depth = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    if (depth === 0) {
      depth++;
      cb(0);
      depth--;
    }
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

// LDI/OUT pin 13 high, then RJMP to itself.
const BLINK_HEX = ':0A0000000FEF04B900E205B9FFCFCD\n' + ':00000001FF\n';

describe('AVRSimulator — pause', () => {
  it('keeps the scheduled pin changes and serial input; stop() drops them', () => {
    const sim = new AVRSimulator(new PinManager());
    sim.loadHex(BLINK_HEX);
    const queued = () => {
      const s = sim as unknown as { scheduledPinChanges: unknown[]; serialRxQueue: unknown[] };
      return [s.scheduledPinChanges.length, s.serialRxQueue.length];
    };
    sim.start();
    sim.schedulePinChange(2, true, 1e12);
    (sim as unknown as { serialRxQueue: number[] }).serialRxQueue.push(65);

    sim.pause();
    expect(sim.isRunning()).toBe(false);
    expect(queued()).toEqual([1, 1]);

    sim.start();
    expect(sim.isRunning()).toBe(true);
    sim.stop();
    expect(queued()).toEqual([0, 0]);
  });
});
