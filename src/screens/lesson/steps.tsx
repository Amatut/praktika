// Шаги урока, кроме заданий: история, теория, пример, прогноз, порядок действий,
// вопрос, чек-лист для внешнего инструмента и закрепление.

import { ArrowDown, ArrowRight, ArrowUp, CircleAlert, CircleCheck, CircleX, FileCode2, Play, RotateCcw, Shuffle, Square } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useRunnerState } from '../../app/hooks.ts';
import { buildRunFeedback } from '../../coach/feedback.ts';
import { CodeBlock } from '../../components/CodeBlock.tsx';
import { InlineText, Markdown } from '../../components/Markdown.tsx';
import { rovingKeyDown, rovingTabIndex } from '../../components/roving.ts';
import { Notice, StatusBadge, formatDate, formatMinutes } from '../../components/ui.tsx';
import type {
  ChecklistStep as ChecklistStepData,
  ExampleStep as ExampleStepData,
  Lesson,
  OrderStep as OrderStepData,
  PredictStep as PredictStepData,
  QuizStep as QuizStepData,
  RecapStep as RecapStepData,
  TheoryStep as TheoryStepData,
} from '../../content/schema.ts';
import { CodeEditor } from '../../editor/CodeEditor.tsx';
import { pythonRunner, type RunOutcome } from '../../runner/runner.ts';
import { isDue } from '../../storage/schedule.ts';
import type { LessonRecord, ReviewRecord, SelfCheck } from '../../storage/types.ts';
import { CoachNote, CoachPanel, CoachPortal, FeedbackCard, InfoCard, SuccessCard } from './coach.tsx';
import { Transcript } from './results.tsx';
import { isActiveReview } from './review.ts';

const ENV_LABEL = {
  python: 'Python в браузере',
  web: 'Веб-пример',
  external: 'Внешний инструмент',
} as const;

export function normalizeOutput(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n+$/, '')
    .replace(/^\n+/, '');
}

/**
 * Перевести фокус на элемент, который пришёл на смену нажатой кнопке (результат, новая кнопка),
 * когда сработает флаг. Иначе фокус падает на body и следующий Tab уводит в начало страницы.
 */
function useFocusWhen(ref: RefObject<HTMLElement | null>, when: unknown) {
  useEffect(() => {
    if (!when || !ref.current) return;
    if (ref.current.tabIndex < 0 && !ref.current.hasAttribute('tabindex')) ref.current.tabIndex = -1;
    ref.current.focus();
  }, [when, ref]);
}

/** Пометка варианта или пункта после проверки: значок и слово, не только цвет. */
function Verdict({ ok, children }: { ok: boolean; children: string }) {
  const Icon = ok ? CircleCheck : CircleX;
  return (
    <span className="verdict" data-ok={ok}>
      <Icon aria-hidden="true" />
      {children}
    </span>
  );
}

// ------------------------------------------------------------ вступление

export function IntroStep({ lesson }: { lesson: Lesson }) {
  return (
    <>
      <section className="step-card" aria-labelledby="intro-title">
        <div className="story">
          <h2 id="intro-title" className="story-title">
            {lesson.story.title}
          </h2>
          <Markdown text={lesson.story.text} />
          {lesson.story.fictional && <p className="story-note">История-пример: придумана для наглядности.</p>}
        </div>
        <div className="intro-facts">
          <div className="fact">
            <span className="label">Зачем это нужно</span>
            <Markdown text={lesson.why} />
          </div>
          <div className="fact">
            <span className="label">Где это используется</span>
            <Markdown text={lesson.usedIn} />
          </div>
        </div>
        <dl className="kv">
          <dt>Цель урока</dt>
          <dd>{lesson.objective}</dd>
          <dt>Время</dt>
          <dd>{formatMinutes(lesson.minutes)}</dd>
          <dt>Среда</dt>
          <dd>{ENV_LABEL[lesson.environment]}</dd>
        </dl>
      </section>
      <CoachPortal>
        <CoachPanel>
          <p>
            Урок короткий: история, одна идея, пример и практика. Можно остановиться на любом шаге — место сохранится.
          </p>
          <p className="small muted">Застрянешь в задании — здесь появятся разбор ошибки и подсказки.</p>
        </CoachPanel>
      </CoachPortal>
    </>
  );
}

// ------------------------------------------------------------ теория

