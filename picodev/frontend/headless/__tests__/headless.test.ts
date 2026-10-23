import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SetupSheet, TestSpec } from '../../pro/bench/types';
import { runHeadless } from '../headless';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const hex = read('./blink/blink.hex');

const sheet = (specs: TestSpec[]): SetupSheet =>
  ({
    schema: 1,
    id: 'fixture',
    board: { kind: 'arduino-nano', fqbn: 'arduino:avr:nano' },
    couplings: [],
    levels: [
      {
        id: 'l1',
        title: '',
        brief: '',
        hints: [],
        timeout_ms: 2500,
        stimulus: [
          { at_ms: 1000, pin: 10, level: 'low' },
          { at_ms: 1600, pin: 10, level: 'high' },
        ],
        tests: specs.map((spec, i) => ({ id: `t${i}`, label: `test ${i}`, spec })),
      },
    ],
  }) as unknown as SetupSheet;

describe('runHeadless', () => {
  it('plays a level on the compiled program', async () => {
    const report = await runHeadless(
      sheet([
        { type: 'pulse', pin: 13, level: 'high', min_ms: 400, max_ms: 600, count: 2 },
        { type: 'serial_contains', text: 'ready', within_ms: 200 },
        { type: 'pin_level', pin: 2, level: 'low', at_ms: 500 },
        { type: 'follows', pin: 2, source: 10, max_delay_ms: 5, invert: true },
      ]),
      'l1',
      hex,
    );
    expect(report.tests.filter((t) => t.status !== 'passed')).toEqual([]);
    expect(report).toMatchObject({ setup: 'fixture', level: 'l1', passed: true });
  });

  it('fails a test the program does not meet', async () => {
    const report = await runHeadless(
      sheet([{ type: 'pulse', pin: 13, level: 'high', min_ms: 100, max_ms: 200 }]),
      'l1',
      hex,
      'en',
    );
    expect(report.passed).toBe(false);
    expect(report.tests[0]).toMatchObject({ status: 'failed', label: 'test 0' });
  });

  it('refuses an unknown level', async () => {
    await expect(runHeadless(sheet([]), 'l2', hex)).rejects.toThrow('no level "l2"');
  });

  it('bundles the avr8js of the editor', () => {
    const pkg = (path: string) => JSON.parse(read(path));
    expect(pkg('../package.json').devDependencies.avr8js).toBe(pkg('../../../../frontend/package.json').dependencies.avr8js);
  });
});
