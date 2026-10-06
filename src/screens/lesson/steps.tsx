// Шаги урока, кроме заданий: история, теория, пример, прогноз, порядок действий,
// вопрос, чек-лист для внешнего инструмента и закрепление.
// Раскладка (спецификация редизайна, 4.3 и 4.5): шаг-«документ» — одна панель section.pane.pane-doc с колонкой
// текста; пример — две панели: «Пример» (pane-task) и код (pane-code). Наставник — портал в колонку кадра урока;
// в нём только содержание курса (step.coach, «Проще», разборы). Нечего сказать — колонки наставника нет.

import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  CalendarClock,
  CircleAlert,
  CircleCheck,
  CircleX,
  FileCode2,
  GripVertical,
  Lightbulb,
  ListChecks,
  MessageSquareText,
  Play,
  RotateCcw,
  Shuffle,
  Square,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useRunnerState } from '../../app/hooks.ts';
import { buildRunFeedback } from '../../coach/feedback.ts';
import { CodeBlock } from '../../components/CodeBlock.tsx';
import { InlineText, Markdown } from '../../components/Markdown.tsx';
import { rovingKeyDown, rovingTabIndex } from '../../components/roving.ts';
import { Disclosure, Kbd, Notice, Spinner, StatusBadge, StatusLine, Tag, formatDate, formatMinutes } from '../../components/ui.tsx';
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
import { stepEnvironment } from '../../runner/environment.ts';
import { pythonRunner, type RunOutcome } from '../../runner/runner.ts';
import type { RunEnvironment } from '../../runner/types.ts';
import { isDue } from '../../storage/schedule.ts';
import type { LessonRecord, ReviewRecord, SelfCheck } from '../../storage/types.ts';
import { CoachNote, CoachPanel, CoachPortal, FeedbackCard, HintCard, SuccessCard, useLessonFrame } from './coach.tsx';
import { ChangedFiles, EnvironmentInfo } from './environment.tsx';
import { Transcript } from './results.tsx';
import type { PaneAttributes } from './LessonScreen.tsx';
import { isActiveReview } from './review.ts';
import { StoryIllustration } from './StoryIllustration.tsx';
import { LessonPlayground } from './LessonPlayground.tsx';

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

/**
 * Шаг-«документ»: панель кадра урока с колонкой текста (до 760 px, слева). Заголовок шага — первый h2
 * в .lesson-main: на него кадр переводит фокус после «Далее». Рядом с заголовком — метки вида шага.
 */
function DocPane({ id, title, tags, className, children }: { id: string; title: string; tags?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={`pane pane-doc step-card${className ? ` ${className}` : ''}`} aria-labelledby={`${id}-title`}>
      <div className="doc-col">
        <div className="step-head">
          <h2 id={`${id}-title`} className="step-title">
            {title}
          </h2>
          {tags && <div className="step-tags">{tags}</div>}
        </div>
        {children}
      </div>
    </section>
  );
}

// ------------------------------------------------------------ вступление

export function IntroStep({ lesson }: { lesson: Lesson }) {
  return (
    <DocPane
      id="intro"
      className="intro-step"
      title={lesson.story.title}
      tags={lesson.story.fictional ? <Tag>Вымышленная история</Tag> : undefined}
    >
      <StoryIllustration lessonId={lesson.id} title={lesson.story.title} />
      <div className="story">
        <Markdown text={lesson.story.text} />
      </div>
      <LessonPlayground key={lesson.id} lessonId={lesson.id} />
      <div className="intro-facts">
        <section className="intro-fact" aria-labelledby="intro-why">
          <h3 id="intro-why" className="intro-fact-title">
            Зачем это нужно
          </h3>
          <Markdown text={lesson.why} />
        </section>
        <section className="intro-fact" aria-labelledby="intro-used">
          <h3 id="intro-used" className="intro-fact-title">
            Где это используется
          </h3>
          <Markdown text={lesson.usedIn} />
        </section>
      </div>
      <dl className="kv intro-kv">
        <dt>Цель урока</dt>
        <dd>{lesson.objective}</dd>
        <dt>Время</dt>
        <dd>{formatMinutes(lesson.minutes)}</dd>
        <dt>Среда</dt>
        <dd>{ENV_LABEL[lesson.environment]}</dd>
      </dl>
    </DocPane>
  );
}

