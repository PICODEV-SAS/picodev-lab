import type { BenchProbe, Source } from '../types';

/**
 * Calls `cb` with the value of a source each time it changes: 0|1 for `pin:`,
 * 0..1 for `pwm:`, degrees for `servo:`. Returns the unsubscribe.
 *
 * The probe cannot be asked for a current value, so callers start from 0
 * (pin low, no duty, servo at 0 degrees) until the first report.
 */
export function watchSource(
  probe: BenchProbe,
  source: Source,
  cb: (value: number) => void,
): () => void {
  const [kind, n] = source.split(':');
  const pin = Number(n);
  if (kind === 'pin') return probe.onPin(pin, (high) => cb(high ? 1 : 0));
  if (kind === 'pwm') return probe.onPwm(pin, (duty) => cb(duty));
  if (kind === 'servo') return probe.onServo(pin, (angle) => cb(angle));
  // The sheet is data from another repository: an unknown kind is ignored.
  console.warn(`bench: unknown source "${source}"`);
  return () => {};
}
