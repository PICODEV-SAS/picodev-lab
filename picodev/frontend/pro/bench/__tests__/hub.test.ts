/**
 * The bench's hub client against a fake hub: fetch and WebSocket are mocked,
 * the address bar and sessionStorage are plain objects.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeProbe } from '../engine/__tests__/fakeProbe';
import type { SetupSheet } from '../types';

class FakeSocket {
  static OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeSocket.all.push(this);
  }
  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
  // the hub's side
  accept() {
    this.readyState = 1;
    this.onopen?.();
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  deliver(msg: object) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  ofType(type: string) {
    return this.sent.filter((m) => m.type === type);
  }
}

const sheet = {
  id: 'setup-a',
  probes: [
    { pin: 9, label: 'D9', kind: 'scope' },
    { pin: 2, label: 'D2', kind: 'logic' },
  ],
  scene: { svg: 'scene.svg', bindings: [{ target: 'arm', source: 'servo:9', effect: 'rotate', min: 0, max: 180, from: 0, to: 90 }] },
  levels: [],
} as unknown as SetupSheet;

const state = { setup: 'setup-a', mode: 'free' as const, files: [{ name: 'sketch.ino', content: 'void setup(){}' }], level: 0, running: false, results: [] };

function setAddress(path: string) {
  const url = new URL(path, 'https://lab.example');
  Object.assign(location, { pathname: url.pathname, search: url.search, hash: url.hash });
}

let fetchMock: ReturnType<typeof vi.fn>;
let store: Map<string, string>;
let hidden: boolean;
let visibility: Set<() => void>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  FakeSocket.all = [];
  store = new Map();
  (globalThis as { __LAB_CONFIG__?: object }).__LAB_CONFIG__ = { hubUrl: '/hub' };
  vi.stubGlobal('location', { protocol: 'https:', host: 'lab.example', origin: 'https://lab.example', pathname: '/', search: '', hash: '' });
  vi.stubGlobal('history', { state: null, replaceState: vi.fn((_s: unknown, _t: string, url: string) => setAddress(url)) });
  vi.stubGlobal('sessionStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) });
  vi.stubGlobal('WebSocket', FakeSocket);
  hidden = false;
  visibility = new Set();
  vi.stubGlobal('document', {
    get hidden() {
      return hidden;
    },
    addEventListener: (_type: string, f: () => void) => visibility.add(f),
    removeEventListener: (_type: string, f: () => void) => visibility.delete(f),
  });
  fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ session: 'renard-bleu-042', owner: 'OWNER', viewer: 'VIEWER', visibility: 'link' }) }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const HEX = ':0100000000FF\r\n:00000001FF\r\n';

function hooks() {
  return { state: () => state, push: vi.fn(), program: vi.fn(), agent: vi.fn(), viewers: vi.fn(), status: vi.fn(), session: vi.fn() };
}

describe('bench hub client, owner', () => {
  it('creates the session, says hello first, then publishes the state', async () => {
    const { startOwner } = await import('../hub');
    setAddress('/bench/setup-a');
    const h = hooks();
    const link = startOwner(sheet, 'free', fakeProbe().probe, h);
    await vi.runOnlyPendingTimersAsync();

    expect(fetchMock).toHaveBeenCalledWith('/hub/sessions', expect.objectContaining({ method: 'POST', body: JSON.stringify({ setup: 'setup-a', mode: 'free' }) }));
    expect(h.session).toHaveBeenCalledWith({ session: 'renard-bleu-042', owner: 'OWNER', viewer: 'VIEWER', visibility: 'link' });
    expect(location.search).toBe('?s=renard-bleu-042'); // a reload resumes it

    const ws = FakeSocket.all[0];
    expect(ws.url).toBe('wss://lab.example/hub/sessions/renard-bleu-042/live');
    ws.accept();
    expect(ws.sent[0]).toEqual({ type: 'hello', role: 'owner', token: 'OWNER' });
    expect(ws.sent[1]).toEqual({ type: 'state', ...state });
    expect(h.status).toHaveBeenLastCalledWith('live');

    link.publishState();
    link.publishState();
    await vi.advanceTimersByTimeAsync(400);
    expect(ws.ofType('state')).toHaveLength(2); // debounced into one

    link.publishCompile(false, 'error: x');
    expect(ws.ofType('compile')).toEqual([{ type: 'compile', ok: false, log: 'error: x', origin: 'cloud' }]);
    link.publishCompile(true, 'from the agent', HEX, 'agent');
    expect(ws.ofType('compile')[1]).toEqual({ type: 'compile', ok: true, log: 'from the agent', program: HEX, origin: 'agent' });
    link.close();
  });

  it('resumes ?s=<session>#o=<token>, takes the token out of the address, reads the session back', async () => {
    const { startOwner } = await import('../hub');
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ session: 'abc123', setup: 'setup-a', mode: 'free', visibility: 'public', viewer: 'VIEWER', viewers: 3 }) });
    setAddress('/bench/setup-a?s=abc123#o=TOKEN');
    const h = hooks();
    startOwner(sheet, 'free', fakeProbe().probe, h);
    await vi.runOnlyPendingTimersAsync();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/hub/sessions/abc123', { headers: { Authorization: 'Bearer TOKEN' } });
    expect(location.hash).toBe('');
    expect(location.search).toBe('?s=abc123');
    expect(h.session).toHaveBeenCalledWith({ session: 'abc123', owner: 'TOKEN', visibility: 'public', viewer: 'VIEWER', viewers: 3 });
    expect(h.viewers).toHaveBeenCalledWith(3);
    expect(JSON.parse(store.get('picodev-lab:hub:abc123')!)).toEqual({ session: 'abc123', owner: 'TOKEN', visibility: 'public', viewer: 'VIEWER' });
    FakeSocket.all[0].accept();
    expect(FakeSocket.all[0].sent[0]).toEqual({ type: 'hello', role: 'owner', token: 'TOKEN' });
  });

  it('batches the probe events, at most every 100 ms', async () => {
    const { startOwner } = await import('../hub');
    const fake = fakeProbe();
    const link = startOwner(sheet, 'free', fake.probe, hooks());
    await vi.runOnlyPendingTimersAsync();
    const ws = FakeSocket.all[0];
    ws.accept();

    fake.pin(2, true, 1);
    fake.pin(5, true, 1.5); // neither a probe nor in the scene
    fake.servo(9, 70, 2);
    fake.serial('Arm', 3);
    fake.serial(': press', 3.2);
    await vi.advanceTimersByTimeAsync(100);
    expect(ws.ofType('events')).toEqual([
      {
        type: 'events',
        events: [
          { t: 1, k: 'pin', pin: 2, v: 1 },
          { t: 2, k: 'servo', pin: 9, v: 70 },
          { t: 3, k: 'serial', v: 'Arm: press' },
        ],
      },
    ]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(ws.ofType('events')).toHaveLength(1); // nothing new, nothing sent

    link.close();
    expect(fake.listenerCount()).toBe(0);
  });

  it('applies push, reports agent calls and viewers, ignores a bad push', async () => {
    const { startOwner } = await import('../hub');
    const h = hooks();
    startOwner(sheet, 'free', fakeProbe().probe, h);
    await vi.runOnlyPendingTimersAsync();
    const ws = FakeSocket.all[0];
    ws.accept();

    ws.deliver({ type: 'push', files: [{ name: 'sketch.ino', content: 'x' }], run: true });
    ws.deliver({ type: 'push', files: [{ name: '../etc/passwd', content: 'x' }], run: true });
    ws.deliver({ type: 'push', files: 'nope' });
    ws.deliver({ type: 'agent', tool: 'push_to_editor', summary: 'LED suit le bouton' });
    ws.deliver({ type: 'viewers', viewers: 5 }); // not the contract's field
    ws.deliver({ type: 'viewers', count: 2 });
    expect(h.push).toHaveBeenCalledTimes(1);
    expect(h.push).toHaveBeenCalledWith([{ name: 'sketch.ino', content: 'x' }], true);
    expect(h.agent).toHaveBeenCalledWith({ tool: 'push_to_editor', summary: 'LED suit le bouton' });
    expect(h.viewers.mock.calls).toEqual([[2]]);
  });

  it('applies a program, its sources when sent, and drops a bad one', async () => {
    const { startOwner } = await import('../hub');
    const h = hooks();
    startOwner(sheet, 'free', fakeProbe().probe, h);
    await vi.runOnlyPendingTimersAsync();
    const ws = FakeSocket.all[0];
    ws.accept();

    ws.deliver({ type: 'program', hex: HEX, run: false });
    ws.deliver({ type: 'program', hex: HEX, files: [{ name: 'sketch.ino', content: 'x' }] });
    ws.deliver({ type: 'program', hex: HEX, files: [{ name: '../x', content: 'x' }] }); // bad sources: all of it dropped
    ws.deliver({ type: 'program', hex: ':0100000000FE\n:00000001FF\n' }); // wrong checksum
    ws.deliver({ type: 'program', hex: ':0100000000FF\n:' + '00'.repeat(25 * 1024) });
    expect(h.program.mock.calls).toEqual([
      [HEX, undefined, false],
      [HEX, [{ name: 'sketch.ino', content: 'x' }], true],
    ]);
  });

  it('reconnects with a growing delay', async () => {
    const { startOwner } = await import('../hub');
    const h = hooks();
    const link = startOwner(sheet, 'free', fakeProbe().probe, h);
    await vi.runOnlyPendingTimersAsync();
    FakeSocket.all[0].drop();
    expect(h.status).toHaveBeenLastCalledWith('offline');
    await vi.advanceTimersByTimeAsync(999);
    expect(FakeSocket.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.all).toHaveLength(2);
    FakeSocket.all[1].drop();
    await vi.advanceTimersByTimeAsync(1999);
    expect(FakeSocket.all).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.all).toHaveLength(3);
    FakeSocket.all[2].accept();
    expect(FakeSocket.all[2].sent[0]).toMatchObject({ type: 'hello' });
    link.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.all).toHaveLength(3);
  });

  it('takes its own session back after a reload (language switch), without creating another', async () => {
    setAddress('/bench/setup-a');
    const first = (await import('../hub')).startOwner(sheet, 'free', fakeProbe().probe, hooks());
    await vi.runOnlyPendingTimersAsync();
    first.close();
    vi.resetModules(); // the reload: same address and sessionStorage, a fresh page
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ session: 'renard-bleu-042', visibility: 'link', viewer: 'VIEWER', viewers: 0 }) });
    const h = hooks();
    (await import('../hub')).startOwner(sheet, 'free', fakeProbe().probe, h);
    await vi.runOnlyPendingTimersAsync();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(fetchMock).toHaveBeenLastCalledWith('/hub/sessions/renard-bleu-042', { headers: { Authorization: 'Bearer OWNER' } });
    expect(h.session).toHaveBeenCalledWith(expect.objectContaining({ session: 'renard-bleu-042', owner: 'OWNER' }));
    FakeSocket.all[1].accept();
    expect(FakeSocket.all[1].sent[0]).toEqual({ type: 'hello', role: 'owner', token: 'OWNER' });
  });

  it('resumes on what the tab remembers when the read-back fails', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const { startOwner } = await import('../hub');
    setAddress('/bench/setup-a?s=abc123#o=TOKEN');
    const h = hooks();
    startOwner(sheet, 'free', fakeProbe().probe, h);
    await vi.runOnlyPendingTimersAsync();
    expect(h.session).toHaveBeenCalledWith({ session: 'abc123', owner: 'TOKEN' });
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('reads the session back when the agent changes the visibility', async () => {
    const { startOwner } = await import('../hub');
    const h = hooks();
    startOwner(sheet, 'free', fakeProbe().probe, h);
    await vi.runOnlyPendingTimersAsync();
    const ws = FakeSocket.all[0];
    ws.accept();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ session: 'renard-bleu-042', setup: 'setup-a', mode: 'free', visibility: 'public', viewer: 'NEW', viewers: 0 }) });

    ws.deliver({ type: 'agent', tool: 'set_visibility', summary: 'public' });
    await vi.runOnlyPendingTimersAsync();
    expect(fetchMock).toHaveBeenLastCalledWith('/hub/sessions/renard-bleu-042', { headers: { Authorization: 'Bearer OWNER' } });
    expect(h.session).toHaveBeenLastCalledWith({ session: 'renard-bleu-042', owner: 'OWNER', visibility: 'public', viewer: 'NEW', viewers: 0 });
    expect(h.viewers).toHaveBeenLastCalledWith(0);
  });

  it('does not retry a channel the hub refused (1008)', async () => {
    const { connectLive } = await import('../hub');
    const refused = vi.fn();
    const status = vi.fn();
    connectLive('abc123', 'viewer', 'REVOKED', { message: () => {}, status, refused });
    FakeSocket.all[0].accept();
    FakeSocket.all[0].drop(1008);
    expect(refused).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenLastCalledWith('offline');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('goes on without a hub that does not answer', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { startOwner } = await import('../hub');
    const h = hooks();
    const link = startOwner(sheet, 'free', fakeProbe().probe, h);
    await vi.runOnlyPendingTimersAsync();
    expect(h.status).toHaveBeenLastCalledWith('offline');
    expect(FakeSocket.all).toHaveLength(0);
    link.publishState();
    link.publishCompile(true, '');
    link.close();
  });

  it('leaves the files out of a state larger than a hub accepts', async () => {
    const { startOwner, stateMessage } = await import('../hub');
    const big = { ...state, files: [{ name: 'sketch.ino', content: 'x'.repeat(70_000) }] };
    const h = { ...hooks(), state: () => big };
    startOwner(sheet, 'free', fakeProbe().probe, h);
    await vi.runOnlyPendingTimersAsync();
    const ws = FakeSocket.all[0];
    ws.accept();
    const { files: _f, ...rest } = big;
    expect(ws.ofType('state')).toEqual([{ type: 'state', ...rest, files_omitted: true }]);
    expect(stateMessage(state)).toEqual({ type: 'state', ...state });
  });

  it('opens a new session when the resumed one is gone (404)', async () => {
    const { startOwner } = await import('../hub');
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({ detail: 'no such session' }) });
    setAddress('/bench/setup-a?s=old123#o=TOKEN');
    const h = hooks();
    startOwner(sheet, 'free', fakeProbe().probe, h);
    await vi.runOnlyPendingTimersAsync();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith('/hub/sessions', expect.objectContaining({ method: 'POST' }));
    expect(location.search).toBe('?s=renard-bleu-042');
    expect(JSON.parse(store.get('picodev-lab:hub:renard-bleu-042')!)).toMatchObject({ owner: 'OWNER' });
    expect(FakeSocket.all[0].url).toBe('wss://lab.example/hub/sessions/renard-bleu-042/live');
  });

  it('replaces a session whose hello is refused, once, then gives up', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { startOwner } = await import('../hub');
    const h = hooks();
    startOwner(sheet, 'free', fakeProbe().probe, h);
    await vi.runOnlyPendingTimersAsync();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ session: 'neuf-007', owner: 'OWNER2', viewer: 'V2', visibility: 'link' }) });
    FakeSocket.all[0].accept();
    FakeSocket.all[0].drop(1008); // refused at hello: nothing was received
    await vi.runOnlyPendingTimersAsync();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(location.search).toBe('?s=neuf-007');
    expect(h.session).toHaveBeenLastCalledWith({ session: 'neuf-007', owner: 'OWNER2', viewer: 'V2', visibility: 'link' });
    expect(FakeSocket.all).toHaveLength(2);
    FakeSocket.all[1].accept();
    expect(FakeSocket.all[1].sent[0]).toEqual({ type: 'hello', role: 'owner', token: 'OWNER2' });

    FakeSocket.all[1].drop(1008); // refused again: sharing is unavailable
    await vi.runOnlyPendingTimersAsync();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(h.session).toHaveBeenLastCalledWith(null);
    expect(h.status).toHaveBeenLastCalledWith('offline');
  });

  it('stays offline when another tab takes the session over', async () => {
    const { startOwner } = await import('../hub');
    const h = hooks();
    startOwner(sheet, 'free', fakeProbe().probe, h);
    await vi.runOnlyPendingTimersAsync();
    const ws = FakeSocket.all[0];
    ws.accept();
    ws.deliver({ type: 'viewers', count: 0 });
    ws.drop(1008); // on a channel that worked: replaced
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.status).toHaveBeenLastCalledWith('replaced');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('changes the visibility with the owner token, never in the address', async () => {
    const { changeVisibility, spectatorLink } = await import('../hub');
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ visibility: 'public', viewer: 'NEWVIEWER' }) });
    const info = await changeVisibility({ session: 'abc123', owner: 'OWNER' }, 'public');
    expect(fetchMock).toHaveBeenCalledWith('/hub/sessions/abc123/visibility', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer OWNER' },
      body: JSON.stringify({ visibility: 'public' }),
    });
    expect(info).toEqual({ session: 'abc123', owner: 'OWNER', visibility: 'public', viewer: 'NEWVIEWER' });
    expect(spectatorLink('abc123', 'NEWVIEWER')).toBe('https://lab.example/w/abc123#v=NEWVIEWER');
  });
});

describe('bench hub client, queue (v0.4)', () => {
  it('sends queue_join and queue_leave on the owner channel, not while it is down', async () => {
    const { startOwner } = await import('../hub');
    const link = startOwner(sheet, 'free', fakeProbe().probe, hooks());
    await vi.runOnlyPendingTimersAsync();
    expect(link.joinQueue('real')).toBe(false); // not open yet
    const ws = FakeSocket.all[0];
    ws.accept();
    expect(link.joinQueue('real')).toBe(true);
    expect(link.leaveQueue()).toBe(true);
    expect(ws.sent.filter((m) => String(m.type).startsWith('queue'))).toEqual([{ type: 'queue_join', kind: 'real' }, { type: 'queue_leave' }]);
  });

  it('hands queue, turn, turn_end and queue_error to the page, checked', async () => {
    const { startOwner } = await import('../hub');
    const h = { ...hooks(), queue: vi.fn() };
    startOwner(sheet, 'free', fakeProbe().probe, h);
    await vi.runOnlyPendingTimersAsync();
    const ws = FakeSocket.all[0];
    ws.accept();
    ws.deliver({ type: 'queue', kind: 'real', position: 3, waiting: 4, eta_s: 840 });
    ws.deliver({ type: 'queue', kind: 'real', position: '3', waiting: 4, eta_s: 840 }); // not a number
    ws.deliver({ type: 'turn', kind: 'real', bench: 'setup-a-1', ends_at: 1_800_000_300 });
    ws.deliver({ type: 'turn', kind: '../x', ends_at: 1 }); // not a kind
    ws.deliver({ type: 'turn_end', reason: 'time' });
    ws.deliver({ type: 'queue_error', code: 'full', detail: 'File pleine.' });
    ws.deliver({ type: 'queue_error', detail: 'Ancien hub.' }); // no code
    expect(h.queue.mock.calls).toEqual([
      [{ type: 'queue', kind: 'real', position: 3, waiting: 4, eta_s: 840 }],
      [{ type: 'turn', kind: 'real', bench: 'setup-a-1', ends_at: 1_800_000_300 }],
      [{ type: 'turn_end', reason: 'time' }],
      [{ type: 'queue_error', code: 'full' }],
      [{ type: 'queue_error', code: '' }],
    ]);
  });

  it('reads a spectator turn, without bench', async () => {
    const { queueMessage } = await import('../hub');
    expect(queueMessage({ type: 'turn', kind: 'sim', ends_at: 5 })).toEqual({ type: 'turn', kind: 'sim', ends_at: 5 });
    expect(queueMessage({ type: 'state' })).toBeNull();
  });

  it('keeps the camera of a turn only as a path on this origin', async () => {
    const { queueMessage, queueView } = await import('../hub');
    const turn = (video: unknown) => queueMessage({ type: 'turn', kind: 'real', ends_at: 5, video });
    expect(turn('/video/3/whep')).toEqual({ type: 'turn', kind: 'real', ends_at: 5, video: '/video/3/whep' });
    for (const bad of ['//evil.example/whep', '/\\evil.example/whep', 'https://evil.example/whep', 'video/3/whep', '', 3, null, `/${'a'.repeat(300)}`]) {
      expect(turn(bad), String(bad)).toEqual({ type: 'turn', kind: 'real', ends_at: 5 });
    }
    // Owner and spectators keep it for the turn; turn_end drops it.
    const view = queueView({ phase: 'none' }, turn('/video/3/whep')!);
    expect(view).toMatchObject({ phase: 'turn', video: '/video/3/whep' });
    expect(queueView(view, { type: 'turn_end', reason: 'time' })).not.toHaveProperty('video');
  });

  it('lists the benches of the open setup only, from GET <hub>/benches', async () => {
    const { fetchBenches, kindLabel } = await import('../hub');
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [
        { setup: 'setup-a', kind: 'real', benches: 1, free: 0, waiting: 2 },
        { setup: 'setup-a', kind: 'sim', benches: 0, free: 0, waiting: 0 }, // none connected
        { setup: 'setup-b', kind: 'real', benches: 1, free: 1, waiting: 0 },
        { setup: 'setup-a', kind: 'BAD', benches: 1, free: 1, waiting: 0 },
      ],
    });
    expect(await fetchBenches('setup-a')).toEqual([{ setup: 'setup-a', kind: 'real', benches: 1, free: 0, waiting: 2, status: 'open' }]);
    expect(fetchMock).toHaveBeenCalledWith('/hub/benches');

    // v0.18: a `soon` couple is listed with no bench; an unknown status is dropped.
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [
        { setup: 'setup-a', kind: 'real', benches: 0, free: 0, waiting: 0, status: 'soon' },
        { setup: 'setup-a', kind: 'sim', benches: 1, free: 1, waiting: 0, status: 'open' },
        { setup: 'setup-a', kind: 'sim-2', benches: 1, free: 1, waiting: 0, status: 'later' },
        { setup: 'setup-a', kind: 'sim-3', benches: 0, free: 0, waiting: 0, status: 'open' },
      ],
    });
    expect(await fetchBenches('setup-a')).toEqual([
      { setup: 'setup-a', kind: 'real', benches: 0, free: 0, waiting: 0, status: 'soon' },
      { setup: 'setup-a', kind: 'sim', benches: 1, free: 1, waiting: 0, status: 'open' },
    ]);

    fetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({ detail: 'Not Found' }) });
    expect(await fetchBenches('setup-a')).toEqual([]); // a relay without benches
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    expect(await fetchBenches('setup-a')).toEqual([]);

    const { setLang } = await import('../lang');
    setLang('fr', () => {});
    expect([kindLabel('real'), kindLabel('sim'), kindLabel('sim-esp32')]).toEqual(['banc réel', 'banc simulé', 'sim-esp32']);
    setLang('en', () => {});
    expect([kindLabel('real'), kindLabel('sim')]).toEqual(['real bench', 'simulated bench']);
  });
});

describe('bench hub client, viewer', () => {
  it('takes #v= out of the address and keeps it for a reload', async () => {
    const { takeFragment } = await import('../hub');
    setAddress('/w/abc123#v=VIEWER');
    expect(takeFragment('abc123').viewer).toBe('VIEWER');
    expect(location.hash).toBe('');
    expect(takeFragment('abc123').viewer).toBe('VIEWER');
  });
});

describe('bench hub client, back-office extensions (v0.7)', () => {
  it('shows a notice and moves to a level, drops malformed ones', async () => {
    const { startOwner } = await import('../hub');
    const h = { ...hooks(), notice: vi.fn(), level: vi.fn() };
    startOwner(sheet, 'challenge', fakeProbe().probe, h);
    await vi.runOnlyPendingTimersAsync();
    const ws = FakeSocket.all[0];
    ws.accept();

    ws.deliver({ type: 'notice', text: '<b>Fermeture</b> dans 1 min' });
    ws.deliver({ type: 'notice', text: 'x'.repeat(900) });
    ws.deliver({ type: 'notice', text: 42 });
    ws.deliver({ type: 'notice', text: '  ' });
    ws.deliver({ type: 'level', level: 2 });
    ws.deliver({ type: 'level', level: -1 });
    ws.deliver({ type: 'level', level: 1.5 });
    ws.deliver({ type: 'level', level: '1' });
    expect(h.notice.mock.calls).toEqual([['<b>Fermeture</b> dans 1 min'], ['x'.repeat(500)]]);
    expect(h.level.mock.calls).toEqual([[2]]);
  });

  it('reads a draft token with the owner token, and never replaces a draft session', async () => {
    const { startOwner, takeFragment } = await import('../hub');
    setAddress('/bench/setup-b/challenge?s=try123#o=OWNER&d=DRAFT');
    expect(takeFragment('try123')).toMatchObject({ owner: 'OWNER', draft: 'DRAFT' });
    expect(location.hash).toBe('');
    expect(takeFragment('try123').draft).toBe('DRAFT'); // a reload reads the draft again

    fetchMock.mockResolvedValue({ ok: false, status: 404 }); // the draft expired with its session
    const h = hooks();
    startOwner(sheet, 'challenge', fakeProbe().probe, h);
    await vi.runOnlyPendingTimersAsync();
    expect(fetchMock).toHaveBeenCalledTimes(1); // the read-back only: no POST /sessions
    expect(h.session).toHaveBeenCalledWith(null);
    expect(FakeSocket.all).toHaveLength(0);
  });

  it('reads the status: banner in the language, until, maintenance, closed setups', async () => {
    const { fetchStatus } = await import('../hub');
    const banner = { fr: 'Coupure à 18 h', en: 'Down at 6 pm', until: '2999-01-01T00:00:00Z' };
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ accepting: false, banner, closed_setups: ['setup-a', 3] }) });
    expect(await fetchStatus('en')).toEqual({ accepting: false, closed: ['setup-a'], hidden: [], banner: 'Down at 6 pm' });
    expect(fetchMock).toHaveBeenCalledWith('/hub/status', { cache: 'no-cache' });

    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ accepting: true, banner: { fr: 'x'.repeat(300) }, closed_setups: [] }) });
    expect(await fetchStatus('en')).toEqual({ accepting: true, closed: [], hidden: [], banner: 'x'.repeat(200) }); // French when English is missing

    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ accepting: true, banner: { ...banner, until: '2000-01-01T00:00:00Z' }, closed_setups: [] }) });
    expect(await fetchStatus('fr')).toEqual({ accepting: true, closed: [], hidden: [] }); // over

    // v0.18: soon setups are closed (even from a hub that would not list them in closed_setups), disabled ones hidden.
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ accepting: true, closed_setups: ['setup-b', 'setup-x'], soon_setups: ['setup-b', 'setup-c', 7], hidden_setups: ['setup-x'] }),
    });
    expect(await fetchStatus('fr')).toEqual({ accepting: true, closed: ['setup-b', 'setup-x', 'setup-c'], hidden: ['setup-x'] });

    fetchMock.mockResolvedValue({ ok: false, status: 404 }); // a relay without status
    expect(await fetchStatus('fr')).toBeNull();
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    expect(await fetchStatus('fr')).toBeNull();
  });

  it('pauses the hub session on maintenance or a closed setup, never a session in progress', async () => {
    const { hubPaused } = await import('../hub');
    const open = { accepting: true, closed: [] as string[], hidden: [] as string[] };
    setAddress('/bench/setup-a');
    expect(hubPaused(null, 'setup-a')).toBeNull(); // no hub, or no status
    expect(hubPaused(open, 'setup-a')).toBeNull();
    expect(hubPaused({ ...open, accepting: false }, 'setup-a')).toBe('maintenance');
    expect(hubPaused({ ...open, closed: ['setup-a'] }, 'setup-a')).toBe('closed');
    expect(hubPaused({ ...open, closed: ['setup-b'] }, 'setup-a')).toBeNull();
    // v0.18: the hub's lists rule over the index. A setup marked "soon" in the index but in no list
    // (opened by the administrator) opens; the bench page never reads the index status.
    const lists = await (async () => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({ accepting: true, closed_setups: [], soon_setups: [], hidden_setups: [] }) });
      const { fetchStatus } = await import('../hub');
      return (await fetchStatus('fr'))!;
    })();
    expect(hubPaused(lists, 'setup-b')).toBeNull();
    expect(lists.hidden).not.toContain('setup-b');
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining('index.json'), expect.anything());
    setAddress('/bench/setup-a/challenge?s=try123'); // resumed, a try session's included
    expect(hubPaused({ ...open, accepting: false, closed: ['setup-a'] }, 'setup-a')).toBeNull();
  });

  it('asks nothing without a hub', async () => {
    (globalThis as { __LAB_CONFIG__?: object }).__LAB_CONFIG__ = {};
    const { fetchStatus } = await import('../hub');
    expect(await fetchStatus('fr')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('setup sheet, draft (v0.7)', () => {
  const served = { schema: 1, id: 'setup-b', title: 'B', board: { kind: 'arduino-nano', fqbn: 'arduino:avr:nano' }, files: [{ name: 'sketch.ino', content: '' }], circuit: { components: [], wires: [] }, probes: [], levels: [], scene: { svg: 'https://evil.example/x.svg', bindings: [] } };
  const answer = (url: string) => ({ ok: true, json: async () => served, text: async () => `<svg from="${url}"/>` });
  beforeEach(() => void Object.assign(location, { href: 'https://lab.example/' }));

  it('reads the sheet and the scene from the hub, with the draft token, at fixed paths', async () => {
    fetchMock.mockImplementation(async (url: string) => answer(String(url)));
    const { fetchSetup } = await import('../sheet');
    setAddress('/bench/setup-b/challenge?s=try123#o=OWNER&d=DRAFT');
    const loaded = await fetchSetup('setup-b');
    const auth = { headers: { Authorization: 'Bearer DRAFT' } };
    expect(fetchMock.mock.calls).toEqual([
      ['/hub/drafts/setup-b/setup.json', { cache: 'no-cache', ...auth }],
      [new URL('https://lab.example/hub/drafts/setup-b/scene.svg'), auth],
    ]);
    expect(loaded.draft).toBe(true);
    expect(location.hash).toBe(''); // and the owner token kept for the hub client
    expect(JSON.parse(store.get('picodev-lab:hub:try123')!)).toMatchObject({ owner: 'OWNER', draft: 'DRAFT' });
  });

  it('ignores #d= without a session, and without a hub', async () => {
    fetchMock.mockImplementation(async (url: string) => answer(String(url)));
    let { fetchSetup } = await import('../sheet');
    setAddress('/bench/setup-b#d=DRAFT');
    expect((await fetchSetup('setup-b')).draft).toBe(false);
    expect(fetchMock.mock.calls[0]).toEqual(['/setups/setup-b/setup.json', { cache: 'no-cache' }]);
    expect(fetchMock).toHaveBeenCalledTimes(1); // the scene of another origin is not fetched

    vi.resetModules();
    fetchMock.mockClear();
    (globalThis as { __LAB_CONFIG__?: object }).__LAB_CONFIG__ = {};
    ({ fetchSetup } = await import('../sheet'));
    setAddress('/bench/setup-b?s=try123#d=DRAFT');
    expect((await fetchSetup('setup-b')).draft).toBe(false);
    expect(fetchMock.mock.calls[0][0]).toBe('/setups/setup-b/setup.json');
  });
});

describe('bench hub client, logic capture (v0.5)', () => {
  async function owner() {
    const { startOwner } = await import('../hub');
    const fake = fakeProbe();
    let running = true;
    const link = startOwner(sheet, 'free', fake.probe, { ...hooks(), state: () => ({ ...state, running }) });
    await vi.runOnlyPendingTimersAsync();
    const ws = FakeSocket.all[0];
    ws.accept();
    return { link, fake, ws, stopRunning: () => void (running = false) };
  }
  const bytes = (m: object) => new TextEncoder().encode(JSON.stringify(m)).length;

  it('records the probed pins from reception, in µs, then sends one chunk with the initial levels', async () => {
    const { fake, ws } = await owner();
    fake.pin(2, true, 1); // before the capture: only its level counts
    fake.advance(5);
    ws.deliver({ type: 'capture_start', capture: 'c1', pins: [2, 9, 7], duration_ms: 10 }); // 7 is not probed
    fake.pin(2, false, 5.5);
    fake.pin(2, false, 5.7); // same level: not an edge
    fake.pin(9, true, 6.0004);
    await vi.advanceTimersByTimeAsync(500);
    expect(ws.ofType('capture_chunk')).toEqual([]); // 1 ms of the 10 simulated

    fake.pin(2, true, 15.0001); // past the duration
    await vi.advanceTimersByTimeAsync(50);
    expect(ws.ofType('capture_chunk')).toEqual([
      { type: 'capture_chunk', capture: 'c1', seq: 0, initial: { 2: 1, 9: 0 }, t0_ms: 5, edges: [[500, 2, 0], [1000, 9, 1]], last: true },
    ]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(ws.ofType('capture_chunk')).toHaveLength(1);
    expect(ws.ofType('capture_error')).toEqual([]);
    // The live events go on as before, beside the capture.
    expect(ws.ofType('events').flatMap((m) => m.events as object[])).toContainEqual({ t: 5.5, k: 'pin', pin: 2, v: 0 });
  });

  it('stops one edge past 200,000 and sends chunks under 64 KiB, in order, well under 20 a second', async () => {
    const { fake, ws } = await owner();
    ws.deliver({ type: 'capture_start', capture: 'big', pins: [2], duration_ms: 10_000 });
    for (let i = 0; i < 200_010; i++) fake.pin(2, i % 2 === 0, (i + 1) / 1000);
    expect(ws.ofType('capture_chunk')).toHaveLength(1); // the cap ends the recording at once

    await vi.advanceTimersByTimeAsync(74);
    expect(ws.ofType('capture_chunk')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(925);
    expect(ws.ofType('capture_chunk')).toHaveLength(14); // one every 75 ms: 14 in 999 ms

    await vi.advanceTimersByTimeAsync(10_000);
    const chunks = ws.ofType('capture_chunk');
    expect(chunks.length).toBeGreaterThan(14);
    chunks.forEach((c, i) => {
      expect(bytes(c)).toBeLessThanOrEqual(64 * 1024);
      expect(c.seq).toBe(i);
      expect(c.capture).toBe('big');
      expect('initial' in c).toBe(i === 0);
      expect('t0_ms' in c).toBe(i === 0);
      expect(c.last).toBe(i === chunks.length - 1);
    });
    expect(chunks[0].initial).toEqual({ 2: 0 });
    const edges = chunks.flatMap((c) => c.edges as number[][]);
    expect(edges).toHaveLength(200_001); // one more than a hub keeps: it marks the capture truncated
    expect(edges[0]).toEqual([1, 2, 1]);
    expect(edges.at(-1)).toEqual([200_001, 2, 1]);
    expect(edges.every((e, i) => i === 0 || e[0] >= edges[i - 1][0])).toBe(true);
  });

  it('refuses a capture it cannot record', async () => {
    const { ws, stopRunning } = await owner();
    ws.deliver({ type: 'capture_start', pins: [2], duration_ms: 10 }); // no id: nothing to answer to
    ws.deliver({ type: 'capture_start', capture: 'a', pins: [2], duration_ms: 20_000 });
    ws.deliver({ type: 'capture_start', capture: 'b', pins: [7], duration_ms: 10 });
    hidden = true;
    ws.deliver({ type: 'capture_start', capture: 'c', pins: [2], duration_ms: 10 });
    hidden = false;
    stopRunning();
    ws.deliver({ type: 'capture_start', capture: 'd', pins: [2], duration_ms: 10 });
    expect(ws.ofType('capture_error')).toEqual([
      { type: 'capture_error', capture: 'a', detail: 'Invalid capture request.' },
      { type: 'capture_error', capture: 'b', detail: expect.stringContaining('probed') },
      { type: 'capture_error', capture: 'c', detail: expect.stringContaining('background') },
      { type: 'capture_error', capture: 'd', detail: expect.stringContaining('not running') },
    ]);
  });

  it('gives a recording up when the tab hides, the simulation stops or starts again', async () => {
    const { fake, link, ws } = await owner();
    const run = (id: string) => ws.deliver({ type: 'capture_start', capture: id, pins: [2], duration_ms: 10 });
    run('hidden');
    hidden = true;
    visibility.forEach((f) => f());
    hidden = false;
    run('stopped');
    link.halted('stop');
    fake.pin(2, true, 1);
    run('relaunched');
    link.halted('relaunch'); // also forgets the levels: the next run starts low
    run('after'); // from 1 ms
    fake.advance(11);
    await vi.advanceTimersByTimeAsync(50);
    expect(ws.ofType('capture_error')).toEqual([
      { type: 'capture_error', capture: 'hidden', detail: expect.stringContaining('background') },
      { type: 'capture_error', capture: 'stopped', detail: expect.stringContaining('stopped') },
      { type: 'capture_error', capture: 'relaunched', detail: expect.stringContaining('started again') },
    ]);
    expect(ws.ofType('capture_chunk')).toEqual([{ type: 'capture_chunk', capture: 'after', seq: 0, initial: { 2: 0 }, t0_ms: 1, edges: [], last: true }]);

    // Once recorded, the capture is sent whatever the page does.
    ws.deliver({ type: 'capture_start', capture: 'sent', pins: [2], duration_ms: 10 });
    for (let i = 0; i < 6000; i++) fake.pin(2, i % 2 === 0, 11 + i / 1000);
    fake.advance(30);
    await vi.advanceTimersByTimeAsync(50); // first chunk out
    link.halted('stop');
    await vi.advanceTimersByTimeAsync(1000);
    expect(ws.ofType('capture_chunk').filter((c) => c.capture === 'sent').at(-1)?.last).toBe(true);
    expect(ws.ofType('capture_error')).toHaveLength(3);
  });

  it('replaces a recording by a new capture_start', async () => {
    const { fake, ws } = await owner();
    ws.deliver({ type: 'capture_start', capture: 'old', pins: [2], duration_ms: 10 });
    fake.pin(2, true, 1);
    ws.deliver({ type: 'capture_start', capture: 'new', pins: [2, 9], duration_ms: 5 });
    fake.pin(2, false, 3);
    fake.advance(6);
    await vi.advanceTimersByTimeAsync(50);
    expect(ws.ofType('capture_error')).toEqual([{ type: 'capture_error', capture: 'old', detail: 'Capture replaced by a new request.' }]);
    expect(ws.ofType('capture_chunk')).toEqual([{ type: 'capture_chunk', capture: 'new', seq: 0, initial: { 2: 1, 9: 0 }, t0_ms: 1, edges: [[2000, 2, 0]], last: true }]);
  });
});

describe('bench hub client, circuit (v0.8)', () => {
  const circuit = { components: [{ type: 'wokwi-led', id: 'led1', x: 1, y: 2, properties: {} }], wires: [] };
  async function owner(mode: 'free' | 'challenge', apply: (c: unknown) => Promise<string | null>) {
    const { startOwner } = await import('../hub');
    let current = circuit;
    const h = { ...hooks(), state: () => ({ ...state, mode, circuit: current }), circuit: vi.fn(apply) };
    const link = startOwner(sheet, mode, fakeProbe().probe, h);
    await vi.runOnlyPendingTimersAsync();
    const ws = FakeSocket.all[0];
    ws.accept();
    return { link, ws, h, set: (c: typeof circuit) => void (current = c) };
  }

  it('publishes the circuit in state, again only when it changed', async () => {
    const { link, ws, set } = await owner('free', async () => null);
    expect(ws.ofType('state')[0].circuit).toEqual(circuit);
    link.circuitChanged(); // a part's level changed: same circuit
    await vi.advanceTimersByTimeAsync(1000);
    expect(ws.ofType('state')).toHaveLength(1);
    set({ ...circuit, components: [{ ...circuit.components[0], x: 50 }] });
    for (let i = 0; i < 20; i++) link.circuitChanged(); // dragged
    await vi.advanceTimersByTimeAsync(1000);
    expect(ws.ofType('state')).toHaveLength(2);
    expect((ws.ofType('state')[1].circuit as typeof circuit).components[0].x).toBe(50);
  });

  it('leaves out a circuit larger than a hub keeps', async () => {
    const { stateMessage } = await import('../hub');
    const big = { components: Array.from({ length: 41 }, (_, i) => ({ ...circuit.components[0], id: `l${i}` })), wires: [] };
    expect(stateMessage({ ...state, circuit: big })).not.toHaveProperty('circuit');
    expect(stateMessage({ ...state, circuit })).toHaveProperty('circuit', circuit);
  });

  it('applies a pushed circuit in free mode, then publishes; says why it refuses one', async () => {
    const { ws, h } = await owner('free', async (c) => ((c as typeof circuit).components.length ? null : 'Unknown component type "x" (component a).'));
    ws.deliver({ type: 'circuit', components: [{ type: 'wokwi-led', id: 'led2' }], wires: [] });
    await vi.advanceTimersByTimeAsync(400);
    expect(h.circuit).toHaveBeenCalledWith({ components: [{ type: 'wokwi-led', id: 'led2', properties: {} }], wires: [] });
    expect(ws.ofType('state')).toHaveLength(2);

    ws.deliver({ type: 'circuit', components: [], wires: [] });
    await vi.advanceTimersByTimeAsync(400);
    ws.deliver({ type: 'circuit', components: 'no' });
    expect(ws.ofType('circuit_error')).toEqual([
      { type: 'circuit_error', detail: 'Unknown component type "x" (component a).' },
      { type: 'circuit_error', detail: expect.stringContaining('Invalid circuit') },
    ]);
    expect(h.circuit).toHaveBeenCalledTimes(2); // the malformed one never reaches the page
    expect(ws.ofType('state')).toHaveLength(2);
  });

  it('ignores a circuit in challenge mode', async () => {
    const { ws, h } = await owner('challenge', async () => null);
    ws.deliver({ type: 'circuit', components: [], wires: [] });
    await vi.advanceTimersByTimeAsync(400);
    expect(h.circuit).not.toHaveBeenCalled();
    expect(ws.ofType('circuit_error')).toEqual([]);
  });
});

describe('bench hub client, analog capture (v0.8)', () => {
  /** A simulator whose clock moves only when the test says so; clock events fire in order. */
  function fakeSim() {
    let cycles = 0;
    let events: Array<{ at: number; cb: () => void }> = [];
    const adc = { channelValues: [0, 0, 0, 0, 0, 0, 0, 0], avcc: 5 };
    return {
      sim: {
        getADC: () => adc,
        addClockEvent: (cb: () => void, n: number) => !!events.push({ at: cycles + n, cb }),
        getCurrentCycles: () => cycles,
        getClockHz: () => 16_000_000,
      },
      adc,
      run(to: number) {
        for (;;) {
          events.sort((a, b) => a.at - b.at);
          const e = events[0];
          if (!e || e.at > to) break;
          events = events.slice(1);
          cycles = e.at;
          e.cb();
        }
        cycles = Math.max(cycles, to);
      },
    };
  }
  async function owner(withSim = true) {
    const { startOwner } = await import('../hub');
    const fake = fakeProbe();
    const sim = fakeSim();
    let running = true;
    const link = startOwner(sheet, 'free', fake.probe, { ...hooks(), state: () => ({ ...state, running }), ...(withSim && { sim: () => sim.sim }) });
    await vi.runOnlyPendingTimersAsync();
    const ws = FakeSocket.all.at(-1)!;
    ws.accept();
    return { link, fake, sim, ws, stopRunning: () => void (running = false) };
  }
  const bytes = (m: object) => new TextEncoder().encode(JSON.stringify(m)).length;

  it('samples on the simulated clock: converter inputs read the circuit, other pins their level times Vcc', async () => {
    const { fake, sim, ws } = await owner();
    sim.adc.channelValues[0] = 2.5;
    fake.pin(6, true, 0);
    ws.deliver({ type: 'analog_start', capture: 'a1', pins: [14, 6, 3], duration_ms: 1, rate_hz: 10_000 }); // 10 rows, one every 1600 cycles
    sim.run(4 * 1600);
    expect(ws.ofType('analog_chunk')).toEqual([]);
    sim.adc.channelValues[0] = 1.2345;
    fake.pin(6, false, 0.5);
    sim.run(100_000);
    const rows = [...Array(5).fill([2500, 5000, 0]), ...Array(5).fill([1235, 0, 0])];
    expect(ws.ofType('analog_chunk')).toEqual([{ type: 'analog_chunk', capture: 'a1', seq: 0, t0_ms: 0, samples: rows, last: true }]);
    expect(ws.ofType('capture_error')).toEqual([]);
    expect(ws.ofType('capture_chunk')).toEqual([]); // the logic capture is untouched
  });

  it('sends 200,000 samples in chunks under 64 KiB, in order, one every 75 ms', async () => {
    const { sim, ws } = await owner();
    sim.adc.channelValues.fill(4.987); // 21 bytes a row: about 17 chunks
    ws.deliver({ type: 'analog_start', capture: 'big', pins: [14, 15, 16, 17], duration_ms: 5000, rate_hz: 10_000 });
    sim.run(5000 * 16_000);
    expect(ws.ofType('analog_chunk')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(74);
    expect(ws.ofType('analog_chunk')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(925);
    expect(ws.ofType('analog_chunk')).toHaveLength(14);
    await vi.advanceTimersByTimeAsync(10_000);
    const chunks = ws.ofType('analog_chunk');
    chunks.forEach((c, i) => {
      expect(bytes(c)).toBeLessThanOrEqual(64 * 1024);
      expect(c.seq).toBe(i);
      expect(c.last).toBe(i === chunks.length - 1);
    });
    expect(chunks.length).toBeGreaterThan(14);
    const rows = chunks.flatMap((c) => c.samples as number[][]);
    expect(rows).toHaveLength(50_000);
    expect(rows.every((r) => r.length === 4 && r.every((v) => v === 4987))).toBe(true);
  });

  it('refuses a capture it cannot take', async () => {
    const { ws, stopRunning } = await owner();
    const ask = (capture: string, more: object) => ws.deliver({ type: 'analog_start', capture, pins: [14], duration_ms: 10, rate_hz: 1000, ...more });
    ask('rate', { rate_hz: 50 });
    ask('pins', { pins: [14, 15, 16, 17, 18] });
    ask('pin', { pins: [22] });
    ask('many', { pins: [14, 15, 16], duration_ms: 10_000, rate_hz: 10_000 });
    stopRunning();
    ask('stopped', {});
    expect(ws.ofType('capture_error')).toEqual([
      { type: 'capture_error', capture: 'rate', detail: expect.stringContaining('Invalid analog capture') },
      { type: 'capture_error', capture: 'pins', detail: expect.stringContaining('Invalid pins') },
      { type: 'capture_error', capture: 'pin', detail: expect.stringContaining('Invalid pins') },
      { type: 'capture_error', capture: 'many', detail: expect.stringContaining('Too many samples') },
      { type: 'capture_error', capture: 'stopped', detail: expect.stringContaining('not running') },
    ]);

    const other = await owner(false);
    other.ws.deliver({ type: 'analog_start', capture: 'nosim', pins: [14], duration_ms: 10, rate_hz: 1000 });
    expect(other.ws.ofType('capture_error')).toEqual([{ type: 'capture_error', capture: 'nosim', detail: expect.stringContaining('not available') }]);
  });

  it('gives a sampling up on stop, relaunch, background, and a new capture of either kind', async () => {
    const { link, sim, ws } = await owner();
    const ask = (capture: string) => ws.deliver({ type: 'analog_start', capture, pins: [14], duration_ms: 10, rate_hz: 1000 });
    ask('stopped');
    link.halted('stop');
    ask('relaunched');
    link.halted('relaunch');
    ask('hidden');
    hidden = true;
    visibility.forEach((f) => f());
    hidden = false;
    ask('replaced');
    ws.deliver({ type: 'capture_start', capture: 'logic', pins: [2], duration_ms: 10 });
    ask('analog'); // and the logic one is replaced in turn
    sim.run(10 * 16_000);
    expect(ws.ofType('capture_error')).toEqual([
      { type: 'capture_error', capture: 'stopped', detail: expect.stringContaining('stopped') },
      { type: 'capture_error', capture: 'relaunched', detail: expect.stringContaining('started again') },
      { type: 'capture_error', capture: 'hidden', detail: expect.stringContaining('background') },
      { type: 'capture_error', capture: 'replaced', detail: 'Capture replaced by a new request.' },
      { type: 'capture_error', capture: 'logic', detail: 'Capture replaced by a new request.' },
    ]);
    expect(ws.ofType('analog_chunk').map((c) => [c.capture, (c.samples as unknown[]).length])).toEqual([['analog', 10]]);
  });
});

