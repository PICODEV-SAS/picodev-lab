// @vitest-environment jsdom
/** The studio's draft: a served sheet in, a setup folder out (architecture v0.18, « L'atelier »). */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  draftFromSheet,
  draftKey,
  dropDraft,
  fieldOf,
  folderFiles,
  levelIds,
  loadDraft,
  newDraft,
  parseRest,
  saveDraft,
  sceneIds,
  sceneName,
  sheetFqbn,
  tryMode,
  tryUrl,
  withScene,
  type FolderFile,
} from '../draft';
import { circuitOf } from '../../bench/circuit';

/** A served sheet, as /setups/<id>/setup.json gives it: files and i18n.en.files built from the folder. */
const served = {
  schema: 1,
  id: 'setup-a',
  title: 'Setup A',
  summary: 'Un servo appuie sur un bouton.',
  i18n: { en: { title: 'Setup A (en)', files: [{ name: 'sketch.ino', content: '// en' }] } },
  board: { kind: 'arduino-nano', fqbn: 'arduino:avr:nano' },
  files: [
    { name: 'sketch.ino', content: '// fr' },
    { name: 'util.h', content: '#pragma once' },
  ],
  libraries: ['Servo@1.2.2'],
  circuit: {
    components: [{ type: 'wokwi-led', id: 'led', x: 1, y: 2, properties: { color: 'red' } }],
    wires: [{ id: 'w1', start: { componentId: 'arduino-nano', pinName: '6' }, end: { componentId: 'led', pinName: 'A' }, color: '#f00' }],
  },
  probes: [{ pin: 6, label: 'D6', kind: 'logic' }],
  scene: { svg: 'scene.svg', bindings: [{ target: 'led', source: 'pin:6', effect: 'visible', when: 'high' }] },
  levels: [
    { id: 'niveau-1', title: 'Un', brief: '', hints: [], timeout_ms: 1000, tests: [] },
    { id: 'niveau-2', title: 'Deux', brief: '', hints: [], timeout_ms: 1000, tests: [] },
  ],
};
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><g id="arm"><rect id="led"/></g><circle/></svg>';

const byPath = (files: FolderFile[]) => Object.fromEntries(files.map((f) => [f.path, f.content]));

beforeEach(() => localStorage.clear());

