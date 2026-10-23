/**
 * The bench's side of the hub ([hub] url of the deployment file): the
 * session, the live channel, what the owner publishes and what it applies.
 * Protocol: picodev/docs/live-protocol.adoc; example server: picodev/hub-example/.
 *
 * Nothing here imports Velxio: the page hands over a BenchProbe and a few
 * callbacks. Tokens never go into a path or a query string; the ones that
 * arrive in a fragment are taken out of the address at once and kept in
 * sessionStorage (this tab only).
 */
import { ANALOG_MAX, createSampler, type AnalogSim, type Sampler } from './analog';
import { CAPTURE_MAX_MS, createRecorder, type Interruption, type Recorder, type Recording } from './capture';
import { circuitFits, readCircuit, type Circuit, type PushedCircuit } from './circuit';
import { HUB_URL } from './config';
import { text } from './text';
import type { BenchEvent, BenchProbe, Lang, SetupSheet, TestResult } from './types';
import type { BoardPins } from './wiring';

export type Visibility = 'private' | 'link' | 'public';
/** `replaced`: another tab took over this session's owner channel. */
export type HubStatus = 'connecting' | 'live' | 'offline' | 'replaced';
export interface SketchFile {
  name: string;
  content: string;
}

/** What this tab knows of a session. `viewer` is unknown when the session came from an agent's link. */
export interface SessionInfo {
  session: string;
  owner?: string;
  viewer?: string;
  visibility?: Visibility;
  /** Spectators connected when the session was read back (GET), not remembered. */
  viewers?: number;
  /** Draft token (`#d=`): the sheet is a draft the hub serves to this session only. */
  draft?: string;
}

/** Published by the owner (`state`). `setup` and `mode` are an addition to the contract: the spectator needs the sheet. */
export interface BenchState {
  setup: string;
  mode: 'free' | 'challenge';
  /** Absent with `files_omitted` (the message would exceed MAX_MESSAGE). */
  files?: SketchFile[];
  files_omitted?: true;
  level: number;
  running: boolean;
  results: TestResult[];
  /** Hints shown so far on this level. */
  hints: number;
  /** The circuit on the bench (v0.8); left out when larger than a hub keeps. */
  circuit?: Circuit;
  /** The session clock (v0.12); left out when malformed. */
  clock?: Clock;
}

/** The speeds the owner may choose (v0.12), against real time. */
export const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 5, 10];
/** `t_ms`: integer simulated ms since the launch. */
export interface Clock {
  t_ms: number;
  speed: number;
  paused: boolean;
}
export const isClock = (c: unknown): c is Clock => {
  const k = c as Clock | null;
  return !!k && Number.isSafeInteger(k.t_ms) && k.t_ms >= 0 && SPEEDS.includes(k.speed) && typeof k.paused === 'boolean';
};

const SESSION_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_FILES = 8;
const FLUSH_MS = 100; // at most 10 `events` messages a second
const MAX_BATCH = 400; // events a message (live-protocol.adoc); far below the 64 KiB a message may weigh
const MAX_BACKLOG = 10 * MAX_BATCH; // a second of messages waiting: past it, the backlog is coalesced
const MAX_LOG = 16_000;
const MAX_PROGRAM = 48 * 1024; // bytes of Intel HEX a real bench accepts
const STATE_DEBOUNCE_MS = 300;
const MAX_MESSAGE = 64 * 1024; // bytes a hub accepts in one message (live-protocol.adoc)
const MAX_COMPILE = 60 * 1024; // a `compile` with its program, kept clear of MAX_MESSAGE (the hub closes with 1009 above)
const LOG_CUT = '[…]\n';
const BACKOFF_MAX_MS = 30_000;
const MAX_NOTICE = 500;
const MAX_BANNER = 200;

export const isSessionId = (s: unknown): s is string => typeof s === 'string' && SESSION_RE.test(s);

// ── This tab's memory of a session ──────────────────────────────────────────

const storeKey = (session: string) => `picodev-lab:hub:${session}`;

export function remembered(session: string): SessionInfo {
  try {
    return { ...JSON.parse(sessionStorage.getItem(storeKey(session)) ?? '{}'), session };
  } catch {
    return { session }; // storage refused: the session lasts as long as the page
  }
}

function remember(info: SessionInfo): SessionInfo {
  const merged = { ...remembered(info.session), ...info };
  try {
    sessionStorage.setItem(storeKey(info.session), JSON.stringify(merged));
  } catch {
    // ditto
  }
  return merged;
}

const FRAGMENT_KEYS = { o: 'owner', v: 'viewer', d: 'draft' } as const;

/**
 * Takes the tokens of the fragment (`#o=`, `#v=`, `#d=`) out of the address
 * bar (history keeps no trace of them) and remembers them for `session`.
 * Returns what this tab knows.
 */
export function takeFragment(session: string): SessionInfo {
  const hash = new URLSearchParams(location.hash.slice(1));
  const found = Object.entries(FRAGMENT_KEYS).filter(([k]) => hash.get(k));
  if (!found.length) return remembered(session);
  history.replaceState(history.state, '', location.pathname + location.search);
  return remember({ session, ...Object.fromEntries(found.map(([k, name]) => [name, hash.get(k)])) });
}

export const spectatorLink = (session: string, viewer: string) =>
  `${location.origin}/w/${encodeURIComponent(session)}#v=${encodeURIComponent(viewer)}`;

// ── HTTP ────────────────────────────────────────────────────────────────────

/**
 * Resumes the session of `?s=` when this tab holds its owner token and the
 * hub still knows it, else creates one.
 */
async function ownSession(setup: string, mode: string): Promise<SessionInfo> {
  const s = new URLSearchParams(location.search).get('s');
  if (isSessionId(s)) {
    const known = takeFragment(s);
    const back = known.owner ? await readBack(known) : null;
    if (back) return back;
    // A draft is served to its own session only: no other session can show it.
    if (known.draft) throw new Error('hub : session d’essai terminée');
  }
  return createSession(setup, mode);
}

