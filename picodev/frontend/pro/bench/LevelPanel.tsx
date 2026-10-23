/** Left panel of the challenge mode: the level, its tests and its hints. */
import { useId, type FormEvent } from 'react';
import { text } from './text';
import type { Level, TestResult } from './types';

/** An answer test's field: open (`idle`, maybe with the reason the last answer was refused) or waiting for the hub. */
export interface AnswerState {
  status: 'idle' | 'waiting';
  error?: string;
}

interface TestListProps {
  level: Level;
  results: TestResult[];
  answers?: Record<string, AnswerState>;
  /** Absent: read-only (the spectator), no field. */
  onAnswer?(test: string, value: string): void;
  /** The hub cannot be reached: the field is closed and says why. */
  offline?: boolean;
}

export function TestList({ level, results, answers, onAnswer, offline }: TestListProps) {
  const t = text();
  const uid = useId();
  return (
    <ol className="bench-tests">
      {level.tests.map((test) => {
        const result = results.find((r) => r.id === test.id);
        const status = result?.status ?? 'pending';
        const answer = answers?.[test.id];
        const detailId = `${uid}-${test.id}-detail`;
        const field = test.spec.type === 'answer' && !!onAnswer && status !== 'passed';
        const submit = (e: FormEvent<HTMLFormElement>) => {
          e.preventDefault();
          const value = String(new FormData(e.currentTarget).get('answer') ?? '').trim();
          if (value) onAnswer?.(test.id, value);
        };
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
              <span className="bench-test-state" id={detailId}>
                <span className="bench-sr">{t.statusPrefix}</span>
                {(field && offline ? t.answerOffline : answer?.error || result?.detail) || t.status[status]}
              </span>
              {field && (
                <form className="bench-answer" onSubmit={submit}>
                  <input type="text" name="answer" maxLength={200} autoComplete="off" disabled={offline || answer?.status === 'waiting'} placeholder={t.answerPlaceholder} aria-label={test.label} aria-describedby={detailId} />
                  <button type="submit" className="bench-btn bench-btn-primary" disabled={offline || answer?.status === 'waiting'}>
                    {t.validate}
                  </button>
                </form>
              )}
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
  answers?: Record<string, AnswerState>;
  onAnswer?(test: string, value: string): void;
  offline?: boolean;
  /** Every test of the current level passed on the last run. */
  passed: boolean;
  hintsShown: number;
  onHint(): void;
  onNext(): void;
  onFinish(): void;
}

export function LevelPanel({ levels, index, results, answers, onAnswer, offline, passed, hintsShown, onHint, onNext, onFinish }: Props) {
  const level = levels[index];
  const last = index === levels.length - 1;
  const t = text();
  const answerCount = level.tests.filter((x) => x.spec.type === 'answer').length;
  const foot = answerCount === 0 ? t.levelFoot : answerCount === level.tests.length ? t.levelFootAnswer : t.levelFootBoth;
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
        <TestList level={level} results={results} answers={answers} onAnswer={onAnswer} offline={offline} />
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
      <p className="bench-level-foot">{foot}</p>
    </aside>
  );
}
