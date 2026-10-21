/**
 * The language of the bench pages: French or English, read once per page load.
 *
 * Kept in localStorage under LANG_KEY, in the same `picodev-lab:` namespace as
 * the sketch and the level, so a site served from the same origin can share
 * the choice. Without a stored choice: French when one of the browser's
 * languages is French, English otherwise. A switch reloads the page, so every
 * text is made again in the new language; the code, the level and the hub
 * session are kept by the browser (autosave, levelMemory, sessionStorage).
 */
import type { Lang, SetupSheet } from './types';

export const LANG_KEY = 'picodev-lab:lang';

export function pickLang(stored: string | null, languages: readonly string[]): Lang {
  if (stored === 'fr' || stored === 'en') return stored;
  return languages.some((l) => l.toLowerCase().startsWith('fr')) ? 'fr' : 'en';
}

export function readLang(): Lang {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(LANG_KEY);
  } catch {
    // storage refused (private mode): the browser's languages decide
  }
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  return pickLang(stored, nav?.languages ?? (nav?.language ? [nav.language] : []));
}

let current = readLang();

export const getLang = (): Lang => current;

/** Keeps `lang` and reloads the page in it; nothing for the language shown. `reload` is replaced in tests only. */
export function setLang(lang: Lang, reload = () => location.reload()): void {
  if (lang === current) return;
  current = lang;
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    // not kept: the page reloads in the browser's language
  }
  reload();
}

/** A same-origin path of the site in `lang`: English pages live under /en. */
export const localPath = (path: string, lang: Lang) => (lang === 'en' && path.startsWith('/') && !path.startsWith('//') ? `/en${path}` : path);

const str = (v: unknown, fallback: string) => (typeof v === 'string' ? v : fallback);

/** The sheet with its texts in `lang` (its `i18n`), French for anything missing. */
export function localizeSheet(sheet: SetupSheet, lang: Lang): SetupSheet {
  const tr = lang === 'fr' ? undefined : sheet.i18n?.[lang];
  if (!tr || typeof tr !== 'object') return sheet;
  const files = Array.isArray(tr.files) ? tr.files : [];
  return {
    ...sheet,
    title: str(tr.title, sheet.title),
    summary: str(tr.summary, sheet.summary),
    levels: sheet.levels.map((level) => {
      const l = tr.levels?.[level.id];
      return {
        ...level,
        title: str(l?.title, level.title),
        brief: str(l?.brief, level.brief),
        hints: Array.isArray(l?.hints) && l.hints.every((h) => typeof h === 'string') ? l.hints : level.hints,
        tests: level.tests.map((t) => ({ ...t, label: str(tr.tests?.[t.id], t.label) })),
      };
    }),
    // The starting sketch: file by file, by name; a file not translated stays French.
    files: sheet.files.map((f) => ({ ...f, content: str(files.find((t) => t?.name === f.name)?.content, f.content) })),
  };
}
