/**
 * The spectator page: /w/<session>#v=<viewer token>.
 *
 * Shows a session the way the hub relays it: the owner's code, the scene and
 * the traces replayed from `events` (./replayProbe), the serial output, the
 * test results. It never compiles nor simulates, and loads no part of
 * Velxio's editor or simulator.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { BRAND_NAME } from '@velxio/lib/deploymentConfig';
import { Camera } from './Camera';
import { HOME_URL, HUB_URL } from './config';
import { mountScene } from './engine/scene';
import { Brand, Footer, Message, SimClock } from './frame';
import { connectLive, isClock, isSessionId, queueMessage, takeFragment, type BenchState, type HubStatus } from './hub';
import { TurnBadge } from './HubControls';
import { getLang, localizeSheet } from './lang';
import { TestList } from './LevelPanel';
import { createReplayProbe } from './replayProbe';
import { fetchSetup, type LoadedSetup } from './sheet';
import { text } from './text';
import { Traces } from './Traces';
import type { BenchEvent } from './types';
import './bench.css';

const MAX_SERIAL = 20_000;

/** A `state` relayed from the owner's browser: keep it only if it has the expected shape. */
function readState(m: Record<string, unknown>): BenchState | null {
  const ok =
    // `setup` is missing from a hub that keeps to the contract as first written: no scene then.
    (m.setup === undefined || typeof m.setup === 'string') &&
    // `files` is left out (`files_omitted`) when the sketch is too long to share live.
    (m.files_omitted === true
      ? m.files === undefined
      : Array.isArray(m.files) && m.files.every((f) => typeof f?.name === 'string' && typeof f?.content === 'string')) &&
    Number.isInteger(m.level) &&
    Array.isArray(m.results);
  return ok ? (m as unknown as BenchState) : null;
}

export default function SpectatorPage() {
  const { sessionId = '' } = useParams();
  const [token] = useState(() => (isSessionId(sessionId) ? takeFragment(sessionId).viewer : undefined));
  const lang = getLang();
  const t = text();
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  if (!HUB_URL) {
    return (
      <Message title={t.noSpectator}>
        <p>{t.noSpectatorText}</p>
        <p>
          <a className="bench-btn bench-btn-primary" href={HOME_URL}>
            {t.backHome}
          </a>
        </p>
      </Message>
    );
  }
  if (!token) {
    return (
      <Message title={t.incompleteLink}>
        <p>{t.incompleteLinkText}</p>
      </Message>
    );
  }
  return <Spectator key={sessionId} sessionId={sessionId} token={token} />;
}

