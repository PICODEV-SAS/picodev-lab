/**
 * The bench's view during a turn with `video` (live-protocol.adoc): the
 * camera player, and the switch between the views of the bench.
 */
import { useEffect, useRef, useState } from 'react';
import { text } from './text';
import { playCamera, type VideoState } from './video';

export type View = 'decor' | 'schema' | 'camera';

/** The views offered: during a turn with a camera, « Caméra » takes the place of the scene. */
export function ViewSwitch({ scene, camera, view, onChange }: { scene: boolean; camera: boolean; view: View; onChange: (v: View) => void }) {
  const t = text();
  const views: View[] = camera ? ['camera', 'schema'] : scene ? ['decor', 'schema'] : ['schema'];
  const label: Record<View, string> = { decor: t.scene, schema: t.schema, camera: t.camera };
  return (
    <div className="bench-view-switch" role="radiogroup" aria-label={t.viewSwitch}>
      {views.map((v) => (
        <label key={v}>
          <input type="radio" name="bench-view" checked={view === v} onChange={() => onChange(v)} />
          {label[v]}
        </label>
      ))}
    </div>
  );
}

/** Plays the WHEP path `path` (its LL-HLS fallback `hls`) with the session token `token` while mounted. */
export function Camera({ path, hls, token }: { path?: string; hls?: string; token: string }) {
  const t = text();
  const video = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<VideoState>('connecting');
  // The viewer's own freeze: the bench keeps running, even when the session is paused.
  const [frozen, setFrozen] = useState(false);
  useEffect(() => playCamera({ video: path, hls }, token, video.current!, setState), [path, hls, token]);
  // pause() keeps the last frame. WebRTC has no buffer, play() is back at live; HLS plays on from its buffer, so jump to its live edge.
  const resume = () => {
    const v = video.current!;
    if (v.seekable.length) v.currentTime = v.seekable.end(v.seekable.length - 1);
    void v.play().catch(() => {});
  };
  const toggle = () => (frozen ? resume() : video.current!.pause());
  return (
    <div className="bench-camera" data-state={state}>
      {/* A reconnection plays again by itself (autoPlay): onPlay then ends the freeze. */}
      <video ref={video} autoPlay muted playsInline aria-label={t.cameraAria} onPlay={() => setFrozen(false)} onPause={() => setFrozen(true)} />
      {state !== 'playing' && <p role="status">{state === 'connecting' ? t.cameraConnecting : t.cameraUnavailable}</p>}
      {state === 'playing' && (
        <button type="button" className="bench-camera-freeze" aria-pressed={frozen} onClick={toggle}>
          {frozen ? t.cameraResume : t.cameraFreeze}
        </button>
      )}
    </div>
  );
}
