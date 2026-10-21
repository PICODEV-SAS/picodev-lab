// @vitest-environment jsdom
/** The WHEP player against a fake RTCPeerConnection and a fake fetch. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { playWhep, type VideoState } from '../video';

class FakePC {
  static all: FakePC[] = [];
  iceGatheringState = 'complete';
  connectionState = 'new';
  localDescription: { sdp: string } | null = null;
  remote?: { type: string; sdp: string };
  closed = false;
  onconnectionstatechange: (() => void) | null = null;
  ontrack = null;
  config: unknown;
  constructor(config: unknown) {
    this.config = config;
    FakePC.all.push(this);
  }
  addTransceiver = vi.fn();
  addEventListener() {}
  createOffer = async () => ({ type: 'offer', sdp: 'offer' });
  async setLocalDescription(d: { sdp: string }) {
    this.localDescription = d;
  }
  async setRemoteDescription(d: { type: string; sdp: string }) {
    this.remote = d;
  }
  close() {
    this.closed = true;
  }
  fail() {
    this.connectionState = 'failed';
    this.onconnectionstatechange?.();
  }
}

let fetchMock: ReturnType<typeof vi.fn>;
let states: VideoState[];
let video: HTMLVideoElement;
const flush = () => vi.advanceTimersByTimeAsync(0);
const offers = () => fetchMock.mock.calls.filter(([, init]) => init.method === 'POST');

beforeEach(() => {
  vi.useFakeTimers();
  FakePC.all = [];
  states = [];
  video = document.createElement('video');
  fetchMock = vi.fn(async () => new Response('', { status: 404 }));
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('RTCPeerConnection', FakePC);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('WHEP player', () => {
  it('posts a complete offer with the token, sets the answer, deletes the session on close', async () => {
    fetchMock.mockResolvedValueOnce(new Response('answer', { status: 201, headers: { Location: '/video/3/whep/abc' } }));
    const stop = playWhep('/video/3/whep', 'tok', video, (s) => states.push(s));
    await flush();
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`${location.origin}/video/3/whep`);
    expect(init).toMatchObject({ method: 'POST', body: 'offer', headers: { 'Content-Type': 'application/sdp', Authorization: 'Bearer tok' } });
    expect(FakePC.all[0].config).toEqual({ iceServers: [] });
    expect(FakePC.all[0].addTransceiver).toHaveBeenCalledWith('video', { direction: 'recvonly' });
    expect(FakePC.all[0].remote).toEqual({ type: 'answer', sdp: 'answer' });
    video.onplaying?.(new Event('playing'));
    expect(states).toEqual(['connecting', 'playing']);

    stop();
    expect(FakePC.all[0].closed).toBe(true);
    expect(fetchMock).toHaveBeenLastCalledWith(`${location.origin}/video/3/whep/abc`, { method: 'DELETE', headers: { Authorization: 'Bearer tok' } });
  });

  it('retries no more than every 2 s, says unavailable after 20 s without image, stops at close', async () => {
    const stop = playWhep('/video/3/whep', 'tok', video, (s) => states.push(s));
    await flush();
    expect(offers()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1999);
    expect(offers()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(offers()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(18_000);
    expect(states).toEqual(['connecting', 'unavailable']);
    const sent = offers().length;
    expect(sent).toBe(11); // at 0, 2, 4… 20 s
    stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(offers()).toHaveLength(sent);
  });

  it('says unavailable when WebRTC fails before any image, and offers again', async () => {
    fetchMock.mockResolvedValueOnce(new Response('answer', { status: 201 }));
    const stop = playWhep('/video/3/whep', 'tok', video, (s) => states.push(s));
    await flush();
    FakePC.all[0].fail();
    expect(states).toEqual(['connecting', 'unavailable']);
    await vi.advanceTimersByTimeAsync(2000);
    expect(offers()).toHaveLength(2);
    stop();
  });

  it('never sends the token to another origin', async () => {
    fetchMock.mockResolvedValueOnce(new Response('answer', { status: 201, headers: { Location: 'https://evil.example/x' } }));
    const stop = playWhep('/video/3/whep', 'tok', video, (s) => states.push(s));
    await flush();
    stop();
    expect(fetchMock).toHaveBeenCalledTimes(1); // no DELETE elsewhere
    playWhep('//evil.example/whep', 'tok', video, (s) => states.push(s));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(states.at(-1)).toBe('unavailable');
  });
});
