/**
 * Plays one level of a setup sheet against a compiled program, in Node:
 * Velxio's AVRSimulator (avr8js) with the bench's own probe, couplings and
 * test runner, wired in the order of BenchPage's launch(). Nothing of the
 * test logic is here.
 *
 * What the browser has and this does not: the circuit is not solved (no
 * SPICE), so the inputs of the board come only from the couplings, the
 * level's stimulus and the pull-ups the sketch enables. That is what the
 * level tests rely on; a level that needs a part of the circuit to drive a
 * pin (a potentiometer, a sensor) cannot be played here.
 */
import { AVRSimulator } from '../../../frontend/src/simulation/AVRSimulator';
import { PinManager } from '../../../frontend/src/simulation/PinManager';
import { applyCouplings, runLevel } from '../pro/bench/engine';
import { createProbe, type ProbedSim } from '../pro/bench/probe';
import type { Lang, SetupSheet, TestResult } from '../pro/bench/types';

/** Velxio's board kinds that run on its AVRSimulator (see createSimulator in the store). */
const VARIANTS: Record<string, 'uno' | 'mega' | 'tiny85'> = {
  'arduino-uno': 'uno',
  'arduino-nano': 'uno',
  'arduino-mega': 'mega',
  attiny85: 'tiny85',
};

// The simulator paces itself on animation frames: here a frame comes as soon
// as the event loop is free (so runLevel's poll timer runs between frames)
// and claims 50 ms, the most one frame runs. Simulated time runs as fast as
// the CPU allows.
let frameMs = 0;
globalThis.requestAnimationFrame ??= (cb) =>
  setImmediate(() => cb((frameMs += 50))) as unknown as number;
globalThis.cancelAnimationFrame ??= (id) => clearImmediate(id as unknown as NodeJS.Immediate);

export interface LevelReport {
  setup: string;
  level: string;
  passed: boolean;
  tests: Array<TestResult & { label: string }>;
}

export async function runHeadless(
  sheet: SetupSheet,
  levelId: string,
  hex: string,
  lang: Lang = 'fr',
): Promise<LevelReport> {
  const level = sheet.levels.find((l) => l.id === levelId);
  if (!level) {
    throw new Error(`no level "${levelId}" in ${sheet.id} (${sheet.levels.map((l) => l.id).join(', ') || 'none'})`);
  }
  const variant = VARIANTS[sheet.board.kind];
  if (!variant) throw new Error(`board "${sheet.board.kind}" does not run headless (AVR boards only)`);

  const sim = new AVRSimulator(new PinManager(), variant);
  // No circuit, so nothing to keep the forced pins away from.
  const probe = createProbe(sim as unknown as ProbedSim, sim.pinManager, { claim() {}, releaseAll() {} });
  sim.loadHex(hex);
  probe.reset();
  const uncouple = applyCouplings(sheet.couplings ?? [], probe);
  sim.start();
  const final = await runLevel(level, probe, () => {}, lang).done;
  sim.stop();
  uncouple();
  probe.dispose();

  return {
    setup: sheet.id,
    level: level.id,
    passed: final.length > 0 && final.every((r) => r.status === 'passed'),
    tests: final.map((r, i) => ({ ...r, label: sheet.i18n?.[lang]?.tests?.[r.id] ?? level.tests[i].label })),
  };
}
