/**
 * Step 3 of the studio, « Liaisons » (architecture v0.20): an editor of
 * `scene.bindings`, one row per binding, and the scene animated by the
 * bench's own reader. The rows write into the rest of setup.json, whose JSON
 * stays editable next to them: the form and the text are the same data.
 *
 * The preview follows the studio simulation while it runs; otherwise one
 * control per source (level, duty, angle) drives it.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { getBoardPinManager, getBoardSimulator, useSimulatorStore } from '@velxio/store/useSimulatorStore';
import { mountScene } from '../bench/engine/scene';
import type { Circuit } from '../bench/circuit';
import { BINDINGS_MAX, bindingsOf, boardPins, EFFECT_KEYS, EFFECTS, HAS_ORIGIN, sceneIds, shapeBinding, SOURCE_KINDS, withBindings, type Binding, type Effect } from './draft';
import { createPreviewProbe, followSim, type SimClock } from './preview';
import { text } from './text';

interface Props {
  rest: string;
  svg: string;
  circuit: Circuit;
  boardKind: string;
  onRest(rest: string): void;
}

const SOURCE_RE = /^(pin|pwm|servo):(\d+)$/;
const str = (v: unknown) => (typeof v === 'string' ? v : '');

export function Bindings({ rest, svg, circuit, boardKind, onRest }: Props) {
  const t = text();
  const read = useMemo(() => bindingsOf(rest), [rest]);
  const bindings = useMemo(() => read ?? [], [read]);
  const ids = useMemo(() => sceneIds(svg), [svg]);
  const pins = useMemo(() => boardPins(circuit, boardKind), [circuit, boardKind]);
  const [selected, setSelected] = useState<number | null>(null);

  const write = (list: Binding[]) => onRest(withBindings(rest, list));
  const change = (i: number, b: Binding) => write(bindings.map((x, j) => (j === i ? b : x)));
  const add = () => {
    write([...bindings, shapeBinding({ target: ids[0] ?? '', source: `pin:${pins[0] ?? 13}` }, 'visible')]);
    setSelected(bindings.length);
  };

  if (!read) return <p className="studio-small" data-kind="error">{t.bindUnreadable}</p>;
  return (
    <>
      <Preview svg={svg} bindings={bindings} highlight={selected === null ? null : str(bindings[selected]?.target)} />
      {!ids.length && <p className="studio-small" data-kind="error">{t.sceneNoIds}</p>}
      {!pins.length && <p className="studio-small" data-kind="error">{t.bindNoPins}</p>}
      <ol className="studio-bindings">
        {bindings.map((b, i) => (
          <li key={i} data-selected={selected === i} onFocus={() => setSelected(i)} onClick={() => setSelected(i)}>
            <BindingRow b={b} ids={ids} pins={pins} onChange={(nb) => change(i, nb)} />
            <button
              type="button"
              className="studio-link"
              onClick={(e) => {
                e.stopPropagation();
                write(bindings.filter((_, j) => j !== i));
                setSelected(null);
              }}
            >
              {t.bindRemove}
            </button>
          </li>
        ))}
      </ol>
      <button type="button" className="studio-btn" disabled={bindings.length >= BINDINGS_MAX} onClick={add}>
        {t.bindAdd}
      </button>
    </>
  );
}

function BindingRow({ b, ids, pins, onChange }: { b: Binding; ids: string[]; pins: number[]; onChange(b: Binding): void }) {
  const t = text();
  const target = str(b.target);
  const [, kind = 'pin', n = ''] = SOURCE_RE.exec(str(b.source)) ?? [];
  const pin = n === '' ? NaN : Number(n);
  const effect = (EFFECTS as readonly string[]).includes(str(b.effect)) ? (b.effect as Effect) : null;
  const set = (k: string, v: unknown) => onChange({ ...b, [k]: v });
  // Values the form does not offer (written in the JSON by hand) stay shown, marked.
  const targets = ids.includes(target) || !target ? ids : [target, ...ids];
  const sourcePins = pins.includes(pin) || Number.isNaN(pin) ? pins : [pin, ...pins];
  const origin = Array.isArray(b.origin) ? (b.origin as unknown[]) : null;

  return (
    <div className="studio-binding">
      <label className="studio-field">
        <span>{t.bindTarget}</span>
        <select value={target} onChange={(e) => set('target', e.target.value)} aria-invalid={!ids.includes(target)}>
          {!target && <option value="" />}
          {targets.map((id) => (
            <option key={id} value={id}>
              {ids.includes(id) ? id : `${id} (${t.bindMissing})`}
            </option>
          ))}
        </select>
      </label>
      <div className="studio-binding-pair">
        <label className="studio-field">
          <span>{t.bindSource}</span>
          <select value={kind} onChange={(e) => set('source', `${e.target.value}:${Number.isNaN(pin) ? (pins[0] ?? 13) : pin}`)}>
            {SOURCE_KINDS.map((k) => (
              <option key={k} value={k}>
                {t.sourceKinds[k]}
              </option>
            ))}
          </select>
        </label>
        <label className="studio-field">
          <span>{t.bindPin}</span>
          <select value={Number.isNaN(pin) ? '' : String(pin)} onChange={(e) => set('source', `${kind}:${e.target.value}`)} aria-invalid={!pins.includes(pin)}>
            {Number.isNaN(pin) && <option value="" />}
            {sourcePins.map((p) => (
              <option key={p} value={p}>
                {pinLabel(p)}
                {pins.includes(p) ? '' : ` (${t.bindUnwired})`}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="studio-field">
        <span>{t.bindEffect}</span>
        <select value={effect ?? ''} onChange={(e) => onChange(shapeBinding(b, e.target.value as Effect))}>
          {!effect && <option value="">{str(b.effect) || '?'}</option>}
          {EFFECTS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </label>
      {effect && (
        <div className="studio-binding-keys">
          {Object.entries(EFFECT_KEYS[effect]).map(([k, dflt]) => (
            <label key={k} className="studio-field">
              <span>{k}</span>
              {k === 'when' ? (
                <select value={str(b.when)} onChange={(e) => set('when', e.target.value)}>
                  <option value="high">high</option>
                  <option value="low">low</option>
                </select>
              ) : typeof dflt === 'number' ? (
                <NumberInput value={b[k]} onChange={(v) => set(k, v)} />
              ) : (
                <input value={str(b[k])} maxLength={32} onChange={(e) => set(k, e.target.value)} />
              )}
            </label>
          ))}
          {HAS_ORIGIN.includes(effect) &&
            (['x', 'y'] as const).map((axis, a) => (
              <label key={axis} className="studio-field">
                <span>origin {axis}</span>
                <NumberInput
                  value={origin?.[a]}
                  onChange={(v) => {
                    const next = [Number(origin?.[0] ?? 0), Number(origin?.[1] ?? 0)];
                    next[a] = v ?? 0;
                    // Both empty: no origin (the element's own 0, 0).
                    const { origin: _, ...without } = b;
                    onChange(v === null && typeof origin?.[1 - a] !== 'number' ? without : { ...b, origin: next });
                  }}
                />
              </label>
            ))}
        </div>
      )}
    </div>
  );
}

/** A number input; empty gives null (only the origin takes it as "none"; elsewhere it is ignored). */
function NumberInput({ value, onChange }: { value: unknown; onChange(v: number | null): void }) {
  return (
    <input
      type="number"
      step="any"
      value={typeof value === 'number' ? value : ''}
      onChange={(e) => {
        if (e.target.value === '') return onChange(null);
        if (!Number.isNaN(e.target.valueAsNumber)) onChange(e.target.valueAsNumber);
      }}
    />
  );
}

