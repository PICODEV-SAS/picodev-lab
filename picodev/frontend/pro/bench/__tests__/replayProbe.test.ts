import { describe, expect, it, vi } from 'vitest';
import { createReplayProbe } from '../replayProbe';

describe('replay probe', () => {
  it('hands the relayed events to the listeners, like the live probe', () => {
    const probe = createReplayProbe();
    const pin = vi.fn();
    const servo = vi.fn();
    const pwm = vi.fn();
    const serial = vi.fn();
    probe.onPin(6, pin);
    probe.onServo(9, servo);
    probe.onPwm(5, pwm);
    const off = probe.onSerial(serial);

    probe.feed([
      { t: 1, k: 'pin', pin: 6, v: 1 },
      { t: 2, k: 'servo', pin: 9, v: 70 },
      { t: 3, k: 'pwm', pin: 5, v: 0.5 },
      { t: 4, k: 'serial', v: 'Arm: press\n' },
      { t: 5, k: 'pin', pin: 7, v: 1 }, // nobody listens
      { t: 6, k: 'pin', pin: 6, v: 0 },
    ]);
    expect(pin.mock.calls).toEqual([
      [true, 1],
      [false, 6],
    ]);
    expect(servo).toHaveBeenCalledWith(70, 2);
    expect(pwm).toHaveBeenCalledWith(0.5, 3);
    expect(serial).toHaveBeenCalledWith('Arm: press\n', 4);
    expect(probe.nowMs()).toBe(6);
    expect(probe.samples(6)).toEqual([
      { timeMs: 1, state: true },
      { timeMs: 6, state: false },
    ]);

    off();
    probe.feed([{ t: 7, k: 'serial', v: 'x' }]);
    expect(serial).toHaveBeenCalledTimes(1);
  });

  it('drops malformed events and starts the traces over on a new run', () => {
    const probe = createReplayProbe();
    const pin = vi.fn();
    probe.onPin(2, pin);
    probe.feed([
      { t: 10, k: 'pin', pin: 2, v: 1 },
      { t: Number.NaN, k: 'pin', pin: 2, v: 0 },
      { t: 11, k: 'pin', v: 0 } as never,
      { t: 12, k: 'serial', v: 3 } as never,
      null as never,
    ]);
    expect(pin).toHaveBeenCalledTimes(1);
    expect(probe.samples(2)).toHaveLength(1);

    probe.feed([{ t: 0.5, k: 'pin', pin: 2, v: 0 }]); // the owner relaunched: its clock is back to 0
    expect(probe.samples(2)).toEqual([{ timeMs: 0.5, state: false }]);
    expect(probe.nowMs()).toBe(0.5);
  });

  it('never drives the bench', () => {
    const probe = createReplayProbe();
    const pin = vi.fn();
    probe.onPin(2, pin);
    probe.setPin(2, true);
    expect(pin).not.toHaveBeenCalled();
  });
});
