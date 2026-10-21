/**
 * The workspace look for Velxio's CodeEditor, without patching it.
 *
 * CodeEditor asks Monaco for "velxio-dark" or "velxio-light" and sets its own
 * options on every render. While the workspace is mounted both theme names
 * are redefined with the workspace palette, and the two options that matter
 * (font, minimap) are put back whenever the editor's configuration changes.
 * Leaving the workspace restores Velxio's themes. `setEditorReadOnly` locks the
 * editor (an agent's compiled program, v0.15): CodeEditor never sets that
 * option, so it stays as set here, on the editors open and those to come.
 */
import { loader } from '@monaco-editor/react';
import { MONACO_DARK, MONACO_LIGHT, defineVelxioThemes } from '@velxio/components/editor/monacoThemes';

const RULES = [
  { token: '', foreground: 'DCE4EF' },
  { token: 'comment', foreground: '7F93AF' },
  { token: 'keyword', foreground: '8DB7F0' },
  { token: 'keyword.directive', foreground: 'F3B3AF' },
  { token: 'number', foreground: 'F6C26B' },
  { token: 'string', foreground: '9FD5B3' },
];

const COLORS = {
  'editor.background': '#0B1D33',
  'editor.foreground': '#DCE4EF',
  'editorGutter.background': '#0B1D33',
  'editorLineNumber.foreground': '#5E7493',
  'editorLineNumber.activeForeground': '#E7746F',
  'editor.lineHighlightBackground': '#1C3352',
  'editor.lineHighlightBorder': '#00000000',
  'editorCursor.foreground': '#E7746F',
  'editor.selectionBackground': '#2B4C78',
  'editorIndentGuide.background1': '#1C3352',
  'editorWidget.background': '#13263F',
  'editorWidget.border': '#1C3352',
  'editorSuggestWidget.background': '#13263F',
  'editorHoverWidget.background': '#13263F',
  'scrollbar.shadow': '#00000000',
};

const OPTIONS = {
  minimap: { enabled: false },
  fontFamily: "'Geist Mono', ui-monospace, monospace",
  fontSize: 14,
  lineHeight: 24,
  padding: { top: 16 },
  renderLineHighlight: 'all' as const,
};

type Editor = { updateOptions(o: object): void };
let readOnly = false;
const editors = new Set<Editor>();

export function setEditorReadOnly(on: boolean) {
  readOnly = on;
  editors.forEach((e) => e.updateOptions({ readOnly: on }));
}

export function themeMonaco(): () => void {
  let undo = () => {};
  let cancelled = false;
  loader
    .init()
    .then((monaco) => {
      if (cancelled) return;
      // CodeEditor defines its themes once per monaco instance, behind this flag.
      const flag = monaco as unknown as { __velxioThemes?: boolean };
      flag.__velxioThemes = true;
      for (const name of [MONACO_DARK, MONACO_LIGHT]) {
        monaco.editor.defineTheme(name, { base: 'vs-dark', inherit: true, rules: RULES, colors: COLORS });
      }
      const dress = (editor: { updateOptions(o: object): void; getRawOptions(): { minimap?: { enabled?: boolean } } }) => {
        if (editor.getRawOptions().minimap?.enabled !== false) editor.updateOptions(OPTIONS);
      };
      const created = monaco.editor.onDidCreateEditor((editor: unknown) => {
        const e = editor as Parameters<typeof dress>[0] & { onDidChangeConfiguration(cb: () => void): void; onDidDispose(cb: () => void): void };
        dress(e);
        editors.add(e);
        e.onDidDispose(() => editors.delete(e));
        if (readOnly) e.updateOptions({ readOnly });
        e.onDidChangeConfiguration(() => dress(e));
      });
      // Monaco measured the glyphs with the fallback font if ours was late.
      void document.fonts.load("14px 'Geist Mono'").then(() => monaco.editor.remeasureFonts());
      undo = () => {
        created.dispose();
        setEditorReadOnly(false);
        editors.clear();
        flag.__velxioThemes = false;
        defineVelxioThemes(monaco);
      };
    })
    .catch(() => {}); // cancelled, or Monaco did not load: the editor says so itself
  return () => {
    cancelled = true;
    undo();
  };
}