/** "D9", "A0" (14) as the board's silkscreen. */
const pinLabel = (p: number) => (p >= 14 ? `A${p - 14}` : `D${p}`);

/** The scene as the bench shows it, driven by the simulation when it runs, by the controls otherwise. */
function Preview({ svg, bindings, highlight }: { svg: string; bindings: Binding[]; highlight: string | null }) {
  const t = text();
  const box = useRef<HTMLDivElement>(null);
  const probe = useMemo(createPreviewProbe, []);
  const sources = useMemo(() => [...new Set(bindings.map((b) => str(b.source)).filter((s) => SOURCE_RE.test(s)))], [bindings]);
  const [manual, setManual] = useState<Record<string, number>>({});
  const boardId = useSimulatorStore((s) => s.activeBoardId);
  const running = useSimulatorStore((s) => !!s.boards.find((b) => b.id === s.activeBoardId)?.running);

  // The bench's reader takes the bindings as the sheet types them; the rest of setup.json is checked by setup-check.
  useEffect(() => (box.current ? mountScene(box.current, svg, bindings as never, probe) : undefined), [svg, bindings, probe]);

  useEffect(() => {
    if (!highlight || !box.current) return;
    const el = [...box.current.querySelectorAll('[id]')].find((e) => e.id === highlight);
    el?.classList.add('studio-hl');
    return () => el?.classList.remove('studio-hl');
  }, [highlight, svg, bindings]);

  const key = sources.join(' ');
  useEffect(() => {
    if (running && boardId) {
      const pins = getBoardPinManager(boardId);
      if (!pins) return;
      probe.clear();
      return followSim(pins, getBoardSimulator(boardId) as SimClock | undefined, sources, probe);
    }
    probe.clear();
    sources.forEach((s) => probe.set(s, manual[s] ?? 0));
  }, [running, boardId, key]); // eslint-disable-line react-hooks/exhaustive-deps

  const setSource = (s: string, v: number) => {
    setManual((m) => ({ ...m, [s]: v }));
    probe.set(s, v);
  };

  return (
    <div className="studio-preview-wrap">
      <div ref={box} className="studio-preview" aria-label={t.bindPreview} />
      <p className="studio-small">{running ? t.bindFromSim : sources.length ? t.bindFromControls : t.bindNone}</p>
      {!running && sources.length > 0 && (
        <div className="studio-controls">
          {sources.map((s) => {
            const [kind] = s.split(':');
            const v = manual[s] ?? 0;
            return (
              <label key={s} className="studio-control">
                <code>{s}</code>
                {kind === 'pin' ? (
                  <input type="checkbox" checked={v > 0} onChange={(e) => setSource(s, e.target.checked ? 1 : 0)} aria-label={`${s} ${t.bindLevel}`} />
                ) : (
                  <input
                    type="range"
                    min={0}
                    max={kind === 'pwm' ? 1 : 180}
                    step={kind === 'pwm' ? 0.01 : 1}
                    value={v}
                    onChange={(e) => setSource(s, e.target.valueAsNumber)}
                    aria-label={`${s} ${kind === 'pwm' ? t.bindDuty : t.bindAngle}`}
                  />
                )}
                <span>{kind === 'pin' ? (v > 0 ? 'high' : 'low') : kind === 'pwm' ? `${Math.round(v * 100)} %` : `${v}°`}</span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