export function TheoryStep({ step }: { step: TheoryStepData }) {
  const [simpler, setSimpler] = useState(false);
  useEffect(() => setSimpler(false), [step.id]);
  return (
    <>
      <section className="step-card" aria-labelledby={`${step.id}-title`}>
        <h2 id={`${step.id}-title`} className="step-title">
          {step.title}
        </h2>
        <Markdown text={step.body} />
      </section>
      <CoachPortal>
        <CoachPanel
          actions={
            step.simpler ? (
              <button type="button" className="btn btn-block" onClick={() => setSimpler((value) => !value)} aria-pressed={simpler}>
                {simpler ? 'Скрыть простое объяснение' : 'Объясни проще'}
              </button>
            ) : undefined
          }
        >
          {step.coach ? <CoachNote text={step.coach} /> : <p>Прочитай и переходи к примеру — там всё станет нагляднее.</p>}
          {simpler && step.simpler && (
            <div className="hint-card">
              <div className="label">Проще</div>
              <Markdown text={step.simpler} className="prose-compact" />
            </div>
          )}
        </CoachPanel>
      </CoachPortal>
    </>
  );
}

// ------------------------------------------------------------ общий мини-запуск для примеров и прогнозов

function useQuickRun() {
  const runner = useRunnerState();
  const [outcome, setOutcome] = useState<RunOutcome | null>(null);
  const [running, setRunning] = useState(false);
  async function run(code: string, stdin = '') {
    if (running || runner.phase === 'busy') return null;
    setRunning(true);
    const result = await pythonRunner.run(code, stdin);
    setRunning(false);
    setOutcome(result);
    return result;
  }
  return { outcome, setOutcome, running, run, runner };
}

