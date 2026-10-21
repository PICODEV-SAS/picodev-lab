/**
 * Read-only traces of some probes, drawn from Velxio's oscilloscope store.
 *
 * Velxio's own Oscilloscope panel shows every channel of the store with its
 * controls; the workspace needs two small fixed views of that one store (the
 * scope probes, the logic probes), so this draws the samples itself.
 */
import { useEffect, useReducer, type CSSProperties } from 'react';
import { useOscilloscopeStore } from '@velxio/store/useOscilloscopeStore';
import { probeColor } from './palette';
import { text } from './text';
import type { SetupSheet } from './types';

type Probe = SetupSheet['probes'][number];

// How much simulated time a panel shows. A servo command repeats every 20 ms;
// a button press lasts a fraction of a second.
const WINDOW_MS = { scope: 60, logic: 4000 };
const MAX_EDGES = 400; // beyond that the trace is a solid band anyway

const W = 300;
const H = 120;

function tracePath(samples: { timeMs: number; state: boolean }[], end: number, windowMs: number, x0: number, hi: number, lo: number): string {
  const start = end - windowMs;
  const x = (t: number) => x0 + ((t - start) / windowMs) * (W - x0);
  let i = samples.length;
  while (i > 0 && samples[i - 1].timeMs > start && samples.length - i < MAX_EDGES) i--;
  if (i === samples.length && !samples.length) return '';
  const y = (s: boolean) => (s ? hi : lo);
  let d = `M${x0} ${y(i > 0 ? samples[i - 1].state : !samples[i].state)}`;
  for (; i < samples.length; i++) {
    const s = samples[i];
    if (s.timeMs > end) break;
    d += `H${x(s.timeMs).toFixed(1)}V${y(s.state)}`;
  }
  return `${d}H${W}`;
}

type Samples = Array<{ timeMs: number; state: boolean }>;

/** `samples`: where the edges come from when not from the oscilloscope store (the spectator's replay). */
export function Traces({ kind, probes, nowMs, live, samples }: { kind: 'scope' | 'logic'; probes: Probe[]; nowMs: () => number; live: boolean; samples?: (pin: number) => Samples }) {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    redraw();
    if (!live) return;
    const id = setInterval(redraw, 100);
    return () => clearInterval(id);
  }, [live]);

  const t = text();
  const scope = useOscilloscopeStore.getState();
  const rows = probes.map((p) => {
    if (samples) return { probe: p, samples: samples(p.pin) };
    const ch = scope.channels.find((c) => c.kind === 'digital' && c.pin === p.pin);
    return { probe: p, samples: (ch && scope.samples[ch.id]) || [] };
  });
  // Stopped, the simulator's clock is back to zero: keep the last capture on screen.
  const end = Math.max(nowMs(), ...rows.map((r) => r.samples[r.samples.length - 1]?.timeMs ?? 0), WINDOW_MS[kind]);
  const band = H / Math.max(rows.length, 1);
  const x0 = kind === 'logic' ? 30 : 0;
  const names = probes.map((p) => p.label).join(' / ');
  const title = kind === 'scope' ? t.scope : t.logic;

  return (
    <figure className="bench-trace">
      <svg className={`bench-trace-${kind}`} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${title} · ${names}`}>
        {kind === 'scope' && <path d="M30 0V120M60 0V120M90 0V120M120 0V120M150 0V120M180 0V120M210 0V120M240 0V120M270 0V120M0 30H300M0 60H300M0 90H300" stroke="#1F3A5C" />}
        {rows.map((r, i) => (
          <g key={r.probe.pin}>
            {kind === 'logic' && (
              <text x="6" y={band * (i + 0.5) + 4} fontSize="11" fill="#4A5B70">
                {r.probe.label}
              </text>
            )}
            <path d={tracePath(r.samples, end, WINDOW_MS[kind], x0, band * (i + 0.28), band * (i + 0.8))} fill="none" stroke={probeColor(kind, i)} strokeWidth="2" vectorEffect="non-scaling-stroke" />
          </g>
        ))}
      </svg>
      <figcaption>
        <strong>
          {title} · {names}
        </strong>
        <span>{t.simulated}</span>
      </figcaption>
      {/* The scope draws its rows over each other: one legend entry per row. */}
      {kind === 'scope' && (
        <ul className="bench-trace-legend" aria-label={t.legend}>
          {probes.map((p, i) => (
            <li key={p.pin} style={{ '--c': probeColor(kind, i) } as CSSProperties}>
              {p.label}
            </li>
          ))}
        </ul>
      )}
    </figure>
  );
}
