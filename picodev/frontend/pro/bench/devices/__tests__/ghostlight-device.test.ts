/**
 * Ghostlight virtual device — spec/logic validation (no engine, no CPU).
 * Drives the device through the register protocol with a mock clock and asserts
 * the vuln gates hold: the flag only comes out via the intended exploit path.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { GhostlightDevice, OFFLINE_FLAG, SCENE_MS, SERVICE_MAGIC, Scene } from '../GhostlightDevice';
import { getVirtualI2cDevice } from '..';

const FLAG = 'PICO{test_1234}';

// A mutable clock the device reads via nowMs().
function makeDev() {
  const clock = { ms: 0 };
  const dev = new GhostlightDevice(() => clock.ms, FLAG);
  return { dev, clock };
}

// Simulate an I2C "read N bytes from register" transaction.
function readReg(dev: GhostlightDevice, reg: number, n: number): number[] {
  dev.writeByte(reg); // pointer
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(dev.readByte());
  dev.stop();
  return out;
}
const readStr = (dev: GhostlightDevice, reg: number, n: number) =>
  String.fromCharCode(...readReg(dev, reg, n));

// Simulate an I2C "write value to register" transaction.
function writeReg(dev: GhostlightDevice, reg: number, value: number) {
  dev.writeByte(reg);
  dev.writeByte(value);
  dev.stop();
}

// Put the clock in the middle of a given scene within a given loop.
const atScene = (loop: number, scene: number) => loop * 4 * SCENE_MS + scene * SCENE_MS + SCENE_MS / 2;

describe('Ghostlight device — recon & state', () => {
  it('L1: DEVID reads LC-20', () => {
    const { dev } = makeDev();
    expect(readStr(dev, 0x02, 5)).toBe('LC-20');
  });

  it('SCENE register tracks the timer', () => {
    const { dev, clock } = makeDev();
    clock.ms = atScene(0, Scene.DAY);
    expect(readReg(dev, 0x01, 1)[0]).toBe(Scene.DAY);
    clock.ms = atScene(0, Scene.NIGHT);
    expect(readReg(dev, 0x01, 1)[0]).toBe(Scene.NIGHT);
  });

  it('L2: SERVICE reads SVC-OPEN only during NIGHT', () => {
    const { dev, clock } = makeDev();
    clock.ms = atScene(0, Scene.DAY);
    expect(readStr(dev, 0x42, 8)).toBe('SVC-LOCK');
    clock.ms = atScene(0, Scene.NIGHT);
    expect(readStr(dev, 0x42, 8)).toBe('SVC-OPEN');
  });

  it('maintenance lamp (light ch3) is on only during NIGHT', () => {
    const { dev, clock } = makeDev();
    clock.ms = atScene(0, Scene.DAY);
    expect(readReg(dev, 0x13, 1)[0]).toBe(0x00);
    clock.ms = atScene(0, Scene.NIGHT);
    expect(readReg(dev, 0x13, 1)[0]).toBe(0xff);
  });
});

describe('Ghostlight device — the exploit path', () => {
  it('L3+L4: NIGHT write → next-DAY escalation → flag', () => {
    const { dev, clock } = makeDev();

    // Before the exploit: locked.
    clock.ms = atScene(0, Scene.DAY);
    expect(readStr(dev, 0x03, 8)).toBe('LOCKED--');
    expect(readStr(dev, 0xf0, 4)).toBe('NOPE');

    // L3: write the magic byte to SERVICE during NIGHT (sets the latch).
    clock.ms = atScene(0, Scene.NIGHT);
    writeReg(dev, 0x42, SERVICE_MAGIC);
    // Not escalated yet — still the same loop.
    expect(dev.isEscalated()).toBe(false);
    expect(readStr(dev, 0xf0, 4)).toBe('NOPE');

    // Advance into the NEXT loop's DAY → escalation settles.
    clock.ms = atScene(1, Scene.DAY);
    expect(readStr(dev, 0x03, 8)).toBe('MAINT-OK'); // L3 token
    expect(readStr(dev, 0xf0, FLAG.length)).toBe(FLAG); // L4 flag
  });
});

describe('Ghostlight device — the gates hold (no cheating)', () => {
  it('writing SERVICE outside NIGHT does nothing', () => {
    const { dev, clock } = makeDev();
    clock.ms = atScene(0, Scene.DAY);
    writeReg(dev, 0x42, SERVICE_MAGIC);
    clock.ms = atScene(1, Scene.DAY);
    expect(dev.isEscalated()).toBe(false);
    expect(readStr(dev, 0xf0, 4)).toBe('NOPE');
  });

  it('wrong magic byte during NIGHT does nothing', () => {
    const { dev, clock } = makeDev();
    clock.ms = atScene(0, Scene.NIGHT);
    writeReg(dev, 0x42, 0x00);
    clock.ms = atScene(1, Scene.DAY);
    expect(dev.isEscalated()).toBe(false);
  });

  it('latch set but still same loop → no flag yet', () => {
    const { dev, clock } = makeDev();
    clock.ms = atScene(0, Scene.NIGHT);
    writeReg(dev, 0x42, SERVICE_MAGIC);
    clock.ms = atScene(0, Scene.DAWN); // later, but same loop
    expect(readStr(dev, 0xf0, 4)).toBe('NOPE');
  });

  it('BONUS L5: maintenance HOLD (0x30) freezes the scene', () => {
    const { dev, clock } = makeDev();
    // LIVE while unfrozen; scene tracks the clock.
    clock.ms = atScene(0, Scene.NIGHT);
    expect(readStr(dev, 0x30, 4)).toBe('LIVE');
    expect(readReg(dev, 0x01, 1)[0]).toBe(Scene.NIGHT);

    // Hold during NIGHT: scene is pinned to NIGHT even as time marches on.
    writeReg(dev, 0x30, 1);
    expect(readStr(dev, 0x30, 4)).toBe('HELD');
    clock.ms = atScene(3, Scene.DAY); // would be DAY if live
    expect(readReg(dev, 0x01, 1)[0]).toBe(Scene.NIGHT);
    expect(readStr(dev, 0x42, 8)).toBe('SVC-OPEN'); // window stays open → exploit any time
    expect(readReg(dev, 0x13, 1)[0]).toBe(0xff); // maintenance lamp stuck on

    // Release: scene resumes from real time.
    writeReg(dev, 0x30, 0);
    expect(readStr(dev, 0x30, 4)).toBe('LIVE');
    expect(readReg(dev, 0x01, 1)[0]).toBe(Scene.DAY);
  });

  it('the flag never appears without the latch', () => {
    const { dev, clock } = makeDev();
    for (let loop = 0; loop < 3; loop++)
      for (const s of [Scene.DAY, Scene.DUSK, Scene.NIGHT, Scene.DAWN]) {
        clock.ms = atScene(loop, s);
        expect(readStr(dev, 0xf0, 4)).toBe('NOPE');
      }
  });
});

describe('Ghostlight device � the flag comes from the session', () => {
  const reveal = (make: (now: () => number) => GhostlightDevice, n: number) => {
    const clock = { ms: atScene(0, Scene.NIGHT) };
    const dev = make(() => clock.ms);
    writeReg(dev, 0x42, SERVICE_MAGIC);
    clock.ms = atScene(1, Scene.DAY);
    return readStr(dev, 0xf0, n);
  };

  it('reveals the flag it was given', () => {
    expect(reveal((now) => new GhostlightDevice(now, 'PICO{test_1234}'), 15)).toBe('PICO{test_1234}');
  });

  it('the registry feeds it secrets.flag, else the offline flag', () => {
    const make = getVirtualI2cDevice('ghostlight')!;
    expect(reveal((now) => make(now, { flag: 'PICO{from_hub}' }) as GhostlightDevice, 14)).toBe('PICO{from_hub}');
    expect(reveal((now) => make(now, {}) as GhostlightDevice, OFFLINE_FLAG.length)).toBe(OFFLINE_FLAG);
  });

  it('the bundle holds no flag literal', () => {
    const source = readFileSync(new URL('../GhostlightDevice.ts', import.meta.url), 'utf8');
    expect(source.split('PICO{').length - 1).toBe(1);
    expect(source).toContain(`'${OFFLINE_FLAG}'`);
  });
});