describe('bench hub client, session clock and pause (v0.12)', () => {
  const PAUSED = 'The simulation was paused during the capture.';
  async function owner() {
    const { startOwner } = await import('../hub');
    const { createRecorder } = await import('../capture');
    const fake = fakeProbe();
    const recorder = createRecorder(sheet, fake.probe); // the page's, shared as on the bench
    let cycles = 0;
    let events: Array<{ at: number; cb: () => void }> = [];
    const sim = {
      getADC: () => ({ channelValues: [1, 0, 0, 0, 0, 0, 0, 0], avcc: 5 }),
      addClockEvent: (cb: () => void, n: number) => !!events.push({ at: cycles + n, cb }),
      getCurrentCycles: () => cycles,
      getClockHz: () => 16_000_000,
    };
    const run = (ms: number) => {
      const to = ms * 16_000;
      for (;;) {
        events.sort((a, b) => a.at - b.at);
        const e = events[0];
        if (!e || e.at > to) break;
        events = events.slice(1);
        cycles = e.at;
        e.cb();
      }
      cycles = Math.max(cycles, to);
      fake.advance(ms);
    };
    const clock = { t_ms: 0, speed: 1, paused: false };
    const link = startOwner(sheet, 'free', fake.probe, { ...hooks(), state: () => ({ ...state, running: true, clock: { ...clock, t_ms: Math.round(fake.probe.nowMs()) } }), sim: () => sim }, recorder);
    await vi.runOnlyPendingTimersAsync();
    const ws = FakeSocket.all.at(-1)!;
    ws.accept();
    /** As the page does: the flag first, then the link, then a state. */
    const pause = (paused: boolean) => {
      clock.paused = paused;
      if (paused) link.paused();
      link.publishState();
    };
    return { link, fake, ws, run, clock, pause, recorder };
  }

  it('publishes the clock in state, and a state on pause, resume and speed change', async () => {
    const { ws, run, clock, pause, link } = await owner();
    expect(ws.ofType('state')[0].clock).toEqual({ t_ms: 0, speed: 1, paused: false });
    run(6200.4);
    pause(true);
    await vi.advanceTimersByTimeAsync(300);
    expect(ws.ofType('state').at(-1)!.clock).toEqual({ t_ms: 6200, speed: 1, paused: true });
    clock.speed = 0.5;
    link.publishState();
    pause(false);
    await vi.advanceTimersByTimeAsync(300);
    expect(ws.ofType('state')).toHaveLength(3); // debounced: speed and resume in one
    expect(ws.ofType('state').at(-1)!.clock).toEqual({ t_ms: 6200, speed: 0.5, paused: false });
  });

  it('leaves a malformed clock out of state', async () => {
    const { stateMessage } = await import('../hub');
    const ok = { t_ms: 6421, speed: 0.25, paused: true };
    expect(stateMessage({ ...state, clock: ok })).toHaveProperty('clock', ok);
    for (const bad of [{ ...ok, t_ms: 1.5 }, { ...ok, t_ms: -1 }, { ...ok, speed: 3 }, { ...ok, paused: 'yes' }, null])
      expect(stateMessage({ ...state, clock: bad } as never)).not.toHaveProperty('clock');
  });

  it('puts t0_ms, the start on the session clock, in the first chunk of either capture', async () => {
    const { ws, run } = await owner();
    run(6421.3);
    ws.deliver({ type: 'capture_start', capture: 'l', pins: [2], duration_ms: 10 });
    run(6432);
    await vi.advanceTimersByTimeAsync(50);
    ws.deliver({ type: 'analog_start', capture: 'a', pins: [14], duration_ms: 2, rate_hz: 1000 });
    run(6440);
    expect(ws.ofType('capture_chunk')).toEqual([{ type: 'capture_chunk', capture: 'l', seq: 0, initial: { 2: 0 }, t0_ms: 6421, edges: [], last: true }]);
    expect(ws.ofType('analog_chunk')).toEqual([{ type: 'analog_chunk', capture: 'a', seq: 0, t0_ms: 6432, samples: [[1000], [1000]], last: true }]);
  });

  it('ends the agent’s capture on a pause, logic or analog, and refuses one while paused', async () => {
    const { fake, ws, run, pause } = await owner();
    ws.deliver({ type: 'capture_start', capture: 'logic', pins: [2], duration_ms: 10 });
    run(3);
    pause(true);
    run(20); // nothing more to send for it
    await vi.advanceTimersByTimeAsync(100);
    ws.deliver({ type: 'capture_start', capture: 'asked', pins: [2], duration_ms: 10 });
    pause(false);
    ws.deliver({ type: 'analog_start', capture: 'analog', pins: [14], duration_ms: 10, rate_hz: 1000 });
    run(25);
    pause(true);
    run(40);
    expect(ws.ofType('capture_error')).toEqual([
      { type: 'capture_error', capture: 'logic', detail: PAUSED },
      { type: 'capture_error', capture: 'asked', detail: expect.stringContaining('paused') },
      { type: 'capture_error', capture: 'analog', detail: PAUSED },
    ]);
    expect(ws.ofType('capture_chunk')).toEqual([]);
    expect(ws.ofType('analog_chunk')).toEqual([]);

    // Once recorded, its chunks go out whatever the page does.
    pause(false);
    ws.deliver({ type: 'capture_start', capture: 'sent', pins: [2], duration_ms: 10 });
    for (let i = 0; i < 6000; i++) fake.pin(2, i % 2 === 0, 41 + i / 1000); // two chunks
    run(51);
    await vi.advanceTimersByTimeAsync(50); // first chunk out
    pause(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(ws.ofType('capture_chunk').map((c) => c.last)).toEqual([false, true]);
    expect(ws.ofType('capture_error')).toHaveLength(3);
  });

  it('lets the visitor’s capture wait through a pause', async () => {
    const { fake, ws, run, pause, recorder } = await owner();
    const said: string[] = [];
    let t0 = -1;
    recorder.record([2], 100, (rec) => ((t0 = rec.t0Ms), said.push(`done ${rec.edges.length}`)), (why) => said.push(why));
    run(40);
    fake.pin(2, true, 40);
    pause(true);
    await vi.advanceTimersByTimeAsync(10_000); // ten real seconds, no simulated time
    expect(recorder.busy()).toBe(true);
    expect(said).toEqual([]);
    pause(false);
    run(101);
    await vi.advanceTimersByTimeAsync(50);
    expect(said).toEqual(['done 1']);
    expect(t0).toBe(0);
    expect(ws.ofType('capture_error')).toEqual([]);
    recorder.close();
  });
});

describe('Intel HEX check', () => {
  it('takes what arduino-cli writes, LF or CRLF', async () => {
    const { isIntelHex } = await import('../hub');
    expect(isIntelHex(':100000000C9434000C9446000C9446000C9446006A\n:00000001FF\n')).toBe(true);
    expect(isIntelHex(HEX)).toBe(true);
    expect(isIntelHex(':00000001FF')).toBe(true);
  });

  it('refuses anything else', async () => {
    const { isIntelHex } = await import('../hub');
    for (const bad of [
      '',
      'hello',
      ':0100000000FF\n', // no end record
      ':00000001FF\n:0100000000FF\n', // end record not last
      ':00000001FF\n:00000001FF\n', // two end records
      ':0200000000FF\n:00000001FF\n', // length wrong
      ':0100000600F9\n:00000001FF\n', // type 06
      ':0100000000FF\n\n:00000001FF\n', // empty line
      ':01000000GGFF\n:00000001FF\n',
    ])
      expect(isIntelHex(bad), bad).toBe(false);
  });
});

describe('compile message', () => {
  it('stays under 60 KiB with a full program, keeping the end of the log, for both origins', async () => {
    const { compileMessage } = await import('../hub');
    const program = ':' + 'A'.repeat(48 * 1024 - 1);
    for (const origin of ['cloud', 'agent'] as const) {
      const log = 'début '.repeat(3000) + '\n'.repeat(2000) + 'THE END';
      const msg = compileMessage(true, log, program, origin);
      expect(new TextEncoder().encode(JSON.stringify(msg)).length).toBeLessThanOrEqual(60 * 1024);
      expect(msg.program).toBe(program);
      expect(msg.origin).toBe(origin);
      expect(msg.log.startsWith('[…]\n')).toBe(true);
      expect(msg.log.endsWith('THE END')).toBe(true);
    }
    expect(compileMessage(false, 'short', undefined, 'cloud')).toEqual({ type: 'compile', ok: false, log: 'short', origin: 'cloud' });
  });
});