/** `POST <hub>/sessions`; `?s=` and this tab's memory follow the new session. */
async function createSession(setup: string, mode: string): Promise<SessionInfo> {
  const params = new URLSearchParams(location.search);
  const res = await fetch(`${HUB_URL}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ setup, mode }),
  });
  if (!res.ok) throw new Error(`hub : HTTP ${res.status}`);
  const r = (await res.json()) as Record<string, unknown>;
  if (!isSessionId(r.session) || typeof r.owner !== 'string') throw new Error('hub : réponse invalide');
  // A reload of the page comes back to the same session.
  params.set('s', r.session);
  history.replaceState(history.state, '', `${location.pathname}?${params}`);
  return remember({
    session: r.session,
    owner: r.owner,
    viewer: typeof r.viewer === 'string' ? r.viewer : undefined,
    visibility: r.visibility as Visibility,
  });
}

/**
 * `GET <hub>/sessions/<id>` with the owner token: the real visibility and
 * viewer token of a resumed session (an agent's link, a reload). Null when
 * the hub no longer knows the session or refuses the token (404, 403). The
 * hub out of reach, what this tab remembers is used and the live channel retries.
 */
async function readBack(known: SessionInfo): Promise<SessionInfo | null> {
  try {
    const res = await fetch(`${HUB_URL}/sessions/${encodeURIComponent(known.session)}`, {
      headers: { Authorization: `Bearer ${known.owner}` },
    });
    if (res.status === 404 || res.status === 403) return null;
    if (!res.ok) return known;
    const r = (await res.json()) as Record<string, unknown>;
    const info = remember({
      session: known.session,
      visibility: r.visibility as Visibility,
      viewer: typeof r.viewer === 'string' ? r.viewer : undefined,
    });
    return Number.isInteger(r.viewers) ? { ...info, viewers: r.viewers as number } : info;
  } catch {
    return known;
  }
}

// StrictMode mounts twice: one request for both.
const opening = new Map<string, Promise<SessionInfo>>();
function ownSessionOnce(setup: string, mode: string): Promise<SessionInfo> {
  const key = `${setup}/${mode}`;
  if (!opening.has(key)) opening.set(key, ownSession(setup, mode).finally(() => opening.delete(key)));
  return opening.get(key)!;
}

export async function changeVisibility(info: SessionInfo, visibility: Visibility): Promise<SessionInfo> {
  const res = await fetch(`${HUB_URL}/sessions/${encodeURIComponent(info.session)}/visibility`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${info.owner}` },
    body: JSON.stringify({ visibility }),
  });
  if (!res.ok) throw new Error(`hub : HTTP ${res.status}`);
  const r = (await res.json()) as Record<string, unknown>;
  const changed = {
    session: info.session,
    visibility: (r.visibility as Visibility) ?? visibility,
    viewer: typeof r.viewer === 'string' ? r.viewer : undefined,
  };
  return { ...info, ...remember(changed), ...changed };
}

// ── Live channel ────────────────────────────────────────────────────────────

export interface Live {
  /** False when the channel is down: the message is dropped. */
  send(msg: object): boolean;
  close(): void;
}

/**
 * WebSocket `<hub>/sessions/<id>/live`, `hello` first, reopened with a
 * backoff (1 s, 2 s, 4 s… 30 s) until `close()`.
 */
