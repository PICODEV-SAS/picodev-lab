import type { BenchProbe, Coupling } from '../types';
import { watchSource } from './source';

/**
 * Imitates what the assembly does mechanically: while the source is within
 * [min, max] (a missing bound is open) the coupled pin is held at `level`,
 * otherwise at the opposite level.
 *
 * The initial state is set at once, taking every source at 0 until its first
 * report. The pin is only written when its level changes. Returns the cleanup,
 * which stops following the sources (the pins keep their last level: the probe
 * has no way to release one).
 */
export function applyCouplings(couplings: Coupling[], probe: BenchProbe): () => void {
  const unsubs = couplings.map((c) => {
    let held: boolean | undefined;
    const apply = (value: number) => {
      const inRange = value >= (c.min ?? -Infinity) && value <= (c.max ?? Infinity);
      const high = inRange === (c.level === 'high');
      if (high === held) return;
      held = high;
      probe.setPin(c.pin, high);
    };
    apply(0);
    return watchSource(probe, c.source, apply);
  });
  return () => unsubs.forEach((u) => u());
}
