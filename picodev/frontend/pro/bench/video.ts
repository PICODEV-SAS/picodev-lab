/**
 * The bench filmed live during a turn: a WHEP player (RFC 9725) with the
 * browser's RTCPeerConnection, no library. Protocol: `video` and `hls` of
 * `turn` in picodev/docs/live-protocol.adoc.
 *
 * One complete offer (no trickle ICE, no STUN/TURN) at most every 2 s, with
 * the session token as Bearer, retried while the turn lasts: the stream may
 * start a few seconds after the turn, and the hub may cut a player at any time.
 * No WebRTC frame in 8 s (UDP blocked): the same video in LL-HLS, played by the
 * copy of hls.js under vendor/hls, loaded only then.
 */
import type Hls from './vendor/hls/hls.light.min.mjs';

export type VideoState = 'connecting' | 'playing' | 'unavailable';

export const OFFER_EVERY_MS = 2000;
export const NO_IMAGE_MS = 20_000;
/** No WebRTC frame by then: LL-HLS instead. */
export const HLS_AFTER_MS = 8000;
const GATHER_MS = 1000;

/** Plays `path` into `video` until the returned function is called. */
export function playWhep(path: string, token: string, video: HTMLVideoElement, onState: (s: VideoState) => void): () => void {
  const url = new URL(path, location.href);
  let closed = false;
  let pc: RTCPeerConnection | null = null;
  let resource: string | null = null; // the WHEP session, to delete on close
  let lastOffer = -Infinity;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let noImage: ReturnType<typeof setTimeout> | undefined;
  let state: VideoState | null = null;
  const set = (s: VideoState) => {
    if (s !== state) onState((state = s));
  };
  const waitImage = () => {
    clearTimeout(noImage);
    noImage = setTimeout(() => set('unavailable'), NO_IMAGE_MS);
  };

  const drop = () => {
    const was = pc;
    pc = null;
    was?.close();
    if (resource) void fetch(resource, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
    resource = null;
  };

  /** Drops the current attempt and offers again, no sooner than 2 s after the last offer. */
  const again = () => {
    drop();
    if (closed) return;
    clearTimeout(retry);
    retry = setTimeout(attempt, Math.max(0, lastOffer + OFFER_EVERY_MS - performance.now()));
  };

  async function attempt() {
    if (closed) return;
    lastOffer = performance.now();
    const peer = new RTCPeerConnection({ iceServers: [] });
    pc = peer;
    let shown = false;
    peer.addTransceiver('video', { direction: 'recvonly' });
    peer.ontrack = (e) => {
      video.srcObject = e.streams[0] ?? new MediaStream([e.track]);
    };
    // Lost, or cut by the hub (MediaMTX closes the connection): offer again while allowed.
    peer.onconnectionstatechange = () => {
      const s = peer.connectionState;
      if (pc !== peer || (s !== 'failed' && s !== 'disconnected')) return;
      if (shown) {
        set('connecting');
        waitImage();
      } else if (s === 'failed') set('unavailable'); // no image at all: UDP blocked, most likely
      again();
    };
    video.onplaying = () => {
      if (pc !== peer) return;
      shown = true;
      clearTimeout(noImage);
      set('playing');
    };
    try {
      await peer.setLocalDescription(await peer.createOffer());
      await gathered(peer);
      if (pc !== peer) return;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp', Authorization: `Bearer ${token}` },
        body: peer.localDescription!.sdp,
      });
      if (pc !== peer) return;
      if (res.status !== 201) throw new Error(`WHEP ${res.status}`);
      const at = res.headers.get('Location');
      const where = at ? new URL(at, url) : null;
      // ponytail: the token goes only to this origin, as for the offer.
      if (where?.origin === location.origin) resource = where.href;
      await peer.setRemoteDescription({ type: 'answer', sdp: await res.text() });
    } catch {
      if (pc === peer) again(); // no stream yet (404), refused, network: try again
    }
  }

  if (url.origin !== location.origin) {
    set('unavailable');
    return () => {};
  }
  set('connecting');
  waitImage();
  void attempt();
  return () => {
    closed = true;
    clearTimeout(retry);
    clearTimeout(noImage);
    video.onplaying = null;
    drop();
    video.srcObject = null;
  };
}

/** Resolves once ICE gathering is complete, or after 1 s with the candidates found so far. */
function gathered(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((done) => {
    const timer = setTimeout(done, GATHER_MS);
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(timer);
        done();
      }
    });
  });
}

/**
 * Plays the turn's camera: `video` (WHEP), and `hls` when no frame played
 * within 8 s, or at once without `video`.
 */
export function playCamera(paths: { video?: string; hls?: string }, token: string, video: HTMLVideoElement, onState: (s: VideoState) => void, load?: HlsLoader): () => void {
  const { hls } = paths;
  if (!paths.video) return hls ? playHls(hls, token, video, onState, load) : (onState('unavailable'), () => {});
  let played = false;
  let fallback: ReturnType<typeof setTimeout> | undefined;
  let stop = playWhep(paths.video, token, video, (s) => {
    if (s === 'playing') {
      played = true;
      clearTimeout(fallback);
    }
    // The fallback still to come: not unavailable yet.
    onState(s === 'unavailable' && hls && !played ? 'connecting' : s);
  });
  if (hls)
    fallback = setTimeout(() => {
      if (played) return;
      stop();
      stop = playHls(hls, token, video, onState, load);
    }, HLS_AFTER_MS);
  return () => {
    clearTimeout(fallback);
    stop();
  };
}

export type HlsLoader = () => Promise<{ default: typeof Hls }>;
const loadHls: HlsLoader = () => import('./vendor/hls/hls.light.min.mjs');

/**
 * Plays the LL-HLS path `path` with hls.js, the session token as Bearer on
 * every request to this origin (none elsewhere), started again 2 s after a
 * fatal error until the returned function is called.
 */
export function playHls(path: string, token: string, video: HTMLVideoElement, onState: (s: VideoState) => void, load: HlsLoader = loadHls): () => void {
  const url = new URL(path, location.href);
  let closed = false;
  let player: Hls | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const drop = () => {
    player?.destroy();
    player = null;
  };
  if (url.origin !== location.origin) {
    onState('unavailable');
    return () => {};
  }
  onState('connecting');
  video.onplaying = () => !closed && onState('playing');
  load().then(
    ({ default: Player }) => {
      // No MSE (iOS Safari before 17.1): its own HLS player sends no header, so no video.
      if (closed || !Player.isSupported()) return void (closed || onState('unavailable'));
      const start = () => {
        if (closed) return;
        const p = new Player({
          enableWorker: false, // a worker from a blob: URL is one more CSP exception
          lowLatencyMode: true,
          xhrSetup: (xhr, at) => {
            if (new URL(at, location.href).origin === location.origin) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
          },
        });
        player = p;
        p.on(Player.Events.ERROR, (_e, data) => {
          if (!data.fatal || player !== p) return;
          drop();
          onState('connecting');
          retry = setTimeout(start, OFFER_EVERY_MS);
        });
        p.loadSource(url.href);
        p.attachMedia(video);
      };
      start();
    },
    () => !closed && onState('unavailable'),
  );
  return () => {
    closed = true;
    clearTimeout(retry);
    video.onplaying = null;
    drop();
  };
}
