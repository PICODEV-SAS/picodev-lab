/**
 * The bench workspace: /bench/<setup> (Libre) and /bench/<setup>/challenge (Défi).
 *
 * A full page of its own, built from Velxio's store-driven parts (code
 * editor, simulator canvas, stores) and from ./engine (scene, couplings,
 * tests). Everything it shows about the bench comes from the setup sheet;
 * names and links come from the deployment file.
 */
import { Fragment, useEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { CodeEditor } from '@velxio/components/editor/CodeEditor';
import { i18n, loadLocale } from '@velxio/i18n';
import { BRAND_NAME } from '@velxio/lib/deploymentConfig';
import { compileCode, type CompileResult } from '@velxio/services/compilation';
import registry from '@velxio/services/ComponentRegistry';
import { claimPartPin, releasePartPins } from '@velxio/simulation/partPinOwnership';
import { ADC_PIN_MAP } from '@velxio/simulation/spice/connectAnalogInputsToMcu';
import { startSimulation } from '@velxio/simulation/spice/start';
import { getVirtualI2cDevice } from './devices';
import { useEditorStore } from '@velxio/store/useEditorStore';
import { useOscilloscopeStore } from '@velxio/store/useOscilloscopeStore';
import { getBoardPinManager, getBoardSimulator, useSimulatorStore } from '@velxio/store/useSimulatorStore';
import type { BoardKind } from '@velxio/types/board';
import { boardPinToNumber } from '@velxio/utils/boardPinMapping';
import { stripBrandPrefix } from '@velxio/utils/exampleToBuildNetlistInput';
import { loadExample } from '@velxio/utils/loadExample';
import type { AnalogSim } from './analog';
import { createRecorder, type Recorder } from './capture';
import { Camera, ViewSwitch, type View } from './Camera';
import { CapturePanel } from './CapturePanel';
import { checkCircuit, circuitOf, placeFree, withWaypoints, type Catalogue, type PushedCircuit, type Size } from './circuit';
import { EXIT_URL, HOME_URL, HUB_URL } from './config';
import { applyCouplings, mountScene, runLevel } from './engine';
import { Banner, Brand, Footer, LangSwitch, Message, SimClock } from './frame';
import { fetchBenches, fetchStatus, hubPaused, queueView, SPEEDS, startOwner, withShare, type BenchCapture, type BenchOffer, type HubStatus, type OwnerLink, type SessionInfo } from './hub';
import { AgentJournal, QueuePanel, useKindLink, VisibilityMenu, type AgentCall } from './HubControls';
import { getLang, localizeSheet, localPath } from './lang';
import { dropZone, Fold, Grip, moveTo, Splitter, step, useLayout, type Column, type Part, type Section } from './layout';
import { LevelPanel, TestList, type AnswerState } from './LevelPanel';
import { endSession, readHints, readLevel, readSpeed, saveHints, saveLevel, saveSpeed, sessionStart } from './levelMemory';
import { setEditorReadOnly, themeMonaco } from './monaco';
import { createProbe, type ProbedSim, type SimProbe } from './probe';
import { Schema } from './Schema';
import { fetchSetup, toExample, type LoadedSetup } from './sheet';
import { emptySerial, serialView } from './serial';
import { text } from './text';
import { Traces } from './Traces';
import type { TestResult } from './types';
import { boardPins, type BoardPins } from './wiring';
import './bench.css';

/** Read by the end page of the site: the last sketch the visitor worked on. */
const LAST_SKETCH_KEY = 'picodev-lab:last-sketch';
const sketchKey = (setupId: string) => `picodev-lab:sketch:${setupId}`;
/** Whether the editor column is shown, for this tab only: a new session starts with it. */
const codeShownKey = (setupId: string) => `picodev-lab:bench-code:${setupId}`;

type Mode = 'free' | 'challenge';
interface Bench extends LoadedSetup {
  boardId: string;
  /** The board's pins as its simulator numbers them (Velxio's mapping). */
  pins: BoardPins;
  probe: SimProbe;
  /** The logic capture, shared by the agent (through the hub) and the visitor. */
  recorder: Recorder;
  /** The hub's banner (GET <hub>/status), in the page's language. */
  banner?: string;
  /** The hub takes no new session (maintenance, setup closed): the bench simulates without it. */
  paused?: string;
}

const seconds1 = (s: number, locale = text().locale) => s.toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
/** What pause and speed need of a Velxio simulator (AVRSimulator has all of it). */
interface PausableSim {
  start?(): void;
  stop?(): void;
  /** Stops and keeps what is scheduled ahead (a level's stimulus); stop() empties it, fit for a reset. */
  pause?(): void;
  setSpeed?(speed: number): void;
}

const clock = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

/** The pin names a web component of the canvas exposes (Velxio's wires read the same), or null. */
function pinNames(el: Element | null): string[] | null {
  const info = (el as { pinInfo?: unknown } | null)?.pinInfo;
  return Array.isArray(info) && info.length ? info.map((p: { name?: unknown }) => String(p?.name)) : null;
}

/** The pins of a part of the catalogue, from a detached element of its tag; null when it cannot say. */
function partPins(tagName: string | undefined, properties: Record<string, unknown>): string[] | null {
  if (!tagName || !customElements.get(tagName)) return null;
  try {
    const el = document.createElement(tagName);
    for (const [k, v] of Object.entries(properties)) (el as unknown as Record<string, unknown>)[k] = v; // as DynamicComponent does
    return pinNames(el);
  } catch {
    return null;
  }
}

/**
 * The room a part of the catalogue takes on the canvas, measured off screen
 * once rendered, with the 6 px Velxio's wrapper adds on each side; null when
 * it cannot say.
 */
async function partSize(tagName: string | undefined, properties: Record<string, unknown>): Promise<Size | null> {
  if (!tagName || !customElements.get(tagName)) return null;
  const el = document.createElement(tagName);
  try {
    for (const [k, v] of Object.entries(properties)) (el as unknown as Record<string, unknown>)[k] = v;
    el.style.cssText = 'position:fixed;left:-10000px;top:0;visibility:hidden';
    document.body.append(el);
    await (el as { updateComplete?: Promise<unknown> }).updateComplete; // a Lit element renders in a microtask
    const r = el.getBoundingClientRect();
    return r.width && r.height ? { w: r.width + 12, h: r.height + 12 } : null;
  } catch {
    return null;
  } finally {
    el.remove();
  }
}

const catalogue: Catalogue = {
  kind(type) {
    const meta = registry.getById(stripBrandPrefix(type));
    return !meta ? null : meta.category === 'boards' ? 'board' : 'part';
  },
  pins: (type, properties) => partPins(registry.getById(stripBrandPrefix(type))?.tagName, properties),
};

function readSaved(setupId: string): string | null {
  try {
    return localStorage.getItem(sketchKey(setupId));
  } catch {
    return null; // storage refused (private mode): the sketch of the sheet is used
  }
}

export default function BenchPage({ mode }: { mode: Mode }) {
  const { setupId = '' } = useParams();
  const lang = getLang();
  // Velxio's own parts shown here (code editor, schematic) follow the bench's language.
  // A switch reloads the page (lang.ts): this runs once.
  useEffect(() => {
    document.documentElement.lang = lang;
    void loadLocale(lang).then(() => i18n.changeLanguage(lang));
  }, [lang]);
  // Keyed: another setup is another page, with nothing kept of the previous one.
  return <Loader key={setupId} setupId={setupId} mode={mode} />;
}

function Loader({ setupId, mode }: { setupId: string; mode: Mode }) {
  const [bench, setBench] = useState<Bench | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** v0.18: a setup the hub lists in `hidden_setups` (disabled): no bench at all. */
  const [hidden, setHidden] = useState(false);
  const t = text();

  useEffect(() => {
    let cancelled = false;
    let probe: SimProbe | undefined;
    let recorder: Recorder | undefined;
    // A page without Velxio's EditorPage starts the electrical simulation itself.
    const stopSpice = startSimulation();
    const restoreMonaco = themeMonaco();

    (async () => {
      const [fetched, status] = await Promise.all([fetchSetup(setupId), fetchStatus(getLang())]);
      if (cancelled) return;
      // A draft tried from the back-office opens even when the served setup is disabled.
      if (!fetched.draft && status?.hidden.includes(setupId)) {
        setHidden(true);
        return;
      }
      const paused = hubPaused(status, setupId);
      // In the language of this page load, starting sketch included; a saved sketch wins.
      const loaded = { ...fetched, sheet: localizeSheet(fetched.sheet, getLang()) };
      await loadExample(toExample(loaded.sheet));
      if (cancelled) return;
      const loadedSim = useSimulatorStore.getState();
      loadedSim.setWires(withWaypoints(loadedSim.wires, loaded.sheet.circuit.wires));

      const saved = readSaved(setupId);
      const editor = useEditorStore.getState();
      if (saved !== null) editor.setFileContent(editor.activeFileId, saved);

      const boardId = useSimulatorStore.getState().activeBoardId;
      const sim = boardId ? getBoardSimulator(boardId) : null;
      const pins = boardId ? getBoardPinManager(boardId) : null;
      if (!boardId || !sim || !pins) throw new Error(text().boardNotSimulated(loaded.sheet.board.kind));
      await registry.load();
      if (cancelled) return;
      const kind = useSimulatorStore.getState().boards.find((b) => b.id === boardId)?.boardKind ?? (loaded.sheet.board.kind as BoardKind);
      const numbers = boardPins(partPins(registry.getById(kind)?.tagName, {}) ?? [], (name) => boardPinToNumber(kind, name), ADC_PIN_MAP[kind] ?? []);

      // Seat any fixed-firmware controller boards (strictly after loadExample, which
      // wipes boards). Their cross-board wires auto-rebind via the store subscription.
      // Seat the fixed-firmware controller board(s). Their virtual I2C devices are
      // (re)registered in launch() instead, because each run resets the main bus.
      const store = useSimulatorStore.getState();
      for (const c of loaded.sheet.controllers ?? []) {
        if (!store.boards.find((b) => b.id === c.id)) store.addBoard(c.kind as never, c.x, c.y, c.id);
        store.compileBoardProgram(c.id, c.hex); // fixed HEX straight in — no cloud compile
      }

      const scope = useOscilloscopeStore.getState();
      scope.channels.forEach((c) => scope.removeChannel(c.id));
      loaded.sheet.probes.forEach((p) => scope.addChannel(boardId, p.pin, p.label));
      scope.setTriggerMode('auto');
      scope.setCapturing(true);

      probe = createProbe(sim as unknown as ProbedSim, pins, {
        claim: (pin) => claimPartPin(boardId, pin, 'bench-probe'),
        releaseAll: () => releasePartPins('bench-probe'),
      });
      recorder = createRecorder(loaded.sheet, probe);
      setBench({
        ...loaded,
        boardId,
        pins: numbers,
        probe,
        recorder,
        banner: status?.banner,
        paused: paused ? (paused === 'maintenance' ? text().maintenance : text().setupClosed) : undefined,
      });
    })().catch((e: unknown) => {
      if (!cancelled) setError(e instanceof Error ? e.message : String(e));
    });

    return () => {
      cancelled = true;
      const boardId = useSimulatorStore.getState().activeBoardId;
      if (probe && boardId) useSimulatorStore.getState().stopBoard(boardId);
      recorder?.close();
      probe?.dispose();
      restoreMonaco();
      stopSpice();
    };
  }, [setupId]);

  if (hidden) {
    return (
      <Message title={t.setupHidden}>
        <p>{t.setupHiddenText}</p>
        <p>
          <a className="bench-btn bench-btn-primary" href={HOME_URL}>
            {t.backHome}
          </a>
        </p>
      </Message>
    );
  }
  if (error) {
    return (
      <Message title={t.notFound}>
        <p>{t.notFoundText}</p>
        <p>
          <a className="bench-btn bench-btn-primary" href={HOME_URL}>
            {t.backHome}
          </a>
        </p>
        <p className="bench-message-detail">{error}</p>
      </Message>
    );
  }
  if (!bench) return <Message title={t.loading} />;
  return <Workspace bench={bench} mode={mode} />;
}

function Workspace({ bench, mode }: { bench: Bench; mode: Mode }) {
  const { sheet, boardId, probe } = bench;
  // Free mode edits the circuit, which the scene would no longer show: the schema only.
  const sceneSvg = mode === 'free' ? undefined : bench.sceneSvg;
  const lang = getLang();
  const t = text();
  const levels = mode === 'challenge' ? sheet.levels : [];

  const running = useSimulatorStore((s) => s.boards.find((b) => b.id === boardId)?.running ?? false);
  const serial = useSimulatorStore((s) => s.boards.find((b) => b.id === boardId)?.serialOutput ?? '');
  const [compiling, setCompiling] = useState(false);
  // Pause keeps the processor where it is (no reset); the speed is kept in this browser.
  const [paused, setPaused] = useState(false);
  const [speed, setSpeed] = useState(() => readSpeed(SPEEDS));
  const [compileSecs, setCompileSecs] = useState<number | null>(null);
  const [journal, say] = useReducer(
    (lines: string[], line: string) => [...lines, `${new Date().toLocaleTimeString(text().locale)}  ${line}`].slice(-500),
    [],
  );
  const [tab, setTab] = useState<'vue' | 'tests' | 'journal'>('vue');
  const { layout, setColumns, setParts, setSize, toggleFold, reset: resetLayout } = useLayout();
  // Hidden while the agent's last code is a compiled program, shown again by a push; the visitor's button wins until then.
  const [codeShown, setCodeShown] = useState(() => {
    try {
      return sessionStorage.getItem(codeShownKey(sheet.id)) !== 'hidden';
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      sessionStorage.setItem(codeShownKey(sheet.id), codeShown ? 'shown' : 'hidden');
    } catch {
      // storage refused: the choice lasts for the page
    }
  }, [codeShown, sheet.id]);
  /** The agent's compiled program (v0.15): what Lancer runs, without compiling, until the code is pushed, reset or edited here. */
  const agentHex = useRef<string | null>(null);
  const [agentBuilt, setAgentBuilt] = useState<'sources' | 'program' | null>(null);
  function fromAgent(hex: string | null, sources = false) {
    agentHex.current = hex;
    setAgentBuilt(hex === null ? null : sources ? 'sources' : 'program');
    setEditorReadOnly(hex !== null);
  }
  const boxes = useRef<Partial<Record<Section, HTMLDivElement | null>>>({});
  const [view, setView] = useState<View>(sceneSvg ? 'decor' : 'schema');
  // Défi resumes at the level reached in this browser; Libre has no levels.
  const [levelIndex, setLevelIndex] = useState(() => (levels.length ? readLevel(sheet.id, levels.length) : 0));
  /** What the simulation run measured; the answer tests are not in it. */
  const [runResults, setResults] = useState<TestResult[]>([]);
  /** The hub's verdicts on the typed answers, kept until the level changes. */
  const [answers, setAnswers] = useState<Record<string, TestResult>>({});
  const [pendingAnswers, setPending] = useState<Record<string, AnswerState>>({});
  const answersNow = useRef<Record<string, TestResult>>({});
  const answerTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  /** What the hub hands the session (`secrets`), for the virtual devices: read when a run starts. */
  const secrets = useRef<Record<string, string>>({});
  // The hints shown stay shown, per setup and level, in this browser.
  const hintsFor = (i: number) => (levels[i] ? readHints(sheet.id, levels[i].id, levels[i].hints.length) : 0);
  const [hints, setHints] = useState(() => hintsFor(levelIndex));
  // One result per test of the level: a verdict, else the run's, else pending.
  const resultsOf = (given: Record<string, TestResult>, ran: TestResult[]): TestResult[] =>
    (levels[levelIndex]?.tests ?? []).map((t) => given[t.id] ?? ran.find((r) => r.id === t.id) ?? { id: t.id, status: 'pending' });
  const results = useMemo(() => resultsOf(answers, runResults), [answers, runResults, levelIndex]); // eslint-disable-line react-hooks/exhaustive-deps
  const passed = results.length > 0 && results.every((r) => r.status === 'passed');
  // The session counts from its start in this tab, not from the page load: a reload or a language change keeps it.
  const [startedAt] = useState(() => sessionStart(sheet.id, mode));
  const [tickMs, setTickMs] = useState(() => Date.now());
  const elapsed = Math.max(0, Math.floor((tickMs - startedAt) / 1000));
  const [hubStatus, setHubStatus] = useState<HubStatus>('connecting');
  const [hubInfo, setHubInfo] = useState<SessionInfo | null>(null);
  const [viewers, setViewers] = useState(0);
  const [agentCalls, addAgentCall] = useReducer((calls: AgentCall[], call: AgentCall) => [...calls, call].slice(-200), []);
  const hub = useRef<OwnerLink | null>(null);
  const [offers, setOffers] = useState<BenchOffer[]>([]);
  /** The hub pushed the offer (`benches`, v0.20): the reading at load, if later, is older. */
  const offersPushed = useRef(false);
  /** The bench's last capture for the session (v0.20), relayed by the hub. */
  const [benchCapture, setBenchCapture] = useState<BenchCapture | null>(null);
  /** The serial output of the bench's board during a real turn (v0.23), and the editor's lines on its loads (v0.24). */
  const [benchSerial, onBenchSerial] = useReducer(serialView, emptySerial);
  const [queue, onQueue] = useReducer(queueView, { phase: 'none' });
  const [notice, setNotice] = useState<string | null>(null);
  // No hub session while the hub takes none: no sharing, no queue, no agent.
  const hubOn = !!HUB_URL && !bench.paused;
  // The bench filmed live during a turn with `video` (or `hls`, v0.20): shown first, the scene comes back at turn_end.
  const turnVideo = queue.phase === 'turn' && hubInfo?.owner ? { video: queue.video, hls: queue.hls } : null;
  const camera = turnVideo?.video ?? turnVideo?.hls;
  const [viewFor, setViewFor] = useState(camera);
  if (viewFor !== camera) {
    setViewFor(camera);
    setView(camera ? 'camera' : sceneSvg ? 'decor' : 'schema');
  }
  // A turn on a real bench: the program goes to its board, the browser simulates nothing, and
  // the circuit is the bench's wiring, which no edit changes.
  const realTurn = queue.phase === 'turn' && queue.kind !== 'sim';
  /** The circuit as loaded from the sheet: what a real bench is wired as. */
  const benchCircuit = useRef<Pick<ReturnType<typeof useSimulatorStore.getState>, 'components' | 'wires'> | null>(null);
  benchCircuit.current ??= { components: useSimulatorStore.getState().components, wires: useSimulatorStore.getState().wires };
  /** The visitor's own circuit (Libre), put aside during a real turn and put back after it. */
  const visitorCircuit = useRef<typeof benchCircuit.current>(null);
  useEffect(() => {
    const sim = useSimulatorStore.getState();
    const setCircuit = ({ components, wires }: NonNullable<typeof benchCircuit.current>) => {
      sim.setComponents(components);
      sim.setWires(wires);
      sim.recalculateAllWirePositions();
    };
    onBenchSerial({ type: realTurn ? 'reset' : 'clear' });
    if (!realTurn) {
      const kept = visitorCircuit.current;
      visitorCircuit.current = null;
      if (kept) {
        setCircuit(kept);
        say(text().logVisitorCircuit);
      }
      return;
    }
    now.current.halt();
    const wiring = benchCircuit.current!;
    if (sim.components === wiring.components && sim.wires === wiring.wires) return;
    visitorCircuit.current = { components: sim.components, wires: sim.wires };
    setCircuit(wiring);
    say(text().logBenchCircuit);
  }, [realTurn]);

  /** The current run: a token to drop late answers, and what to undo on stop. */
  const run = useRef({ token: 0, undo: [] as Array<() => void> });
  const scene = useRef<HTMLDivElement>(null);
  const serialBox = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const id = setInterval(() => setTickMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    document.title = `${sheet.title} · ${BRAND_NAME}`;
  }, [sheet.title]);

  // Autosave: the last sketch for the end page, and the sketch per setup once it
  // changes (an untouched starting sketch is not kept: it follows the language).
  useEffect(() => {
    const save = (edited: boolean) => {
      const file = useEditorStore.getState().files[0];
      if (!file) return;
      try {
        if (edited) localStorage.setItem(sketchKey(sheet.id), file.content);
        localStorage.setItem(LAST_SKETCH_KEY, JSON.stringify({ name: file.name, content: file.content }));
      } catch {
        // storage full or refused: the session goes on unsaved
      }
    };
    save(false);
    return useEditorStore.subscribe((s, prev) => {
      if (s.files !== prev.files) save(true);
    });
  }, [sheet.id]);

  useEffect(() => {
    if (!sceneSvg || !scene.current) return;
    return mountScene(scene.current, sceneSvg, sheet.scene?.bindings ?? [], probe);
  }, [sceneSvg, sheet, probe]);

  useEffect(() => {
    serialBox.current?.scrollTo(0, serialBox.current.scrollHeight);
  }, [serial, benchSerial]);

  useEffect(() => () => halt(), []); // eslint-disable-line react-hooks/exhaustive-deps

  // The hub ([hub] url): the session, what the bench publishes, what the agent sends.
  // The callbacks read `now`, so the connection outlives the renders.
  const now = useRef({ launch, goToLevel, levelIndex, running, results, answers, hints, halt, paused, speed, fromAgent, realTurn });
  now.current = { launch, goToLevel, levelIndex, running, results, answers, hints, halt, paused, speed, fromAgent, realTurn };
  useEffect(() => {
    if (!hubOn) return;
    // A part's type as the sheet (or the agent) wrote it; Velxio keeps the catalogue id only.
    const types = new Map((sheet.circuit.components as Array<{ type: string }>).map((c) => [stripBrandPrefix(c.type), c.type]));
    const typeOf = (id: string) => types.get(id) ?? `wokwi-${id}`;
    const link = startOwner(sheet, mode, probe, {
      state: () => ({
        setup: sheet.id,
        mode,
        files: useEditorStore.getState().files.map(({ name, content }) => ({ name, content })),
        level: now.current.levelIndex,
        running: now.current.running,
        results: now.current.results,
        hints: now.current.hints,
        circuit: circuitOf(useSimulatorStore.getState().components, useSimulatorStore.getState().wires, typeOf),
        clock: { t_ms: Math.round(probe.nowMs()), speed: now.current.speed, paused: now.current.paused },
      }),
      push(files, run) {
        // Code for the lab to compile: the editor comes back, unlocked.
        now.current.fromAgent(null);
        setCodeShown(true);
        useEditorStore.getState().loadFiles(files);
        say(text().logPushed(files.map((f) => f.name).join(', ')));
        if (run) void now.current.launch();
      },
      program(hex, files, run) {
        if (files) useEditorStore.getState().loadFiles(files);
        now.current.fromAgent(hex, !!files);
        setCodeShown(false);
        say(text().logProgram);
        void now.current.launch(run);
      },
      agent: (call) => addAgentCall({ ...call, at: new Date().toLocaleTimeString(text().locale) }),
      viewers: setViewers,
      status(s) {
        setHubStatus(s);
        // No queue state is kept: on every (re)connection the hub resends the place or turn in progress.
        if (s === 'live') onQueue({ type: 'reset' });
      },
      session: setHubInfo,
      queue: onQueue,
      notice(said) {
        setNotice(said);
        say(said);
      },
      // As "Niveau suivant": a try session's agent skips levels, a visitor's moves on once passed; Libre has none.
      level: (i) => i < levels.length && now.current.goToLevel(i),
      verdict(test, ok, error) {
        // A verdict in flight during a level change belongs to no test of this level.
        if (levels[now.current.levelIndex]?.tests.find((x) => x.id === test)?.spec.type !== 'answer') return;
        clearTimeout(answerTimers.current[test]);
        if (error) {
          setPending((p) => ({ ...p, [test]: { status: 'idle', error } }));
          return;
        }
        const t = text();
        const result: TestResult = { id: test, status: ok ? 'passed' : 'failed', detail: ok ? t.answerRight : t.answerWrong };
        // The ref follows every verdict at once; the state is updated functionally, so two verdicts before a render both stay.
        const given = (answersNow.current = { ...answersNow.current, [test]: result });
        setAnswers((a) => ({ ...a, [test]: result }));
        const cur = now.current;
        const merged = levels[cur.levelIndex].tests.map((x) => given[x.id] ?? cur.results.find((r) => r.id === x.id));
        if (ok && merged.every((r) => r?.status === 'passed')) say(t.logPassed(cur.levelIndex + 1));
        setPending((p) => ({ ...p, [test]: { status: 'idle' } }));
      },
      secrets: (given) => {
        secrets.current = given;
      },
      circuit: (pushed) => replaceCircuit(pushed, types),
      sim: () => getBoardSimulator(boardId) as unknown as AnalogSim | null,
      board: bench.pins,
      // A draft has no queue: no offer.
      offers: (o) => {
        if (bench.draft) return;
        offersPushed.current = true;
        setOffers(o);
      },
      benchCapture: setBenchCapture,
      benchSerial: (text) => onBenchSerial({ type: 'board', text }),
      benchFlash: (state, detail) => onBenchSerial({ type: 'flash', state, detail, at: performance.now() }),
    }, bench.recorder);
    hub.current = link;
    const unsubscribe = useEditorStore.subscribe((s, prev) => {
      if (s.files !== prev.files) link.publishState();
    });
    const unsubscribeCircuit = useSimulatorStore.subscribe((s, prev) => {
      if (s.components !== prev.components || s.wires !== prev.wires) link.circuitChanged();
    });
    return () => {
      unsubscribe();
      unsubscribeCircuit();
      link.close();
      hub.current = null;
    };
    // One link per sheet, mode and board: `levels` follows sheet and mode, and replaceCircuit reads boardId, the store and now.current.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet, mode, probe, bench.recorder, hubOn, boardId]);

  /**
   * An agent's circuit (free mode, v0.8): checked against the catalogue and
   * the pins of each part and of the board; then the simulation stops and the
   * circuit is replaced. Refused: nothing changes.
   */
  async function replaceCircuit(pushed: PushedCircuit, types: Map<string, string>): Promise<string | null> {
    if (now.current.realTurn) return 'The session is on a real bench: its circuit is the bench\'s wiring and cannot change.';
    await registry.load();
    const boardEl = document.getElementById(boardId);
    const why = checkCircuit(pushed, boardId, pinNames(boardEl), catalogue);
    if (why) return why;
    const sizes = new Map(await Promise.all(pushed.components.map(async (p) => [p.id, await partSize(registry.getById(stripBrandPrefix(p.type))?.tagName, p.properties)] as const)));
    now.current.halt();
    const sim = useSimulatorStore.getState();
    const board = sim.boards.find((b) => b.id === boardId);
    const placed = placeFree(pushed, (board?.x ?? 0) + (boardEl instanceof HTMLElement ? boardEl.offsetWidth : 300), board?.y ?? 0, (p) => sizes.get(p.id) ?? null);
    placed.components.forEach((p) => types.set(stripBrandPrefix(p.type), p.type));
    sim.setComponents(placed.components.map((p) => ({ id: p.id, metadataId: stripBrandPrefix(p.type), x: p.x, y: p.y, properties: p.properties })));
    sim.setWires(
      placed.wires.map((w) => ({
        id: w.id,
        start: { ...w.start, x: 0, y: 0 },
        end: { ...w.end, x: 0, y: 0 },
        color: w.color,
        waypoints: w.waypoints ?? [],
      })),
    );
    sim.recalculateAllWirePositions();
    return null;
  }

  useEffect(() => () => Object.values(answerTimers.current).forEach(clearTimeout), []);

  /** The visitor typed an answer: the hub decides (verdict), and says so within 10 s or the field reopens. */
  function onAnswer(test: string, value: string) {
    const t = text();
    clearTimeout(answerTimers.current[test]);
    if (!hub.current?.submitAnswer(test, value)) {
      setPending((p) => ({ ...p, [test]: { status: 'idle', error: t.answerOffline } }));
      return;
    }
    say(t.logAnswer(test));
    setPending((p) => ({ ...p, [test]: { status: 'waiting' } }));
    answerTimers.current[test] = setTimeout(() => setPending((p) => ({ ...p, [test]: { status: 'idle', error: text().answerTimeout } })), 10_000);
  }

  useEffect(() => hub.current?.publishState(), [levelIndex, running, results, hints, paused, speed]);

  // The hub's benches for this setup (v0.4), read once; then the hub pushes them (`benches`, v0.20).
  // None, and the bench is unchanged. A draft has none.
  useEffect(() => {
    if (!hubOn || bench.draft) return;
    let stopped = false;
    void fetchBenches(sheet.id).then((o) => !stopped && !offersPushed.current && setOffers(o));
    return () => {
      stopped = true;
    };
  }, [sheet.id, bench.draft, hubOn]);

  const offline = { type: 'note', text: t.hubOffline } as const;
  const joinQueue = (kind: string) => onQueue(hub.current?.joinQueue(kind) ? { type: 'note', text: '' } : offline);
  useKindLink(offers, hubStatus === 'live' && queue.phase === 'none', joinQueue);
  const leaveQueue = () => onQueue(hub.current?.leaveQueue() ? { type: 'note', text: '' } : offline);

  /** `relaunch`: launch() starts the simulation again (new code, pushed or not). */
  function halt(reason: 'stop' | 'relaunch' = 'stop') {
    setPaused(false); // the reset below ends a pause too
    bench.recorder.halted(reason); // the agent's capture or the visitor's
    hub.current?.halted(reason); // the agent's analog capture
    run.current.token++;
    run.current.undo.splice(0).forEach((undo) => undo());
    probe.reset();
    const sim = useSimulatorStore.getState();
    if (sim.boards.find((b) => b.id === boardId)?.running) sim.stopBoard(boardId);
    for (const c of sheet.controllers ?? []) {
      if (sim.boards.find((b) => b.id === c.id)?.running) sim.stopBoard(c.id);
    }
  }

  /**
   * Compiles (or takes the agent's program), loads, and with `start` runs
   * the board, its couplings and the level's tests.
   */
  async function launch(start = true) {
    halt('relaunch');
    const token = run.current.token;
    const sim = useSimulatorStore.getState();
    const board = sim.boards.find((b) => b.id === boardId);
    if (!board) return;
    const program = agentHex.current ?? (await compile(board, token));
    if (!program || token !== run.current.token) return;
    if (program === agentHex.current) hub.current?.publishCompile(true, text().logProgram, program, 'agent');

    if (now.current.realTurn) {
      // publishCompile sent it to the bench, which flashes it (one load per 10 s at most).
      onBenchSerial({ type: 'reset' });
      say(text().logSentToBench);
      return;
    }
    sim.compileBoardProgram(boardId, program);
    // compileBoardProgram's loadHex resets the main board's I2C bus and re-adds the
    // engine's default demo devices, so our controllers' virtual devices must be
    // re-registered here too, on every run. Fresh instance = fresh challenge state.
    if ((sheet.controllers?.length ?? 0) > 0) {
      const boardSim = getBoardSimulator(boardId) as unknown as {
        addI2CDevice?: (d: unknown) => void;
        removeI2CDevice?: (addr: number, bus?: number) => void;
      } | null;
      // Strip the engine's default demo devices (RTC 0x68, temp 0x48, EEPROM 0x50):
      // a challenge bus should carry only its target, not confusing extras.
      for (const addr of [0x48, 0x50, 0x68]) boardSim?.removeI2CDevice?.(addr, 0);
      for (const c of sheet.controllers ?? []) {
        if (!c.i2cDevice || !boardSim?.addI2CDevice) continue;
        const make = getVirtualI2cDevice(c.i2cDevice);
        if (!make) continue;
        const cid = c.id;
        boardSim.addI2CDevice(
          make(() => ((getBoardSimulator(cid) as unknown as { getCurrentCycles?: () => number })?.getCurrentCycles?.() ?? 0) / 16000, secrets.current),
        );
      }
    }
    sim.clearBoardSerialOutput(boardId);
    useOscilloscopeStore.getState().clearSamples();
    probe.reset();
    if (!start) return;
    // The couplings listen before the first cycle; the clock of a level
    // starts when runLevel is called, so right after the start.
    run.current.undo.push(applyCouplings(sheet.couplings ?? [], probe));
    simulator()?.setSpeed?.(speed);
    sim.startBoard(boardId);
    // Start the controller board(s) together with the player board (fresh scene clock).
    for (const c of sheet.controllers ?? []) sim.startBoard(c.id);
    say(text().logStarted);
    const level = levels[levelIndex];
    if (!level) return;
    const tests = runLevel(level, probe, setResults, getLang());
    run.current.undo.push(() => tests.cancel());
    tests.done
      .then((final) => {
        if (token !== run.current.token) return;
        setResults(final);
        // The level passes on the merged results (answer tests included); the score counts what the run measured.
        const t = text();
        if (resultsOf(now.current.answers, final).every((r) => r.status === 'passed')) say(t.logPassed(levelIndex + 1));
        else if (final.length) say(t.logScore(levelIndex + 1, final.filter((r) => r.status === 'passed').length, final.length));
      })
      .catch(() => {});
  }

  /** The lab compiles the editor's code; the program, or nothing (failed, or stopped meanwhile). */
  async function compile(board: ReturnType<typeof useSimulatorStore.getState>['boards'][number], token: number): Promise<string | undefined> {
    setCompiling(true);
    setCompileSecs(null);
    say(text().compiling);
    const files = useEditorStore
      .getState()
      .getGroupFiles(board.activeFileGroupId)
      .map(({ name, content }) => ({ name, content }));
    const t0 = performance.now();
    let result: CompileResult;
    try {
      result = await compileCode(files, sheet.board.fqbn, null, undefined, {
        boardKind: sheet.board.kind,
        libraries: board.libraries ?? null,
      });
    } catch (e) {
      result = { success: false, stdout: '', stderr: '', error: e instanceof Error ? e.message : String(e) };
    }
    if (token !== run.current.token) return undefined; // stopped or relaunched meanwhile
    setCompiling(false);

    const program = result.success ? (result.hex_content ?? result.binary_content) : undefined;
    // arduino-cli colours its output for a terminal.
    const output = [result.stdout, result.stderr, result.error].filter((t) => t?.trim()).map((t) => t!.replace(/\x1b\[[0-9;]*m/g, '').trim());
    output.forEach(say);
    hub.current?.publishCompile(!!program, output.join('\n'), program, 'cloud');
    if (!program) {
      // A refusal of the server (rate limit, guard) is not a CompileResult: it
      // carries a `detail`, or nothing readable at all.
      const detail = (result as { detail?: unknown }).detail;
      if (typeof detail === 'string') say(detail);
      else if (![result.stdout, result.stderr, result.error].some((t) => t?.trim())) say(text().logRefused);
      say(text().logFailed);
      setTab('journal');
      return undefined;
    }
    const secs = (performance.now() - t0) / 1000;
    setCompileSecs(secs);
    say(text().logCompiled(seconds1(secs)));
    return program;
  }

  const simulator = () => getBoardSimulator(boardId) as unknown as PausableSim | null;

  /** Pause: the processor stops where it is; the scene, traces, clock and tests stop with it. Stop still resets. */
  function pause() {
    const sim = simulator();
    if (!running || paused || !sim?.stop || !sim.start) return;
    if (sim.pause) sim.pause();
    else sim.stop(); // a simulator without pause(): what it had scheduled is lost
    setPaused(true);
    now.current.paused = true; // before the next render: a capture asked meanwhile is refused
    hub.current?.paused(); // the agent's capture ends; the visitor's waits
    say(text().logPaused);
  }

  function resume() {
    if (!paused) return;
    simulator()?.start?.();
    setPaused(false);
    say(text().logResumed);
  }

  function changeSpeed(value: number) {
    setSpeed(value);
    saveSpeed(value);
    simulator()?.setSpeed?.(value);
  }

  function stop() {
    halt();
    setCompiling(false);
    say(text().logStopped);
  }

  function resetCode() {
    if (!window.confirm(text().confirmReset)) return;
    const editor = useEditorStore.getState();
    editor.setFileContent(editor.files[0].id, sheet.files[0].content);
    fromAgent(null);
    say(text().logReset);
  }

  function goToLevel(i: number) {
    halt();
    setLevelIndex(i);
    saveLevel(sheet.id, i);
    setResults([]);
    setAnswers({});
    answersNow.current = {};
    setPending({});
    Object.values(answerTimers.current).forEach(clearTimeout);
    answerTimers.current = {};
    setHints(hintsFor(i));
  }

  // The levels before the current one were passed, in this session or a former one.
  const levelsPassed = levelIndex + (passed ? 1 : 0);
  const exitHref = `${localPath(EXIT_URL, lang)}?${new URLSearchParams({ setup: sheet.id, mode, level: String(levelsPassed), t: String(elapsed) })}`;
  /** To the end page, with the result the hub signed when it has one (v0.20). */
  // Leaving ends the session: the next visit of the setup in this tab counts from zero.
  const leave = () => {
    endSession(sheet.id, mode);
    void withShare(exitHref, hubOn ? hubInfo : null).then((href) => window.location.assign(href));
  };
  const level = levels[levelIndex];
  const testsPassed = results.filter((r) => r.status === 'passed').length;
  const probesOf = (kind: 'scope' | 'logic') => sheet.probes.filter((p) => p.kind === kind);

  // The sections the visitor arranges (layout.tsx); an absent one is falsy.
  const parts: Partial<Record<Part, ReactNode>> = {
    view: (
      <div className="bench-view" data-view={view}>
        <span className="bench-view-label">
          <i />
          {view === 'decor' ? t.sceneLabel : view === 'camera' ? t.cameraLabel : mode === 'free' && !realTurn ? t.schemaEditable : t.schemaLabel}
        </span>
        <ViewSwitch scene={!!sceneSvg} camera={!!camera} view={view} onChange={setView} />
        <SimClock nowMs={probe.nowMs} running={running} paused={paused} />
        {/* The scene stays mounted: it follows the bench even when hidden. */}
        <div ref={scene} className="bench-scene" role="img" aria-label={t.sceneAria} hidden={view !== 'decor' || realTurn} />
        {/* A real bench without a camera: the browser simulates nothing, so the scene would stay still. */}
        {view === 'decor' && realTurn && (
          <div className="bench-real-turn" role="status">
            <strong>{t.realTurnTitle}</strong>
            <p>{t.realTurnNoVideo}</p>
          </div>
        )}
        {/* The schema stays mounted too: its parts follow the bench from the start. */}
        <Schema boardId={boardId} board={bench.pins} probes={sheet.probes} probe={probe} running={running} editable={mode === 'free' && !realTurn} hidden={view !== 'schema'} />
        {view === 'camera' && turnVideo && <Camera path={turnVideo.video} hls={turnVideo.hls} token={hubInfo!.owner!} />}
      </div>
    ),
    // During a real turn only the bench's capture shows (v0.22): the simulation's traces are hidden.
    traces: sheet.probes.length > 0 && !realTurn && (
      <div className="bench-traces">
        {(['scope', 'logic'] as const).map((kind) => probesOf(kind).length > 0 && <Traces key={kind} kind={kind} probes={probesOf(kind)} nowMs={probe.nowMs} live={running} />)}
      </div>
    ),
    // During a real turn the capture is the bench's analyser, asked through the hub (v0.20).
    capture: probesOf('logic').length > 0 && (
      <CapturePanel
        recorder={bench.recorder}
        probes={probesOf('logic')}
        running={running}
        bench={realTurn ? { capture: benchCapture, request: (pins, ms) => hub.current?.requestCapture(pins, ms) ?? false } : undefined}
      />
    ),
    serial: (
      <div className="bench-serial">
        <div>
          <strong>{t.serial}</strong>
          <span>{compiling ? t.compilingShort : compileSecs === null ? '' : t.compiledIn(seconds1(compileSecs, t.locale))}</span>
        </div>
        <pre ref={serialBox} tabIndex={0} role="log" aria-label={t.serialAria}>
          {realTurn
            ? benchSerial.entries.map((e, i) => (
                // Plain text, never HTML; the editor's own lines styled apart from the board's output.
                'board' in e ? <Fragment key={i}>{e.board}</Fragment> : (
                  <span key={i} className="bench-serial-note">
                    {e.flash === 'start' ? t.flashStart : e.flash === 'ok' ? t.flashOk(e.secs === undefined ? null : seconds1(e.secs, t.locale)) : t.flashFailed(e.detail)}
                  </span>
                )
              ))
            : serial}
        </pre>
      </div>
    ),
  };

  const columns: Partial<Record<Column, ReactNode>> = {
    agent: agentCalls.length > 0 && <AgentJournal calls={agentCalls} />,
    level: level && (
      <LevelPanel
        levels={levels}
        index={levelIndex}
        results={results}
        answers={pendingAnswers}
        onAnswer={onAnswer}
        offline={hubStatus !== 'live'}
        passed={passed}
        hintsShown={hints}
        onHint={() => {
          setHints(hints + 1);
          saveHints(sheet.id, level.id, hints + 1);
        }}
        onNext={() => goToLevel(levelIndex + 1)}
        onFinish={leave}
      />
    ),
    code: codeShown && (
      <section className="bench-code" aria-label={t.code}>
        <div className="bench-code-bar">
          <span className="bench-code-tab">{sheet.files[0].name}</span>
          {/* Monaco keeps Tab for indenting; Ctrl+M is its own way out. */}
          <span className="bench-code-keys">{t.editorKeys}</span>
          <span className="bench-code-saved">{t.savedHere}</span>
          {agentBuilt && (
            <span className="bench-code-agent" role="status">
              {agentBuilt === 'sources' ? t.agentBuilt : `${t.agentBuilt} · ${t.agentNoSources}`}
              <button type="button" title={t.editHereTitle} onClick={() => fromAgent(null)}>
                {t.editHere}
              </button>
            </span>
          )}
        </div>
        <div className="bench-code-editor">
          <CodeEditor />
        </div>
      </section>
    ),
    hub: (
      <section className="bench-hub" aria-labelledby="bench-hub-title">
        <div className="bench-hub-bar">
          <h2 id="bench-hub-title">
            {t.benchTitle} <span>{queue.phase === 'turn' && queue.kind !== 'sim' ? t.benchSubLive : t.benchSub}</span>
          </h2>
          <nav aria-label={t.benchTitle}>
            {(['vue', 'tests', 'journal'] as const).map((k) => (
              <button key={k} type="button" aria-current={tab === k ? 'page' : undefined} onClick={() => setTab(k)}>
                {k === 'vue' ? t.tabView : k === 'journal' ? t.tabLog : level ? `${t.tabTests} ${testsPassed}/${level.tests.length}` : t.tabTests}
              </button>
            ))}
          </nav>
        </div>

        {/* Above the tabs: the turn may start while the visitor reads the tests. */}
        <QueuePanel offers={offers} view={queue} disabled={hubStatus !== 'live'} onJoin={joinQueue} onLeave={leaveQueue} onSeen={() => onQueue({ type: 'seen' })} />

        <div className="bench-hub-panel" hidden={tab !== 'vue'}>
          {arranged('y', layout.parts, parts, setParts, 'bench-part')}
        </div>

        <div className="bench-hub-panel bench-hub-text" hidden={tab !== 'tests'}>
          {level ? (
            <>
              <h3>
                {t.levelOf(levelIndex + 1, levels.length)} · {level.title}
              </h3>
              <TestList level={level} results={results} answers={pendingAnswers} onAnswer={onAnswer} />
              <p>{t.testsRun(seconds1(level.timeout_ms / 1000, t.locale))}</p>
            </>
          ) : sheet.levels.length > 0 ? (
            <p>
              {t.testsInChallenge} <a href={`${window.location.pathname.replace(/\/$/, '')}/challenge`}>{t.toChallenge}</a>
            </p>
          ) : (
            <p>{t.noChallenge}</p>
          )}
        </div>

        <div className="bench-hub-panel bench-hub-text" hidden={tab !== 'journal'}>
          <pre className="bench-journal" tabIndex={0} role="log" aria-label={t.tabLog}>
            {journal.length ? journal.join('\n') : t.logEmpty}
          </pre>
        </div>
      </section>
    ),
  };
  /** The sections of a group in the visitor's order, each with its grip and the separator that sizes it. */
  function arranged<T extends Section>(axis: 'x' | 'y', order: T[], items: Partial<Record<T, ReactNode>>, set: (order: T[]) => void, className: string) {
    const shown = order.filter((id) => items[id]);
    return shown.map((id, i) => {
      const folded = layout.folded.includes(id);
      const size = folded ? undefined : layout.size[id];
      return (
        <Fragment key={id}>
          <div
            ref={(el) => void (boxes.current[id] = el)}
            className={className}
            data-section={id}
            data-sized={size ? '' : undefined}
            data-folded={folded ? '' : undefined}
            style={size ? ({ '--size': `${size}px` } as CSSProperties) : undefined}
            {...dropZone(axis, (dragged) => set(moveTo(order, dragged as T, id)))}
          >
            <Grip id={id} axis={axis} label={t.moveSection(t.sections[id])} onStep={(by) => set(step(order, id, by, shown))} />
            <Fold axis={axis} folded={folded} label={(folded ? t.unfoldSection : t.foldSection)(t.sections[id])} onToggle={() => toggleFold(id)} />
            {folded && <span className="bench-folded-name">{t.sections[id]}</span>}
            {items[id]}
          </div>
          {/* A column fills what is left after the last separator; a part may grow below the last one (the panel scrolls). */}
          {!folded && (axis === 'y' || i < shown.length - 1) && <Splitter axis={axis} label={t.resizeSection(t.sections[id])} size={size} of={() => boxes.current[id] ?? null} onSize={(n) => setSize(id, n)} />}
        </Fragment>
      );
    });
  }

  return (
    <div className="bench">
      <header className="bench-header">
        <Brand />
        <div className="bench-setup">
          <span>
            <strong>{sheet.title}</strong>
            <span>
              {t.mode(mode)} · {queue.phase === 'turn' ? t.kind(queue.kind) : t.simulatedBench}
            </span>
          </span>
          <a href={HOME_URL}>{t.change}</a>
        </div>

        <div className="bench-actions">
          <button type="button" className="bench-btn bench-btn-primary" onClick={() => void launch()} disabled={compiling} aria-busy={compiling}>
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path d="M3 1.5v11l9-5.5z" fill="currentColor" />
            </svg>
            {compiling ? t.compiling : t.run}
          </button>
          <button type="button" className="bench-btn bench-btn-icon" onClick={stop} disabled={!running && !compiling} aria-label={t.stop} title={t.stop}>
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <rect x="2" y="2" width="10" height="10" rx="1.5" fill="currentColor" />
            </svg>
          </button>
          <button
            type="button"
            className="bench-btn bench-btn-icon"
            onClick={paused ? resume : pause}
            disabled={!running || compiling}
            aria-pressed={paused}
            aria-label={paused ? t.resume : t.pause}
            title={paused ? t.resume : t.pause}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              {paused ? <path d="M3 1.5v11l9-5.5z" fill="currentColor" /> : <path d="M3 2h3v10H3zM8 2h3v10H8z" fill="currentColor" />}
            </svg>
          </button>
          {/* A real bench runs at its own pace: nothing to speed up during the turn. */}
          <select
            className="bench-speed"
            value={speed}
            onChange={(e) => changeSpeed(Number(e.target.value))}
            disabled={realTurn}
            aria-label={t.speed}
            title={realTurn ? t.speedRealTurn : t.speed}
          >
            {SPEEDS.map((v) => (
              <option key={v} value={v}>
                ×{v.toLocaleString(t.locale)}
              </option>
            ))}
          </select>
          <button type="button" className="bench-btn bench-btn-icon" onClick={resetCode} aria-label={t.resetCode} title={t.resetCode}>
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3.5 9a5.5 5.5 0 1 0 1.8-4.1" />
              <path d="M3.5 2.5v3h3" />
            </svg>
          </button>
          <button
            type="button"
            className="bench-btn bench-btn-icon"
            onClick={() => setCodeShown(!codeShown)}
            aria-pressed={codeShown}
            aria-label={codeShown ? t.hideCode : t.showCode}
            title={codeShown ? t.hideCode : t.showCode}
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M6 5L2 9l4 4M12 5l4 4-4 4" />
              {!codeShown && <path d="M3 15L15 3" />}
            </svg>
          </button>
          <button type="button" className="bench-btn bench-btn-icon" onClick={resetLayout} aria-label={t.resetLayout} title={t.resetLayout}>
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden="true">
              <rect x="2.5" y="3" width="13" height="12" rx="1.5" />
              <path d="M7 3v12M7 9h8.5" />
            </svg>
          </button>
        </div>

        <div className="bench-session">
          {hubOn && <VisibilityMenu status={hubStatus} info={hubInfo} viewers={viewers} onChange={setHubInfo} />}
          <LangSwitch />
          <span className="bench-timer" role="timer" aria-label={t.sessionTime}>
            {clock(elapsed)}
          </span>
          <a
            href={exitHref}
            onClick={(e) => {
              if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // a new tab gets the plain link
              e.preventDefault();
              leave();
            }}
          >
            {t.yourProject}
          </a>
        </div>
      </header>

      {bench.banner && <Banner text={bench.banner} />}
      {bench.paused && <Banner text={bench.paused} />}
      {notice && <Banner text={notice} alert onClose={() => setNotice(null)} />}
      <div className="bench-body">{arranged('x', layout.columns, columns, setColumns, 'bench-col')}</div>
      <Footer />
    </div>
  );
}