// ------------------------------------------------------------ теория

export function TheoryStep({ step }: { step: TheoryStepData }) {
  const [simpler, setSimpler] = useState(false);
  useEffect(() => setSimpler(false), [step.id]);
  const simplerId = `${step.id}-simpler`;
  return (
    <>
      <DocPane id={step.id} title={step.title}>
        <Markdown text={step.body} />
      </DocPane>
      {(step.coach || step.simpler) && (
        <CoachPortal>
          <CoachPanel
            actions={
              step.simpler ? (
                <button
                  type="button"
                  className="btn btn-block"
                  onClick={() => setSimpler((value) => !value)}
                  aria-expanded={simpler}
                  aria-controls={simpler ? simplerId : undefined}
                >
                  <Lightbulb aria-hidden="true" />
                  {simpler ? 'Скрыть простое объяснение' : 'Объясни проще'}
                </button>
              ) : undefined
            }
          >
            {step.coach && <CoachNote text={step.coach} />}
            {simpler && step.simpler && (
              <HintCard id={simplerId} label="Проще">
                <Markdown text={step.simpler} className="prose-compact" />
              </HintCard>
            )}
          </CoachPanel>
        </CoachPortal>
      )}
    </>
  );
}

// ------------------------------------------------------------ общий мини-запуск для примеров и прогнозов

function useQuickRun() {
  const runner = useRunnerState();
  const [outcome, setOutcome] = useState<RunOutcome | null>(null);
  const [running, setRunning] = useState(false);
  async function run(code: string, stdin = '', environment?: RunEnvironment) {
    if (running || runner.phase === 'busy') return null;
    setRunning(true);
    const result = await pythonRunner.run(code, stdin, environment ? { environment } : {});
    setRunning(false);
    setOutcome(result);
    return result;
  }
  return { outcome, setOutcome, running, run, runner };
}

/**
 * Итог запуска: вывод программы или короткий статус. Пустое состояние — одной строкой.
 * file — строка прогона над выводом («Запуск example.py · ввод Катя · 12 мс»): повторный запуск с тем же
 * выводом всё равно виден по новому времени.
 */
function RunOutput({
  outcome,
  running,
  loading,
  file,
  stdin,
}: {
  outcome: RunOutcome | null;
  running: boolean;
  loading: boolean;
  file?: string;
  stdin?: string;
}) {
  if (running) {
    return (
      <p className="run-line" role="status">
        <Spinner />
        {loading ? 'Загружаю Python…' : 'Программа выполняется…'}
      </p>
    );
  }
  if (!outcome) return <p className="run-line run-empty">Запусков ещё не было</p>;
  if (outcome.status === 'timeout') {
    return <StatusLine tone="err">Программа работала дольше {Math.round(outcome.limitMs / 1000)} с и была остановлена.</StatusLine>;
  }
  if (outcome.status === 'stopped') return <StatusLine tone="muted" icon={Square}>Программа остановлена.</StatusLine>;
  if (outcome.status === 'failed') return <StatusLine tone="warn">{outcome.message}</StatusLine>;
  const result = outcome.result;
  const error = result.compileError ?? result.error;
  const input = stdinPreview(stdin);
  return (
    <div className="run-result">
      {file && (
        <p className="run-line run-meta">
          <Play aria-hidden="true" />
          <span>
            Запуск <span className="run-file">{file}</span>
            {input && (
              <>
                {' · ввод '}
                <span className="n">{input}</span>
              </>
            )}
            {result.durationMs !== undefined && (
              <>
                {' · '}
                {/* Короткая программа укладывается меньше чем в миллисекунду: «0 мс» читалось бы как «не запускалась». */}
                <span className="n">{result.durationMs < 1 ? '<\u00a01' : Math.round(result.durationMs)}</span> мс
              </>
            )}
          </span>
        </p>
      )}
      {!result.compileError && <Transcript parts={result.transcript ?? []} />}
      {error && (
        <StatusLine tone="err" icon={CircleAlert}>
          {error.line ? `Строка ${error.line}: ` : ''}
          <span className="mono">{error.summary}</span>
        </StatusLine>
      )}
      <ChangedFiles files={result.files} />
    </div>
  );
}

