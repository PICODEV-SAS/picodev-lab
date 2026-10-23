/** What the hub adds to the workspace: who may watch, what the agent did, the queue of the benches. */
import { useEffect, useRef, useState } from 'react';
import { changeVisibility, kindLabel, spectatorLink, type BenchOffer, type HubStatus, type QueueView, type SessionInfo, type Visibility } from './hub';
import { text } from './text';

const CHOICES: Visibility[] = ['private', 'link', 'public'];

export function VisibilityMenu({ status, info, viewers, onChange }: { status: HubStatus; info: SessionInfo | null; viewers: number; onChange(info: SessionInfo): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const t = text();

  if (status === 'replaced') {
    return (
      <span className="bench-hub-off" title={t.replacedTitle}>
        {t.replaced}
      </span>
    );
  }
  // The bench works without the hub: say so, quietly.
  if (status === 'offline' && !info?.owner) {
    return (
      <span className="bench-hub-off" title={t.sharingOffTitle}>
        {t.sharingOff}
      </span>
    );
  }
  if (!info?.owner) return null;

  const current = info.visibility && t.visibility[info.visibility];
  const link = info.viewer && info.visibility !== 'private' ? spectatorLink(info.session, info.viewer) : '';

  async function choose(v: Visibility) {
    if (!info || busy || v === info.visibility) return;
    setBusy(true);
    setError('');
    try {
      onChange(await changeVisibility(info, v));
    } catch {
      setError(t.visibilityFailed);
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError(t.copyRefused);
    }
  }

  return (
    <details className="bench-visibility" data-status={status}>
      <summary title={status === 'live' ? undefined : t.connecting}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
          <circle cx="8" cy="8" r="2" />
        </svg>
        {current ? current[0] : t.visibilityWord} · {viewers}
        <span className="bench-sr">{t.viewers(viewers)}</span>
      </summary>
      <div className="bench-visibility-panel">
        <h2>{t.whoWatches}</h2>
        <div role="radiogroup" aria-label={t.visibilityAria}>
          {CHOICES.map((c) => (
            <div key={c} className="bench-visibility-choice" data-checked={c === info.visibility || undefined}>
              <label>
                <input type="radio" name="bench-visibility" checked={c === info.visibility} disabled={busy} onChange={() => choose(c)} />
                <span>
                  <strong>{t.visibility[c][0]}</strong>
                  {t.visibility[c][1]}
                </span>
              </label>
              {c === info.visibility && link && (
                <div className="bench-visibility-link">
                  <input readOnly value={link} aria-label={t.viewerLink} onFocus={(e) => e.currentTarget.select()} />
                  <button type="button" className="bench-btn bench-btn-primary" onClick={copy}>
                    {copied ? t.copied : t.copy}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
        {error && <p role="alert">{error}</p>}
        <p>{t.levelCutsViewers}</p>
      </div>
    </details>
  );
}

export interface AgentCall {
  at: string;
  tool: string;
  summary: string;
}

export function AgentJournal({ calls }: { calls: AgentCall[] }) {
  const t = text();
  return (
    <aside className="bench-level bench-agent" aria-labelledby="bench-agent-title">
      <div className="bench-agent-head">
        <h2 id="bench-agent-title">{t.agentTitle}</h2>
        <span>{t.agentCalls}</span>
      </div>
      <ol role="log" aria-live="polite">
        {calls.map((c, i) => {
          // The hub writes its summaries in French; another language says what the tool did.
          const summary = t.agentLabel(c.tool) ?? c.summary;
          return (
            <li key={i}>
              <code>{c.tool}</code>
              <time>{c.at}</time>
              {summary && <p>{summary}</p>}
            </li>
          );
        })}
      </ol>
    </aside>
  );
}

// ── Queue and turn (v0.4, optional extension of the live channel) ──────────

/** m:ss left until `endsAt` (Unix seconds). */
const timeLeft = (endsAt: number, nowMs: number) => {
  const s = Math.max(0, endsAt - Math.floor(nowMs / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The time, refreshed every second. */
function useNow() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/**
 * The bench's offer to go on a bench of the hub, then the place in its queue,
 * then the turn. Nothing at all when the setup has no bench and no place is held.
 */
/**
 * `?kind=real` in the address (v0.22): joins the `real` queue once per page load,
 * as soon as the benches list offers it `open` and the visitor holds no place
 * (`ready`), through the same `join` as the button. Any other value, or no open
 * real bench, and nothing happens. The parameter leaves the address bar when it
 * is used (`s=` and the rest stay), so a reload does not join again.
 */
export function useKindLink(offers: BenchOffer[], ready: boolean, join: (kind: string) => void) {
  const wanted = useRef(new URLSearchParams(location.search).get('kind') === 'real');
  useEffect(() => {
    if (!wanted.current || !ready || !offers.some((o) => o.kind === 'real' && o.status === 'open')) return;
    wanted.current = false;
    const params = new URLSearchParams(location.search);
    params.delete('kind');
    const query = params.toString();
    history.replaceState(history.state, '', location.pathname + (query ? `?${query}` : '') + location.hash);
    join('real');
  });
}

export function QueuePanel({ offers, view, disabled, onJoin, onLeave, onSeen }: { offers: BenchOffer[]; view: QueueView; disabled: boolean; onJoin(kind: string): void; onLeave(): void; onSeen(): void }) {
  const now = useNow();
  const t = text();
  if (view.phase === 'none' && !offers.length) return null;
  const left = view.phase === 'turn' ? timeLeft(view.ends_at, now) : '';
  const open = offers.filter((o) => o.status !== 'soon');

  return (
    <div className="bench-queue-slot">
      <div className="bench-queue" data-phase={view.phase}>
        {view.phase === 'waiting' ? (
          <>
            <p>
              <strong>
                {t.waiting(capital(kindLabel(view.kind)))}
                {t.ordinal(view.position)[0]}
                <sup>{t.ordinal(view.position)[1]}</sup>
                {t.inQueue}
                {view.eta_s > 0 ? t.eta(Math.ceil(view.eta_s / 60)) : t.benchFreeing}
              </strong>{' '}
              {t.keepCoding}
            </p>
            <button type="button" className="bench-queue-link" onClick={onLeave}>
              {t.leaveQueue}
            </button>
          </>
        ) : view.phase === 'turn' ? (
          <>
            <p>
              <strong>{t.yourTurn(kindLabel(view.kind))}</strong> · <span className="bench-queue-clock">{left}</span> {t.left}
              {view.kind === 'sim' && <span className="bench-queue-sim">{t.simStays}</span>}
            </p>
            <button type="button" className="bench-queue-link" onClick={onLeave}>
              {t.giveBack}
            </button>
          </>
        ) : (
          <>
            <p>
              {open.length ? (
                <>
                  <strong>{offers.length > 1 ? t.alsoBenches : t.alsoBench(kindLabel(offers[0].kind))}</strong> {t.takePlace}
                </>
              ) : (
                <strong>{t.soonBench(kindLabel(offers[0].kind))}</strong>
              )}
            </p>
            <div className="bench-queue-offers">
              {offers.map((o) =>
                o.status === 'soon' ? (
                  // v0.18: announced, nothing to join yet.
                  <button key={o.kind} type="button" className="bench-btn" disabled>
                    {t.soonButton(capital(kindLabel(o.kind)))}
                  </button>
                ) : (
                  <button key={o.kind} type="button" className="bench-btn" disabled={disabled} onClick={() => onJoin(o.kind)}>
                    {t.goTo(kindLabel(o.kind))}
                    <span>{o.free > 0 ? t.free(o.free) : t.queued(o.waiting)}</span>
                  </button>
                ),
              )}
            </div>
          </>
        )}
        {view.note && (
          <p className="bench-queue-note" role="status">
            {view.note}
          </p>
        )}
      </div>
      {view.phase === 'turn' && !view.seen && <TurnDialog view={view} left={left} onLeave={onLeave} onSeen={onSeen} />}
    </div>
  );
}

function TurnDialog({ view, left, onLeave, onSeen }: { view: Extract<QueueView, { phase: 'turn' }>; left: string; onLeave(): void; onSeen(): void }) {
  const ok = useRef<HTMLButtonElement>(null);
  const t = text();
  useEffect(() => ok.current?.focus(), []);
  return (
    <div className="bench-dialog-backdrop" onKeyDown={(e) => e.key === 'Escape' && onSeen()}>
      <div role="dialog" aria-modal="true" aria-labelledby="bench-turn-title" aria-describedby="bench-turn-desc" className="bench-dialog">
        <div className="bench-dialog-head">
          <span className="bench-eyebrow">
            <i />
            {view.bench ? t.benchFree(view.bench) : t.kindFree(kindLabel(view.kind))}
          </span>
          <span className="bench-queue-clock" role="timer" aria-label={t.timeLeft}>
            {left}
          </span>
        </div>
        <h2 id="bench-turn-title">{t.turnTitle(kindLabel(view.kind))}</h2>
        <p id="bench-turn-desc">{view.kind === 'sim' ? t.turnSim : t.turnReal}</p>
        <div className="bench-dialog-actions">
          <button type="button" className="bench-queue-link" onClick={onLeave}>
            {t.letNext}
          </button>
          <button ref={ok} type="button" className="bench-btn bench-btn-primary" onClick={onSeen}>
            {t.continue}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The spectator's view of the owner's turn (`turn` without `bench`). */
export function TurnBadge({ turn }: { turn: { kind: string; ends_at: number } }) {
  const now = useNow();
  const t = text();
  return (
    <span className="bench-turn" role="status">
      {t.turnOn(kindLabel(turn.kind))} · <span className="bench-queue-clock">{timeLeft(turn.ends_at, now)}</span>
    </span>
  );
}