function Spectator({ sessionId, token }: { sessionId: string; token: string }) {
  const probe = useMemo(() => createReplayProbe(), []);
  const [status, setStatus] = useState<HubStatus>('connecting');
  const [state, setState] = useState<BenchState | null>(null);
  const [compile, setCompile] = useState<{ ok: boolean; log: string; agent: boolean } | null>(null);
  const [serial, setSerial] = useState('');
  const [closed, setClosed] = useState(false);
  /** The owner's turn on a bench of the hub (v0.4), if one is running; `video`: the bench filmed live (v0.10). */
  const [turn, setTurn] = useState<{ kind: string; ends_at: number; video?: string } | null>(null);
  const [setup, setSetup] = useState<LoadedSetup | null>(null);
  const [setupError, setSetupError] = useState('');
  const scene = useRef<HTMLDivElement>(null);
  const serialBox = useRef<HTMLPreElement>(null);
  const lang = getLang();
  const t = text();
  // The owner's clock (v0.12): its time at the last state when paused, else the time of the last event replayed.
  const clock = isClock(state?.clock) ? state.clock : undefined;
  const pausedAt = clock?.paused ? clock.t_ms : null;
  const clockNow = useCallback(() => pausedAt ?? probe.nowMs(), [probe, pausedAt]);

  useEffect(() => {
    const live = connectLive(sessionId, 'viewer', token, {
      status: setStatus,
      refused: () => setClosed(true), // revoked link or private session
      message(m) {
        switch (m.type) {
          case 'state':
            setState(readState(m) ?? ((s) => s));
            break;
          case 'events':
            if (Array.isArray(m.events)) probe.feed(m.events as BenchEvent[]);
            break;
          case 'compile':
            // Each run starts with a compile: the serial output of the previous one goes.
            setCompile({ ok: m.ok === true, log: String(m.log ?? ''), agent: m.origin === 'agent' });
            setSerial('');
            break;
          case 'closed':
            setClosed(true);
            live.close();
            break;
          case 'turn':
          case 'turn_end': {
            const q = queueMessage(m);
            if (q?.type === 'turn') setTurn({ kind: q.kind, ends_at: q.ends_at, video: q.video });
            else if (q) setTurn(null);
            break;
          }
        }
      },
    });
    const offSerial = probe.onSerial((text) => setSerial((s) => (s + text).slice(-MAX_SERIAL)));
    return () => {
      offSerial();
      live.close();
    };
  }, [sessionId, token, probe]);

  // The sheet of the session's setup: the scene, the probes, the levels.
  const setupId = state?.setup;
  useEffect(() => {
    if (!setupId) return;
    let cancelled = false;
    fetchSetup(setupId).then(
      (loaded) => {
        if (cancelled) return;
        setSetup(loaded);
      },
      (e: unknown) => !cancelled && setSetupError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [setupId, sessionId]);

  useEffect(() => {
    if (!setup?.sceneSvg || !scene.current) return;
    return mountScene(scene.current, setup.sceneSvg, setup.sheet.scene?.bindings ?? [], probe);
  }, [setup, probe]);

  useEffect(() => {
    serialBox.current?.scrollTo(0, serialBox.current.scrollHeight);
  }, [serial]);

  const sheet = setup ? localizeSheet(setup.sheet, lang) : undefined;
  const title = sheet?.title;
  useEffect(() => {
    if (title) document.title = `${t.session} ${sessionId} · ${title} · ${BRAND_NAME}`;
  }, [title, sessionId, t.session]);

  if (closed) {
    return (
      <Message title={t.sessionOver}>
        <p>{t.sessionOverText}</p>
        <p>
          <a className="bench-btn bench-btn-primary" href={HOME_URL}>
            {t.backHome}
          </a>
        </p>
      </Message>
    );
  }

  const level = state?.mode === 'challenge' ? sheet?.levels[state.level] : undefined;
  const probesOf = (kind: 'scope' | 'logic') => sheet?.probes.filter((p) => p.kind === kind) ?? [];
  const files = state?.files ?? [];

  return (
    <div className="bench">
      <header className="bench-header">
        <Brand />
        <div className="bench-setup">
          <span>
            <strong>
              {t.session} <code>{sessionId}</code>
            </strong>
            <span>{sheet ? `${sheet.title} · ${t.mode(state?.mode === 'challenge' ? 'challenge' : 'free')} · ${turn ? t.kind(turn.kind) : t.simulatedBench}` : t.loadingShort}</span>
          </span>
        </div>
        <span className="bench-readonly">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <rect x="2.5" y="6" width="9" height="6.5" rx="1.5" />
            <path d="M4.5 6V4.5a2.5 2.5 0 0 1 5 0V6" />
          </svg>
          {t.readOnly}
        </span>
        <div className="bench-session">
          {turn && <TurnBadge turn={turn} />}
          <span className="bench-live" data-status={status}>
            {status === 'live' ? (state?.running ? t.live : t.connected) : t.reconnecting}
          </span>
          <a href={HOME_URL}>{t.leave}</a>
        </div>
      </header>

      <div className="bench-body">
        <section className="bench-code" aria-label={t.sessionCode}>
          <div className="bench-code-bar">
            <span className="bench-code-tab">{files.map((f) => f.name).join(' · ') || 'code'}</span>
            <span className="bench-code-saved">{state ? (compile?.agent ? t.agentBuilt : t.byOwner) : t.waitingSession}</span>
          </div>
          <div className="bench-code-editor bench-code-read">
            {state?.files_omitted && <p className="bench-message-detail">{t.codeTooLong}</p>}
            {files.map((f) => (
              <pre key={f.name} tabIndex={0} aria-label={f.name}>
                {files.length > 1 && <span className="bench-code-file">{`// ${f.name}\n`}</span>}
                {f.content}
              </pre>
            ))}
          </div>
        </section>

        <section className="bench-hub" aria-label={t.benchTitle}>
          <div className="bench-hub-panel">
            {setupError && <p className="bench-message-detail">{setupError}</p>}
            {(setup?.sceneSvg || turn?.video) && (
              <div className="bench-view" data-view={turn?.video ? 'camera' : 'decor'}>
                <span className="bench-view-label">
                  <i />
                  {turn?.video ? t.cameraLabel : t.replayed}
                </span>
                {clock && <SimClock nowMs={clockNow} running={!!state?.running} paused={clock.paused} speed={clock.speed} />}
                {/* As on the bench page, the camera takes the place of the scene during the turn; the scene stays mounted. */}
                {setup?.sceneSvg && <div ref={scene} className="bench-scene" role="img" aria-label={t.sceneAria} hidden={!!turn?.video} />}
                {turn?.video && <Camera path={turn.video} token={token} />}
              </div>
            )}
            {clock && !setup?.sceneSvg && !turn?.video && <SimClock nowMs={clockNow} running={!!state?.running} paused={clock.paused} speed={clock.speed} className="bench-clock-inline" />}

            <div className="bench-traces">
              {(['scope', 'logic'] as const).map(
                (kind) => probesOf(kind).length > 0 && <Traces key={kind} kind={kind} probes={probesOf(kind)} nowMs={probe.nowMs} live={!!state?.running} samples={probe.samples} />,
              )}
            </div>

            {level && (
              <div className="bench-hub-text">
                <h3>
                  {t.level(state!.level + 1)} · {level.title}
                </h3>
                <TestList level={level} results={state!.results} />
              </div>
            )}

            <div className="bench-serial">
              <div>
                <strong>{t.serial}</strong>
                <span>{compile ? (compile.ok ? t.compiled : t.compileFailed) : ''}</span>
              </div>
              <pre ref={serialBox} tabIndex={0} role="log" aria-label={t.serialAria}>
                {compile && !compile.ok ? compile.log : serial}
              </pre>
            </div>
          </div>
        </section>
      </div>
      <Footer />
    </div>
  );
}