function RunOutput({ outcome, running, loading }: { outcome: RunOutcome | null; running: boolean; loading: boolean }) {
  if (running) {
    return (
      <div className="run-state">
        <span className="spinner" aria-hidden="true" />
        {loading ? 'Загружаю Python… В первый раз это может занять до минуты.' : 'Программа выполняется…'}
      </div>
    );
  }
  if (!outcome) return <p className="small muted">Нажми «Запустить», чтобы увидеть, что выведет программа.</p>;
  if (outcome.status === 'timeout') {
    return (
      <div className="status-line status-error">
        <CircleAlert aria-hidden="true" />
        <span>Программа работала дольше {Math.round(outcome.limitMs / 1000)} с и была остановлена.</span>
      </div>
    );
  }
  if (outcome.status === 'stopped') return <p className="small muted">Программа остановлена.</p>;
  if (outcome.status === 'failed') {
    return (
      <div className="status-line status-warn">
        <CircleAlert aria-hidden="true" />
        <span>{outcome.message}</span>
      </div>
    );
  }
  const result = outcome.result;
  return (
    <div className="stack-sm">
      {!result.compileError && <Transcript parts={result.transcript ?? []} />}
      {(result.compileError || result.error) && (
        <div className="status-line status-error">
          <CircleAlert aria-hidden="true" />
          <span>
            {(result.compileError ?? result.error)?.line ? `Строка ${(result.compileError ?? result.error)?.line}: ` : ''}
            <span className="mono">{(result.compileError ?? result.error)?.summary}</span>
          </span>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------ пример

export function ExampleStep({ step, onDone }: { step: ExampleStepData; onDone: () => void }) {
  const [code, setCode] = useState(step.code);
  // Выбранное пояснение подсвечивает свою строку в редакторе (наведение, фокус или нажатие).
  const [activeNote, setActiveNote] = useState<number | null>(null);
  const [pinnedNote, setPinnedNote] = useState<number | null>(null);
  const { outcome, running, run, runner } = useQuickRun();
  const feedback = outcome ? buildRunFeedback(code, outcome) : null;
  const noteLine = activeNote ?? pinnedNote;

  async function execute() {
    const result = await run(code, step.stdin ?? '');
    if (result) onDone();
  }

  return (
    <>
      <section className="step-card" aria-labelledby={`${step.id}-title`}>
        <h2 id={`${step.id}-title`} className="step-title">
          {step.title}
        </h2>
        {step.body && <Markdown text={step.body} />}
        <div className="stack-sm">
          <span className="label" id={`${step.id}-notes`}>
            Что важно в этом коде
          </span>
          <ul className="notes-list" aria-labelledby={`${step.id}-notes`}>
            {step.notes.map((note) => (
              <li key={note.line}>
                <button
                  type="button"
                  className={`note-btn${noteLine === note.line ? ' is-active' : ''}`}
                  aria-pressed={pinnedNote === note.line}
                  onClick={() => setPinnedNote((value) => (value === note.line ? null : note.line))}
                  onMouseEnter={() => setActiveNote(note.line)}
                  onMouseLeave={() => setActiveNote(null)}
                  onFocus={() => setActiveNote(note.line)}
                  onBlur={() => setActiveNote(null)}
                >
                  <span className="line-tag">строка {note.line}</span>
                  <span>
                    <InlineText text={note.text} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
        {step.tryIt && (
          <div className="prose-note prose-note-lesson">
            <strong>Попробуй: </strong>
            <InlineText text={step.tryIt} />
          </div>
        )}
      </section>
      <section className="workbench" aria-label="Пример кода">
        <div className="wb-head">
          <span className="wb-file">
            <FileCode2 aria-hidden="true" />
            example.py
          </span>
          <span className="wb-env">
            <span className="nowrap env-text">Можно менять и запускать</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCode(step.code)} disabled={code === step.code}>
              <RotateCcw aria-hidden="true" />
              <span>Вернуть пример</span>
            </button>
          </span>
        </div>
        <CodeEditor
          value={code}
          onChange={setCode}
          onSubmit={() => void execute()}
          ariaLabel={`Пример «${step.title}». Ctrl+Enter — запустить.`}
          errorLine={feedback?.line ?? null}
          noteLine={noteLine}
          minLines={Math.max(4, step.code.split('\n').length + 1)}
        />
        <div className="wb-actions">
          <button type="button" className="btn btn-primary" onClick={() => void execute()} disabled={running || runner.phase === 'busy'}>
            {running ? <span className="spinner" aria-hidden="true" /> : <Play aria-hidden="true" />}
            Запустить
          </button>
          {running && (
            <button type="button" className="btn btn-danger" onClick={() => pythonRunner.stop()}>
              <Square aria-hidden="true" />
              Остановить
            </button>
          )}
          <span className="hint-keys">
            <kbd>Ctrl</kbd> + <kbd>Enter</kbd> — запустить
          </span>
        </div>
        <div className="wb-results">
          <div className="results-body">
            <span className="label">Результат</span>
            <RunOutput outcome={outcome} running={running} loading={runner.phase === 'loading' || runner.phase === 'restarting'} />
          </div>
        </div>
      </section>
      <CoachPortal>
        <CoachPanel>
          {feedback ? <FeedbackCard feedback={feedback} /> : step.coach ? <CoachNote text={step.coach} /> : <p>Запусти пример, затем измени одну деталь и запусти снова — так лучше видно, за что отвечает каждая строка.</p>}
        </CoachPanel>
      </CoachPortal>
    </>
  );
}

// ------------------------------------------------------------ прогноз

export function PredictStep({
  step,
  record,
  onAnswer,
}: {
  step: PredictStepData;
  record: LessonRecord | null;
  onAnswer: (answer: string, matched: boolean | null) => void;
}) {
  const saved = record?.predictions[step.id] ?? null;
  const [answer, setAnswer] = useState(saved?.answer ?? '');
  const [revealed, setRevealed] = useState(saved !== null);
  const { outcome, setOutcome, running, run, runner } = useQuickRun();
  const resultRef = useRef<HTMLDivElement>(null);
  const checkRef = useRef<HTMLButtonElement>(null);
  const [focusResult, setFocusResult] = useState(0);
  const [focusCheck, setFocusCheck] = useState(0);
  useFocusWhen(resultRef, focusResult);
  useFocusWhen(checkRef, focusCheck);

  const matched = useMemo(() => {
    if (!revealed || !answer) return null;
    if (step.options) return answer === step.answer;
    return normalizeOutput(answer).replace(/[ \t]+/g, ' ').toLowerCase() === normalizeOutput(step.answer).replace(/[ \t]+/g, ' ').toLowerCase();
  }, [revealed, answer, step]);

  async function reveal() {
    setRevealed(true);
    setFocusResult((value) => value + 1);
    const isMatch = step.options
      ? answer === step.answer
      : normalizeOutput(answer).replace(/[ \t]+/g, ' ').toLowerCase() === normalizeOutput(step.answer).replace(/[ \t]+/g, ' ').toLowerCase();
    onAnswer(answer, answer ? isMatch : null);
    await run(step.code, step.stdin ?? '');
  }

  return (
    <>
      <section className="step-card" aria-labelledby={`${step.id}-title`}>
        <div className="step-title-row">
          <h2 id={`${step.id}-title`} className="step-title">
            {step.title}
          </h2>
          <span className="badge badge-accent">Как ты думаешь?</span>
        </div>
        <Markdown text={step.prompt} />
        <CodeBlock code={step.code} label="Код для прогноза" />
        {step.stdin && (
          <p className="small muted">
            Ввод: <span className="mono">{step.stdin.trim().split('\n').join(', ')}</span>
          </p>
        )}
        {step.options ? (
          <div className="options" role="radiogroup" aria-label="Варианты ответа" onKeyDown={(event) => rovingKeyDown(event)}>
            {step.options.map((option, optionIndex) => {
              const result = revealed ? (option === step.answer ? 'correct' : option === answer ? 'wrong' : undefined) : undefined;
              return (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  className="option"
                  aria-checked={answer === option}
                  tabIndex={rovingTabIndex(answer === option, optionIndex, step.options!.includes(answer))}
                  data-result={result}
                  disabled={revealed}
                  onClick={() => setAnswer(option)}
                >
                  <span className="option-mark" aria-hidden="true" />
                  {/* Варианты — это вывод программы: все набраны моноширинным шрифтом. */}
                  <span className="option-text mono">{option}</span>
                  {result === 'correct' && <Verdict ok>{option === answer ? 'верно — твой ответ' : 'верный ответ'}</Verdict>}
                  {result === 'wrong' && <Verdict ok={false}>твой ответ</Verdict>}
                </button>
              );
            })}
          </div>
        ) : (
          <label className="field">
            <span className="field-label">Что появится на экране?</span>
            <textarea
              className="textarea mono"
              rows={Math.max(2, step.answer.split('\n').length)}
              value={answer}
              disabled={revealed}
              onChange={(event) => setAnswer(event.target.value)}
              placeholder="Напиши вывод построчно"
            />
          </label>
        )}
        <div className="row">
          {!revealed ? (
            <button
              ref={checkRef}
              type="button"
              className="btn btn-primary"
              onClick={() => void reveal()}
              disabled={!answer.trim() && Boolean(step.options)}
            >
              {answer.trim() ? 'Проверить прогноз' : 'Не знаю — покажи'}
            </button>
          ) : (
            <button
              type="button"
              className="btn"
              onClick={() => {
                setRevealed(false);
                setOutcome(null);
                setFocusCheck((value) => value + 1);
              }}
            >
              <RotateCcw aria-hidden="true" />
              Попробовать ещё раз
            </button>
          )}
        </div>
        {revealed && (
          <div className="stack-sm step-result" aria-live="polite" ref={resultRef}>
            {matched === true && <StatusBadge tone="good">Прогноз совпал</StatusBadge>}
            {matched === false && <StatusBadge tone="warn">Прогноз не совпал — разберёмся</StatusBadge>}
            {matched === null && <StatusBadge tone="muted">Без прогноза</StatusBadge>}
            <span className="label">Настоящий запуск</span>
            <RunOutput outcome={outcome} running={running} loading={runner.phase === 'loading' || runner.phase === 'restarting'} />
            <Markdown text={step.explanation} />
          </div>
        )}
      </section>
      <CoachPortal>
        <CoachPanel>
          {step.coach ? (
            <CoachNote text={step.coach} />
          ) : (
            <p>Сначала предскажи результат, потом смотри запуск. Ошибиться в прогнозе полезно: так видно, что стоит повторить.</p>
          )}
        </CoachPanel>
      </CoachPortal>
    </>
  );
}

// ------------------------------------------------------------ порядок действий

function stableShuffle<T extends { id: string }>(items: T[], seed: string): T[] {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    hash = (hash * 1103515245 + 12345) >>> 0;
    const j = hash % (i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  if (result.every((item, index) => item.id === items[index].id)) result.reverse();
  return result;
}

export function isOrderCorrect(step: OrderStepData, order: string[]): boolean[] {
  if (step.before && step.before.length > 0) {
    const position = new Map(order.map((id, index) => [id, index]));
    const bad = new Set<string>();
    for (const [a, b] of step.before) {
      if ((position.get(a) ?? 0) > (position.get(b) ?? 0)) {
        bad.add(a);
        bad.add(b);
      }
    }
    return order.map((id) => !bad.has(id));
  }
  return order.map((id, index) => step.items[index].id === id);
}

export function OrderStep({
  step,
  record,
  onResult,
}: {
  step: OrderStepData;
  record: LessonRecord | null;
  onResult: (solved: boolean) => void;
}) {
  const saved = record?.orders[step.id];
  const [order, setOrder] = useState(() => (saved?.solved ? step.items.map((item) => item.id) : stableShuffle(step.items, step.id).map((item) => item.id)));
  const [checked, setChecked] = useState<boolean[] | null>(saved?.solved ? step.items.map(() => true) : null);
  const [attempts, setAttempts] = useState(saved?.attempts ?? 0);
  // Ответ показан приложением: это не решение ученика — ни «Порядок верный», ни отметки шага.
  const [revealed, setRevealed] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const checkRef = useRef<HTMLButtonElement>(null);
  const [focusResult, setFocusResult] = useState(0);
  const [focusCheck, setFocusCheck] = useState(0);
  useFocusWhen(resultRef, focusResult);
  useFocusWhen(checkRef, focusCheck);
  const solved = !revealed && (checked?.every(Boolean) ?? false);
  const locked = solved || revealed;
  const text = new Map(step.items.map((item) => [item.id, item.text]));

  function move(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= order.length) return;
    const next = [...order];
    [next[index], next[target]] = [next[target], next[index]];
    setOrder(next);
    setChecked(null);
  }

  function drop(targetId: string) {
    if (!dragging || dragging === targetId) return;
    const next = order.filter((id) => id !== dragging);
    next.splice(next.indexOf(targetId), 0, dragging);
    setOrder(next);
    setChecked(null);
    setDragging(null);
  }

  function check() {
    const result = isOrderCorrect(step, order);
    setChecked(result);
    setAttempts((value) => value + 1);
    onResult(result.every(Boolean));
    if (result.every(Boolean)) setFocusResult((value) => value + 1);
  }

  function showAnswer() {
    setOrder(step.items.map((item) => item.id));
    setChecked(null);
    setRevealed(true);
    setFocusResult((value) => value + 1);
  }

  function shuffleAgain() {
    setOrder(stableShuffle(step.items, `${step.id}:${attempts}`).map((item) => item.id));
    setChecked(null);
    setRevealed(false);
    setFocusCheck((value) => value + 1);
  }

  return (
    <>
      <section className="step-card" aria-labelledby={`${step.id}-title`}>
        <div className="step-title-row">
          <h2 id={`${step.id}-title`} className="step-title">
            {step.title}
          </h2>
          <span className="badge badge-accent">Без кода</span>
        </div>
        <Markdown text={step.prompt} />
        <ol className="order-list" aria-label="Шаги — расставь по порядку">
          {order.map((id, index) => (
            <li
              key={id}
              className="order-item"
              data-result={checked ? (checked[index] ? 'ok' : 'bad') : undefined}
              draggable={!locked}
              onDragStart={() => setDragging(id)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => drop(id)}
            >
              <span className="order-text">{text.get(id)}</span>
              {checked && !solved && <Verdict ok={checked[index]}>{checked[index] ? 'на месте' : 'не на месте'}</Verdict>}
              {!locked && (
                <span className="order-buttons">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm btn-icon"
                    aria-label={`Поднять: ${text.get(id)}`}
                    onClick={() => move(index, -1)}
                    disabled={index === 0}
                  >
                    <ArrowUp aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm btn-icon"
                    aria-label={`Опустить: ${text.get(id)}`}
                    onClick={() => move(index, 1)}
                    disabled={index === order.length - 1}
                  >
                    <ArrowDown aria-hidden="true" />
                  </button>
                </span>
              )}
            </li>
          ))}
        </ol>
        {!locked ? (
          <div className="row">
            <button ref={checkRef} type="button" className="btn btn-primary" onClick={check}>
              Проверить порядок
            </button>
            {attempts >= 2 && (
              <button type="button" className="btn" onClick={showAnswer}>
                Показать ответ
              </button>
            )}
            {checked && (
              <span className="status-line status-error">
                <CircleAlert aria-hidden="true" />
                Переставь шаги с пометкой «не на месте».
              </span>
            )}
          </div>
        ) : (
          <div className="stack-sm step-result" aria-live="polite" ref={resultRef}>
            {revealed ? (
              <>
                <StatusBadge tone="muted">Ответ показан</StatusBadge>
                <p className="step-result-text">
                  Правильный порядок показан — попробуй объяснить себе, почему он именно такой. Потом можно собрать его заново
                  самому.
                </p>
              </>
            ) : (
              <StatusBadge tone="good">Порядок верный</StatusBadge>
            )}
            <Markdown text={step.explanation} />
            {revealed && (
              <div className="row">
                <button type="button" className="btn" onClick={shuffleAgain}>
                  <Shuffle aria-hidden="true" />
                  Собрать заново
                </button>
              </div>
            )}
          </div>
        )}
      </section>
      <CoachPortal>
        <CoachPanel>
          {step.coach ? (
            <CoachNote text={step.coach} />
          ) : (
            <p>Программист сначала раскладывает задачу на шаги. Перетащи пункты или двигай их стрелками.</p>
          )}
        </CoachPanel>
      </CoachPortal>
    </>
  );
}

// ------------------------------------------------------------ вопрос с вариантами

export function QuizStep({
  step,
  record,
  onAnswer,
}: {
  step: QuizStepData;
  record: LessonRecord | null;
  onAnswer: (choice: number, correct: boolean) => void;
}) {
  const saved = record?.quizzes[step.id];
  const [choice, setChoice] = useState<number | null>(saved?.choice ?? null);
  const [answered, setAnswered] = useState(saved !== undefined);
  const resultRef = useRef<HTMLDivElement>(null);
  const [focusResult, setFocusResult] = useState(0);
  useFocusWhen(resultRef, focusResult);
  return (
    <>
      <section className="step-card" aria-labelledby={`${step.id}-title`}>
        <h2 id={`${step.id}-title`} className="step-title">
          {step.title}
        </h2>
        <Markdown text={step.question} />
        <div className="options" role="radiogroup" aria-label="Варианты ответа" onKeyDown={(event) => rovingKeyDown(event)}>
          {step.options.map((option, index) => {
            const result = answered ? (index === step.correct ? 'correct' : index === choice ? 'wrong' : undefined) : undefined;
            return (
              <button
                key={option}
                type="button"
                role="radio"
                className="option"
                aria-checked={choice === index}
                tabIndex={rovingTabIndex(choice === index, index, choice !== null)}
                data-result={result}
                disabled={answered}
                onClick={() => setChoice(index)}
              >
                <span className="option-mark" aria-hidden="true" />
                <span className="option-text">
                  <InlineText text={option} />
                </span>
                {result === 'correct' && <Verdict ok>{index === choice ? 'верно — твой ответ' : 'верный ответ'}</Verdict>}
                {result === 'wrong' && <Verdict ok={false}>твой ответ</Verdict>}
              </button>
            );
          })}
        </div>
        {!answered ? (
          <div className="row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={choice === null}
              onClick={() => {
                setAnswered(true);
                setFocusResult((value) => value + 1);
                onAnswer(choice!, choice === step.correct);
              }}
            >
              Ответить
            </button>
          </div>
        ) : (
          <div className="stack-sm step-result" aria-live="polite" ref={resultRef}>
            {choice === step.correct ? <StatusBadge tone="good">Верно</StatusBadge> : <StatusBadge tone="warn">Не совсем</StatusBadge>}
            <Markdown text={step.explanation} />
          </div>
        )}
      </section>
      <CoachPortal>
        <CoachPanel>{step.coach ? <CoachNote text={step.coach} /> : <p>Короткий вопрос на понимание — без оценки.</p>}</CoachPanel>
      </CoachPortal>
    </>
  );
}

// ------------------------------------------------------------ чек-лист (внешний инструмент)

export function ChecklistStep({
  step,
  record,
  onChange,
}: {
  step: ChecklistStepData;
  record: LessonRecord | null;
  onChange: (done: string[]) => void;
}) {
  const done = new Set(record?.checklists[step.id] ?? []);
  function toggle(id: string) {
    const next = new Set(done);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(step.items.map((item) => item.id).filter((itemId) => next.has(itemId)));
  }
  return (
    <>
      <section className="step-card" aria-labelledby={`${step.id}-title`}>
        <div className="step-title-row">
          <h2 id={`${step.id}-title`} className="step-title">
            {step.title}
          </h2>
          <span className="badge badge-warn">Внешний инструмент</span>
        </div>
        <Markdown text={step.body} />
        <ul className="checklist">
          {step.items.map((item) => (
            <li key={item.id} data-done={done.has(item.id)}>
              <label className="check">
                <input type="checkbox" checked={done.has(item.id)} onChange={() => toggle(item.id)} />
                <Markdown text={item.text} />
              </label>
              {item.help && (
                <details className="disclosure" style={{ marginTop: 8 }}>
                  <summary>Если не получается</summary>
                  <div className="disclosure-body">
                    <Markdown text={item.help} className="prose-compact" />
                  </div>
                </details>
              )}
            </li>
          ))}
        </ul>
        <p className="small muted">
          Отметки ставишь ты сам: приложение не видит твой компьютер и не может проверить установку за тебя.
        </p>
      </section>
      <CoachPortal>
        <CoachPanel>
          {step.coach ? <CoachNote text={step.coach} /> : <p>Делай по одному пункту. Если что-то пошло не так — раскрой «Если не получается».</p>}
        </CoachPanel>
      </CoachPortal>
    </>
  );
}

// ------------------------------------------------------------ закрепление

const SELF_CHECK: { value: SelfCheck; label: string }[] = [
  { value: 'understood', label: 'Понимаю' },
  { value: 'partly', label: 'Частично' },
  { value: 'not-yet', label: 'Пока нет' },
];

export function RecapStep({
  step,
  record,
  review,
  exercisesLeft,
  nextLesson,
  onSave,
  onReview,
  onFinish,
}: {
  step: RecapStepData;
  record: LessonRecord | null;
  /** Повторение темы урока, если оно есть. */
  review: ReviewRecord | null;
  exercisesLeft: { id: string; title: string; index: number }[];
  nextLesson: { href: string; title: string } | null;
  onSave: (answer: string, selfCheck: SelfCheck | null) => void;
  /** Итог повторения темы: засчитать («понимаю») или начать интервалы заново. */
  onReview: (success: boolean) => Promise<ReviewRecord | undefined>;
  onFinish: () => void;
}) {
  const [answer, setAnswer] = useState(record?.recap?.answer ?? '');
  const [shown, setShown] = useState(Boolean(record?.recap?.selfCheck));
  const [reviewResult, setReviewResult] = useState<{ success: boolean; text: string } | null>(null);
  const [reviewPending, setReviewPending] = useState(false);
  const selfCheck = record?.recap?.selfCheck ?? null;
  const finished = Boolean(record?.completedAt);
  const activeReview = isActiveReview(review) ? review : null;
  // Повторение засчитывается только в свой день: раньше срока интервал не сокращается.
  const reviewDue = activeReview !== null && isDue(activeReview.dueAt, Date.now());

  const answerRef = useRef<HTMLDivElement>(null);
  const reviewRef = useRef<HTMLDivElement>(null);
  const doneRef = useRef<HTMLDivElement>(null);
  const nextRef = useRef<HTMLAnchorElement>(null);
  const [focusAnswer, setFocusAnswer] = useState(0);
  const [focusReview, setFocusReview] = useState(0);
  const [focusFinish, setFocusFinish] = useState(0);
  useFocusWhen(answerRef, focusAnswer);
  useFocusWhen(reviewRef, focusReview);
  // «Завершить урок» исчезает, когда запись сохранена: фокус — на следующий урок или на итог.
  useFocusWhen(nextLesson ? nextRef : doneRef, finished ? focusFinish : 0);

  async function answerReview(success: boolean) {
    if (reviewPending) return;
    setReviewPending(true);
    try {
      const next = await onReview(success);
      setReviewResult({
        success,
        text: !success
          ? 'Вернёмся к теме завтра. Это нормально: навык складывается из нескольких подходов.'
          : next?.doneAt
            ? 'Повторение завершено: тема закреплена.'
            : `Повторение засчитано. Следующее — ${formatDate(next?.dueAt ?? Date.now())}.`,
      });
      setFocusReview((value) => value + 1);
    } finally {
      setReviewPending(false);
    }
  }

  return (
    <>
      <section className="step-card" aria-labelledby={`${step.id}-title`}>
        <h2 id={`${step.id}-title`} className="step-title">
          {step.title}
        </h2>
        {reviewDue && !reviewResult && (
          <Notice
            tone="accent"
            title="Пора повторить тему"
            action={
              <>
                <button type="button" className="btn btn-primary btn-sm" disabled={reviewPending} onClick={() => void answerReview(true)}>
                  Повторил — понимаю
                </button>
                <button type="button" className="btn btn-sm" disabled={reviewPending} onClick={() => void answerReview(false)}>
                  Пока не держится
                </button>
              </>
            }
          >
            {activeReview.reason}. Перечитай главное ниже и ответь на вопрос своими словами, а потом честно отметь, держится ли
            тема.
          </Notice>
        )}
        {reviewResult && (
          <div ref={reviewRef}>
            <Notice tone={reviewResult.success ? 'good' : 'muted'}>{reviewResult.text}</Notice>
          </div>
        )}
        {activeReview && !reviewDue && !reviewResult && (
          <p className="small muted">Тема в повторении: вернёмся к ней {formatDate(activeReview.dueAt)}.</p>
        )}
        <ul className="recap-points">
          {step.points.map((point) => (
            <li key={point}>
              <CircleCheck aria-hidden="true" />
              <span>
                <InlineText text={point} />
              </span>
            </li>
          ))}
        </ul>
        <hr className="divider" />
        <label className="field">
          <span className="field-label">Вопрос на понимание: {step.question}</span>
          <span className="field-hint">Ответь своими словами — это только для тебя, оценки нет.</span>
          <textarea
            className="textarea"
            rows={3}
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            onBlur={() => onSave(answer, selfCheck)}
          />
        </label>
        {!shown ? (
          <div className="row">
            <button
              type="button"
              className="btn"
              onClick={() => {
                setShown(true);
                setFocusAnswer((value) => value + 1);
                onSave(answer, selfCheck);
              }}
            >
              Сравнить с ответом наставника
            </button>
          </div>
        ) : (
          <div className="stack-sm">
            <div className="hint-card" ref={answerRef}>
              <div className="label">Ответ наставника</div>
              <Markdown text={step.answer} className="prose-compact" />
            </div>
            <div className="stack-sm">
              <span className="field-label" id={`${step.id}-self`}>
                Как оцениваешь своё понимание?
              </span>
              {/* Выбор сразу сохраняется и ставит тему на повторение, поэтому стрелки только переводят фокус. */}
              <div
                className="segmented"
                role="radiogroup"
                aria-labelledby={`${step.id}-self`}
                onKeyDown={(event) => rovingKeyDown(event, { select: false })}
              >
                {SELF_CHECK.map((option, optionIndex) => (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={selfCheck === option.value}
                    tabIndex={rovingTabIndex(selfCheck === option.value, optionIndex, selfCheck !== null)}
                    onClick={() => onSave(answer, option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
        <hr className="divider" />
        {exercisesLeft.length > 0 ? (
          <div className="stack-sm">
            <div className="status-line status-warn">
              <CircleAlert aria-hidden="true" />
              <span>Остались нерешённые задания — урок будет засчитан, когда они пройдут проверку:</span>
            </div>
            <ul className="bullets small">
              {exercisesLeft.map((item) => (
                <li key={item.id}>
                  <a href={`#${item.index}`} onClick={(event) => {
                    event.preventDefault();
                    window.dispatchEvent(new CustomEvent('praktika:goto-step', { detail: item.index }));
                  }}>
                    {item.title}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ) : finished ? (
          <div ref={doneRef}>
            <SuccessCard title="Урок завершён">Прогресс сохранён. {nextLesson ? 'Дальше — следующий урок.' : ''}</SuccessCard>
          </div>
        ) : (
          <div className="row">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                setFocusFinish((value) => value + 1);
                onFinish();
              }}
            >
              <CircleCheck aria-hidden="true" />
              Завершить урок
            </button>
          </div>
        )}
        {finished && nextLesson && (
          <div className="row">
            <a ref={nextRef} className="btn btn-primary btn-wrap" href={nextLesson.href}>
              <span>Следующий урок: {nextLesson.title}</span>
              <ArrowRight aria-hidden="true" />
            </a>
          </div>
        )}
      </section>
      <CoachPortal>
        <CoachPanel>
          {selfCheck === 'not-yet' || selfCheck === 'partly' ? (
            <InfoCard title="Вернёмся к этому">
              Тема попадёт в повторение. Можно открыть примеры урока ещё раз — это нормально, навык складывается из нескольких
              подходов.
            </InfoCard>
          ) : (
            <p>Закрепление: коротко вспомни главное и ответь своими словами. Объяснить — значит понять.</p>
          )}
        </CoachPanel>
      </CoachPortal>
    </>
  );
}
