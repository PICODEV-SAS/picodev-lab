/**
 * The setup studio, /studio (architecture v0.18, « L'atelier »): Velxio's own
 * editor, whole (circuit, sketch, compile, simulation), with a panel for what
 * Velxio does not know of a setup: the scene, the rest of setup.json (probes,
 * couplings, levels and tests, i18n…) and the solution of each level. The
 * panel asks the hub's back-office, relayed by the studio server on this same
 * origin, to check the folder, to try it, and to give it back as a .zip.
 *
 * Registered only when /config.js says `studio` (the studio server's own, see
 * picodev/docker/render_config.py); the public server answers 404 on /studio.
 * The draft stays in this origin's localStorage, nothing on the server.
 */
import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { i18n, loadLocale } from '@velxio/i18n';
import { BRAND_NAME, isBoardAllowed } from '@velxio/lib/deploymentConfig';
import { EditorPage } from '@velxio/pages/EditorPage';
import { useEditorStore } from '@velxio/store/useEditorStore';
import { useSimulatorStore } from '@velxio/store/useSimulatorStore';
import { BOARD_KIND_FQBN, BOARD_KIND_LABELS, type BoardKind } from '@velxio/types/board';
import { stripBrandPrefix } from '@velxio/utils/exampleToBuildNetlistInput';
import { loadExample } from '@velxio/utils/loadExample';
import { circuitOf, withWaypoints } from '../bench/circuit';
import { SETUPS_URL } from '../bench/config';
import { getLang, setLang } from '../bench/lang';
import { Bindings } from './Bindings';
import {
  adminHeaders,
  draftFromSheet,
  dropDraft,
  fieldOf,
  folderFiles,
  ID_RE,
  levelIds,
  loadDraft,
  loadToken,
  newDraft,
  parseRest,
  saveDraft,
  saveToken,
  sceneIds,
  sheetFqbn,
  tryMode,
  tryUrl,
  withScene,
  type Field,
  type FolderFile,
  type StudioDraft,
} from './draft';
import { text } from './text';
import './studio.css';

/** The boards a new setup may take: the deployment's, among those Velxio compiles for. */
const BOARDS = (Object.keys(BOARD_KIND_FQBN) as BoardKind[]).filter((k) => BOARD_KIND_FQBN[k] && isBoardAllowed(k));

interface IndexEntry {
  id: string;
  title?: string;
  status?: string;
}

type Outcome = { kind: 'ok' | 'error' | 'info'; text: string; link?: string } | null;

export default function StudioPage() {
  const lang = getLang();
  useEffect(() => {
    document.documentElement.lang = lang;
    void loadLocale(lang).then(() => i18n.changeLanguage(lang));
  }, [lang]);
  // The panel takes its width from the editor rather than covering the circuit.
  const [open, setOpen] = useState(true);
  return (
    <>
      <div className="studio-editor" data-panel={open ? 'open' : 'closed'}>
        <EditorPage />
      </div>
      <StudioPanel open={open} setOpen={setOpen} />
    </>
  );
}

/** The editor's board, files and circuit, in the sheet's shape. `types`: a catalogue id back to the sheet's type. */
function fromEditor(types: Map<string, string>) {
  const sim = useSimulatorStore.getState();
  const board = sim.boards.find((b) => b.id === sim.activeBoardId) ?? sim.boards[0];
  const files = board ? useEditorStore.getState().getGroupFiles(board.activeFileGroupId).map(({ name, content }) => ({ name, content })) : [];
  const circuit = circuitOf(sim.components, sim.wires, (id) => types.get(id) ?? `wokwi-${id}`);
  // The sheet names the board by its kind in the wires, whatever id the editor gave it.
  if (board && board.id !== board.boardKind) {
    const end = (e: { componentId: string; pinName: string }) => (e.componentId === board.id ? { ...e, componentId: board.boardKind } : e);
    circuit.wires = circuit.wires.map((w) => ({ ...w, start: end(w.start), end: end(w.end) }));
  }
  return { board, boards: sim.boards.length, files, circuit };
}

/** The draft as one of Velxio's examples: what the editor loads. */
async function loadIntoEditor(d: StudioDraft) {
  const parsed = parseRest(d.rest);
  const libraries = 'value' in parsed && Array.isArray(parsed.value.libraries) ? parsed.value.libraries.filter((l): l is string => typeof l === 'string') : [];
  await loadExample({
    id: d.id,
    title: d.title,
    description: '',
    category: 'basics',
    difficulty: 'beginner',
    boardType: d.board.kind,
    code: d.files[0]?.content ?? '',
    files: d.files,
    components: d.circuit.components as never,
    wires: d.circuit.wires as never,
    // The sheet pins versions ("Servo@1.2.2"); Velxio's manifest wants names.
    libraries: libraries.map((l) => l.split('@')[0]),
  });
  const sim = useSimulatorStore.getState();
  sim.setWires(withWaypoints(sim.wires, d.circuit.wires));
}

