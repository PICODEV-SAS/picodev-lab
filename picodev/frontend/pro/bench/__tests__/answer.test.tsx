// @vitest-environment jsdom
/** The answer field of an answer test, as the visitor sees it in the test list. */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLang } from '../lang';
import { LevelPanel, TestList, type AnswerState } from '../LevelPanel';
import type { Level, TestResult } from '../types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const level: Level = {
  id: 'l1',
  title: 'Niveau',
  brief: '',
  hints: [],
  timeout_ms: 1000,
  tests: [
    { id: 'flag', label: 'Le code secret', spec: { type: 'answer' } },
    { id: 'serial', label: 'Le message', spec: { type: 'serial_contains', text: 'hi' } as never },
  ],
};

let root: Root;
let box: HTMLDivElement;
const onAnswer = vi.fn();

beforeEach(() => {
  setLang('fr', () => {});
  box = document.createElement('div');
  document.body.append(box);
  root = createRoot(box);
  onAnswer.mockClear();
});
afterEach(() => {
  act(() => root.unmount());
  box.remove();
});

const render = (results: TestResult[] = [], answers?: Record<string, AnswerState>, on: typeof onAnswer | null = onAnswer, offline = false) =>
  act(() => root.render(<TestList level={level} results={results} answers={answers} onAnswer={on ?? undefined} offline={offline} />));
const input = () => box.querySelector<HTMLInputElement>('input[type=text]');
const type = (value: string) =>
  act(() => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    set.call(input(), value);
    input()!.dispatchEvent(new Event('input', { bubbles: true }));
  });

describe('answer field', () => {
  it('renders a field for answer tests only', () => {
    render();
    expect(box.querySelectorAll('input[type=text]')).toHaveLength(1);
    expect(input()!.getAttribute('aria-label')).toBe('Le code secret');
  });

  it('Enter and the button call onAnswer with the trimmed value', () => {
    render();
    type('  abc  ');
    act(() => box.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(onAnswer).toHaveBeenLastCalledWith('flag', 'abc');
    act(() => box.querySelector<HTMLButtonElement>('button[type=submit]')!.click());
    expect(onAnswer).toHaveBeenCalledTimes(2);
  });

  it('does not send an empty value', () => {
    render();
    type('   ');
    act(() => box.querySelector<HTMLButtonElement>('button[type=submit]')!.click());
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it('waiting disables the field', () => {
    render([], { flag: { status: 'waiting' } });
    expect(input()!.disabled).toBe(true);
    expect(box.querySelector<HTMLButtonElement>('button[type=submit]')!.disabled).toBe(true);
  });

  it('a passed answer shows the check and no field', () => {
    render([{ id: 'flag', status: 'passed', detail: 'Bonne réponse' }]);
    expect(input()).toBeNull();
    expect(box.querySelector('li[data-status=passed] svg')).not.toBeNull();
    expect(box.textContent).toContain('Bonne réponse');
  });

  it('an error reopens the field and shows it', () => {
    render([], { flag: { status: 'idle', error: 'Trop de tentatives.' } });
    expect(input()!.disabled).toBe(false);
    const describedBy = input()!.getAttribute('aria-describedby')!;
    expect(box.querySelector(`[id="${describedBy}"]`)!.textContent).toContain('Trop de tentatives.');
  });

  it('without onAnswer there is no field', () => {
    render([], undefined, null);
    expect(input()).toBeNull();
  });

  it('offline closes the field and says why', () => {
    render([], undefined, onAnswer, true);
    expect(input()!.disabled).toBe(true);
    expect(box.querySelector<HTMLButtonElement>('button[type=submit]')!.disabled).toBe(true);
    const describedBy = input()!.getAttribute('aria-describedby')!;
    expect(box.querySelector(`[id="${describedBy}"]`)!.textContent).toContain('pas joignable');
  });

  it('offline says so on the answer test only', () => {
    render([], undefined, onAnswer, true);
    const [answerLi, serialLi] = Array.from(box.querySelectorAll('li'));
    expect(answerLi.textContent).toContain('pas joignable');
    expect(serialLi.textContent).not.toContain('pas joignable');
    expect(serialLi.querySelector('input')).toBeNull();
  });
});

describe('level footer', () => {
  it('says when an answer is checked', () => {
    const only = { ...level, tests: [level.tests[0]] };
    act(() => root.render(<LevelPanel levels={[only]} index={0} results={[]} passed={false} hintsShown={0} onHint={() => {}} onNext={() => {}} onFinish={() => {}} />));
    expect(box.querySelector('.bench-level-foot')!.textContent).toBe('Une réponse est vérifiée au moment où vous la validez.');
  });
});
