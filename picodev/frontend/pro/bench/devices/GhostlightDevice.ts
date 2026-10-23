/**
 * Ghostlight — virtual I2C industrial lighting controller (CTF target).
 * ===================================================================
 *
 * Implements the Ghostlight spec (ghostlight-spec.md): an I2C slave at 0x20 that
 * cycles lighting scenes on a timer and guards a flag behind a state-dependent
 * register flaw. This is the SIM implementation of the controller; the real bench
 * runs the equivalent Nano firmware. The register map / timing / vuln here are the
 * single source of truth the reference exploit and the level grading are written to.
 *
 * Time: there is no per-device frame hook in the engine, so the device takes a
 * `nowMs()` clock (wired to the bus master's cpu.cycles → ms, so it's deterministic
 * and testable). Scene, latch and escalation are all derived from elapsed time plus
 * the one latch event.
 *
 * I2C access is pointer-based (standard): a write sends [reg, data...]; a read sends
 * [reg] then reads N bytes from that register. `stop()` ends a transaction.
 */

import type { I2CDevice } from '@velxio/simulation/I2CBusManager';

export const GHOSTLIGHT_ADDR = 0x20;
export const SCENE_MS = 2000; // per scene; full DAY→DUSK→NIGHT→DAWN loop = 8 s
// What the device reveals when the session gave it no flag (the hub is not reached).
export const OFFLINE_FLAG = 'PICO{simulation-hors-ligne}';
export const SERVICE_MAGIC = 0xa5;

export const Scene = { DAY: 0, DUSK: 1, NIGHT: 2, DAWN: 3 } as const;

// Per-scene light levels for channels 0..3. ch3 is the NIGHT maintenance lamp.
// Distinct on/off patterns per scene so the change is unmistakable; ch3 is the
// red maintenance lamp, lit only in NIGHT (the visible tell).
const LIGHTS: Record<number, [number, number, number, number]> = {
  [Scene.DAY]: [0xff, 0xff, 0xff, 0x00],
  [Scene.DUSK]: [0xff, 0xff, 0x00, 0x00],
  [Scene.NIGHT]: [0xff, 0x00, 0x00, 0xff],
  [Scene.DAWN]: [0x00, 0xff, 0xff, 0x00],
};

const bytes = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));

export class GhostlightDevice implements I2CDevice {
  readonly address = GHOSTLIGHT_ADDR;

  private readonly nowMs: () => number;
  private readonly sceneMs: number;

  private pointer = 0;
  private pointerSet = false; // first write of a transaction is the register pointer
  private readBuf: number[] = [];
  private readPos = 0;
  private readStale = true;

  private latched = false;
  private latchLoop = -1;
  private escalated = false;

  // Bonus flaw: an unauthenticated "maintenance hold" freezes the scene machine.
  private frozen = false;
  private frozenScene = 0;
  private readonly flag: string;

  constructor(nowMs: () => number, flag: string, sceneMs: number = SCENE_MS) {
    this.nowMs = nowMs;
    this.flag = flag;
    this.sceneMs = sceneMs;
  }

  // ── time / state ──────────────────────────────────────────────────────────
  // Absolute time (not elapsed-from-first-access): when clocked off the controller
  // board's cycles, this matches the controller firmware's millis() exactly, so the
  // LEDs it drives and this device's I2C scene can't drift apart.
  private now(): number {
    return Math.max(0, this.nowMs());
  }
  private scene(): number {
    if (this.frozen) return this.frozenScene; // held: time no longer advances the scene
    return Math.floor(this.now() / this.sceneMs) % 4;
  }
  private loop(): number {
    return Math.floor(this.now() / (this.sceneMs * 4));
  }
  /** Apply the cross-cycle escalation: a latch set in NIGHT elevates at the next DAY. */
  private settle(): void {
    if (this.latched && this.loop() > this.latchLoop) {
      this.escalated = true;
      this.latched = false;
    }
  }

  levels(): [number, number, number, number] {
    return LIGHTS[this.scene()];
  }
  isEscalated(): boolean {
    this.settle();
    return this.escalated;
  }

  // ── register reads ─────────────────────────────────────────────────────────
  private regBytes(reg: number): number[] {
    this.settle();
    const sc = this.scene();
    if (reg === 0x00) {
      return [(this.escalated ? 1 : 0) | (this.latched ? 2 : 0) | (sc === Scene.NIGHT ? 4 : 0)];
    }
    if (reg === 0x01) return [sc];
    if (reg === 0x02) return bytes('LC-20');
    if (reg === 0x03) return bytes(this.escalated ? 'MAINT-OK' : 'LOCKED--');
    if (reg >= 0x10 && reg <= 0x13) return [this.levels()[reg - 0x10]];
    if (reg === 0x30) return bytes(this.frozen ? 'HELD' : 'LIVE');
    if (reg === 0x42) return bytes(sc === Scene.NIGHT ? 'SVC-OPEN' : 'SVC-LOCK');
    if (reg === 0xf0) return bytes(this.escalated ? this.flag : 'NOPE');
    return [0xff];
  }

  // ── register writes (the vuln) ──────────────────────────────────────────────
  private writeReg(reg: number, value: number): void {
    this.settle();
    if (reg === 0x30) {
      // Maintenance HOLD — no authentication (the bonus flaw): freeze the current
      // scene, so a NIGHT freeze keeps the service window open indefinitely.
      if (value) {
        this.frozenScene = Math.floor(this.now() / this.sceneMs) % 4;
        this.frozen = true;
      } else {
        this.frozen = false;
      }
      return;
    }
    if (reg === 0x42 && this.scene() === Scene.NIGHT && value === SERVICE_MAGIC) {
      this.latched = true;
      this.latchLoop = this.loop(); // escalates at the next DAY (loop boundary)
    }
    // every other register is read-only: ignored.
  }

  // ── I2CDevice interface ─────────────────────────────────────────────────────
  writeByte(value: number): boolean {
    if (!this.pointerSet) {
      this.pointer = value;
      this.pointerSet = true;
      this.readStale = true;
    } else {
      this.writeReg(this.pointer, value);
    }
    return true; // ACK
  }

  readByte(): number {
    if (this.readStale) {
      this.readBuf = this.regBytes(this.pointer);
      this.readPos = 0;
      this.readStale = false;
    }
    return this.readPos < this.readBuf.length ? this.readBuf[this.readPos++] : 0xff;
  }

  stop(): void {
    this.pointerSet = false;
    this.readStale = true;
  }
}