async function readSheet(id: string): Promise<StudioDraft> {
  const t = text();
  const res = await fetch(`${SETUPS_URL}/${id}/setup.json`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(t.sheetFailed(id, String(res.status)));
  const sheet = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!sheet || typeof sheet !== 'object' || sheet.id !== id) throw new Error(t.sheetFailed(id, 'JSON'));
  let scene: string | null = null;
  const svg = (sheet.scene as { svg?: unknown } | undefined)?.svg;
  if (typeof svg === 'string' && /^[a-z0-9-]+\.svg$/.test(svg)) {
    const r = await fetch(`${SETUPS_URL}/${id}/${svg}`, { cache: 'no-cache' }).catch(() => null);
    if (r?.ok) scene = await r.text();
  }
  return draftFromSheet(sheet, scene);
}

/** One of the three back-office requests, on this origin (the studio server relays them, Authorization included, to the hub). */
async function admin(name: 'setup-check' | 'setup-zip' | 'setup-try', body: object, token: string): Promise<Response> {
  return fetch(`/admin/api/${name}`, { method: 'POST', headers: adminHeaders(token), body: JSON.stringify(body) });
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []);

function StudioPanel({ open, setOpen }: { open: boolean; setOpen(open: boolean): void }) {
  const t = text();
  const [draft, setDraft] = useState<StudioDraft | null>(null);
  const [kept, setKept] = useState(true);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[] | null>(null);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [tryLevel, setTryLevel] = useState(0);
  const [boards, setBoards] = useState(1);
  const [token, setToken] = useState(loadToken);
  const types = useRef(new Map<string, string>());

  useEffect(() => {
    document.title = `${t.title} · ${BRAND_NAME}`;
  });

  // ?open=<id>: that setup, straight away (a reload comes back to it).
  useEffect(() => {
    const id = new URLSearchParams(location.search).get('open');
    if (id) void openSetup(id);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The editor's circuit and sketch follow into the draft, which is kept on every change.
  useEffect(() => {
    if (!draft) return;
    const follow = () => {
      const now = fromEditor(types.current);
      setBoards(now.boards);
      setDraft((d) => {
        if (!d) return d;
        const kind = now.board?.boardKind ?? d.board.kind;
        const board = kind === d.board.kind ? d.board : { kind, fqbn: sheetFqbn(BOARD_KIND_FQBN[kind as BoardKind] ?? '') };
        return { ...d, board, files: now.files, circuit: now.circuit };
      });
    };
    const a = useEditorStore.subscribe((s, p) => s.files !== p.files && follow());
    const b = useSimulatorStore.subscribe((s, p) => (s.components !== p.components || s.wires !== p.wires || s.boards !== p.boards) && follow());
    return () => {
      a();
      b();
    };
  }, [draft?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (draft) setKept(saveDraft(draft));
  }, [draft]);

  async function start(d: StudioDraft, said: string | null) {
    types.current = new Map(d.circuit.components.map((c) => [stripBrandPrefix(c.type), c.type]));
    await loadIntoEditor(d);
    setDraft(d);
    setNote(said);
    setProblems(null);
    setOutcome(null);
    setTryLevel(0);
    history.replaceState(null, '', `${location.pathname}?open=${encodeURIComponent(d.id)}`);
  }

  async function openSetup(id: string, served = false) {
    setError(null);
    if (!ID_RE.test(id)) return setError(t.badId);
    const kept = served ? null : loadDraft(id);
    if (kept) return start(kept, t.resumed);
    setBusy(t.loading);
    try {
      await start(await readSheet(id), null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  function create(id: string, title: string, kind: string) {
    setError(null);
    if (!ID_RE.test(id)) return setError(t.badId);
    const kept = loadDraft(id);
    if (kept) return void start(kept, t.resumed);
    void start(newDraft(id, title.trim() || id, { kind, fqbn: sheetFqbn(BOARD_KIND_FQBN[kind as BoardKind] ?? '') }), null);
  }

  function close() {
    setDraft(null);
    setProblems(null);
    setOutcome(null);
    history.replaceState(null, '', location.pathname);
  }

  async function revert() {
    if (!draft || !window.confirm(t.confirmRevert)) return;
    const { id, title, board } = draft;
    dropDraft(id);
    try {
      await start(await readSheet(id), null);
    } catch {
      // Not served: a new one, as it was created.
      await start(newDraft(id, title, board), null);
    }
  }

  /** The folder from the draft as the editor has it now; null with the reason said. */
  function folder(): FolderFile[] | null {
    if (!draft) return null;
    const now = fromEditor(types.current);
    const d = { ...draft, files: now.files, circuit: now.circuit };
    const built = folderFiles(d);
    if (Array.isArray(built)) return built;
    setOutcome({ kind: 'error', text: `${t.buildError[built.error]}${built.detail ? ` : ${built.detail}` : ''}` });
    return null;
  }

  async function request(label: string, run: (files: FolderFile[]) => Promise<void>) {
    const files = folder();
    if (!files) return;
    setBusy(label);
    setOutcome(null);
    try {
      await run(files);
    } catch {
      setOutcome({ kind: 'error', text: t.unreachable });
    } finally {
      setBusy(null);
    }
  }

  /** A refusal: its problems in front of their field, its detail (the hub's, in French) as the outcome. */
  async function refusal(res: Response) {
    const body = (await res.json().catch(() => null)) as { detail?: unknown; problems?: unknown } | null;
    const listed = strings(body?.problems);
    setProblems(listed.length ? listed : null);
    setOutcome({ kind: 'error', text: typeof body?.detail === 'string' ? body.detail : t.refused(res.status) });
  }

  const check = () =>
    request(t.check, async (files) => {
      const res = await admin('setup-check', { files }, token);
      if (!res.ok) return refusal(res);
      const body = (await res.json()) as { ok?: unknown; problems?: unknown };
      const listed = strings(body.problems);
      setProblems(listed);
      setOutcome(body.ok === true && !listed.length ? { kind: 'ok', text: t.checkOk } : { kind: 'error', text: t.problems(listed.length) });
    });

  const tryIt = () =>
    request(t.try, async (files) => {
      const mode = tryMode(draft!);
      const res = await admin('setup-try', { files, mode, level: mode === 'challenge' ? tryLevel : 0 }, token);
      if (!res.ok) return refusal(res);
      setProblems(null);
      const body = (await res.json()) as { open_url?: unknown; expires_at?: unknown };
      const url = tryUrl(body.open_url, location.href);
      if (!url) return setOutcome({ kind: 'error', text: t.refused(res.status) });
      const exp = typeof body.expires_at === 'number' ? new Date(body.expires_at < 1e12 ? body.expires_at * 1000 : body.expires_at) : new Date(String(body.expires_at));
      const until = Number.isNaN(exp.getTime()) ? '?' : exp.toLocaleTimeString(getLang() === 'en' ? 'en-GB' : 'fr-FR', { hour: '2-digit', minute: '2-digit' });
      // The tokens are in the fragment: the new tab must not reach back to this one.
      const tab = window.open(url, '_blank');
      if (tab) tab.opener = null;
      setOutcome({ kind: tab ? 'ok' : 'info', text: tab ? t.tryOpened(until) : t.tryBlocked, link: url });
    });

  const zip = () =>
    request(t.zip, async (files) => {
      const res = await admin('setup-zip', { files }, token);
      if (!res.ok) return refusal(res);
      setProblems(null);
      const name = `${draft!.id}.zip`;
      const href = URL.createObjectURL(await res.blob());
      const a = Object.assign(document.createElement('a'), { href, download: name });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 10_000);
      setOutcome({ kind: 'ok', text: t.zipDone(name) });
    });

  const update = (patch: Partial<StudioDraft>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  async function pickScene(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !draft) return;
    const svg = await file.text();
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    if (doc.getElementsByTagName('parsererror').length || doc.documentElement.nodeName.toLowerCase() !== 'svg') {
      return setOutcome({ kind: 'error', text: t.sceneBad });
    }
    update({ scene: svg, rest: withScene(draft.rest) });
  }

  if (!open) {
    return (
      <button type="button" className="studio-tab" onClick={() => setOpen(true)}>
        {t.show}
      </button>
    );
  }

  const byField = (f: Field) => (problems ?? []).filter((p) => fieldOf(p) === f);
  const levels = draft ? levelIds(draft.rest) : [];
  const parsed = draft ? parseRest(draft.rest) : null;

  return (
    <aside className="studio" aria-label={t.title}>
      <header className="studio-head">
        <h1>{t.title}</h1>
        <div className="studio-lang" role="group">
          {(['fr', 'en'] as const).map((l) => (
            <button key={l} type="button" lang={l} aria-pressed={getLang() === l} onClick={() => setLang(l)}>
              {l.toUpperCase()}
            </button>
          ))}
        </div>
        <button type="button" className="studio-fold" onClick={() => setOpen(false)} aria-label={t.hide} title={t.hide}>
          ›
        </button>
      </header>

      <label className="studio-field studio-token">
        <span>{t.token}</span>
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={token}
          title={t.tokenHint}
          onChange={(e) => {
            setToken(e.target.value);
            saveToken(e.target.value);
          }}
        />
      </label>

      {error && <p className="studio-out" data-kind="error" role="alert">{error}</p>}
      {busy && !draft && <p className="studio-out" data-kind="info">{busy}</p>}

      {!draft ? (
        <Chooser onCreate={create} onOpen={(id) => void openSetup(id)} />
      ) : (
        <>
          <Section title={t.sections.identity} problems={byField('identity')}>
            <p className="studio-id">
              <code>{draft.id}</code>
              <button type="button" className="studio-link" onClick={close}>
                {t.close}
              </button>
              <button type="button" className="studio-link" onClick={() => void revert()}>
                {t.revert}
              </button>
            </p>
            <label className="studio-field">
              <span>{t.setupTitle}</span>
              <input value={draft.title} maxLength={80} onChange={(e) => update({ title: e.target.value })} />
            </label>
            <p className="studio-small">{t.boardOf(BOARD_KIND_LABELS[draft.board.kind as BoardKind] ?? draft.board.kind)} · <code>{draft.board.fqbn}</code></p>
            {boards > 1 && <p className="studio-small" data-kind="error">{t.oneBoard}</p>}
            <p className="studio-small">{note ?? (kept ? t.kept : t.notKept)}</p>
          </Section>

          <div className="studio-actions">
            <button type="button" className="studio-btn" disabled={!!busy} onClick={() => void check()}>
              {t.check}
            </button>
            <button type="button" className="studio-btn studio-btn-primary" disabled={!!busy} onClick={() => void tryIt()}>
              {t.try}
            </button>
            <button type="button" className="studio-btn" disabled={!!busy} onClick={() => void zip()}>
              {t.zip}
            </button>
            {levels.length > 0 && (
              <label className="studio-field studio-inline">
                <span>{t.tryLevel}</span>
                <select value={tryLevel} onChange={(e) => setTryLevel(Number(e.target.value))}>
                  {levels.map((id, i) => (
                    <option key={id} value={i}>
                      {i + 1} · {id}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {!levels.length && <span className="studio-small">{t.tryFree}</span>}
          </div>
          {busy && <p className="studio-out" data-kind="info">{t.working}</p>}
          {outcome && (
            <p className="studio-out" data-kind={outcome.kind} role="status">
              {outcome.text}{' '}
              {outcome.link && (
                <a href={outcome.link} target="_blank" rel="noopener noreferrer">
                  {t.tryLink}
                </a>
              )}
            </p>
          )}

          <Section title={t.sections.editor} problems={byField('editor')}>
            <p className="studio-small">{draft.files.map((f) => f.name).join(', ')}</p>
            {draft.en.length > 0 && <p className="studio-small">{t.enFiles(draft.en.map((f) => f.name).join(', '))}</p>}
          </Section>

          <Section title={t.sections.scene} problems={byField('scene')}>
            <SceneField svg={draft.scene} onPick={pickScene} onRemove={() => update({ scene: null })} />
          </Section>

          {draft.scene !== null && (
            <Section title={t.sections.bindings} problems={[]}>
              <Bindings rest={draft.rest} svg={draft.scene} circuit={draft.circuit} boardKind={draft.board.kind} onRest={(rest) => update({ rest })} />
            </Section>
          )}

          <Section title={t.sections.sheet} problems={byField('sheet')}>
            <p className="studio-small">{t.sheetHint}</p>
            <textarea className="studio-json" spellCheck={false} value={draft.rest} onChange={(e) => update({ rest: e.target.value })} aria-invalid={!!parsed && 'error' in parsed} />
            {parsed && 'error' in parsed && <p className="studio-small" data-kind="error">{t.jsonError(parsed.error)}</p>}
          </Section>

          <Section title={t.sections.solutions} problems={byField('solutions')}>
            {!levels.length && <p className="studio-small">{t.solutionsNone}</p>}
            {levels.map((id) => (
              <div key={id} className="studio-solution">
                <div>
                  <code>{t.solutionOf(id)}</code>
                  <button
                    type="button"
                    className="studio-link"
                    onClick={() => {
                      const sketch = fromEditor(types.current).files[0]?.content ?? '';
                      if (draft.solutions[id]?.trim() && !window.confirm(t.confirmFromEditor)) return;
                      update({ solutions: { ...draft.solutions, [id]: sketch } });
                    }}
                  >
                    {t.fromEditor}
                  </button>
                </div>
                <textarea className="studio-code" spellCheck={false} value={draft.solutions[id] ?? ''} onChange={(e) => update({ solutions: { ...draft.solutions, [id]: e.target.value } })} />
              </div>
            ))}
          </Section>
        </>
      )}
    </aside>
  );
}

function Section({ title, problems, children }: { title: string; problems: string[]; children: ReactNode }) {
  return (
    <section className="studio-section">
      <h2>{title}</h2>
      {problems.length > 0 && (
        <ul className="studio-problems">
          {problems.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      )}
      {children}
    </section>
  );
}

function SceneField({ svg, onPick, onRemove }: { svg: string | null; onPick(e: ChangeEvent<HTMLInputElement>): void; onRemove(): void }) {
  const t = text();
  const ids = svg ? sceneIds(svg) : [];
  return (
    <>
      <label className="studio-btn studio-file">
        {svg === null ? t.sceneUpload : t.sceneReplace}
        <input type="file" accept=".svg,image/svg+xml" onChange={onPick} />
      </label>
      {svg !== null && (
        <button type="button" className="studio-link" onClick={onRemove}>
          {t.sceneRemove}
        </button>
      )}
      {svg === null ? (
        <p className="studio-small">{t.sceneNone}</p>
      ) : ids.length ? (
        <>
          <p className="studio-small">{t.sceneIds(ids.length)}</p>
          <ul className="studio-ids">
            {ids.map((id, i) => (
              <li key={`${id}-${i}`}>
                <code>{id}</code>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="studio-small">{t.sceneNoIds}</p>
      )}
    </>
  );
}

function Chooser({ onCreate, onOpen }: { onCreate(id: string, title: string, kind: string): void; onOpen(id: string): void }) {
  const t = text();
  const [id, setId] = useState('');
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<string>(BOARDS[0] ?? 'arduino-uno');
  const [index, setIndex] = useState<IndexEntry[] | string | null>(null);

  useEffect(() => {
    fetch(`${SETUPS_URL}/index.json`, { cache: 'no-cache' })
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        const body = (await r.json()) as { setups?: unknown };
        const list = Array.isArray(body?.setups) ? body.setups : [];
        // Every status, private setups included: the studio also edits what visitors do not see.
        setIndex(list.filter((e): e is IndexEntry => !!e && typeof e.id === 'string' && ID_RE.test(e.id)));
      })
      .catch((e: unknown) => setIndex(t.openFailed(e instanceof Error ? e.message : String(e))));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <p className="studio-small">{t.intro}</p>
      <form
        className="studio-section"
        onSubmit={(e) => {
          e.preventDefault();
          onCreate(id.trim(), title, kind);
        }}
      >
        <h2>{t.newTitle}</h2>
        <label className="studio-field">
          <span>{t.id}</span>
          <input value={id} onChange={(e) => setId(e.target.value)} placeholder="setup-d" pattern="[a-z0-9][a-z0-9\-]{0,31}" title={t.idHint} required />
        </label>
        <label className="studio-field">
          <span>{t.setupTitle}</span>
          <input value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="studio-field">
          <span>{t.board}</span>
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            {BOARDS.map((k) => (
              <option key={k} value={k}>
                {BOARD_KIND_LABELS[k] ?? k}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="studio-btn studio-btn-primary">
          {t.create}
        </button>
      </form>

      <section className="studio-section">
        <h2>{t.openTitle}</h2>
        {index === null ? (
          <p className="studio-small">{t.loading}</p>
        ) : typeof index === 'string' ? (
          <p className="studio-small" data-kind="error">{index}</p>
        ) : !index.length ? (
          <p className="studio-small">{t.openEmpty}</p>
        ) : (
          <ul className="studio-index">
            {index.map((e) => (
              <li key={e.id}>
                <button type="button" className="studio-link" onClick={() => onOpen(e.id)}>
                  <code>{e.id}</code> {e.title && <span>{e.title}</span>} {e.status === 'soon' && <em>{t.soon}</em>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
