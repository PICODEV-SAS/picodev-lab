/**
 * The shared recorder and the measures ported from the hub. The square wave
 * is the one of the hub's test_capture_square_wave: both must give the same numbers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CAPTURE_MAX_EDGES, createRecorder, measure, type CaptureEdge, type Recording } from '../capture';
import { logicCapture } from '../hub';
import { fakeProbe } from '../engine/__tests__/fakeProbe';
import type { SetupSheet } from '../types';

const sheet = {
  id: 'setup-a',
  probes: [
    { pin: 2, label: 'D2', kind: 'logic' },
    { pin: 6, label: 'D6', kind: 'logic' },
    { pin: 9, label: 'D9', kind: 'scope' },
  ],
} as unknown as SetupSheet;
const label = (pin: number) => `D${pin}`;

let hidden: boolean;
let visibility: Set<() => void>;
beforeEach(() => {
  vi.useFakeTimers();
  hidden = false;
  visibility = new Set();
  vi.stubGlobal('document', {
    get hidden() {
      return hidden;
    },
    addEventListener: (_type: string, f: () => void) => visibility.add(f),
    removeEventListener: (_type: string, f: () => void) => visibility.delete(f),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('measures, as the hub', () => {
  it('gives the hub’s numbers on its square wave', () => {
    // D2: 10 ms period, high 3 ms from 1 ms on; D6: one falling edge at 500 ms; D2 repeats its level once.
    const edges = [
      ...Array.from({ length: 100 }, (_, k): CaptureEdge => [1000 + 10000 * k, 2, 1]),
      ...Array.from({ length: 100 }, (_, k): CaptureEdge => [4000 + 10000 * k, 2, 0]),
      [500000, 6, 0],
      [492000, 2, 1],
    ].sort((a, b) => a[0] - b[0]) as CaptureEdge[];
    edges.push([1_000_001, 2, 1]); // past the duration: dropped
    const res = measure({ pins: [2, 6], durationMs: 1000, initial: { 2: 0, 6: 1 }, edges }, label);
    expect(res.truncated).toBe(false);
    expect(res.end).toBe(1_000_000);
    expect(res.channels).toEqual([
      {
        pin: 2, label: 'D2', edges: 200, initial: 0, high_ms: 300.0, low_ms: 700.0,
        period_ms: 10.0, duty: 0.3,
        pulses: { high: { count: 100, min_ms: 3.0, max_ms: 3.0 }, low: { count: 99, min_ms: 7.0, max_ms: 7.0 } },
      },
      {
        pin: 6, label: 'D6', edges: 1, initial: 1, high_ms: 500.0, low_ms: 500.0,
        pulses: { high: { count: 0, min_ms: null, max_ms: null }, low: { count: 0, min_ms: null, max_ms: null } },
      },
    ]);
  });

  it('is not periodic past 5 % of jitter, and a truncated window ends at the last edge kept', () => {
    const jitter: CaptureEdge[] = [[0, 2, 1], [5, 2, 0], [100, 2, 1], [105, 2, 0], [220, 2, 1], [225, 2, 0]];
    expect(measure({ pins: [2], durationMs: 1, initial: { 2: 0 }, edges: jitter }, label).channels[0].period_ms).toBeUndefined();

    const edges = Array.from({ length: CAPTURE_MAX_EDGES + 1 }, (_, i): CaptureEdge => [i + 1, 2, i % 2 === 0 ? 1 : 0]);
    const res = measure({ pins: [2], durationMs: 10_000, initial: { 2: 0 }, edges }, label);
    expect(res.truncated).toBe(true);
    expect(res.end).toBe(CAPTURE_MAX_EDGES);
    expect(res.channels[0].edges).toBe(CAPTURE_MAX_EDGES);
    expect(res.channels[0].period_ms).toBe(0.002);
  });
});

describe('recorder, shared by the page and the agent', () => {
  it('records a square wave the page then measures (D6 3 ms high, 7 ms low)', async () => {
    const fake = fakeProbe();
    const recorder = createRecorder(sheet, fake.probe);
    fake.advance(2);
    let rec: Recording | undefined;
    recorder.record([2, 6], 1000, (r) => (rec = r), () => {});
    expect(recorder.busy()).toBe(true);
    for (let k = 0; k < 120; k++) {
      fake.pin(6, true, 2.5 + 10 * k);
      fake.pin(6, false, 5.5 + 10 * k);
    }
    await vi.advanceTimersByTimeAsync(50);
    expect(rec && recorder.busy()).toBe(false);
    const d6 = measure(rec!, label).channels[1];
    expect(d6).toMatchObject({ edges: 200, period_ms: 10, duty: 0.3, pulses: { high: { count: 100, min_ms: 3, max_ms: 3 } } });
    expect(rec!.edges[0]).toEqual([500, 6, 1]);
    expect(rec!.t0Ms).toBe(2); // where the window sits on the page's simulated clock
    recorder.close();
    expect(fake.listenerCount()).toBe(0);
  });

  it('lets the agent’s capture win over the page’s, and tells the page why it stopped', async () => {
    const fake = fakeProbe();
    const recorder = createRecorder(sheet, fake.probe);
    const sent: Array<Record<string, unknown>> = [];
    const agent = logicCapture(recorder, () => true, (m) => !!sent.push(m as Record<string, unknown>));
    const why: string[] = [];
    const page = () => recorder.record([2, 6], 1000, () => why.push('done'), (w) => why.push(w));

    page();
    agent.start({ capture: 'a', pins: [2], duration_ms: 5 }); // the page's recording is replaced
    expect(why).toEqual(['replaced']);
    expect(recorder.busy()).toBe(true); // the page checks this before recording: the agent's is never interrupted
    fake.advance(6);
    await vi.advanceTimersByTimeAsync(50);
    expect(sent).toEqual([{ type: 'capture_chunk', capture: 'a', seq: 0, initial: { 2: 0 }, t0_ms: 0, edges: [], last: true }]);

    page();
    hidden = true;
    visibility.forEach((f) => f());
    page();
    recorder.halted('stop');
    page();
    recorder.halted('relaunch');
    expect(why).toEqual(['replaced', 'hidden', 'stop', 'relaunch']);
    expect(sent.filter((m) => m.type === 'capture_error')).toEqual([]);
    agent.close();
    recorder.close();
  });
});
