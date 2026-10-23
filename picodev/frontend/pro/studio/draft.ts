/**
 * The setup studio's draft (architecture v0.18, « L'atelier »): what the
 * administrator is preparing, and the `files` of a setup folder built from it
 * for the hub's back-office (`setup-check`, `setup-zip`, `setup-try`).
 *
 * Pure functions, no Velxio import: the page hands over the circuit (in the
 * setup sheet's shape, circuit.ts) and the sketch files of the editor. The
 * folder is the one of picodev-lab-setups and picodev-lab-challenges:
 * `setup.json` without `files` (built from the sources), the sources,
 * `en/<source>`, the scene, `solutions/<level id>.ino`.
 */
import type { Circuit } from '../bench/circuit';

export interface SourceFile {
  name: string;
  content: string;
}

export interface StudioDraft {
  id: string;
  title: string;
  /** `kind`: Velxio's board kind; `fqbn`: what the lab compiles for, as the sheet writes it. */
  board: { kind: string; fqbn: string };
  /** The editor's sketch: the first file is the main one (`sketch.ino`). */
  files: SourceFile[];
  /** The English versions of some of the files, same names (`en/` of the folder). */
  en: SourceFile[];
  circuit: Circuit;
  /** The rest of setup.json, as the administrator writes it (JSON text). */
  rest: string;
  /** The text of scene.svg, or null without a scene. */
  scene: string | null;
  /** The reference solution of each level, by level id. */
  solutions: Record<string, string>;
}

/** A setup id, as the hub takes it for a draft. */
export const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** A source file name, as the setups' JSON Schema takes it. */
const SOURCE_RE = /^[A-Za-z0-9_-]+\.(ino|h|hpp|c|cpp)$/;
const SCENE_RE = /^[a-z0-9-]+\.svg$/;
export const SCENE_NAME = 'scene.svg';

/** The keys of setup.json the studio writes itself; the order of the setups' JSON Schema. */
const OWN = ['schema', 'id', 'title', 'board', 'files', 'circuit'] as const;
const ORDER = ['schema', 'id', 'title', 'summary', 'i18n', 'board', 'files', 'libraries', 'circuit', 'probes', 'couplings', 'scene', 'levels'];

export const STARTER_SKETCH = 'void setup() {\n}\n\nvoid loop() {\n}\n';

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** "arduino:avr:nano:cpu=atmega328" -> "arduino:avr:nano": the sheet names the board, not its options. */
export const sheetFqbn = (velxioFqbn: string) => velxioFqbn.split(':').slice(0, 3).join(':');

/** A new setup: an empty circuit on `board`, the starter sketch, the parts of the sheet Velxio does not know. */
export function newDraft(id: string, title: string, board: { kind: string; fqbn: string }): StudioDraft {
  const rest = { summary: '', libraries: [], probes: [], couplings: [], levels: [] };
  return { id, title, board, files: [{ name: 'sketch.ino', content: STARTER_SKETCH }], en: [], circuit: { components: [], wires: [] }, rest: pretty(rest), scene: null, solutions: {} };
}

/** A served sheet (`/setups/<id>/setup.json`, files included) as a draft; its scene apart. Solutions are never served. */
export function draftFromSheet(sheet: Record<string, unknown>, scene: string | null): StudioDraft {
  const rest: Record<string, unknown> = Object.fromEntries(Object.entries(sheet).filter(([k]) => !(OWN as readonly string[]).includes(k)));
  let en: SourceFile[] = [];
  // i18n.en.files is built from en/ of the folder: it goes back to files.
  const i18n = rest.i18n;
  if (isObj(i18n) && isObj(i18n.en) && Array.isArray(i18n.en.files)) {
    en = files(i18n.en.files);
    const { files: _, ...enRest } = i18n.en;
    rest.i18n = Object.keys(enRest).length ? { ...i18n, en: enRest } : Object.fromEntries(Object.entries(i18n).filter(([k]) => k !== 'en'));
    if (!Object.keys(rest.i18n as object).length) delete rest.i18n;
  }
  const board = isObj(sheet.board) ? sheet.board : {};
  const circuit = isObj(sheet.circuit) ? sheet.circuit : {};
  return {
    id: String(sheet.id ?? ''),
    title: String(sheet.title ?? ''),
    board: { kind: String(board.kind ?? ''), fqbn: String(board.fqbn ?? '') },
    files: files(sheet.files),
    en,
    circuit: {
      components: Array.isArray(circuit.components) ? (circuit.components as Circuit['components']) : [],
      wires: Array.isArray(circuit.wires) ? (circuit.wires as Circuit['wires']) : [],
    },
    rest: pretty(rest),
    scene,
    solutions: {},
  };
}

function files(v: unknown): SourceFile[] {
  return Array.isArray(v) ? v.filter((f) => isObj(f) && typeof f.name === 'string' && typeof f.content === 'string').map((f) => ({ name: f.name as string, content: f.content as string })) : [];
}