describe('studio draft', () => {
  it('splits a served sheet: the editor part, the rest of setup.json, en/', () => {
    const d = draftFromSheet(served, SVG);
    expect(d).toMatchObject({ id: 'setup-a', title: 'Setup A', board: served.board, files: served.files, circuit: served.circuit, scene: SVG, solutions: {} });
    expect(d.en).toEqual([{ name: 'sketch.ino', content: '// en' }]);
    const rest = JSON.parse(d.rest);
    expect(Object.keys(rest)).toEqual(['summary', 'i18n', 'libraries', 'probes', 'scene', 'levels']);
    expect(rest.i18n).toEqual({ en: { title: 'Setup A (en)' } }); // the files went to en/
    expect(levelIds(d.rest)).toEqual(['niveau-1', 'niveau-2']);
    // i18n.en with nothing but files: no i18n left.
    const bare = draftFromSheet({ ...served, i18n: { en: { files: [] } } }, null);
    expect(JSON.parse(bare.rest)).not.toHaveProperty('i18n');
  });

  it('builds the folder as the setups repository has it, under <id>/', () => {
    const d = { ...draftFromSheet(served, SVG), solutions: { 'niveau-1': '// sol 1', 'niveau-2': '  ', gone: '// no such level' } };
    const files = folderFiles(d);
    expect(Array.isArray(files)).toBe(true);
    const out = byPath(files as FolderFile[]);
    expect(Object.keys(out)).toEqual(['setup-a/setup.json', 'setup-a/sketch.ino', 'setup-a/util.h', 'setup-a/en/sketch.ino', 'setup-a/scene.svg', 'setup-a/solutions/niveau-1.ino']);
    const sheet = JSON.parse(out['setup-a/setup.json']);
    // No `files` (built from the sources), the circuit in the sheet's shape, the keys in the schema's order.
    expect(sheet).not.toHaveProperty('files');
    expect(Object.keys(sheet)).toEqual(['schema', 'id', 'title', 'summary', 'i18n', 'board', 'libraries', 'circuit', 'probes', 'scene', 'levels']);
    expect(sheet).toMatchObject({ schema: 1, id: 'setup-a', board: served.board, circuit: served.circuit });
    expect(out['setup-a/scene.svg']).toBe(SVG);
    // Keys the administrator adds are kept, after the known ones (setup-check judges them).
    const more = folderFiles({ ...d, rest: JSON.stringify({ ...JSON.parse(d.rest), note: 'x', extra: 1 }) }) as FolderFile[];
    expect(Object.keys(JSON.parse(byPath(more)['setup-a/setup.json'])).slice(-2)).toEqual(['note', 'extra']);
  });

  it('refuses what the hub would refuse anyway: id, JSON, sketch name', () => {
    const d = newDraft('setup-d', 'Nouveau', { kind: 'arduino-uno', fqbn: 'arduino:avr:uno' });
    expect(byPath(folderFiles(d) as FolderFile[])).toHaveProperty('setup-d/sketch.ino');
    expect(folderFiles({ ...d, id: 'Setup D' })).toEqual({ error: 'id' });
    expect(folderFiles({ ...d, rest: '{' })).toMatchObject({ error: 'json' });
    expect(folderFiles({ ...d, rest: '{"id": "x"}' })).toMatchObject({ error: 'json', detail: 'id: is written by the studio' });
    expect(folderFiles({ ...d, files: [{ name: 'main.ino', content: '' }] })).toEqual({ error: 'sketch' });
    expect(folderFiles({ ...d, files: [{ name: 'sketch.ino', content: '' }, { name: '../x.h', content: '' }] })).toEqual({ error: 'sketch' });
    expect(parseRest('[]')).toEqual({ error: 'not an object' });
  });

  it('adds a scene to the sheet when a drawing is dropped, keeps a named one', () => {
    const d = newDraft('setup-d', 'Nouveau', { kind: 'arduino-uno', fqbn: 'arduino:avr:uno' });
    const rest = withScene(d.rest);
    expect(JSON.parse(rest).scene).toEqual({ svg: 'scene.svg', bindings: [] });
    expect(withScene(rest)).toBe(rest);
    const named = JSON.stringify({ scene: { svg: 'decor.svg', bindings: [] } });
    expect(sceneName(named)).toBe('decor.svg');
    expect(sceneName(JSON.stringify({ scene: { svg: '../x.svg' } }))).toBe('scene.svg');
    expect(byPath(folderFiles({ ...d, rest: named, scene: SVG }) as FolderFile[])).toHaveProperty('setup-d/decor.svg', SVG);
  });

  it('lists the ids of the scene', () => {
    expect(sceneIds(SVG)).toEqual(['arm', 'led']);
    expect(sceneIds('<svg')).toEqual([]);
  });

  it('tries in Défi with levels, in Libre without', () => {
    const d = draftFromSheet(served, null);
    expect(tryMode(d)).toBe('challenge');
    expect(tryMode(newDraft('x', 'x', d.board))).toBe('free');
  });

  it('opens the try on the public origin the hub gives, never another scheme', () => {
    const base = 'http://127.0.0.1:8091/studio?open=setup-a';
    const abs = 'https://lab.example/bench/setup-a/challenge?s=abc#o=OWNER&d=DRAFT';
    expect(tryUrl(abs, base)).toBe(abs);
    expect(tryUrl('/bench/setup-a?s=abc#o=O&d=D', base)).toBe('http://127.0.0.1:8091/bench/setup-a?s=abc#o=O&d=D');
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', '', 3, null]) expect(tryUrl(bad, base), String(bad)).toBeNull();
  });

  it('keeps the draft in localStorage under picodev-lab:studio:<id>', () => {
    const d = draftFromSheet(served, SVG);
    expect(loadDraft('setup-a')).toBeNull();
    expect(saveDraft(d)).toBe(true);
    expect(localStorage.getItem(draftKey('setup-a'))).toContain('"id":"setup-a"');
    expect(loadDraft('setup-a')).toEqual(d);
    expect(loadDraft('setup-b')).toBeNull();
    localStorage.setItem(draftKey('setup-b'), '{"id":"setup-a"}'); // not the one asked
    expect(loadDraft('setup-b')).toBeNull();
    dropDraft('setup-a');
    expect(loadDraft('setup-a')).toBeNull();
  });

  it('puts each problem of setup-check in front of its field', () => {
    expect(fieldOf('décor : <script> n’est pas permis')).toBe('scene');
    expect(fieldOf('circuit : le fil w1 va vers un composant inconnu x')).toBe('editor');
    expect(fieldOf('carte : esp32 n’est pas une carte autorisée')).toBe('editor');
    expect(fieldOf('sketch.ino manque')).toBe('editor');
    expect(fieldOf("l'id est 'x', le dossier est 'y'")).toBe('identity');
    expect(fieldOf('niveau niveau-1, test t : at_ms dépasse le délai maximal')).toBe('sheet');
    expect(fieldOf('solutions/niveau-1.ino manque')).toBe('solutions');
    expect(fieldOf('levels/0/tests : ...')).toBe('sheet');
  });

  it('names the board as the sheet does', () => {
    expect(sheetFqbn('arduino:avr:nano:cpu=atmega328')).toBe('arduino:avr:nano');
    expect(sheetFqbn('arduino:avr:uno')).toBe('arduino:avr:uno');
  });

  it("exports the waypoints the author drew in the editor (0.24)", () => {
    const pts = [
      { x: 10, y: 20 },
      { x: 10, y: 80 },
    ];
    // What fromEditor gives: the store's wires in the sheet's shape.
    const circuit = circuitOf([], [{ id: 'w1', start: { componentId: 'arduino-nano', pinName: '6' }, end: { componentId: 'led', pinName: 'A' }, color: '#f00', waypoints: pts }], (id) => id);
    const out = byPath(folderFiles({ ...draftFromSheet(served, null), circuit }) as FolderFile[]);
    expect(JSON.parse(out['setup-a/setup.json']).circuit.wires[0].waypoints).toEqual(pts);
    // A served sheet's waypoints come back into the draft as they are.
    const withPts = { ...served, circuit: { ...served.circuit, wires: [{ ...served.circuit.wires[0], waypoints: pts }] } };
    expect(draftFromSheet(withPts, null).circuit.wires[0].waypoints).toEqual(pts);
  });
});
