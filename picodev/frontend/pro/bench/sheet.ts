/**
 * Loading a setup sheet: fetch, check what this screen uses, hand the circuit
 * and the files to Velxio as one of its own examples.
 */
import type { ExampleProject } from '@velxio/data/examples';
import { HUB_URL, SETUPS_URL } from './config';
import { isSessionId, takeFragment } from './hub';
import { text } from './text';
import type { SetupSheet } from './types';

export interface LoadedSetup {
  sheet: SetupSheet;
  /** Text of the scene, when the sheet has one and it could be fetched. */
  sceneSvg: string | null;
  /** A draft served by the hub to a try session (live-protocol.adoc), not a published sheet. */
  draft: boolean;
}

/** The draft token of `?s=<session>#…&d=<token>`, with a hub only. */
function draftToken(): string | undefined {
  const s = new URLSearchParams(location.search).get('s');
  return HUB_URL && isSessionId(s) ? takeFragment(s).draft : undefined;
}

/** The sheet format is owned by the setups' JSON Schema; only what is used here is checked. */
function check(data: unknown, setupId: string): SetupSheet {
  const s = data as Partial<SetupSheet> | null;
  /** `what`: the key of the sheet at fault, the same word in every language. */
  const fail = (what: string): never => {
    throw new Error(text().sheetBad(setupId, what));
  };
  if (!s || typeof s !== 'object') return fail('JSON');
  if (s.schema !== 1) return fail('schema');
  if (typeof s.id !== 'string' || typeof s.title !== 'string') return fail('id/title');
  if (typeof s.board?.kind !== 'string' || typeof s.board?.fqbn !== 'string') return fail('board');
  if (!Array.isArray(s.files) || !s.files.length) return fail('files');
  if (s.files.some((f) => typeof f?.name !== 'string' || typeof f?.content !== 'string')) return fail('files');
  if (!Array.isArray(s.circuit?.components) || !Array.isArray(s.circuit?.wires)) return fail('circuit');
  if (!Array.isArray(s.probes) || !Array.isArray(s.levels)) return fail('probes/levels');
  if (s.probes.some((p) => !Number.isInteger(p?.pin) || typeof p?.label !== 'string')) return fail('probes');
  if (s.levels.some((l) => typeof l?.title !== 'string' || !Array.isArray(l?.tests) || !Array.isArray(l?.hints)))
    return fail('levels');
  if (s.controllers !== undefined) {
    if (!Array.isArray(s.controllers)) return fail('controllers');
    if (s.controllers.some((c) => typeof c?.id !== 'string' || typeof c?.kind !== 'string' || typeof c?.hex !== 'string'))
      return fail('controllers');
  }
  return s as SetupSheet;
}

export async function fetchSetup(setupId: string): Promise<LoadedSetup> {
  // The id comes from the address bar: keep it one path segment.
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(setupId)) throw new Error(text().badSetupId);
  // A draft comes from fixed paths of the hub, with its token: never from an address in the URL.
  const draft = draftToken();
  const base = draft ? `${HUB_URL}/drafts/${setupId}/` : `${SETUPS_URL}/${setupId}/`;
  const auth = draft ? { headers: { Authorization: `Bearer ${draft}` } } : undefined;
  const res = await fetch(`${base}setup.json`, { cache: 'no-cache', ...auth });
  if (!res.ok) throw new Error(text().sheetHttp(setupId, res.status));
  const sheet = check(await res.json().catch(() => null), setupId);

  let sceneSvg: string | null = null;
  if (sheet.scene?.svg) {
    // Relative to the sheet, and never outside its origin.
    const url = new URL(draft ? 'scene.svg' : sheet.scene.svg, new URL(base, location.href));
    if (url.origin === location.origin) {
      const svg = await fetch(url, auth).catch(() => null);
      if (svg?.ok) sceneSvg = await svg.text();
    }
  }
  return { sheet, sceneSvg, draft: !!draft };
}

export function toExample(sheet: SetupSheet): ExampleProject {
  return {
    id: sheet.id,
    title: sheet.title,
    description: sheet.summary ?? '',
    category: 'basics',
    difficulty: 'beginner',
    boardType: sheet.board.kind,
    code: sheet.files[0].content,
    files: sheet.files,
    components: sheet.circuit.components as ExampleProject['components'],
    wires: sheet.circuit.wires as ExampleProject['wires'],
    // The sheet pins versions ("Servo@1.2.2"); Velxio's manifest wants names.
    libraries: (sheet.libraries ?? []).map((l) => l.split('@')[0]),
  };
}
