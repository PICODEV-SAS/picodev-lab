/** The frame every bench page shares: brand, language switch, footer (AGPL attribution), message page, clock. */
import { useEffect, useState } from 'react';
import { BRAND_NAME, SOURCE_URL } from '@velxio/lib/deploymentConfig';
import { HOME_URL, LOGO_URL } from './config';
import { getLang, setLang } from './lang';
import { text } from './text';
import './bench.css';

const UPSTREAM_URL = 'https://github.com/davidmonterocrespo24/velxio';

export function Brand() {
  // No logo in the deployment file: the name, as text.
  if (!LOGO_URL) {
    return (
      <a className="bench-brand" href={HOME_URL} title={text().backHome}>
        <strong>{BRAND_NAME}</strong>
      </a>
    );
  }
  // The logo carries the first word of the name, the badge the rest.
  const [, ...rest] = BRAND_NAME.split(' ');
  return (
    <a className="bench-brand" href={HOME_URL} title={text().backHome}>
      <img src={LOGO_URL} alt={BRAND_NAME} />
      {rest.length > 0 && <span aria-hidden="true">{rest.join(' ')}</span>}
    </a>
  );
}

/** FR / EN: the address does not change, the page reloads in the chosen language. */
export function LangSwitch() {
  const lang = getLang();
  const t = text();
  return (
    <div className="bench-lang" role="group" aria-label={t.language}>
      {(['fr', 'en'] as const).map((l) => (
        <button key={l} type="button" lang={l} aria-pressed={lang === l} onClick={() => setLang(l)}>
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

export function Footer() {
  const t = text();
  return (
    <footer className="bench-footer">
      <span>
        {t.footerBefore(BRAND_NAME)}
        <a href={UPSTREAM_URL}>Velxio</a>
        {t.footerAfter}
      </span>
      <span>
        <a href={SOURCE_URL || UPSTREAM_URL}>{t.sourceCode}</a> · <a href={UPSTREAM_URL}>{t.upstream}</a>
      </span>
    </footer>
  );
}

/** A line of the hub (banner, operator's notice): plain text, never HTML. */
export function Banner({ text: said, alert, onClose }: { text: string; alert?: boolean; onClose?: () => void }) {
  return (
    <div className="bench-banner" role={alert ? 'alert' : 'status'}>
      <p>{said}</p>
      {onClose && (
        <button type="button" onClick={onClose} aria-label={text().dismiss} title={text().dismiss}>
          ×
        </button>
      )}
    </div>
  );
}

export function Message({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="bench">
      <header className="bench-header">
        <Brand />
      </header>
      <main className="bench-message">
        <h1>{title}</h1>
        {children}
      </main>
      <Footer />
    </div>
  );
}

/**
 * The simulated clock on the scene. Without `speed` (the owner's page), its
 * speed against real time measured over the last second: the scene plays at
 * that speed, the captures and traces count in its time. With `speed` (the
 * spectator's page), the speed the owner chose. Paused, no speed: it would
 * read ×0.
 */
export function SimClock({ nowMs, running, paused = false, speed, className = '' }: { nowMs: () => number; running: boolean; paused?: boolean; speed?: number; className?: string }) {
  const t = text();
  const live = running && !paused;
  const [shown, setShown] = useState<{ ms: number; rate: number | null }>({ ms: nowMs(), rate: null });
  useEffect(() => {
    if (!live) return;
    const marks: Array<[number, number]> = []; // [real ms, simulated ms]
    const tick = () => {
      const mark: [number, number] = [performance.now(), nowMs()];
      marks.push(mark);
      while (marks.length > 1 && mark[0] - marks[0][0] > 1000) marks.shift();
      const [r0, s0] = marks[0];
      setShown({ ms: mark[1], rate: mark[0] - r0 > 400 ? (mark[1] - s0) / (mark[0] - r0) : null });
    };
    const first = setTimeout(tick, 0);
    const id = setInterval(tick, 250);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [nowMs, live]);
  // Stopped or paused, the clock does not move: read it as it is.
  const now = live ? shown : { ms: nowMs(), rate: null };
  const num = (n: number, digits: number) => n.toLocaleString(t.locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const factor = (n: number) => n.toLocaleString(t.locale, { maximumFractionDigits: 2 });
  return (
    <span className={`bench-view-clock ${className}`} role="timer" aria-label={t.clockAria} data-paused={paused || undefined}>
      {t.clock(num(now.ms / 1000, 1))}
      {paused ? <small>{t.clockPaused}</small> : live && speed !== undefined ? <small>{t.clockSpeed(factor(speed))}</small> : live && now.rate !== null && <small>{t.clockRate(num(now.rate, 1))}</small>}
    </span>
  );
}
