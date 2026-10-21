/** Left panel of the challenge mode: the level, its tests and its hints. */
import { text } from './text';
import type { Level, TestResult } from './types';

export function TestList({ level, results }: { level: Level; results: TestResult[] }) {
  const t = text();
  return (
    <ol className="bench-tests">
      {level.tests.map((test) => {
        const result = results.find((r) => r.id === test.id);
        const status = result?.status ?? 'pending';
        return (
          <li key={test.id} data-status={status}>
            <span className="bench-test-mark" aria-hidden="true">
              {status === 'passed' && (
                <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="#FFFFFF" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2.5 6.2l2.3 2.3 4.7-5" />
                </svg>
              )}
              {status === 'failed' && (
                <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="#B8433E" strokeWidth="2.2" strokeLinecap="round">
                  <path d="M3 3l6 6M9 3l-6 6" />
                </svg>
              )}
            </span>
            <span className="bench-test-text">
              <code>{test.id}</code>
              <span>{test.label}</span>
              <span className="bench-test-state">
                <span className="bench-sr">{t.statusPrefix}</span>
                {result?.detail || t.status[status]}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

interface Props {
  levels: Level[];
  index: number;
  results: TestResult[];
  /** Every test of the current level passed on the last run. */
  passed: boolean;
  hintsShown: number;
  onHint(): void;
  onNext(): void;
  onFinish(): void;
}

export function LevelPanel({ levels, index, results, passed, hintsShown, onHint, onNext, onFinish }: Props) {
  const level = levels[index];
  const last = index === levels.length - 1;
  const t = text();
  return (
    <aside className="bench-level" aria-labelledby="bench-level-title">
      <div className="bench-level-bars" role="img" aria-label={t.levelOf(index + 1, levels.length)}>
        {levels.map((l, i) => (
          <span key={l.id} data-state={i < index || (i === index && passed) ? 'done' : i === index ? 'current' : 'locked'} />
        ))}
      </div>
      <div className="bench-level-head">
        <span className="bench-eyebrow">{t.levelOf(index + 1, levels.length)}</span>
        <h2 id="bench-level-title">{level.title}</h2>
        <p>{level.brief}</p>
      </div>
      <div className="bench-level-tests">
        <span className="bench-level-label">{t.levelRule}</span>
        <TestList level={level} results={results} />
      </div>
      <div aria-live="polite" className="bench-level-next">
        {passed && (
          <>
            <p>
              <strong>{t.levelPassed}</strong>
            </p>
            {last ? (
              <button type="button" className="bench-btn bench-btn-primary" onClick={onFinish}>
                {t.finish}
              </button>
            ) : (
              <button type="button" className="bench-btn bench-btn-primary" onClick={onNext}>
                {t.nextLevel}
              </button>
            )}
          </>
        )}
      </div>
      {level.hints.length > 0 && (
        <div className="bench-hints" aria-live="polite">
          {level.hints.slice(0, hintsShown).map((hint, i) => (
            <p key={i}>
              <strong>{t.hint(i + 1)}</strong> {hint}
            </p>
          ))}
          {hintsShown < level.hints.length && (
            <button type="button" className="bench-btn bench-btn-hint" onClick={onHint}>
              {t.showHint(hintsShown + 1, level.hints.length)}
            </button>
          )}
        </div>
      )}
      <p className="bench-level-foot">{t.levelFoot}</p>
    </aside>
  );
}
