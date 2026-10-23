/**
 * I2C scope shim — end-to-end: a REAL AVR running `Wire` against the Ghostlight
 * device produces a decodable I2C waveform on SDA/SCL (pins 18/19), i.e. the logic
 * analyzer can now sniff the bus. This is the engine support that makes L1 real.
 *
 * Skips when arduino-cli is unavailable.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { AVRSimulator } from '@velxio/simulation/AVRSimulator';
import { PinManager } from '@velxio/simulation/PinManager';
import { GhostlightDevice, OFFLINE_FLAG as FLAG } from '../GhostlightDevice';
import { I2C_SDA_PIN, I2C_SCL_PIN } from '@velxio/simulation/I2cScopeShim';

const ARDUINO_CLI_AVAILABLE = (() => {
  const r = spawnSync('arduino-cli', ['version'], { encoding: 'utf-8' });
  return r.error == null && r.status === 0;
})();

function compileSketch(name: string, fqbn = 'arduino:avr:uno'): string {
  const sourcePath = resolve(__dirname, 'fixtures/ghostlight', name, `${name}.ino`);
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
  if (r.status !== 0) throw new Error(`compile failed: ${r.stderr}`);
  for (const c of [`${name}.ino.hex`, `${name}.hex`, 'sketch.ino.hex']) {
    const p = join(buildDir, c);
    if (existsSync(p)) { const h = readFileSync(p, 'utf-8'); writeFileSync(hexCache, h); return h; }
  }
  throw new Error(`no hex (${readdirSync(buildDir).join(', ')})`);
}

type Edge = { t: number; pin: number; v: 0 | 1 };
function decodeI2C(edges: Edge[]) {
  edges = [...edges].sort((a, b) => a.t - b.t);
  let sda = 1, scl = 1, inFrame = false, bitCount = 0, cur = 0, first = true;
  const frames: Array<{ addr: number; rw: 'W' | 'R'; data: number[] }> = [];
  let frame: { addr: number; rw: 'W' | 'R'; data: number[] } | null = null;
  for (const e of edges) {
    const ps = scl, pd = sda;
    if (e.pin === I2C_SDA_PIN) sda = e.v; else scl = e.v;
    if (scl === 1 && pd === 1 && sda === 0 && ps === 1) {
      if (frame) frames.push(frame);
      inFrame = true; bitCount = 0; cur = 0; first = true; frame = { addr: 0, rw: 'W', data: [] };
      continue;
    }
    if (scl === 1 && pd === 0 && sda === 1 && ps === 1) {
      if (frame) frames.push(frame);
      inFrame = false; frame = null; continue;
    }
    if (inFrame && ps === 0 && scl === 1) {
      if (bitCount < 8) { cur = (cur << 1) | sda; bitCount++; }
      else {
        if (first) { frame!.addr = cur >> 1; frame!.rw = (cur & 1) ? 'R' : 'W'; first = false; }
        else frame!.data.push(cur);
        bitCount = 0; cur = 0;
      }
    }
  }
  return frames;
}

describe.runIf(ARDUINO_CLI_AVAILABLE)('I2C scope shim — real Wire traffic is sniffable on SDA/SCL', () => {
  let EXPLOIT_HEX: string;
  beforeAll(() => { EXPLOIT_HEX = compileSketch('exploit'); });

  it('the analyzer captures decodable I2C from a real Wire exploit', () => {
    const player = new AVRSimulator(new PinManager(), 'uno');
    player.loadHex(EXPLOIT_HEX);
    const dev = new GhostlightDevice(() => player.getCurrentCycles() / 16000, FLAG, 300);
    player.addI2CDevice(dev);

    const edges: Edge[] = [];
    player.onPinChangeWithTime = (pin: number, state: boolean, timeMs: number) => {
      if (pin === I2C_SDA_PIN || pin === I2C_SCL_PIN) edges.push({ t: timeMs, pin, v: state ? 1 : 0 });
    };
    let out = '';
    player.onSerialData = (ch: string) => { out += ch; };

    let steps = 0;
    while (player.getCurrentCycles() < 120_000_000 && !out.includes(`L4 flag=${FLAG}`)) {
      player.step();
      if ((++steps & 0x3fff) === 0 && out.includes(`L4 flag=${FLAG}`)) break;
    }

    // The analyzer saw plenty of real I2C edges on the bus.
    expect(edges.length).toBeGreaterThan(50);
    const frames = decodeI2C(edges);
    expect(frames.length).toBeGreaterThan(20);

    // The bus is overwhelmingly the controller at 0x20 (a few boundary/first-txn
    // glitches are expected, as with any real analyzer decoder).
    const addr20 = frames.filter((f) => f.addr === 0x20);
    // Overwhelmingly the controller at 0x20 (a few boundary/first-txn glitches
    // expected, as with any real analyzer decoder).
    expect(addr20.length / frames.length).toBeGreaterThan(0.9);

    // Specific transactions decode correctly off the captured waveform:
    const asStr = (d: number[]) => String.fromCharCode(...d);
    // register reads are sniffable — SERVICE returns "SVC-LOCK"/"SVC-OPEN"
    expect(addr20.some((f) => f.rw === 'R' && /^SVC-(LOCK|OPEN)$/.test(asStr(f.data)))).toBe(true);
    // the attack surface is sniffable — writes targeting the SERVICE register (0x42)
    expect(addr20.some((f) => f.rw === 'W' && f.data[0] === 0x42)).toBe(true);
  });
});
