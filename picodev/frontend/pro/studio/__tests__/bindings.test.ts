// @vitest-environment jsdom
/** « Liaisons » and the back-office token (architecture v0.20, items 7 and 8). */
import { describe, expect, it } from 'vitest';
import { mountScene } from '../../bench/engine/scene';
import { adminHeaders, bindingsOf, boardPins, loadToken, saveToken, shapeBinding, TOKEN_KEY, withBindings } from '../draft';
import { createPreviewProbe, followSim, servoAngle, type SimPins } from '../preview';

const wire = (pinName: string, componentId = 'arduino-uno') => ({ id: pinName, start: { componentId, pinName }, end: { componentId: 'led', pinName: 'A' }, color: '#000' });

describe('bindings in the rest of setup.json', () => {
  it('lists the numbered board pins of the circuit, as check.py reads them', () => {
    const circuit = { components: [], wires: [wire('13'), wire('D9'), wire('A0'), wire('GND'), wire('5V'), wire('9'), wire('7', 'other')] };
    expect(boardPins(circuit, 'arduino-uno')).toEqual([9, 13, 14]);
    expect(boardPins(circuit, 'arduino-nano')).toEqual([]);
  });

  it('reads and writes scene.bindings, keeping the rest', () => {
    const rest = JSON.stringify({ summary: 's', scene: { svg: 'scene.svg', bindings: [{ target: 'a' }, 'junk'] }, levels: [] });
    expect(bindingsOf(rest)).toEqual([{ target: 'a' }, {}]);
    expect(bindingsOf('{"summary":""}')).toBeNull(); // no scene
    expect(bindingsOf('{')).toBeNull();
    const b = { target: 'led', source: 'pin:13', effect: 'visible', when: 'high' };
    const out = JSON.parse(withBindings(rest, [b]));
    expect(out).toEqual({ summary: 's', scene: { svg: 'scene.svg', bindings: [b] }, levels: [] });
    expect(withBindings('{', [b])).toBe('{');
  });

  it('shapes a binding to the keys of its effect, keeping what fits', () => {
    const rotate = { target: 'needle', source: 'servo:9', effect: 'rotate', min: 0, max: 180, from: -90, to: 90, origin: [300, 150] };
    expect(shapeBinding(rotate, 'translate')).toEqual({ target: 'needle', source: 'servo:9', effect: 'translate', min: 0, max: 180, dx: 0, dy: 0 });
    expect(shapeBinding(rotate, 'spin')).toEqual({ target: 'needle', source: 'servo:9', effect: 'spin', threshold: 0.5, origin: [300, 150] });
    expect(Object.keys(shapeBinding({ target: 't', source: 'pwm:3' }, 'fill'))).toEqual(['target', 'source', 'effect', 'on', 'off']);
  });
});

describe('the preview', () => {
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><circle id="led" r="4"/><rect id="arm" width="2" height="2"/></svg>';

  it('drives the bench reader from set(), and a new mount gets the last values', () => {
    const probe = createPreviewProbe();
    const box = document.createElement('div');
    const bindings = [
      { target: 'led', source: 'pin:13', effect: 'fill', on: 'red', off: 'black' },
      { target: 'arm', source: 'servo:9', effect: 'rotate', min: 0, max: 180, from: 0, to: 90 },
    ] as Parameters<typeof mountScene>[2];
    let stop = mountScene(box, SVG, bindings, probe);
    const led = () => box.querySelector<SVGElement>('#led')!;
    expect(led().style.fill).toBe('black');
    probe.set('pin:13', 1);
    probe.set('servo:9', 180);
    expect(led().style.fill).toBe('red');
    stop();
    stop = mountScene(box, SVG, bindings, probe);
    expect(led().style.fill).toBe('red');
    expect(box.querySelector('#arm')!.getAttribute('transform')).toBe('rotate(90 0 0)');
    probe.clear();
    expect(led().style.fill).toBe('black');
    stop();
  });

  it('follows the simulation: levels, duty, servo pulses on the simulated clock', () => {
    const pinCbs = new Map<number, (pin: number, high: boolean) => void>();
    const pwmCbs = new Map<number, (pin: number, duty: number) => void>();
    const pins: SimPins = {
      onPinChange: (p, cb) => (pinCbs.set(p, cb), () => pinCbs.delete(p)),
      onPwmChange: (p, cb) => (pwmCbs.set(p, cb), () => pwmCbs.delete(p)),
      getPinState: (p) => p === 13,
      getPwmValue: () => 0.25,
    };
    let cycles = 0;
    const sim = { getCurrentCycles: () => cycles, getClockHz: () => 16_000_000 };
    const probe = createPreviewProbe();
    const seen: Record<string, number> = {};
    probe.onPin(13, (h) => (seen.pin = h ? 1 : 0));
    probe.onPwm(3, (d) => (seen.pwm = d));
    probe.onServo(9, (a) => (seen.servo = a));
    const off = followSim(pins, sim, ['pin:13', 'pwm:3', 'servo:9'], probe);
    expect(seen).toEqual({ pin: 1, pwm: 0.25 });
    pinCbs.get(13)!(13, false);
    pwmCbs.get(3)!(3, 0.5);
    pinCbs.get(9)!(9, true);
    cycles += 16 * 1472; // 1472 µs: 90°
    pinCbs.get(9)!(9, false);
    expect(seen).toEqual({ pin: 0, pwm: 0.5, servo: 90 });
    off();
    expect(pinCbs.size + pwmCbs.size).toBe(0);
  });

  it('reads a servo pulse as Servo.h writes it', () => {
    expect(servoAngle(544)).toBe(0);
    expect(servoAngle(2400)).toBe(180);
    expect(servoAngle(5000)).toBeNull();
  });
});

describe('the back-office token', () => {
  it('stays in sessionStorage and goes as a Bearer header', () => {
    expect(loadToken()).toBe('');
    saveToken('x'.repeat(40));
    expect(sessionStorage.getItem(TOKEN_KEY)).toBe('x'.repeat(40));
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(adminHeaders(` ${loadToken()} `)).toEqual({ 'Content-Type': 'application/json', Authorization: `Bearer ${'x'.repeat(40)}` });
    saveToken('');
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(adminHeaders('')).toEqual({ 'Content-Type': 'application/json' });
  });
});