export function connectLive(
  session: string,
  role: 'owner' | 'viewer',
  token: string,
  on: {
    open?(live: Live): void;
    message(msg: Record<string, unknown>): void;
    status(s: HubStatus): void;
    /**
     * The hub closed with 1008: no retry. `established` when the channel had
     * worked (a message received, or open more than 5 s): another connection
     * took its place. Otherwise the hello itself was refused (bad token,
     * unknown session, private session).
     */
    refused?(established: boolean): void;
  },
): Live {
  const url = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${HUB_URL}/sessions/${encodeURIComponent(session)}/live`;
  let ws: WebSocket | null = null;
  let closed = false;
  let failures = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const live: Live = {
    send(msg) {
      if (ws?.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(msg));
      return true;
    },
    close() {
      closed = true;
      clearTimeout(retry);
      ws?.close();
    },
  };

  const open = () => {
    on.status('connecting');
    const sock = new WebSocket(url);
    ws = sock;
    let openedAt = 0;
    let heard = false;
    sock.onopen = () => {
      openedAt = Date.now();
      sock.send(JSON.stringify({ type: 'hello', role, token }));
      on.status('live');
      on.open?.(live);
    };
    sock.onmessage = (e) => {
      let msg: unknown;
      heard = true;
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (msg && typeof msg === 'object' && !closed) on.message(msg as Record<string, unknown>);
    };
    sock.onclose = (e) => {
      if (closed || ws !== sock) return;
      on.status('offline');
      const lasted = !!openedAt && Date.now() - openedAt > 5000;
      if (e?.code === 1008) {
        closed = true; // the same token would be refused again
        on.refused?.(heard || lasted);
        return;
      }
      // A refused hello opens then closes at once: that is not a recovery.
      failures = lasted ? 0 : failures + 1;
      retry = setTimeout(open, Math.min(BACKOFF_MAX_MS, 1000 * 2 ** Math.max(0, failures - 1)));
    };
  };
  open();
  return live;
}

// ── Owner ───────────────────────────────────────────────────────────────────

/**
 * A backlog the link cannot keep up with, made short without a wrong end: the
 * last event of each pin, PWM and servo, and the whole serial text in one
 * event, in time order. A trace loses the pulses in between, never the level
 * it ends on, and no serial character is lost.
 */
export function coalesce(events: BenchEvent[]): BenchEvent[] {
  const last = new Map<string, BenchEvent>();
  let serial: BenchEvent | undefined;
  for (const e of events) {
    if (e.k !== 'serial') last.set(`${e.k}:${e.pin}`, e);
    else if (serial) serial.v += e.v as string;
    else serial = { ...e };
  }
  return [...last.values(), ...(serial ? [serial] : [])].sort((a, b) => a.t - b.t);
}

/**
 * Feeds `send` with what the probe sees, at most MAX_BATCH events every 100 ms:
 * the pins of the sheet's probes and of its scene, the servos and PWM of its
 * scene, the serial output (merged while nothing comes between). A burst waits
 * for the next messages; a flood that would keep them more than a second
 * behind is coalesced. Nothing is dropped.
 */
export function recordEvents(sheet: SetupSheet, probe: BenchProbe, send: (events: BenchEvent[]) => void): () => void {
  const want = { pin: new Set(sheet.probes.map((p) => p.pin)), pwm: new Set<number>(), servo: new Set<number>() };
  for (const b of sheet.scene?.bindings ?? []) {
    const [kind, n] = b.source.split(':');
    if (kind === 'pin' || kind === 'pwm' || kind === 'servo') want[kind].add(Number(n));
  }
  let batch: BenchEvent[] = [];
  const t3 = (t: number) => Math.round(t * 1000) / 1000;
  const push = (e: BenchEvent) => {
    batch.push(e);
    if (batch.length > MAX_BACKLOG) batch = coalesce(batch);
  };
  const subs = [
    ...[...want.pin].map((pin) => probe.onPin(pin, (high, t) => push({ t: t3(t), k: 'pin', pin, v: high ? 1 : 0 }))),
    ...[...want.pwm].map((pin) => probe.onPwm(pin, (duty, t) => push({ t: t3(t), k: 'pwm', pin, v: duty }))),
    ...[...want.servo].map((pin) => probe.onServo(pin, (deg, t) => push({ t: t3(t), k: 'servo', pin, v: deg }))),
    probe.onSerial((text, t) => {
      const last = batch[batch.length - 1];
      if (last?.k === 'serial') last.v += text;
      else push({ t: t3(t), k: 'serial', v: text });
    }),
  ];
  const timer = setInterval(() => {
    if (batch.length) send(batch.splice(0, MAX_BATCH));
  }, FLUSH_MS);
  return () => {
    clearInterval(timer);
    subs.forEach((off) => off());
  };
}

/** A `push` from the hub: the agent's files, checked (it comes from a stranger). */
export function pushedFiles(msg: Record<string, unknown>): SketchFile[] | null {
  const files = msg.files;
  if (!Array.isArray(files) || !files.length || files.length > MAX_FILES) return null;
  if (!files.every((f) => typeof f?.name === 'string' && /^[\w.-]{1,64}$/.test(f.name) && typeof f?.content === 'string')) return null;
  return files.map(({ name, content }) => ({ name, content }));
}

/**
 * Intel HEX as the hub checks it (v0.15): records `:` and hex pairs, length and
 * checksum right, types 00 to 05, one end record (01), last; LF or CRLF.
 */
export function isIntelHex(hex: string): boolean {
  const lines = hex.replace(/\r?\n$/, '').split(/\r?\n/);
  return lines.every((line, i) => {
    if (!/^:([0-9A-Fa-f]{2})+$/.test(line)) return false;
    const b = line.slice(1).match(/../g)!.map((h) => parseInt(h, 16));
    if (b.length < 5 || b.length !== b[0] + 5 || b[3] > 5) return false;
    if ((b[3] === 1) !== (i === lines.length - 1)) return false;
    return b.reduce((a, x) => a + x, 0) % 256 === 0;
  });
}

/** A `program` from the hub (v0.15): the agent's compiled HEX, and its sources when sent, checked. */
export function pushedProgram(msg: Record<string, unknown>): { hex: string; files?: SketchFile[] } | null {
  const { hex } = msg;
  if (typeof hex !== 'string' || new TextEncoder().encode(hex).length > MAX_PROGRAM || !isIntelHex(hex)) return null;
  if (msg.files === undefined) return { hex };
  const files = pushedFiles(msg);
  return files && { hex, files };
}

/**
 * The `state` message, without `files` (and with `files_omitted`) when the
 * sketch would make it larger than a hub accepts.
 */
export function stateMessage(state: BenchState): object {
  const msg: Partial<BenchState> & { type: 'state'; files_omitted?: true } = { type: 'state', ...state };
  if (msg.circuit && !circuitFits(msg.circuit)) delete msg.circuit;
  if (msg.clock !== undefined && !isClock(msg.clock)) delete msg.clock;
  if (bytes(msg) <= MAX_MESSAGE) return msg;
  delete msg.files;
  msg.files_omitted = true;
  if (bytes(msg) > MAX_MESSAGE) delete msg.circuit; // ponytail: cannot happen within the circuit limits, kept for safety
  return msg;
}

const bytes = (msg: object) => new TextEncoder().encode(JSON.stringify(msg)).length;

/** The `compile` message, its log cut at the start (marked) until the whole is at most MAX_COMPILE bytes. */
export function compileMessage(ok: boolean, log: string, program: string | undefined, origin: 'cloud' | 'agent'): { type: 'compile'; ok: boolean; log: string; program?: string; origin: string } {
  const msg = { type: 'compile' as const, ok, log, ...(program !== undefined && { program }), origin };
  for (let over = bytes(msg) - MAX_COMPILE; over > 0 && msg.log; over = bytes(msg) - MAX_COMPILE) {
    // A char weighs one byte or more: cutting `over` chars at least frees `over` bytes, give or take the mark.
    const rest = msg.log.startsWith(LOG_CUT) ? msg.log.slice(LOG_CUT.length) : msg.log;
    msg.log = rest.length > over ? LOG_CUT + rest.slice(over + LOG_CUT.length) : '';
  }
  return msg;
}

// ── Queue and benches (optional extension, live-protocol.adoc) ──────────────

/** One (setup, kind) couple of `GET <hub>/benches`. */
export interface BenchOffer {
  setup: string;
  kind: string;
  benches: number;
  free: number;
  waiting: number;
  /** v0.18: `soon` is announced, not joinable (no bench `enabled` yet); absent on the wire means `open`. */
  status: 'open' | 'soon';
}

/** What the hub says of this session's place (owner), or of its turn (owner and spectators). */
export type QueueMessage =
  | { type: 'queue'; kind: string; position: number; waiting: number; eta_s: number }
  /** `bench` is not sent to spectators. `video`: the WHEP path of the bench's camera, `hls` (v0.20) its LL-HLS fallback, same origin. */
  | { type: 'turn'; kind: string; bench?: string; ends_at: number; video?: string; hls?: string }
  | { type: 'turn_end'; reason: string }
  /** `code`: unknown_kind, full, already_queued, soon; anything else gets the generic text. The hub's `detail` is never shown. */
  | { type: 'queue_error'; code: string };

const KIND_RE = /^[a-z0-9-]{1,32}$/;
const isKind = (v: unknown): v is string => typeof v === 'string' && KIND_RE.test(v);
const isCount = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
/** A path on this origin only: the session token goes with it. `\\` counts as `/` in a URL. */
export const isLocalPath = (v: unknown): v is string => typeof v === 'string' && v.length <= 256 && /^\/(?![/\\])/.test(v);

export const kindLabel = (kind: string) => text().kind(kind);

/** A queue message from the hub, checked; null for any other message or a malformed one. */
export function queueMessage(m: Record<string, unknown>): QueueMessage | null {
  switch (m.type) {
    case 'queue':
      return isKind(m.kind) && isCount(m.position) && isCount(m.waiting) && isCount(m.eta_s)
        ? { type: 'queue', kind: m.kind, position: m.position, waiting: m.waiting, eta_s: m.eta_s }
        : null;
    case 'turn': {
      if (!isKind(m.kind) || !isCount(m.ends_at)) return null;
      const turn: QueueMessage = { type: 'turn', kind: m.kind, ends_at: m.ends_at };
      if (typeof m.bench === 'string') turn.bench = m.bench.slice(0, 32);
      if (isLocalPath(m.video)) turn.video = m.video;
      if (isLocalPath(m.hls)) turn.hls = m.hls;
      return turn;
    }
    case 'turn_end':
      return { type: 'turn_end', reason: String(m.reason ?? '').slice(0, 32) };
    case 'queue_error':
      return { type: 'queue_error', code: typeof m.code === 'string' ? m.code : '' };
  }
  return null;
}

/** This session's place, as the hub last said it. `note`: the last thing to tell the visitor. */
export type QueueView =
  | { phase: 'none'; note?: string }
  | { phase: 'waiting'; kind: string; position: number; waiting: number; eta_s: number; note?: string }
  /** `seen`: the visitor closed the "your turn" dialog. */
  | { phase: 'turn'; kind: string; bench?: string; ends_at: number; video?: string; hls?: string; seen: boolean; note?: string };

/** `reset`: the live channel (re)opened; the hub resends the place or turn in progress, if any. */
export type QueueAction = QueueMessage | { type: 'reset' } | { type: 'seen' } | { type: 'note'; text: string };

/** Why a place or a turn ended (`turn_end`), said to the visitor in the current language. */
function endNote(reason: string, wasTurn: boolean): string {
  const t = text();
  const what = wasTurn ? t.turnOver : t.placeLost;
  switch (reason) {
    case 'time':
      return t.endTime;
    case 'left':
      return wasTurn ? t.endLeftTurn : t.endLeftPlace;
    case 'owner':
      return t.endOwner(what);
    case 'bench':
      return t.endBench(what);
    case 'ended':
      return t.endEnded(what);
  }
  return `${what}.`;
}

export function queueView(view: QueueView, a: QueueAction): QueueView {
  switch (a.type) {
    case 'queue':
      return { phase: 'waiting', kind: a.kind, position: a.position, waiting: a.waiting, eta_s: a.eta_s };
    case 'turn':
      return { phase: 'turn', kind: a.kind, bench: a.bench, ends_at: a.ends_at, video: a.video, hls: a.hls, seen: false };
    case 'turn_end':
      // A place or a turn: back to the offer, whatever the reason.
      return { phase: 'none', note: endNote(a.reason, view.phase === 'turn') };
    case 'reset':
      return { phase: 'none' };
    case 'seen':
      return view.phase === 'turn' ? { ...view, seen: true } : view;
    case 'queue_error':
      return { ...view, note: Object.hasOwn(text().queueError, a.code) ? text().queueError[a.code] : text().hubRefused };
    case 'note':
      return { ...view, note: a.text };
  }
}

/**
 * The benches of `setup` in a list of couples: the open ones (at least one connected) and, v0.18,
 * the `soon` ones (announced, none to join). A couple without `setup` (the `benches` message, v0.20)
 * is the session's setup.
 */
export function readOffers(list: unknown, setup: string): BenchOffer[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((b) => (b?.setup ?? setup) === setup && isKind(b.kind) && isCount(b.benches) && isCount(b.free) && isCount(b.waiting))
    .map((b) => ({ ...b, status: b.status === undefined ? 'open' : b.status }))
    .filter((b) => (b.status === 'open' && b.benches > 0) || b.status === 'soon')
    .map(({ kind, benches, free, waiting, status }) => ({ setup, kind, benches, free, waiting, status }));
}

/** The benches of `setup` from `GET <hub>/benches` (readOffers); [] when the hub has none or does not answer. */
export async function fetchBenches(setup: string): Promise<BenchOffer[]> {
  try {
    const res = await fetch(`${HUB_URL}/benches`);
    return res.ok ? readOffers(await res.json(), setup) : [];
  } catch {
    return []; // a hub without benches (the example relay) answers 404
  }
}

// ── Signed share (v0.20) ────────────────────────────────────────────────────

const SHARE_WAIT_MS = 3000;

/**
 * `href` (the end page's address, with its query) plus `&share=<share>`: the result the hub
 * signed (`share` of `GET <hub>/sessions/<id>`, `/p/<share>`), read just before leaving.
 * `href` unchanged without a session, without `share`, or when the hub does not answer in 3 s.
 */
export async function withShare(href: string, info: SessionInfo | null): Promise<string> {
  if (!info?.owner) return href;
  try {
    const res = await fetch(`${HUB_URL}/sessions/${encodeURIComponent(info.session)}`, {
      headers: { Authorization: `Bearer ${info.owner}` },
      signal: AbortSignal.timeout(SHARE_WAIT_MS),
    });
    const share = res.ok ? ((await res.json()) as Record<string, unknown>).share : undefined;
    // The end page takes the share itself, not the hub's path to it (and checks its shape).
    const bare = typeof share === 'string' ? share.replace(/^\/(en\/)?p\//, '') : '';
    return bare ? `${href}${href.includes('?') ? '&' : '?'}share=${encodeURIComponent(bare)}` : href;
  } catch {
    return href;
  }
}

// ── Status (optional extension, live-protocol.adoc) ─────────────────────────

export interface LabStatus {
  /** False: maintenance, no new session. */
  accepting: boolean;
  /** No new session on these: `closed_setups`, plus `soon_setups` (v0.18) for a hub that would not list them there. */
  closed: string[];
  /** v0.18 `hidden_setups` (`disabled`): the bench page says the setup is not available. */
  hidden: string[];
  /** In `lang`, plain text; absent when there is none to show now. */
  banner?: string;
}

/** `GET <hub>/status`; null without a hub or when it does not answer (nothing to say). */
export async function fetchStatus(lang: Lang): Promise<LabStatus | null> {
  if (!HUB_URL) return null;
  try {
    const res = await fetch(`${HUB_URL}/status`, { cache: 'no-cache' });
    if (!res.ok) return null;
    const r = (await res.json()) as Record<string, unknown> | null;
    if (!r || typeof r !== 'object') return null;
    const b = r.banner as Record<string, unknown> | undefined;
    const said = b?.[lang] ?? b?.fr;
    const until = Date.parse(String(b?.until)); // NaN without `until`: no end
    // A list a hub does not send (an older one) is empty.
    const ids = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []);
    return {
      accepting: r.accepting !== false,
      closed: [...new Set([...ids(r.closed_setups), ...ids(r.soon_setups)])],
      hidden: ids(r.hidden_setups),
      ...(typeof said === 'string' && said.trim() && !(until <= Date.now()) && { banner: said.slice(0, MAX_BANNER) }),
    };
  } catch {
    return null;
  }
}

/**
 * Why the hub takes no new session for `setup` (maintenance, or the setup
 * closed); null when it does, or when the address resumes a session (?s=, a
 * draft's included), which goes on.
 */
export function hubPaused(status: LabStatus | null, setup: string): 'maintenance' | 'closed' | null {
  if (!status || new URLSearchParams(location.search).has('s')) return null;
  return !status.accepting ? 'maintenance' : status.closed.includes(setup) ? 'closed' : null;
}

// ── Logic capture (optional extension, live-protocol.adoc) ──────────────────

// ponytail: ~13 chunks a second against the limit of 20, which a hub counts on arrival over a rolling second:
// the margin absorbs network jitter. 200 000 edges take about 3.5 s.
const CHUNK_GAP_MS = 75;

// `detail` goes back to the agent (read_capture): fixed English, whatever the page's language.
const INTERRUPTED: Record<Interruption, string> = {
  replaced: 'Capture replaced by a new request.',
  hidden: 'Capture interrupted: the bench tab went to the background, which pauses the simulation.',
  stop: 'Capture interrupted: the simulation was stopped.',
  relaunch: 'Capture interrupted: the simulation was started again (new code or new run).',
};
const PAUSED = 'The simulation was paused during the capture.';

export interface LogicCapture {
  /** A `capture_start` from the hub; replaces the capture in progress, if any (the page's included). */
  start(msg: Record<string, unknown>): void;
  /** An `analog_start` from the hub (v0.8); replaces the capture in progress, logic or analog. */
  analog(msg: Record<string, unknown>): void;
  /** The owner paused the simulation (v0.12): a capture still recording ends with capture_error. */
  paused(): void;
  /** Drops the capture in progress without a word. */
  close(): void;
}

/**
 * Sends `items` in messages `{...head, seq, ...first, [key]: […], last}` of
 * at most 64 KiB, one every 75 ms; `first` goes into the first one only.
 * `end` runs after the last one, or when the channel is down (the hub fails a
 * capture that gets no `last`). Returns what stops the sending.
 */
function sendChunks(head: object, first: object, key: string, items: unknown[], send: (msg: object) => boolean, end: () => void): () => void {
  let seq = 0;
  let i = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const next = () => {
    const list: unknown[] = [];
    const msg = { ...head, seq, ...(seq === 0 && first), [key]: list, last: false };
    let size = bytes(msg); // `false` is longer than `true`
    for (; i < items.length; i++) {
      const add = JSON.stringify(items[i]).length + (list.length ? 1 : 0); // ASCII only
      if (size + add > MAX_MESSAGE) break;
      size += add;
      list.push(items[i]);
    }
    msg.last = i === items.length;
    if (!send(msg) || msg.last) return end();
    seq++;
    timer = setTimeout(next, CHUNK_GAP_MS);
  };
  next();
  return () => clearTimeout(timer);
}

/**
 * The owner's side of the agent's captures, one at a time. Logic: every edge
 * of the requested probe pins over `duration_ms` of simulated time, from the
 * instant `capture_start` arrives (capture.ts records), sent in
 * `capture_chunk`s. Analog (v0.8, with a `sampler`): the voltage of board pins
 * at `rate_hz` (analog.ts samples), sent in `analog_chunk`s. Both record and
 * never interpret: measures and protocol decoding belong to the hub.
 */
export function logicCapture(recorder: Recorder, running: () => boolean, send: (msg: object) => boolean, sampler?: Sampler, isPaused = () => false): LogicCapture {
  /** `sending`: recorded, its chunks going out; a pause no longer touches it. */
  type Cur = { id: string; cancel?: () => void; sending?: boolean };
  let cur: Cur | null = null;

  const drop = () => {
    cur?.cancel?.();
    cur = null;
  };
  const fail = (detail: string) => {
    if (!cur) return;
    send({ type: 'capture_error', capture: cur.id, detail });
    drop();
  };
  /** The id of a request, the capture in progress given up; null when there is nothing to answer to. */
  const begin = (msg: Record<string, unknown>) => {
    const id = msg.capture;
    if (typeof id !== 'string' || !id || id.length > 128) return null;
    fail(INTERRUPTED.replaced);
    return id;
  };
  const refuser = (id: string) => (detail: string) => void send({ type: 'capture_error', capture: id, detail });
  /** Why a recording cannot start now, or null. */
  const notNow = () =>
    !running()
      ? 'The simulation is not running: run it, then ask for the capture again.'
      : isPaused()
        ? 'The simulation is paused: resume it, then ask for the capture again.'
        : document.hidden
          ? 'The bench tab is in the background: the simulation is paused there.'
          : null;
  const deliver = (c: Cur, type: string, first: object, key: string, items: unknown[]) => {
    if (cur !== c) return;
    c.sending = true;
    c.cancel = sendChunks({ type, capture: c.id }, first, key, items, send, () => {
      if (cur === c) cur = null;
    });
  };
  const interrupted = (c: Cur) => (why: Interruption) => {
    if (cur !== c) return;
    c.cancel = undefined;
    fail(INTERRUPTED[why]);
  };

  return {
    start(msg) {
      const id = begin(msg);
      if (!id) return;
      const refuse = refuser(id);
      const duration = msg.duration_ms;
      if (!Array.isArray(msg.pins) || typeof duration !== 'number' || !(duration >= 1 && duration <= CAPTURE_MAX_MS)) return refuse('Invalid capture request.');
      const pins = [...new Set(msg.pins.filter((p): p is number => Number.isInteger(p) && recorder.probed.has(p)))];
      if (!pins.length) return refuse('None of the requested pins is probed on this bench.');
      const why = notNow();
      if (why) return refuse(why);
      const c: Cur = { id };
      cur = c;
      c.cancel = recorder.record(pins, duration, (rec: Recording) => deliver(c, 'capture_chunk', { initial: rec.initial, t0_ms: Math.max(0, Math.round(rec.t0Ms)) }, 'edges', rec.edges), interrupted(c));
    },
    analog(msg) {
      const id = begin(msg);
      if (!id) return;
      const refuse = refuser(id);
      const { pins, duration_ms: duration, rate_hz: rate } = msg;
      if (typeof duration !== 'number' || !(duration >= 1 && duration <= ANALOG_MAX.ms) || typeof rate !== 'number' || !(rate >= ANALOG_MAX.minHz && rate <= ANALOG_MAX.maxHz))
        return refuse('Invalid analog capture request: duration_ms 1 to 10000, rate_hz 100 to 10000.');
      if (!Array.isArray(pins) || !pins.length || pins.length > ANALOG_MAX.pins || !pins.every((p) => Number.isInteger(p) && (!sampler || sampler.pins.includes(p))))
        return refuse(`Invalid pins: 1 to 4 board pins, by their Arduino number${sampler ? ` (this board: ${sampler.pins.join(', ')})` : ''}.`);
      if ((pins.length * rate * duration) / 1000 > ANALOG_MAX.samples) return refuse('Too many samples: at most 200000 (pins x rate_hz x duration_ms / 1000).');
      const why = notNow();
      if (why) return refuse(why);
      const c: Cur = { id };
      cur = c;
      // A one-row capture is taken and sent before sample() returns.
      const cancel = sampler?.sample(pins as number[], duration, rate, (rows, t0Ms) => deliver(c, 'analog_chunk', { t0_ms: Math.max(0, Math.round(t0Ms)) }, 'samples', rows), interrupted(c));
      if (!cancel) {
        cur = null;
        return refuse('Analog capture is not available on this board.');
      }
      if (cur === c && !c.cancel) c.cancel = cancel;
    },
    paused() {
      if (cur && !cur.sending) fail(PAUSED);
    },
    close: drop,
  };
}

/** A capture of the bench relayed by the hub (v0.20): waiting for its chunks, failed, or put together. */
/** `refused`: the hub answered `capture_request` with `error` (its `code`; the detail is never shown). */
export type BenchCapture = { phase: 'waiting' } | { phase: 'failed' } | { phase: 'refused'; why: 'busy' | 'refused' | 'other' } | { phase: 'done'; rec: Recording };

const isEdge = (e: unknown): e is [number, number, 0 | 1] =>
  Array.isArray(e) && e.length === 3 && Number.isSafeInteger(e[0]) && Number.isInteger(e[1]) && (e[2] === 0 || e[2] === 1);

/**
 * Puts the relayed `capture_chunk`s of one capture together, in `seq` order; a chunk that does not
 * follow is ignored. The window is the first chunk's `duration_ms` when the hub relays it; else
 * `durationMs`, the window the visitor asked for; else (the agent's) it ends at the last edge.
 */
export function benchCaptureReader(durationMs: () => number | undefined) {
  let cur: { id: string; seq: number; rec: Recording; durationMs?: number } | null = null;
  return (msg: Record<string, unknown>): BenchCapture | null => {
    const id = msg.capture;
    if (typeof id !== 'string') return null;
    if (msg.type === 'capture_error') {
      cur = null;
      return { phase: 'failed' };
    }
    const { edges, initial } = msg;
    if (!Array.isArray(edges) || !edges.every(isEdge)) return null;
    if (msg.seq === 0) {
      if (!initial || typeof initial !== 'object' || !Object.values(initial).every((v) => v === 0 || v === 1)) return null;
      const pins = Object.keys(initial).map(Number).filter(Number.isInteger);
      const t0 = Number.isSafeInteger(msg.t0_ms) ? (msg.t0_ms as number) : 0;
      const relayed = Number.isSafeInteger(msg.duration_ms) && (msg.duration_ms as number) > 0 ? (msg.duration_ms as number) : undefined;
      cur = { id, seq: 0, rec: { pins, durationMs: 0, initial: initial as Record<string, 0 | 1>, t0Ms: t0, edges: [] }, durationMs: relayed };
    } else if (!cur || cur.id !== id || msg.seq !== cur.seq + 1) return null;
    else cur.seq++;
    for (const e of edges) cur.rec.edges.push(e);
    if (msg.last !== true) return { phase: 'waiting' };
    const { rec, durationMs: relayed } = cur;
    cur = null;
    rec.durationMs = relayed ?? durationMs() ?? Math.max(1, Math.ceil((rec.edges.at(-1)?.[0] ?? 0) / 1000));
    return { phase: 'done', rec };
  };
}

export interface OwnerHooks {
  /** The bench as it is now, published as `state`. */
  state(): BenchState;
  push(files: SketchFile[], run: boolean): void;
  /** `program` (v0.15): a HEX compiled on the agent's machine, run without compiling; `files` its sources, shown only. */
  program?(hex: string, files: SketchFile[] | undefined, run: boolean): void;
  agent(call: { tool: string; summary: string }): void;
  viewers(count: number): void;
  status(status: HubStatus): void;
  /** Null: no session could be had, sharing is unavailable. */
  session(info: SessionInfo | null): void;
  queue?(msg: QueueMessage): void;
  /** `notice`: a message of the hub's operator, plain text. */
  notice?(text: string): void;
  /** `level`: go to this level (index, unchecked against the sheet). */
  level?(index: number): void;
  /** `verdict`: the hub's decision on an answer; `error` is French text for the visitor. */
  verdict?(test: string, ok: boolean, error?: string): void;
  /** `secrets`: values per test id, to feed the simulation (a virtual device). */
  secrets?(secrets: Record<string, string>): void;
  /**
   * `circuit` (v0.8, free mode only): replace the bench's circuit with this
   * one, its shape checked. Resolves to null once done, or to why it is
   * refused (English, for the agent), nothing changed.
   */
  circuit?(circuit: PushedCircuit): Promise<string | null>;
  /** The board's simulator and its pins, for the analog capture (v0.8); without them, analog_start is refused. */
  sim?(): AnalogSim | null;
  board?: BoardPins;
  /** `benches` (v0.20): the offer of this setup, pushed by the hub. */
  offers?(offers: BenchOffer[]): void;
  /** A capture of the bench relayed by the hub (v0.20), the visitor's or the agent's. */
  benchCapture?(capture: BenchCapture): void;
  /** The serial output of the bench's board during a turn (v0.23), plain text, never HTML. */
  benchSerial?(text: string): void;
}

export interface OwnerLink {
  /** Publishes `state` soon (debounced). */
  publishState(): void;
  /** `origin`: compiled by the lab (`cloud`) or received from the agent (`agent`, v0.15). */
  publishCompile(ok: boolean, log: string, program?: string, origin?: 'cloud' | 'agent'): void;
  /** `queue_join` / `queue_leave`; false when the channel is down (nothing sent). */
  joinQueue(kind: string): boolean;
  leaveQueue(): boolean;
  /** Sends the visitor's answer to an `answer` test; false when the channel is down (nothing sent). */
  submitAnswer(test: string, value: string): boolean;
  /** The simulation was stopped or is about to start again: a capture being recorded is lost. */
  halted(reason: 'stop' | 'relaunch'): void;
  /** The owner paused the simulation (v0.12): the agent's capture being recorded ends; the page's waits. */
  paused(): void;
  /** The circuit may have changed: publishes `state` (debounced) when it did. */
  circuitChanged(): void;
  /** `capture_request` (v0.20): a capture on the bench's analyser during a real turn; false when the channel is down. */
  requestCapture(pins: number[], durationMs: number): boolean;
  close(): void;
}

/**
 * The bench as owner of its session: never throws, the bench works without
 * the hub. A session the hub refuses (ended, unknown token) is replaced by a
 * new one, once; a channel taken over by another tab is left offline.
 */
export function startOwner(sheet: SetupSheet, mode: string, probe: BenchProbe, hooks: OwnerHooks, shared?: Recorder): OwnerLink {
  let live: Live | null = null;
  let stopRecording = () => {};
  let closed = false;
  let renewed = false;
  let pending: ReturnType<typeof setTimeout> | undefined;
  let circuitCheck: ReturnType<typeof setTimeout> | undefined;
  let lastCircuit = '';
  const circuitText = (state: BenchState) => JSON.stringify(state.circuit ?? null);
  const sendState = () => {
    const state = hooks.state();
    lastCircuit = circuitText(state);
    live?.send(stateMessage(state));
  };
  const publishState = () => {
    clearTimeout(pending);
    pending = setTimeout(sendState, STATE_DEBOUNCE_MS);
  };
  // The page's recorder when it has one: one capture at a time, the agent's or the visitor's.
  const recorder = shared ?? createRecorder(sheet, probe);
  const sampler = hooks.sim && hooks.board ? createSampler(hooks.sim, probe, hooks.board) : undefined;
  const capture = logicCapture(recorder, () => hooks.state().running, (msg) => !!live?.send(msg), sampler, () => !!hooks.state().clock?.paused);
  /** The duration of the visitor's bench capture still awaited, if any. */
  let asked: number | undefined;
  const readBenchCapture = benchCaptureReader(() => asked);

  const unavailable = (e: unknown) => {
    if (closed) return;
    console.warn('bench: hub unavailable,', e);
    hooks.session(null);
    hooks.status('offline');
  };

  const begin = (info: SessionInfo) => {
    if (closed) return;
    if (info.draft) renewed = true; // ditto ownSession
    hooks.session(info);
    if (info.viewers !== undefined) hooks.viewers(info.viewers);
    live = connectLive(info.session, 'owner', info.owner!, {
      status: hooks.status,
      open: sendState,
      refused(established) {
        stopRecording();
        if (established) return hooks.status('replaced');
        if (renewed) return unavailable(new Error('hub : session refusée'));
        renewed = true;
        hooks.status('connecting');
        createSession(sheet.id, mode).then(begin, unavailable);
      },
      message(msg) {
        switch (msg.type) {
          case 'push': {
            const files = pushedFiles(msg);
            if (files) hooks.push(files, msg.run !== false);
            break;
          }
          case 'program': {
            const got = pushedProgram(msg);
            if (got) hooks.program?.(got.hex, got.files, msg.run !== false);
            break;
          }
          case 'agent':
            if (typeof msg.tool !== 'string') break;
            hooks.agent({ tool: msg.tool.slice(0, 64), summary: String(msg.summary ?? '').slice(0, 500) });
            // The agent changed who may watch: the hub only says so here.
            if (msg.tool === 'set_visibility')
              void readBack({ ...remembered(info.session), owner: info.owner }).then((fresh) => {
                if (closed || !fresh) return;
                hooks.session(fresh);
                if (fresh.viewers !== undefined) hooks.viewers(fresh.viewers);
              });
            break;
          case 'viewers': {
            const n = Number(msg.count);
            if (Number.isInteger(n) && n >= 0) hooks.viewers(n);
            break;
          }
          case 'capture_start':
            capture.start(msg);
            break;
          case 'analog_start':
            capture.analog(msg);
            break;
          case 'circuit': {
            // A level's circuit does not change: ignored in challenge mode.
            if (mode !== 'free' || !hooks.circuit) break;
            const pushed = readCircuit(msg);
            const refused = (detail: string) => live?.send({ type: 'circuit_error', detail });
            if (typeof pushed === 'string') refused(pushed);
            else
              hooks.circuit(pushed).then(
                (detail) => (detail ? refused(detail) : publishState()),
                (e: unknown) => refused(`Circuit not applied: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500)),
              );
            break;
          }
          case 'notice':
            if (typeof msg.text === 'string' && msg.text.trim()) hooks.notice?.(msg.text.slice(0, MAX_NOTICE));
            break;
          case 'level':
            if (Number.isInteger(msg.level) && (msg.level as number) >= 0) hooks.level?.(msg.level as number);
            break;
          case 'benches':
            hooks.offers?.(readOffers(msg.benches, sheet.id));
            break;
          // The owner sends these for the browser's captures; from the hub they are the bench's.
          case 'capture_chunk':
          case 'capture_error': {
            const got = readBenchCapture(msg);
            if (got && got.phase !== 'waiting') asked = undefined;
            if (got) hooks.benchCapture?.(got);
            break;
          }
          // From the hub, only the bench's serial during a turn (v0.23).
          case 'events': {
            if (!Array.isArray(msg.events)) break;
            const text = msg.events
              .filter((e): e is { v: string } => !!e && e.k === 'serial' && typeof e.v === 'string')
              .map((e) => e.v)
              .join('');
            if (text) hooks.benchSerial?.(text);
            break;
          }
          case 'error':
            if (msg.ref === 'capture_request') {
              asked = undefined; // refused: the next capture is not the visitor's
              hooks.benchCapture?.({ phase: 'refused', why: msg.code === 'busy' || msg.code === 'refused' ? msg.code : 'other' });
            }
            // The detail for the console only, in English.
            console.warn('bench: the hub refused a message,', String(msg.code), String(msg.ref), String(msg.detail ?? '').slice(0, 500));
            break;
          case 'verdict':
            if (typeof msg.test === 'string' && typeof msg.ok === 'boolean')
              hooks.verdict?.(msg.test, msg.ok, typeof msg.error === 'string' ? msg.error : undefined);
            break;
          case 'secrets': {
            const raw = msg.secrets;
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) break;
            const secrets: Record<string, string> = {};
            for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') secrets[k] = v;
            hooks.secrets?.(secrets);
            break;
          }
          default: {
            const q = queueMessage(msg);
            if (q) hooks.queue?.(q);
          }
        }
      },
    });
    stopRecording = recordEvents(sheet, probe, (events) => live?.send({ type: 'events', events }));
  };

  hooks.status('connecting');
  ownSessionOnce(sheet.id, mode).then(begin, unavailable);

  return {
    publishState,
    circuitChanged() {
      // Throttled, not debounced: a running simulation may touch the parts all the time.
      if (circuitCheck) return;
      circuitCheck = setTimeout(() => {
        circuitCheck = undefined;
        if (circuitText(hooks.state()) !== lastCircuit) publishState();
      }, STATE_DEBOUNCE_MS);
    },
    publishCompile(ok, log, program, origin = 'cloud') {
      // The compiled program travels to a real bench through the hub (v0.4.4);
      // above the cap the bench gets nothing and the log says so.
      let note = '';
      if (ok && program !== undefined && new TextEncoder().encode(program).length > MAX_PROGRAM) {
        program = undefined;
        note = '\n' + text().programTooBig;
      }
      log = (log.length > MAX_LOG ? LOG_CUT + log.slice(-MAX_LOG) : log) + note;
      live?.send(compileMessage(ok, log, ok ? program : undefined, origin));
    },
    requestCapture(pins, durationMs) {
      if (!live?.send({ type: 'capture_request', pins, duration_ms: durationMs })) return false;
      asked = durationMs;
      return true;
    },
    joinQueue: (kind) => !!live?.send({ type: 'queue_join', kind }),
    leaveQueue: () => !!live?.send({ type: 'queue_leave' }),
    submitAnswer: (test, value) => !!live?.send({ type: 'answer', test, value }),
    halted(reason) {
      if (!shared) recorder.halted(reason); // a shared one is the page's to tell
      sampler?.halted(reason);
    },
    paused: () => capture.paused(),
    close() {
      closed = true;
      clearTimeout(pending);
      clearTimeout(circuitCheck);
      stopRecording();
      capture.close();
      sampler?.close();
      if (!shared) recorder.close();
      live?.close();
    },
  };
}
