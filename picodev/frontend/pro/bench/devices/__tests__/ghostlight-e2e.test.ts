/**
 * Ghostlight — end-to-end proof: a REAL AVR running real exploit firmware solves
 * the challenge over real I2C against the virtual GhostlightDevice.
 *
 * This is the challenge's equivalent of the Stage-0 proof: it shows the whole thing
 * is solvable by firmware (not just by the JS logic test), that avr8js's Wire master
 * drives our virtual slave, and that the four level tokens come out in order.
 *
 * Uses a short scene duration so the ~1.5-loop exploit runs in ~1 s of wall time.
 * Skips (does not fail) when arduino-cli is unavailable.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { AVRSimulator } from '@velxio/simulation/AVRSimulator';
import { PinManager } from '@velxio/simulation/PinManager';
import { GhostlightDevice, OFFLINE_FLAG as FLAG } from '../GhostlightDevice';

const ARDUINO_CLI_AVAILABLE = (() => {
  const r = spawnSync('arduino-cli', ['version'], { encoding: 'utf-8' });
  return r.error == null && r.status === 0;
})();

function compileSketch(name: string, fqbn = 'arduino:avr:uno'): string {
  const sourcePath = resolve(__dirname, 'fixtures/ghostlight', name, `${name}.ino`);
  if (!existsSync(sourcePath)) throw new Error(`Sketch source missing: ${sourcePath}`);
  const source = readFileSync(sourcePath, 'utf-8');
  let hash = 0;
  for (let i = 0; i < source.length; i++) hash = (hash * 31 + source.charCodeAt(i)) | 0;
  const hexCache = join(tmpdir(), `velxio-${name}-${fqbn.replace(/[^a-z0-9]/gi, '_')}-${hash >>> 0}.hex`);
  if (existsSync(hexCache)) return readFileSync(hexCache, 'utf-8');
  const work = mkdtempSync(join(tmpdir(), `velxio-${name}-`));
  const sketchDir = join(work, name);
  mkdirSync(sketchDir);
  writeFileSync(join(sketchDir, `${name}.ino`), source);
  const buildDir = join(work, 'build');
  mkdirSync(buildDir);
  const r = spawnSync('arduino-cli',
    ['compile', '--fqbn', fqbn, '--output-dir', buildDir, '--build-path', buildDir, sketchDir],
    { encoding: 'utf-8', timeout: 180_000 });
  if (r.error) throw new Error(`arduino-cli not available: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`compile failed (${r.status}):\n${r.stderr}\n${r.stdout}`);
  let hex: string | null = null;
  for (const c of [`${name}.ino.hex`, `${name}.hex`, 'sketch.ino.hex']) {
    const p = join(buildDir, c);
    if (existsSync(p)) { hex = readFileSync(p, 'utf-8'); break; }
  }
  if (!hex) throw new Error(`no hex in ${buildDir} (${readdirSync(buildDir).join(', ')})`);
  writeFileSync(hexCache, hex);
  return hex;
}

const CYCLE_BUDGET = 120_000_000; // ample for ~1.5 short-scene loops

describe.runIf(ARDUINO_CLI_AVAILABLE)('Ghostlight — real AVR exploit vs virtual controller', () => {
  let EXPLOIT_HEX: string;
  beforeAll(() => { EXPLOIT_HEX = compileSketch('exploit'); });

  it('the reference exploit extracts the flag over real I2C', () => {
    const player = new AVRSimulator(new PinManager(), 'uno');
    player.loadHex(EXPLOIT_HEX);

    // Virtual controller on the player's I2C bus; scene clock = player sim time.
    // 300 ms scenes so the full exploit (NIGHT write → next-DAY escalation) is quick.
    const dev = new GhostlightDevice(() => player.getCurrentCycles() / 16000, FLAG, 300);
    player.addI2CDevice(dev);

    let out = '';
    player.onSerialData = (ch: string) => { out += ch; };

    let steps = 0;
    while (player.getCurrentCycles() < CYCLE_BUDGET && !out.includes(`L4 flag=${FLAG}`)) {
      player.step();
      if ((++steps & 0x3fff) === 0 && out.includes(`L4 flag=${FLAG}`)) break;
    }

    expect(out).toContain('L1 token=LC-20');
    expect(out).toContain('L2 svc=SVC-OPEN');
    expect(out).toContain('L3 esc=MAINT-OK');
    expect(out).toContain(`L4 flag=${FLAG}`);
  });
});
