import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Level, TestResult, TestSpec } from '../../types';
import { runLevel } from '../runLevel';
import { fakeProbe } from './fakeProbe';

const level = (specs: TestSpec[], extra: Partial<Level> = {}): Level => ({
  id: 'l1',
  title: '',
  brief: '',
  hints: [],
  timeout_ms: 1000,
  tests: specs.map((spec, i) => ({ id: `t${i}`, label: '', spec })),
  ...extra,
});

/** Starts a run on a fake bench; `step(t)` moves simulated time to t, then lets the poll timer fire. */
function start(lvl: Level, t0 = 0) {
  const f = fakeProbe();
  f.advance(t0);
  const updates: TestResult[][] = [];
  const run = runLevel(lvl, f.probe, (r) => updates.push(r));
  const step = (to: number) => {
    f.advance(to);
    vi.advanceTimersByTime(50);
  };
  return { f, run, updates, step, last: () => updates.at(-1)! };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('runLevel: progress and lifecycle', () => {
  const spec: TestSpec = {
    type: 'pin_level',
    pin: 13,
    level: 'high',
    at_ms: 500,
  };

  it('goes pending -> running -> decided, on simulated time only', async () => {
    const { f, run, updates, step } = start(level([spec]));
    expect(updates).toEqual([[{ id: 't0', status: 'pending' }]]);

    vi.advanceTimersByTime(10_000); // wall clock runs, the simulation is paused
    expect(updates).toHaveLength(1);

    step(100);
    expect(updates.at(-1)).toEqual([{ id: 't0', status: 'running' }]);
    vi.advanceTimersByTime(10_000); // paused again: nothing is decided
    expect(updates).toHaveLength(2);

    f.pin(13, true, 300);
    step(501);
    expect(updates.at(-1)).toEqual([
      { id: 't0', status: 'passed', detail: 'D13 est à 1 à 500 ms' },
    ]);
    expect(await run.done).toEqual(updates.at(-1));
    expect(updates).toHaveLength(3);
  });

  it('finishes early when every test is decided, and unsubscribes', async () => {
    const { f, run, step } = start(
      level([spec, { type: 'serial_contains', text: 'ok', within_ms: 900 }]),
    );
    expect(f.listenerCount()).toBe(2);
    f.serial('ok', 10);
    step(501); // well before the 1000 ms timeout
    expect((await run.done).map((r) => r.status)).toEqual(['failed', 'passed']);
    expect(f.listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('decides everything at the timeout', async () => {
    const { run, step } = start(
      level([{ type: 'pulse', pin: 6, level: 'high', min_ms: 1, max_ms: 2 }]),
    );
    step(999);
    step(1000);
    expect((await run.done)[0].status).toBe('failed');
  });

  it('cancel unsubscribes, stops the updates and resolves with the results so far', async () => {
    const { f, run, updates, step } = start(level([spec]));
    step(100);
    run.cancel();
    expect(f.listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    f.pin(13, true, 300);
    step(2000);
    expect(updates).toHaveLength(2);
    expect(await run.done).toEqual([{ id: 't0', status: 'running' }]);
  });

  it('counts time and applies the stimulus from the moment it is called', async () => {
    const { f, run, step } = start(
      level([{ type: 'pin_level', pin: 2, level: 'high', at_ms: 150 }], {
        stimulus: [
          { at_ms: 100, pin: 2, level: 'high' },
          { at_ms: 200, pin: 2, level: 'low' },
        ],
      }),
      5000,
    );
    expect(f.sets).toEqual([
      { pin: 2, high: true, atMs: 5100 },
      { pin: 2, high: false, atMs: 5200 },
    ]);
    step(5151);
    expect((await run.done)[0]).toMatchObject({
      status: 'passed',
      detail: 'D2 est à 1 à 150 ms',
    });
  });
});

describe('runLevel: pin_level', () => {
  it('fails with the level measured', async () => {
    const { f, run, step } = start(
      level([{ type: 'pin_level', pin: 13, level: 'low', at_ms: 500 }]),
    );
    f.pin(13, true, 300);
    step(501);
    expect((await run.done)[0]).toMatchObject({
      status: 'failed',
      detail: 'D13 est à 1 à 500 ms, 0 attendu',
    });
  });

  it('takes a pin that never reported as low', async () => {
    const { run, step } = start(level([{ type: 'pin_level', pin: 13, level: 'low', at_ms: 500 }]));
    step(501);
    expect((await run.done)[0].status).toBe('passed');
  });

  it('includes a change at exactly at_ms, and waits for it', async () => {
    const { f, run, updates, step } = start(
      level([{ type: 'pin_level', pin: 13, level: 'high', at_ms: 500 }]),
    );
    step(500); // the clock is there, the event may still be on its way
    expect(updates.at(-1)![0].status).toBe('running');
    f.pin(13, true, 500);
    step(510);
    expect((await run.done)[0].status).toBe('passed');
  });

  it('reads the pin before its first report as the opposite of that report', async () => {
    const { f, run, step } = start(
      level([{ type: 'pin_level', pin: 2, level: 'high', at_ms: 100 }]),
    );
    f.pin(2, false, 300); // first report is a falling edge: it was high until then
    step(301);
    expect((await run.done)[0].status).toBe('passed');
  });
});

describe('runLevel: follows', () => {
  const follows = (extra: Partial<Extract<TestSpec, { type: 'follows' }>> = {}): TestSpec => ({
    type: 'follows',
    pin: 6,
    source: 2,
    max_delay_ms: 5,
    ...extra,
  });
  const stimulus: Level['stimulus'] = [
    { at_ms: 100, pin: 2, level: 'high' },
    { at_ms: 200, pin: 2, level: 'low' },
    { at_ms: 300, pin: 2, level: 'high' },
  ];

  it('passes at the end with the worst delay', async () => {
    const { f, run, updates, step } = start(level([follows()], { stimulus }));
    step(100);
    f.pin(6, true, 100.4);
    step(200);
    f.pin(6, false, 200.2);
    step(300);
    f.pin(6, true, 300.3);
    step(900);
    expect(updates.at(-1)![0].status).toBe('running'); // every edge must be followed: only known at the end
    step(1000);
    expect((await run.done)[0]).toEqual({
      id: 't0',
      status: 'passed',
      detail: 'D6 suit D2 avec 0,4 ms de retard',
    });
  });

  it('passes inverted', async () => {
    const { f, run, step } = start(level([follows({ invert: true })], { stimulus }));
    step(100);
    f.pin(6, false, 101);
    step(200);
    f.pin(6, true, 201);
    step(300);
    f.pin(6, false, 301);
    step(1000);
    expect((await run.done)[0]).toMatchObject({
      status: 'passed',
      detail: 'D6 suit D2 en inversé avec 1 ms de retard',
    });
  });

  it('fails as soon as an edge is not followed', async () => {
    const { run, step } = start(level([follows()], { stimulus }));
    step(100);
    step(150);
    expect((await run.done)[0]).toMatchObject({
      status: 'failed',
      detail: "D6 n'a pas suivi le passage à 1 de D2 à 100 ms",
    });
  });

  it('fails with the delay when the edge comes too late', async () => {
    const { f, run, step } = start(level([follows()], { stimulus }));
    step(100);
    f.pin(6, true, 120);
    step(150);
    expect((await run.done)[0]).toMatchObject({
      status: 'failed',
      detail: 'D6 suit D2 avec 20 ms de retard, 5 ms au plus attendu',
    });
  });

  it('fails when min_edges is not reached', async () => {
    const { f, run, step } = start(level([follows()], { stimulus: stimulus.slice(0, 1) }));
    step(100);
    f.pin(6, true, 101);
    step(1000);
    expect((await run.done)[0]).toMatchObject({
      status: 'failed',
      detail: 'seulement 1 front de D2 suivi par D6, 2 attendus',
    });
  });

  it('fails when the source never moves', async () => {
    const { run, step } = start(level([follows()]));
    step(1000);
    expect((await run.done)[0]).toMatchObject({
      status: 'failed',
      detail: "D2 n'a jamais changé d'état",
    });
  });

  it('leaves out an edge whose delay is cut by the end', async () => {
    const { f, run, step } = start(
      level([follows({ max_delay_ms: 50 })], {
        stimulus: [...stimulus.slice(0, 2), { at_ms: 980, pin: 2, level: 'high' }],
      }),
    );
    step(100);
    f.pin(6, true, 110);
    step(200);
    f.pin(6, false, 210);
    step(1000);
    expect((await run.done)[0].status).toBe('passed');
  });

  it('accepts a pin already at the expected level that stays there', async () => {
    const { f, run, step } = start(level([follows()], { stimulus: stimulus.slice(0, 2) }));
    f.pin(6, true, 0); // a report at the start gives the initial level, it is not an edge
    step(100);
    step(200);
    f.pin(6, false, 201);
    step(1000);
    expect((await run.done)[0]).toMatchObject({
      status: 'passed',
      detail: 'D6 suit D2 avec 1 ms de retard',
    });
  });

  it('does not count repeated reports of the same level as edges', async () => {
    const { f, run, step } = start(level([follows()]));
    f.pin(2, false, 0);
    f.pin(2, false, 100);
    f.pin(2, false, 200);
    step(1000);
    expect((await run.done)[0].detail).toBe("D2 n'a jamais changé d'état");
  });
});

describe('runLevel: pulse', () => {
  const pulse = (extra: Partial<Extract<TestSpec, { type: 'pulse' }>> = {}): TestSpec => ({
    type: 'pulse',
    pin: 6,
    level: 'high',
    min_ms: 400,
    max_ms: 600,
    ...extra,
  });

  it('passes as soon as the pulse is complete', async () => {
    const { f, run, step } = start(level([pulse()]));
    f.pin(6, true, 100);
    f.pin(6, false, 600);
    step(601);
    expect((await run.done)[0]).toEqual({
      id: 't0',
      status: 'passed',
      detail: 'impulsion de 500 ms sur D6',
    });
  });

  it('fails with the length of a pulse out of range', async () => {
    const { f, run, step } = start(level([pulse()]));
    f.pin(6, true, 10);
    f.pin(6, false, 960);
    step(1000);
    expect((await run.done)[0]).toMatchObject({
      status: 'failed',
      detail: 'impulsion de 950 ms sur D6, entre 400 ms et 600 ms attendu',
    });
  });

  it('fails when the pin never reaches the level', async () => {
    const { run, step } = start(level([pulse({ pin: 2, level: 'low' })]));
    step(1000);
    expect((await run.done)[0]).toMatchObject({
      status: 'failed',
      detail: "D2 n'est jamais passé à 0",
    });
  });

  it('counts the pulses asked for', async () => {
    const spec = pulse({ min_ms: 90, max_ms: 110, count: 2 });
    const one = start(level([spec]));
    one.f.pin(6, true, 100);
    one.f.pin(6, false, 200);
    one.step(1000);
    expect((await one.run.done)[0]).toMatchObject({
      status: 'failed',
      detail: '1 impulsion valide sur D6, 2 attendues',
    });

    const two = start(level([spec]));
    two.f.pin(6, true, 100);
    two.f.pin(6, false, 200);
    two.f.pin(6, true, 300);
    two.f.pin(6, false, 405);
    two.step(410);
    expect((await two.run.done)[0]).toMatchObject({
      status: 'passed',
      detail: '2 impulsions de 100 ms à 105 ms sur D6',
    });
  });

  it('does not count a pulse under way at the start or at the end', async () => {
    const begun = start(level([pulse()]));
    begun.f.pin(6, true, 0);
    begun.f.pin(6, false, 500);
    begun.step(1000);
    expect((await begun.run.done)[0].detail).toBe('aucune impulsion complète à 1 sur D6');

    const open = start(level([pulse()]));
    open.f.pin(6, true, 500);
    open.step(1000);
    expect((await open.run.done)[0].detail).toBe('aucune impulsion complète à 1 sur D6');
  });
});

describe('runLevel: serial_contains', () => {
  const spec: TestSpec = {
    type: 'serial_contains',
    text: 'Hello\n',
    within_ms: 500,
  };

  it('finds a text split across chunks, whatever the line ending', async () => {
    const { f, run, step } = start(level([spec]));
    f.serial('boot\r\nHel', 100);
    f.serial('lo\r\n', 120);
    step(130);
    expect((await run.done)[0]).toEqual({
      id: 't0',
      status: 'passed',
      detail: '« Hello » reçu à 120 ms',
    });
  });

  it('fails once within_ms is passed', async () => {
    const { f, run, step } = start(level([spec]));
    f.serial('Hello\n', 600);
    step(600);
    expect((await run.done)[0]).toMatchObject({
      status: 'failed',
      detail: '« Hello » non reçu en 500 ms',
    });
  });
});