/** Ввод, с которым запускается программа шага: «ввод 2, 3». */
export function stdinPreview(stdin: string | undefined): string | null {
  const lines = stdin?.replace(/\n$/, '').split('\n') ?? [];
  return lines.some((line) => line !== '') ? lines.join(', ') : null;
}

// ------------------------------------------------------------ пример

export function ExampleStep({
  step,
  onDone,
  pane,
}: {
  step: ExampleStepData;
  onDone: () => void;
  /** Атрибуты частей шага от кадра урока (панели вкладок на планшете). */
  pane?: (value: 'task' | 'code') => PaneAttributes;
}) {
  const [code, setCode] = useState(step.code);
  // Выбранное пояснение подсвечивает свою строку в редакторе (наведение, фокус или нажатие).
  const [activeNote, setActiveNote] = useState<number | null>(null);
  const [pinnedNote, setPinnedNote] = useState<number | null>(null);
  const { outcome, running, run, runner } = useQuickRun();
  // На телефоне пример читается одной колонкой: «Запустить» — под редактором, над выводом.
  const narrow = useLessonFrame().layout === 'narrow';
  const feedback = outcome ? buildRunFeedback(code, outcome) : null;
  const noteLine = activeNote ?? pinnedNote;
  const editorRef = useRef<HTMLDivElement>(null);
  const changed = code !== step.code;

  async function execute() {
    const result = await run(code, step.stdin ?? '', stepEnvironment(step));
    if (result) onDone();
  }

  // «Вернуть пример» есть только после правки и исчезает после нажатия — фокус переходит в редактор.
  function reset() {
    setCode(step.code);
    editorRef.current?.querySelector<HTMLElement>('.cm-content')?.focus();
  }

  const actions = (
    <div className="ex-actions">
      {running && (
        <button type="button" className="btn btn-danger btn-sm" onClick={() => pythonRunner.stop()}>
          <Square aria-hidden="true" />
          Остановить
        </button>
      )}
      {/* После первого запуска шаг выполнен: главное действие — «Далее», «Запустить» становится обычной кнопкой. */}
      <button
        type="button"
        className={outcome ? 'btn btn-sm' : 'btn btn-primary btn-sm'}
        onClick={() => void execute()}
        disabled={running || runner.phase === 'busy'}
        aria-keyshortcuts="Control+Enter"
      >
        {running ? <Spinner /> : <Play aria-hidden="true" />}
        Запустить
        <Kbd>Ctrl ↵</Kbd>
      </button>
    </div>
  );

  return (
    <>
      <section className="pane pane-task step-card example-card" aria-labelledby={`${step.id}-title`} {...pane?.('task')}>
        <div className="pane-head">
          <span className="plabel">Пример</span>
        </div>
        <div className="pane-body step-body">
          <h2 id={`${step.id}-title`} className="step-title">
            {step.title}
          </h2>
          {step.body && <Markdown text={step.body} />}
          <div className="notes">
            <h3 className="notes-title" id={`${step.id}-notes`}>
              Что важно в этом коде
            </h3>
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
                    <span className="tag line-tag">
                      строка <span className="n">{note.line}</span>
                    </span>
                    <span className="note-text">
                      <InlineText text={note.text} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
          {step.tryIt && (
            <p className="prose-note try-note">
              <strong>Попробуй: </strong>
              <InlineText text={step.tryIt} />
            </p>
          )}
          <EnvironmentInfo source={step} />
        </div>
      </section>
      <section className="pane pane-code workbench example-bench" aria-label="Пример кода" {...pane?.('code')}>
        <div className="ex-bar">
          <span className="ex-file">
            <FileCode2 aria-hidden="true" />
            <span className="ex-file-name">example.py</span>
          </span>
          {changed && (
            <button type="button" className="btn btn-ghost btn-sm ex-reset" onClick={reset}>
              <RotateCcw aria-hidden="true" />
              <span>Вернуть пример</span>
            </button>
          )}
          {!narrow && actions}
        </div>
        <div className="ex-editor" ref={editorRef}>
          <CodeEditor
            value={code}
            onChange={setCode}
            onSubmit={() => void execute()}
            ariaLabel={`Пример «${step.title}». Ctrl+Enter — запустить.`}
            errorLine={feedback?.line ?? null}
            noteLine={noteLine}
            minLines={Math.max(4, step.code.split('\n').length + 1)}
          />
        </div>
        {narrow && actions}
        <section className="ex-output" aria-labelledby={`${step.id}-output`}>
          <div className="ex-output-head">
            <h3 className="plabel" id={`${step.id}-output`}>
              Вывод
            </h3>
          </div>
          <div className="ex-output-body" aria-live="polite">
            <RunOutput
              outcome={outcome}
              running={running}
              loading={runner.phase === 'loading' || runner.phase === 'restarting'}
              file="example.py"
              stdin={step.stdin}
            />
          </div>
        </section>
      </section>
      {(feedback || step.coach) && (
        <CoachPortal>
          <CoachPanel>{feedback ? <FeedbackCard feedback={feedback} /> : step.coach && <CoachNote text={step.coach} />}</CoachPanel>
        </CoachPortal>
      )}
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
  const input = stdinPreview(step.stdin);

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
    await run(step.code, step.stdin ?? '', stepEnvironment(step));
  }

  return (
    <>
      <DocPane id={step.id} title={step.title} tags={<Tag>Прогноз</Tag>}>
        <Markdown text={step.prompt} />
        <div className="predict-code">
          <CodeBlock code={step.code} file="программа" label="Код для прогноза" />
          {input && (
            <p className="predict-input">
              <span className="predict-input-label">Ввод</span>
              <span className="n">{input}</span>
            </p>
          )}
        </div>
        <EnvironmentInfo source={step} />
        {step.options ? (
          <div className="options options-output" role="radiogroup" aria-label="Варианты ответа" onKeyDown={(event) => rovingKeyDown(event)}>
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
                  {/* Варианты — это вывод программы: моноширинным, как в консоли. */}
                  <span className="option-text">
                    <code className="option-code">{option}</code>
                  </span>
                  {result === 'correct' && <Verdict ok>{option === answer ? 'верно — твой ответ' : 'верный ответ'}</Verdict>}
                  {result === 'wrong' && <Verdict ok={false}>твой ответ</Verdict>}
                </button>
              );
            })}
          </div>
        ) : (
          <label className="field predict-field">
            <span className="field-label">Что появится на экране?</span>
            <textarea
              className="textarea mono"
              rows={Math.max(2, step.answer.split('\n').length)}
              value={answer}
              disabled={revealed}
              onChange={(event) => setAnswer(event.target.value)}
              placeholder="Вывод построчно"
            />
          </label>
        )}
        {!revealed && (
          <div className="step-actions">
            <button
              ref={checkRef}
              type="button"
              className="btn btn-primary"
              onClick={() => void reveal()}
              disabled={!answer.trim() && Boolean(step.options)}
            >
              {/* Без варианта ответа кнопка ждёт выбора; в поле можно не писать ничего — тогда просто показать запуск. */}
              {answer.trim() || step.options ? 'Проверить прогноз' : 'Не знаю — покажи'}
            </button>
          </div>
        )}
        {revealed && (
          <div className="step-result" aria-live="polite" ref={resultRef}>
            <div className="step-result-status">
              {matched === true && <StatusBadge tone="ok">Прогноз совпал</StatusBadge>}
              {matched === false && <StatusBadge tone="warn">Прогноз не совпал</StatusBadge>}
              {matched === null && <StatusBadge tone="muted">Без прогноза</StatusBadge>}
            </div>
            <section className="run-box" aria-labelledby={`${step.id}-run`}>
              <div className="run-box-head">
                <h3 className="plabel" id={`${step.id}-run`}>
                  Настоящий запуск
                </h3>
              </div>
              <div className="run-box-body">
                <RunOutput outcome={outcome} running={running} loading={runner.phase === 'loading' || runner.phase === 'restarting'} />
              </div>
            </section>
            <Markdown text={step.explanation} />
            <div className="step-actions">
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
            </div>
          </div>
        )}
      </DocPane>
      {step.coach && (
        <CoachPortal>
          <CoachPanel>
            <CoachNote text={step.coach} />
          </CoachPanel>
        </CoachPortal>
      )}
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
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  // После «Поднять / Опустить» фокус остаётся на кнопке переставленного пункта, а новое место объявляется.
  const [moved, setMoved] = useState<{ id: string; direction: 'up' | 'down'; tick: number } | null>(null);
  const [announce, setAnnounce] = useState('');
  const listRef = useRef<HTMLOListElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const checkRef = useRef<HTMLButtonElement>(null);
  const [focusResult, setFocusResult] = useState(0);
  const [focusCheck, setFocusCheck] = useState(0);
  useFocusWhen(resultRef, focusResult);
  useFocusWhen(checkRef, focusCheck);
  const solved = !revealed && (checked?.every(Boolean) ?? false);
  const locked = solved || revealed;
  const text = new Map(step.items.map((item) => [item.id, item.text]));

  useEffect(() => {
    if (!moved) return;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(moved.id)}"]`);
    const same = row?.querySelector<HTMLButtonElement>(`button[data-direction="${moved.direction}"]`);
    const other = row?.querySelector<HTMLButtonElement>(`button[data-direction="${moved.direction === 'up' ? 'down' : 'up'}"]`);
    (same && !same.disabled ? same : other)?.focus();
  }, [moved]);

  function move(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= order.length) return;
    const next = [...order];
    [next[index], next[target]] = [next[target], next[index]];
    setOrder(next);
    setChecked(null);
    setMoved((value) => ({ id: order[index], direction: delta < 0 ? 'up' : 'down', tick: (value?.tick ?? 0) + 1 }));
    setAnnounce(`${text.get(order[index])} — ${target + 1} из ${order.length}`);
  }

  function drop(targetId: string) {
    setDropTarget(null);
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
      <DocPane id={step.id} title={step.title} tags={<Tag>Без кода</Tag>}>
        <Markdown text={step.prompt} />
        <ol className="order-list" aria-label="Шаги — расставь по порядку" ref={listRef} data-locked={locked}>
          {order.map((id, index) => (
            <li
              key={id}
              data-id={id}
              className="order-item"
              data-result={checked ? (checked[index] ? 'ok' : 'bad') : undefined}
              data-dragging={dragging === id || undefined}
              data-drop={(dropTarget === id && dragging !== id) || undefined}
              draggable={!locked}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move';
                setDragging(id);
              }}
              onDragEnd={() => {
                setDragging(null);
                setDropTarget(null);
              }}
              onDragOver={(event) => {
                if (!dragging) return;
                event.preventDefault();
                if (dropTarget !== id) setDropTarget(id);
              }}
              onDrop={(event) => {
                event.preventDefault();
                drop(id);
              }}
            >
              {!locked && <GripVertical aria-hidden="true" className="order-grip" />}
              <span className="order-num n" aria-hidden="true">
                {index + 1}
              </span>
              <span className="order-text">{text.get(id)}</span>
              {checked && !solved && <Verdict ok={checked[index]}>{checked[index] ? 'на месте' : 'не на месте'}</Verdict>}
              {!locked && (
                <span className="order-buttons">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm btn-icon"
                    data-direction="up"
                    aria-label={`Поднять: ${text.get(id)}`}
                    title="Поднять"
                    onClick={() => move(index, -1)}
                    disabled={index === 0}
                  >
                    <ArrowUp aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm btn-icon"
                    data-direction="down"
                    aria-label={`Опустить: ${text.get(id)}`}
                    title="Опустить"
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
        <div className="visually-hidden" role="status" aria-live="polite">
          {announce}
        </div>
        {!locked ? (
          <div className="step-actions">
            <button ref={checkRef} type="button" className="btn btn-primary" onClick={check}>
              <ListChecks aria-hidden="true" />
              Проверить порядок
            </button>
            {attempts >= 2 && (
              <button type="button" className="btn" onClick={showAnswer}>
                Показать ответ
              </button>
            )}
            {checked && <StatusLine tone="err">Есть шаги не на месте</StatusLine>}
          </div>
        ) : (
          <div className="step-result" aria-live="polite" ref={resultRef}>
            <div className="step-result-status">
              {revealed ? <StatusBadge tone="muted">Ответ показан</StatusBadge> : <StatusBadge tone="ok">Порядок верный</StatusBadge>}
            </div>
            <Markdown text={step.explanation} />
            {revealed && (
              <div className="step-actions">
                <button type="button" className="btn" onClick={shuffleAgain}>
                  <Shuffle aria-hidden="true" />
                  Собрать заново
                </button>
              </div>
            )}
          </div>
        )}
      </DocPane>
      {step.coach && (
        <CoachPortal>
          <CoachPanel>
            <CoachNote text={step.coach} />
          </CoachPanel>
        </CoachPortal>
      )}
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
      <DocPane id={step.id} title={step.title} tags={<Tag>Вопрос</Tag>}>
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
          <div className="step-actions">
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
          <div className="step-result" aria-live="polite" ref={resultRef}>
            <div className="step-result-status">
              {choice === step.correct ? <StatusBadge tone="ok">Верно</StatusBadge> : <StatusBadge tone="warn">Не совсем</StatusBadge>}
            </div>
            <Markdown text={step.explanation} />
          </div>
        )}
      </DocPane>
      {step.coach && (
        <CoachPortal>
          <CoachPanel>
            <CoachNote text={step.coach} />
          </CoachPanel>
        </CoachPortal>
      )}
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
  const count = step.items.filter((item) => done.has(item.id)).length;
  function toggle(id: string) {
    const next = new Set(done);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(step.items.map((item) => item.id).filter((itemId) => next.has(itemId)));
  }
  return (
    <>
      <DocPane
        id={step.id}
        title={step.title}
        tags={
          <>
            <Tag>Внешний инструмент</Tag>
            <Tag>Отмечаешь сам</Tag>
          </>
        }
      >
        <Markdown text={step.body} />
        <div className="step-checklist">
          <ul className="checklist">
            {step.items.map((item) => (
              <li key={item.id} data-done={done.has(item.id)}>
                <label className="check">
                  <input type="checkbox" checked={done.has(item.id)} onChange={() => toggle(item.id)} />
                  <Markdown text={item.text} />
                </label>
                {item.help && (
                  <Disclosure summary="Если не получается" className="check-help">
                    <Markdown text={item.help} className="prose-compact" />
                  </Disclosure>
                )}
              </li>
            ))}
          </ul>
          {count === step.items.length ? (
            <StatusLine tone="ok">Все пункты отмечены</StatusLine>
          ) : (
            <p className="checklist-count">
              Отмечено <span className="n">{count}</span> из <span className="n">{step.items.length}</span>
            </p>
          )}
        </div>
      </DocPane>
      {step.coach && (
        <CoachPortal>
          <CoachPanel>
            <CoachNote text={step.coach} />
          </CoachPanel>
        </CoachPortal>
      )}
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
  const activeReview = isActiveReview(review) ? review : null;
  // Повторение засчитывается только в свой день: раньше срока интервал не сокращается.
  const reviewDue = activeReview !== null && isDue(activeReview.dueAt, Date.now());
  const [answer, setAnswer] = useState(record?.recap?.answer ?? '');
  // В день повторения ответ наставника снова закрыт: сначала вспомнить самому, потом сравнить.
  const [shown, setShown] = useState(Boolean(record?.recap?.selfCheck) && !reviewDue);
  const [reviewResult, setReviewResult] = useState<{ success: boolean; text: string } | null>(null);
  const [reviewPending, setReviewPending] = useState(false);
  const selfCheck = record?.recap?.selfCheck ?? null;
  const finished = Boolean(record?.completedAt);
  // Решение по повторению — после вопроса и ответа наставника, на месте самооценки.
  const reviewAsk = reviewDue && !reviewResult;
  // «Тема — в повторении» — у самооценки, которая её туда поставила; строка вверху — только если тема там с прошлого раза.
  const selfReview = shown && !reviewAsk && !reviewResult && (selfCheck === 'partly' || selfCheck === 'not-yet');
  // Повторение читается из базы позже записи урока: если день повторения выяснился уже после открытия шага,
  // ответ наставника закрывается (ученик его ещё не открывал — шаг только что показан).
  const dueSeen = useRef(reviewDue);
  useEffect(() => {
    if (!reviewDue || dueSeen.current) return;
    dueSeen.current = true;
    setShown(false);
  }, [reviewDue]);

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
          ? 'Вернёмся к теме завтра.'
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
      <DocPane id={step.id} title={step.title} className="recap-step">
        {reviewAsk && (
          <Notice tone="accent" title="Пора повторить тему">
            {activeReview.reason}.
          </Notice>
        )}
        {activeReview && !reviewDue && !reviewResult && !selfReview && (
          <p className="recap-due">
            <CalendarClock aria-hidden="true" />
            <span>Повторение {formatDate(activeReview.dueAt)}</span>
          </p>
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
        <div className="recap-section">
          <label className="field recap-question">
            <span className="field-label">Вопрос на понимание</span>
            <span className="recap-question-text">{step.question}</span>
            <textarea
              className="textarea recap-answer"
              rows={3}
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
              onBlur={() => onSave(answer, selfCheck)}
            />
          </label>
          {!shown ? (
            <div className="step-actions">
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setShown(true);
                  setFocusAnswer((value) => value + 1);
                  onSave(answer, selfCheck);
                }}
              >
                <MessageSquareText aria-hidden="true" />
                Сравнить с ответом наставника
              </button>
            </div>
          ) : (
            <>
              <div className="recap-answer-card" ref={answerRef}>
                <HintCard label="Ответ наставника">
                  <Markdown text={step.answer} className="prose-compact" />
                </HintCard>
              </div>
              {reviewResult ? (
                <div className="recap-review-result" ref={reviewRef}>
                  <Notice tone={reviewResult.success ? 'ok' : 'muted'}>{reviewResult.text}</Notice>
                </div>
              ) : (
                <div className="recap-self">
                  <span className="field-label" id={`${step.id}-self`}>
                    Как оцениваешь своё понимание?
                  </span>
                  {reviewAsk ? (
                    // День повторения: вместо самооценки — итог повторения (засчитать или начать интервалы заново).
                    <div className="step-actions recap-review-actions" role="group" aria-labelledby={`${step.id}-self`}>
                      <button type="button" className="btn btn-primary" disabled={reviewPending} onClick={() => void answerReview(true)}>
                        <CircleCheck aria-hidden="true" />
                        Повторил — понимаю
                      </button>
                      <button type="button" className="btn" disabled={reviewPending} onClick={() => void answerReview(false)}>
                        <RotateCcw aria-hidden="true" />
                        Пока не держится
                      </button>
                    </div>
                  ) : (
                    <>
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
                      {selfReview && (
                        <StatusLine tone="warn" icon={CalendarClock} className="recap-self-status">
                          Тема — в повторении
                          {activeReview && !reviewDue ? ` · ${formatDate(activeReview.dueAt)}` : ''}
                        </StatusLine>
                      )}
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </div>
        <div className="recap-section recap-finish">
          {exercisesLeft.length > 0 ? (
            <>
              <StatusLine tone="warn">Остались задания:</StatusLine>
              <ul className="recap-left">
                {exercisesLeft.map((item) => (
                  <li key={item.id}>
                    <a
                      className="recap-left-link"
                      href={`#${item.index}`}
                      onClick={(event) => {
                        event.preventDefault();
                        window.dispatchEvent(new CustomEvent('praktika:goto-step', { detail: item.index }));
                      }}
                    >
                      <span className="recap-left-num n" aria-hidden="true">
                        {item.index + 1}
                      </span>
                      <span className="recap-left-title">{item.title}</span>
                      <ArrowRight aria-hidden="true" className="recap-left-arrow" />
                    </a>
                  </li>
                ))}
              </ul>
            </>
          ) : finished ? (
            <div ref={doneRef}>
              <SuccessCard title="Урок завершён" />
            </div>
          ) : (
            <div className="step-actions">
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
            <div className="step-actions">
              <a ref={nextRef} className="btn btn-primary btn-wrap" href={nextLesson.href}>
                <span>Следующий урок: {nextLesson.title}</span>
                <ArrowRight aria-hidden="true" />
              </a>
            </div>
          )}
        </div>
      </DocPane>
    </>
  );
}
