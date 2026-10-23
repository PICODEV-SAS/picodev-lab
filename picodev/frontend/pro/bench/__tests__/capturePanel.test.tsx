// @vitest-environment jsdom
/** The capture panel during a real turn (v0.20): asks the bench, shows what the hub relays. */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { Recorder } from '../capture';
import { CapturePanel, type BenchSide } from '../CapturePanel';
import type { BenchCapture } from '../hub';
import { setLang } from '../lang';
import type { SetupSheet } from '../types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('asks the bench for a capture and measures the one relayed, the simulation stopped', () => {
  setLang('fr', () => {});
  const box = document.createElement('div');
  const root = createRoot(box);
  const recorder = { record: vi.fn(), busy: () => false } as unknown as Recorder;
  const probes = [{ pin: 2, label: 'PWM', kind: 'logic' }] as SetupSheet['probes'];
  const request = vi.fn(() => true);
  const show = (capture: BenchCapture | null) => {
    const bench: BenchSide = { capture, request };
    act(() => root.render(<CapturePanel recorder={recorder} probes={probes} running={false} bench={bench} />));
  };
  show(null);
  const button = box.querySelector('button')!;
  expect(button.disabled).toBe(false); // nothing runs in the browser, the bench does
  act(() => button.click());
  expect(request).toHaveBeenCalledWith([2], 1000);
  expect(recorder.record).not.toHaveBeenCalled();
  expect(box.textContent).toContain('Capture demandée au banc');
  // The bench records: the panel says nothing of a simulation.
  expect(box.textContent).toContain('Durée de capture du banc');
  expect(box.textContent).not.toContain('simulation');

  // The hub refuses: the panel leaves « Capture demandée » and says why, in the visitor's words.
  show({ phase: 'refused', why: 'busy' });
  expect(box.textContent).not.toContain('Capture demandée');
  expect(box.textContent).toContain('une capture est déjà en cours');
  show({ phase: 'refused', why: 'refused' });
  expect(box.textContent).toContain('pas pendant votre tour');
  act(() => button.click());
  expect(box.textContent).toContain('Capture demandée au banc');

  // A square wave: rising every 200 µs, high 100 µs.
  const edges = Array.from({ length: 10 }, (_, k) => [100 * (k + 1), 2, (k + 1) % 2] as [number, number, 0 | 1]);
  show({ phase: 'done', rec: { pins: [2], durationMs: 1, initial: { 2: 0 }, t0Ms: 0, edges } });
  expect(box.querySelector('th[scope="col"]')?.textContent).toBe('PWM');
  expect(box.textContent).toContain('5 kHz');
  expect(box.textContent).toContain('s sur le banc');
  expect(box.textContent).not.toContain('simulation');

  show({ phase: 'failed' });
  expect(box.textContent).toContain('La capture du banc a échoué');
  request.mockReturnValueOnce(false);
  act(() => button.click());
  expect(box.textContent).toContain('Le hub est injoignable');
  act(() => root.unmount());
});
