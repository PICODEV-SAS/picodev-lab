/**
 * Ghost CTF — content validation: two REAL Arduino cores, a hidden wire
 * protocol, and a flag the player must earn.
 * =========================================================================
 *
 * target (ghost_target.ino)  — ships as HEX, source is the secret. Beacons a
 *   framed packet ("GH0ST" + rolling nonce) on a bit-banged GPIO, answers PING
 *   with "ECHO-7A3", and releases the flag only to an AUTH frame carrying the
 *   current nonce.
 * player (ghost_player.ino)  — the reference exploit: sniffs the beacon, speaks
 *   the frame protocol, extracts PICO{...}, prints progress on USB serial.
 *
 * Two proofs:
 *  1. End to end — the exploit walks L1→L2→L3 and prints the real flag.
 *  2. The protocol is recoverable from a logic capture alone (baud + 8N1),
 *     which is exactly what the AI agent does from read_capture.
 *
 * Skips (does not fail) when arduino-cli is unavailable.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { AVRSimulator } from '@velxio/simulation/AVRSimulator';
import { PinManager } from '@velxio/simulation/PinManager';

const ARDUINO_CLI_AVAILABLE = (() => {
  const r = spawnSync('arduino-cli', ['version'], { encoding: 'utf-8' });
  return r.error == null && r.status === 0;
})();

// Compile a fixture sketch with arduino-cli, cached per (sketch, source hash).
function compileSketch(name: string, fqbn = 'arduino:avr:uno'): string {
  const sourcePath = resolve(__dirname, 'fixtures/ghost', name, `${name}.ino`);
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

  const result = spawnSync(
    'arduino-cli',
    ['compile', '--fqbn', fqbn, '--output-dir', buildDir, '--build-path', buildDir, sketchDir],
    { encoding: 'utf-8', timeout: 180_000 },
  );
  if (result.error) throw new Error(`arduino-cli not available: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`arduino-cli compile failed (exit ${result.status}):\n${result.stderr}\n${result.stdout}`);
  }

  let hex: string | null = null;
  for (const candidate of [`${name}.ino.hex`, `${name}.hex`, 'sketch.ino.hex']) {
    const p = join(buildDir, candidate);
    if (existsSync(p)) { hex = readFileSync(p, 'utf-8'); break; }
  }
  if (!hex) {
    const files = readdirSync(buildDir, { recursive: true });
    throw new Error(`Could not locate .hex in ${buildDir} (saw: ${files.join(', ')})`);
  }
  writeFileSync(hexCache, hex);
  return hex;
}

const CYCLE_BUDGET = 48_000_000; // ~3 s at 16 MHz — ample for the handshake
const FLAG = 'PICO{gh0st_on_th3_w1r3}';

describe.runIf(ARDUINO_CLI_AVAILABLE)('Ghost CTF — hidden wire protocol between two MCUs', () => {
  let TARGET_HEX: string;
  let PLAYER_HEX: string;
  beforeAll(() => {
    TARGET_HEX = compileSketch('ghost_target');
    PLAYER_HEX = compileSketch('ghost_player');
  });

  it('the reference exploit walks L1→L2→L3 and extracts the flag', () => {
    const target = new AVRSimulator(new PinManager(), 'uno');
    target.loadHex(TARGET_HEX);
    const player = new AVRSimulator(new PinManager(), 'uno');
    player.loadHex(PLAYER_HEX);

    // Bidirectional bit-bang bridge, both directions on real GPIOs:
    //   target D4 (TX) → player D3 (RX)   |   player D2 (TX) → target D3 (RX)
    target.onPinChangeWithTime = (pin: number, state: boolean | number) => {
      if (pin === 4) player.setPinState(3, state as boolean);
    };
    player.onPinChangeWithTime = (pin: number, state: boolean | number) => {
      if (pin === 2) target.setPinState(3, state as boolean);
    };

    let out = '';
    player.onSerialData = (ch: string) => { out += ch; };

    while (
      target.getCurrentCycles() < CYCLE_BUDGET &&
      player.getCurrentCycles() < CYCLE_BUDGET &&
      !out.includes(FLAG)
    ) {
      if (target.getCurrentCycles() <= player.getCurrentCycles()) target.step();
      else player.step();
    }

    expect(out).toContain('L1 token=GH0ST');   // recon: decoded the beacon
    expect(out).toContain('L2 echo=ECHO-7A3');  // framing: valid PING → PONG
    expect(out).toContain(`L3 flag=${FLAG}`);   // handshake: nonce-gated flag
  });

  it('the protocol is recoverable from a logic capture alone (baud + 8N1 decode)', () => {
    const target = new AVRSimulator(new PinManager(), 'uno');
    target.loadHex(TARGET_HEX);

    // Record the sniffed line as the bench recorder does: [t_us, level] per
    // transition of the target's bit-banged TX pin (D4).
    const edges: Array<[number, 0 | 1]> = [];
    target.onPinChangeWithTime = (pin: number, state: boolean | number) => {
      if (pin === 4) edges.push([target.getCurrentCycles() / 16, state ? 1 : 0]); // 16 MHz → µs
    };
    for (let i = 0; i < CYCLE_BUDGET && target.getCurrentCycles() < CYCLE_BUDGET; i++) target.step();

    expect(edges.length).toBeGreaterThan(20);

    // Baud = 1 / shortest pulse (one bit). 8N1: low start, 8 data LSB-first, high stop.
    let bitUs = Infinity;
    for (let i = 1; i < edges.length; i++) bitUs = Math.min(bitUs, edges[i][0] - edges[i - 1][0]);
    const baud = Math.round(1e6 / bitUs);

    const levelAt = (t: number): 0 | 1 => {
      let v: 0 | 1 = 1;
      for (const [et, ev] of edges) { if (et > t) break; v = ev; }
      return v;
    };

    const bytes: number[] = [];
    let t = edges[0][0];
    const end = edges[edges.length - 1][0];
    while (t < end) {
      if (levelAt(t) === 1) { t += bitUs / 4; continue; }       // seek a start bit
      let byte = 0;
      for (let b = 0; b < 8; b++) byte |= levelAt(t + bitUs * (1.5 + b)) << b;
      const stop = levelAt(t + bitUs * 9.5);
      if (stop === 1) bytes.push(byte);
      t += bitUs * 10;
      while (t < end && levelAt(t) === 1) t += bitUs / 4;       // resync to next start
    }

    // The agent now sees the raw frame stream and can recover the structure:
    // 0x7E start-of-frame, LEN, cmd 0x01, then the "GH0ST" token + nonce.
    const ascii = String.fromCharCode(...bytes.filter((b) => b >= 0x09 && b < 0x7f));
    expect(baud).toBeGreaterThan(4300);
    expect(baud).toBeLessThan(5300);                            // ~4800, recovered blind
    expect(bytes).toContain(0x7e);                              // framing visible
    expect(ascii).toContain('GH0ST');                          // token decoded
  });
});
