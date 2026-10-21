import { describe, expect, it, vi } from 'vitest';
import { createProbe, pulseToAngle, type ProbedSim } from '../probe';

class FakeSim implements ProbedSim {
  cycles = 0;
  inputs = new Map<number, boolean>();
  scheduled: Array<[number, boolean, number]> = [];
  onPinChangeWithTime: ProbedSim['onPinChangeWithTime'] = null;
  onSerialData: ProbedSim['onSerialData'] = null;
  getCurrentCycles() {
    return this.cycles;
  }
  setPinState(pin: number, state: boolean) {
    this.inputs.set(pin, state);
  }
  schedulePinChange(pin: number, state: boolean, atCycle: number) {
    this.scheduled.push([pin, state, atCycle]);
  }
  /** The MCU drives an output at `ms`. */
  out(pin: number, state: boolean, ms: number) {
    this.cycles = ms * 16_000;
    this.onPinChangeWithTime?.(pin, state, ms);
  }
}

const pins = { onPwmChange: () => () => {} };
const held = new Set<number>();
const hold = { claim: (pin: number) => void held.add(pin), releaseAll: () => held.clear() };

describe('bench probe', () => {
  it('maps a servo pulse to an angle', () => {
    expect(pulseToAngle(544)).toBe(0);
    expect(pulseToAngle(1472)).toBe(90);
    expect(pulseToAngle(2400)).toBe(180);
    expect(pulseToAngle(20_000)).toBeNull();
  });

  it('chains the single slots, reports forced inputs and holds them', () => {
    const sim = new FakeSim();
    const scope = vi.fn();
    const store = vi.fn();
    sim.onPinChangeWithTime = scope;
    sim.onSerialData = store;
    const probe = createProbe(sim, pins, hold);

    const d2 = vi.fn();
    const servo = vi.fn();
    const serial = vi.fn();
    probe.onPin(2, d2);
    probe.onServo(9, servo);
    probe.onSerial(serial);

    sim.cycles = 16_000; // 1 ms
    probe.setPin(2, false);
    expect(sim.inputs.get(2)).toBe(false);
    expect(d2).toHaveBeenCalledWith(false, 1);
    expect(scope).toHaveBeenCalledWith(2, false, 1); // the oscilloscope sees the input too
    expect(held.has(2)).toBe(true); // the SPICE solve leaves it alone
    probe.setPin(2, false);
    expect(d2).toHaveBeenCalledTimes(1);

    probe.setPin(2, true, 50);
    expect(sim.scheduled).toEqual([[2, true, 800_000]]);

    sim.out(9, true, 100);
    sim.out(9, false, 101.5);
    expect(servo).toHaveBeenCalledWith(93, 101.5);

    sim.onSerialData!('A');
    expect(store).toHaveBeenCalledWith('A');
    expect(serial).toHaveBeenCalledWith('A', 101.5);

    probe.dispose();
    expect(held.size).toBe(0);
    expect(sim.onPinChangeWithTime).toBe(scope);
    expect(sim.onSerialData).toBe(store);
    expect(Object.hasOwn(sim, 'setPinState')).toBe(false);
  });
});