const pretty = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

/** The rest of setup.json, read: an object, or why not (in `lang`'s words, by the caller). */
export function parseRest(rest: string): { value: Record<string, unknown> } | { error: string } {
  let value: unknown;
  try {
    value = JSON.parse(rest);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  if (!isObj(value)) return { error: 'not an object' };
  const own = OWN.filter((k) => k in value);
  if (own.length) return { error: `${own.join(', ')}: ${own.length > 1 ? 'are' : 'is'} written by the studio` };
  return { value };
}

/** The level ids of the rest of setup.json, in order: one solution each. */
export function levelIds(rest: string): string[] {
  const parsed = parseRest(rest);
  if ('error' in parsed || !Array.isArray(parsed.value.levels)) return [];
  return parsed.value.levels.map((l) => (isObj(l) && typeof l.id === 'string' ? l.id : '')).filter(Boolean);
}

/** The scene's file name: the sheet's `scene.svg` when it is one, else scene.svg. */
export function sceneName(rest: string): string {
  const parsed = parseRest(rest);
  const scene = 'value' in parsed ? parsed.value.scene : undefined;
  return isObj(scene) && typeof scene.svg === 'string' && SCENE_RE.test(scene.svg) ? scene.svg : SCENE_NAME;
}

/** The rest of setup.json with a `scene` once a drawing is added (its bindings kept, none when it had none). */
export function withScene(rest: string): string {
  const parsed = parseRest(rest);
  if ('error' in parsed) return rest;
  const scene = parsed.value.scene;
  if (isObj(scene) && typeof scene.svg === 'string') return rest;
  return pretty({ ...parsed.value, scene: { svg: SCENE_NAME, bindings: isObj(scene) && Array.isArray(scene.bindings) ? scene.bindings : [] } });
}

/** setup.json of the folder: the studio's keys and the rest, in the order of the schema. */
export function setupJson(draft: StudioDraft, rest: Record<string, unknown>): string {
  const all: Record<string, unknown> = { ...rest, schema: 1, id: draft.id, title: draft.title, board: draft.board, circuit: draft.circuit };
  const keys = [...ORDER.filter((k) => k in all), ...Object.keys(all).filter((k) => !ORDER.includes(k))];
  return pretty(Object.fromEntries(keys.map((k) => [k, all[k]])));
}

export interface FolderFile {
  path: string;
  content: string;
}

/**
 * The setup folder, every path under `<id>/` (the `.zip` is that folder):
 * setup.json, the sketch files, en/, the scene, solutions/<level id>.ino.
 * A string says why it cannot be built (a key of `problemsOf` text).
 */
export function folderFiles(draft: StudioDraft): FolderFile[] | { error: 'id' | 'json' | 'sketch'; detail?: string } {
  if (!ID_RE.test(draft.id)) return { error: 'id' };
  const parsed = parseRest(draft.rest);
  if ('error' in parsed) return { error: 'json', detail: parsed.error };
  if (draft.files[0]?.name !== 'sketch.ino' || draft.files.some((f) => !SOURCE_RE.test(f.name))) return { error: 'sketch' };
  const dir = `${draft.id}/`;
  const out: FolderFile[] = [{ path: `${dir}setup.json`, content: setupJson(draft, parsed.value) }];
  draft.files.forEach((f) => out.push({ path: dir + f.name, content: f.content }));
  draft.en.filter((f) => SOURCE_RE.test(f.name)).forEach((f) => out.push({ path: `${dir}en/${f.name}`, content: f.content }));
  if (draft.scene !== null) out.push({ path: dir + sceneName(draft.rest), content: draft.scene });
  for (const level of levelIds(draft.rest)) {
    const code = draft.solutions[level];
    if (code?.trim() && /^[a-z0-9][a-z0-9_-]*$/i.test(level)) out.push({ path: `${dir}solutions/${level}.ino`, content: code });
  }
  return out;
}

/** setup-try's mode: Défi on the first level when the setup has levels, Libre to try a circuit before writing them. */
export const tryMode = (draft: StudioDraft): 'free' | 'challenge' => (levelIds(draft.rest).length ? 'challenge' : 'free');

/**
 * Where to open a try session's `open_url`. The hub makes it absolute, on the
 * lab's public origin (the draft is served there, under /hub/drafts/, which the
 * studio server does not relay); a relative one is taken against `base`.
 * Anything but http(s) is refused.
 */
export function tryUrl(openUrl: unknown, base: string): string | null {
  if (typeof openUrl !== 'string' || !openUrl) return null;
  try {
    const url = new URL(openUrl, base);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/** The ids of the scene's elements, which the bindings target, in document order. */
export function sceneIds(svg: string): string[] {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  if (doc.getElementsByTagName('parsererror').length) return [];
  return [...doc.querySelectorAll('[id]')].map((el) => el.id);
}

// ── Scene bindings (architecture v0.20, « Liaisons ») ───────────────────────

/** The board pins the circuit wires to the board, sorted: what a binding may read (check.py's board_pin). */
export function boardPins(circuit: Circuit, boardKind: string): number[] {
  const pins = new Set<number>();
  for (const w of circuit.wires)
    for (const end of [w.start, w.end]) {
      const m = end.componentId === boardKind ? /^(?:D?(\d+)|A(\d))$/.exec(end.pinName) : null;
      if (m) pins.add(m[2] !== undefined ? 14 + Number(m[2]) : Number(m[1]));
    }
  return [...pins].sort((a, b) => a - b);
}

export const SOURCE_KINDS = ['pin', 'pwm', 'servo'] as const;
export const EFFECTS = ['visible', 'fill', 'rotate', 'translate', 'spin'] as const;
export type Effect = (typeof EFFECTS)[number];
/** The keys of each effect (the setups' JSON Schema), with the value a new binding takes. `origin` is optional. */
export const EFFECT_KEYS: Record<Effect, Record<string, string | number>> = {
  visible: { when: 'high' },
  fill: { on: '#E7746F', off: '#3A4A5E' },
  rotate: { min: 0, max: 180, from: 0, to: 180 },
  translate: { min: 0, max: 1, dx: 0, dy: 0 },
  spin: { threshold: 0.5 },
};
export const HAS_ORIGIN: readonly Effect[] = ['rotate', 'spin'];
export const BINDINGS_MAX = 64;

export type Binding = Record<string, unknown>;

/** `scene.bindings` of the rest of setup.json; null when it cannot be read or has no scene. */
export function bindingsOf(rest: string): Binding[] | null {
  const parsed = parseRest(rest);
  if ('error' in parsed || !isObj(parsed.value.scene)) return null;
  const list = parsed.value.scene.bindings;
  return Array.isArray(list) ? list.map((b) => (isObj(b) ? b : {})) : [];
}

/** The rest of setup.json with these bindings (unchanged when it cannot be read). */
export function withBindings(rest: string, bindings: Binding[]): string {
  const parsed = parseRest(rest);
  if ('error' in parsed) return rest;
  const scene = isObj(parsed.value.scene) ? parsed.value.scene : { svg: SCENE_NAME };
  return pretty({ ...parsed.value, scene: { ...scene, bindings } });
}

/**
 * A binding with `effect` and only its keys, in the schema's order: the ones
 * it already has are kept (min and max from rotate to translate, origin from
 * rotate to spin), the others take their default.
 */
export function shapeBinding(b: Binding, effect: Effect): Binding {
  const out: Binding = { target: b.target ?? '', source: b.source ?? 'pin:13', effect };
  for (const [k, v] of Object.entries(EFFECT_KEYS[effect])) out[k] = typeof b[k] === typeof v ? b[k] : v;
  if (HAS_ORIGIN.includes(effect) && Array.isArray(b.origin)) out.origin = b.origin;
  return out;
}

// ── The back-office token (architecture v0.20, item 7) ──────────────────────

/** Kept for this tab only, never in localStorage. */
export const TOKEN_KEY = 'picodev-lab:admin-token';

export function loadToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveToken(token: string): void {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // kept in the page only
  }
}

/** The headers of a back-office request: JSON, and the token when there is one. */
export function adminHeaders(token: string): Record<string, string> {
  const t = token.trim();
  return { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) };
}

/** Where a problem of setup-check belongs: the field it names first (check.py writes "<field> : …"). */
export type Field = 'identity' | 'editor' | 'scene' | 'sheet' | 'solutions';
export function fieldOf(problem: string): Field {
  const head = problem.trim().toLowerCase().split(/[\s:/,]/)[0];
  if (head === 'décor' || head === 'scene') return 'scene';
  if (/solution/i.test(problem)) return 'solutions';
  if (['circuit', 'carte', 'board', 'files', 'sketch.ino'].includes(head) || problem.startsWith('sketch.ino')) return 'editor';
  if (['id', 'title', "l'id"].includes(head) || problem.startsWith("l'id")) return 'identity';
  return 'sheet';
}

// ── Kept in this origin's localStorage, nothing on the server ───────────────

export const draftKey = (id: string) => `picodev-lab:studio:${id}`;

export function loadDraft(id: string): StudioDraft | null {
  try {
    const raw = localStorage.getItem(draftKey(id));
    const d = raw ? (JSON.parse(raw) as StudioDraft) : null;
    return d && d.id === id && typeof d.rest === 'string' && Array.isArray(d.files) ? { ...d, en: d.en ?? [], solutions: d.solutions ?? {} } : null;
  } catch {
    return null;
  }
}

/** False when the browser refused (full, private mode): the page says the draft is not kept. */
export function saveDraft(draft: StudioDraft): boolean {
  try {
    localStorage.setItem(draftKey(draft.id), JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

export function dropDraft(id: string): void {
  try {
    localStorage.removeItem(draftKey(id));
  } catch {
    // nothing kept anyway
  }
}
