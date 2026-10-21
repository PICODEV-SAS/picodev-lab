import { describe, expect, it, vi } from 'vitest';
import { applyCouplings } from '../couplings';
import { fakeProbe } from './fakeProbe';

describe('applyCouplings', () => {
  it('sets the initial state with every source at 0', () => {
    const f = fakeProbe();
    applyCouplings(
      [
        { source: 'servo:9', min: 85, max: 95, pin: 2, level: 'low' }, // out of range -> high
        { source: 'pin:4', max: 0, pin: 3, level: 'low' }, // in range -> low
      ],
      f.probe,
    );
    expect(f.sets).toEqual([
      { pin: 2, high: true, atMs: undefined },
      { pin: 3, high: false, atMs: undefined },
    ]);
  });

  it('holds the pin while a servo is in range, the opposite otherwise', () => {
    const f = fakeProbe();
    applyCouplings([{ source: 'servo:9', min: 85, max: 95, pin: 2, level: 'low' }], f.probe);
    f.servo(9, 90);
    f.servo(9, 92); // still in range: no new write
    f.servo(9, 120);
    expect(f.sets.map((s) => s.high)).toEqual([true, false, true]);
  });

  it('reads pin sources as 0/1 and pwm as 0..1, with open bounds', () => {
    const f = fakeProbe();
    applyCouplings(
      [
        { source: 'pin:4', min: 1, pin: 5, level: 'high' },
        { source: 'pwm:6', min: 0.5, pin: 7, level: 'high' },
      ],
      f.probe,
    );
    f.pin(4, true, 1);
    f.pwm(6, 0.8);
    f.pwm(6, 0.2);
    expect(f.sets.map((s) => [s.pin, s.high])).toEqual([
      [5, false],
      [7, false],
      [5, true],
      [7, true],
      [7, false],
    ]);
  });

  it('stops following the sources after cleanup', () => {
    const f = fakeProbe();
    const cleanup = applyCouplings(
      [{ source: 'servo:9', min: 85, max: 95, pin: 2, level: 'low' }],
      f.probe,
    );
    expect(f.listenerCount()).toBe(1);
    cleanup();
    expect(f.listenerCount()).toBe(0);
    f.servo(9, 90);
    expect(f.sets).toHaveLength(1);
  });

  it('ignores a source of an unknown kind', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = fakeProbe();
    const cleanup = applyCouplings([{ source: 'adc:1' as never, pin: 2, level: 'high' }], f.probe);
    expect(warn).toHaveBeenCalledOnce();
    cleanup();
    warn.mockRestore();
  });
});
