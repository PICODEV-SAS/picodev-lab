/**
 * The bench filmed live during a turn: a WHEP player (RFC 9725) with the
 * browser's RTCPeerConnection, no library. Protocol: `video` of `turn` in
 * picodev/docs/live-protocol.adoc.
 *
 * One complete offer (no trickle ICE, no STUN/TURN) at most every 2 s, with
 * the session token as Bearer, retried while the turn lasts: the stream may
 * start a few seconds after the turn, and the hub may cut a player at any time.
 */

export type VideoState = 'connecting' | 'playing' | 'unavailable';

export const OFFER_EVERY_MS = 2000;
export const NO_IMAGE_MS = 20_000;
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
