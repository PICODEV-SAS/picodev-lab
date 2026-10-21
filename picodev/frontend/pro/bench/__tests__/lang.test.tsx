// @vitest-environment jsdom
/** The language of the bench: choosing it, the setup's translations, and the panels in English. */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runLevel } from '../engine';
import { fakeProbe } from '../engine/__tests__/fakeProbe';
import { LANG_KEY, localizeSheet, localPath, pickLang, readLang, setLang } from '../lang';
import { LevelPanel } from '../LevelPanel';
import type { Level, SetupSheet } from '../types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('choice of the language', () => {
  it('keeps a stored choice, whatever the browser says', () => {
    expect(pickLang('fr', ['en-US'])).toBe('fr');
    expect(pickLang('en', ['fr-FR'])).toBe('en');
  });

  it('without one: French when a browser language is French, English otherwise', () => {
    expect(pickLang(null, ['de-DE', 'fr-CA'])).toBe('fr');
    expect(pickLang(null, ['FR'])).toBe('fr');
    expect(pickLang(null, ['en-US', 'de'])).toBe('en');
    expect(pickLang(null, [])).toBe('en');
    expect(pickLang('de', ['fr-FR'])).toBe('fr'); // not a language of the bench: ignored
  });

  it('reads the stored key, and the browser when storage is refused', () => {
    vi.stubGlobal('navigator', { languages: ['fr-FR'] });
    localStorage.setItem(LANG_KEY, 'en');
    expect(readLang()).toBe('en');
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
    });
    expect(readLang()).toBe('fr');
  });

  it('writes the switch to the key, then reloads the page', () => {
    setLang('fr', () => {});
    const reload = vi.fn(() => expect(localStorage.getItem(LANG_KEY)).toBe('en'));
    setLang('en', reload);
    expect(reload).toHaveBeenCalledTimes(1);
    setLang('fr', () => {});
    expect(localStorage.getItem(LANG_KEY)).toBe('fr');
  });

  it('reloads the page itself, and not for the language already shown', () => {
    setLang('fr', () => {});
    const reload = vi.fn();
    vi.stubGlobal('location', { reload });
    setLang('fr');
    expect(reload).not.toHaveBeenCalled();
    setLang('en');
    expect(reload).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(LANG_KEY)).toBe('en');
  });

  it('sends English pages under /en', () => {
    expect(localPath('/fin', 'en')).toBe('/en/fin');
    expect(localPath('/fin', 'fr')).toBe('/fin');
    expect(localPath('https://other.example/end', 'en')).toBe('https://other.example/end');
  });
});

const level = (id: string, tests: string[]): Level => ({
  id,
  title: `Titre ${id}`,
  brief: `Consigne ${id}`,
  hints: [`Indice ${id}`],
  timeout_ms: 1000,
  tests: tests.map((t) => ({ id: t, label: `Test ${t}`, spec: { type: 'pin_level', pin: 13, level: 'high', at_ms: 0 } })),
});

const sheet = {
  schema: 1,
  id: 'setup-a',
  title: 'Montage A',
  summary: 'Résumé',
  files: [],
  levels: [level('l1', ['t1', 't2']), level('l2', ['t3'])],
  i18n: {
    en: {
      title: 'Setup A',
      levels: { l1: { title: 'Blink', hints: ['Look at pin 13'] }, l2: { brief: 42 } },
      tests: { t1: 'LED on' },
    },
  },
} as unknown as SetupSheet;

describe('setup texts', () => {
  it('takes the translation, and the French text for anything missing', () => {
    const en = localizeSheet(sheet, 'en');
    expect([en.title, en.summary]).toEqual(['Setup A', 'Résumé']);
    expect(en.levels[0]).toMatchObject({ title: 'Blink', brief: 'Consigne l1', hints: ['Look at pin 13'] });
    expect(en.levels[0].tests.map((t) => t.label)).toEqual(['LED on', 'Test t2']);
    expect(en.levels[1]).toMatchObject({ title: 'Titre l2', brief: 'Consigne l2' }); // not a string: ignored
    expect(en.levels[1].tests[0].spec).toEqual(sheet.levels[1].tests[0].spec);
  });

  it('takes the translated starting sketch, file by file, by name', () => {
    const files = [
      { name: 'sketch.ino', content: '// Bonjour' },
      { name: 'pins.h', content: '// broches' },
    ];
    const tr = { files: [{ name: 'sketch.ino', content: '// Hello' }, { name: 'other.h', content: 'x' }, { name: 'pins.h', content: 3 }] };
    const en = localizeSheet({ ...sheet, files, i18n: { en: tr } } as unknown as SetupSheet, 'en');
    expect(en.files).toEqual([
      { name: 'sketch.ino', content: '// Hello' },
      { name: 'pins.h', content: '// broches' }, // not a string: French
    ]);
    expect(localizeSheet({ ...sheet, files }, 'en').files).toEqual(files); // no files translated
  });

  it('is the sheet itself in French, or without a translation', () => {
    expect(localizeSheet(sheet, 'fr')).toBe(sheet);
    const bare = { ...sheet, i18n: undefined };
    expect(localizeSheet(bare, 'en')).toBe(bare);
  });
});

describe('in English', () => {
  it('shows the level panel in English', () => {
    setLang('en', () => {});
    const box = document.createElement('div');
    const root = createRoot(box);
    const props = { levels: localizeSheet(sheet, 'en').levels, index: 0, results: [], passed: true, hintsShown: 0, onHint() {}, onNext() {}, onFinish() {} };
    act(() => root.render(<LevelPanel {...props} />));
    const text = () => box.textContent!;
    expect(text()).toContain('Level 1 of 2');
    expect(text()).toContain('Blink');
    expect(text()).toContain('LED on');
    expect(text()).toContain('pending');
    expect(text()).toContain('Level passed.');
    expect(text()).toContain('Next level');
    expect(text()).toContain('Show a hint (1 of 1)');
    act(() => root.unmount());
  });

  it('writes the test details in English', async () => {
    vi.useFakeTimers();
    const f = fakeProbe();
    const run = runLevel(level('l1', ['t1']), f.probe, () => {}, 'en');
    f.pin(13, true, 0);
    f.advance(10);
    vi.advanceTimersByTime(50);
    expect((await run.done)[0].detail).toBe('D13 is 1 at 0 ms');
    vi.useRealTimers();
  });
});
