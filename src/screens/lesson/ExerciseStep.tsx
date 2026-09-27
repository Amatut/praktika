// Шаг-задание: условие → код → запуск и проверка настоящим Python → короткий разбор →
// подсказки → исправление. Черновик и попытки сохраняются автоматически.

import { ChevronDown, CircleAlert, CircleCheck, FileCode2, Lightbulb, Play, RotateCcw, Square } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRunnerState, useSettings } from '../../app/hooks.ts';
import { reportSaveProblem } from '../../app/problems.ts';
import { buildCheckFeedback, buildRunFeedback, testLabel } from '../../coach/feedback.ts';
import type { Feedback } from '../../coach/types.ts';
import { CodeBlock } from '../../components/CodeBlock.tsx';
import { InlineText, Markdown } from '../../components/Markdown.tsx';
import { rovingKeyDown } from '../../components/roving.ts';
import { ConfirmDialog, Notice, StatusBadge, plural } from '../../components/ui.tsx';
import type { Exercise, ExerciseKind, Lesson } from '../../content/schema.ts';
import { CodeEditor } from '../../editor/CodeEditor.tsx';
import { pythonRunner, type CheckOutcome, type RunOutcome } from '../../runner/runner.ts';
import {
  completeReview,
  getAllReviews,
  getExercise,
  markHintShown,
  markSolutionViewed,
  recordCheck,
  recordRun,
  resetDraft,
  saveDraft,
} from '../../storage/repo.ts';
import { exerciseReviewKey, isDue } from '../../storage/schedule.ts';
import type { ExerciseRecord, HelpLevel, ReviewRecord } from '../../storage/types.ts';
import { AiCoachBox } from './AiCoachBox.tsx';
import { checkAnnouncement, failedChecks, onlyRulesFailed, testCounter } from './check-summary.ts';
import { CoachPanel, CoachPortal, FeedbackCard, SuccessCard } from './coach.tsx';
import type { Pane, PaneAttributes } from './LessonScreen.tsx';
import { TestList, Transcript, attemptErrorType, checkPassed, resultsFromOutcome } from './results.tsx';
import { reviewReasonAfter } from './review.ts';
import { ExerciseBrief, ExerciseExamples } from './ExerciseBrief.tsx';
import { OrderDemo } from './LessonPlayground.tsx';
import { illustrationUrl } from './StoryIllustration.tsx';

export const KIND_LABEL: Record<ExerciseKind, string> = {
  repeat: 'Повтори приём',
  modify: 'Измени условие',
  write: 'Реши сам',
  fix: 'Найди ошибку',
  read: 'Прочитай код',
};

type Last = { kind: 'check'; outcome: CheckOutcome; code: string } | { kind: 'run'; outcome: RunOutcome; stdin: string };

export function ExerciseStep({
  lesson,
  exercise,
  pane,
  onPassed,
  onShowCoach,
}: {
  lesson: Lesson;
  exercise: Exercise;
  /** Атрибуты частей шага (на телефоне — панели вкладок «Задание / Код»). */
  pane: (value: Pane) => PaneAttributes;
  onPassed: () => void;
  onShowCoach: () => void;
}) {
  const settings = useSettings();
  const runner = useRunnerState();
  const [record, setRecord] = useState<ExerciseRecord | null>(null);
  const [code, setCode] = useState(exercise.starterCode);
  const [last, setLast] = useState<Last | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [tab, setTab] = useState<'tests' | 'output'>('tests');
  const [action, setAction] = useState<'run' | 'check' | null>(null);
  const [testIndex, setTestIndex] = useState(0);
  const [confirm, setConfirm] = useState<'reset' | 'solution' | null>(null);
  const [announce, setAnnounce] = useState('');
  const firstExample = exercise.tests.find((test) => test.example) ?? exercise.tests[0];
  const [stdin, setStdin] = useState(firstExample.stdin ?? '');
  const usesInput = exercise.tests.some((test) => Boolean(test.stdin));
  const saveTimer = useRef<number | undefined>(undefined);
  const pendingDraft = useRef<string | null>(null);
  // Повторение: задание решается заново; подсказки считаются отдельно для этого подхода.
  const [review, setReview] = useState<ReviewRecord | null>(null);
  const [reviewMode, setReviewMode] = useState(false);
  const [reviewHints, setReviewHints] = useState(0);
  const [reviewSolution, setReviewSolution] = useState(false);
  const [reviewDone, setReviewDone] = useState<string | null>(null);
  const previousCode = useRef<string | null>(null);
  // Кнопка, которую нажали, исчезла («Подсказка 3 из 3», «Показать решение») — фокус к тому, что появилось.
  const [helpFocus, setHelpFocus] = useState<{ id: string; tick: number } | null>(null);

  // Загрузка сохранённого черновика и статуса.
  useEffect(() => {
    let alive = true;
    setLast(null);
    setFeedback(null);
    setTab('tests');
    getExercise(exercise.id).then((stored) => {
      if (!alive) return;
      setRecord(stored ?? null);
      setCode(stored?.draft ?? exercise.starterCode);
    });
    setReviewMode(false);
    setReviewDone(null);
    getAllReviews().then((reviews) => {
      if (!alive) return;
      const key = exerciseReviewKey(exercise.id);
      // Повторение, срок которого наступил: сравниваются календарные дни, «на завтра» сегодня ещё не засчитывается.
      const due = reviews.find((item) => item.key === key && item.doneAt === null && isDue(item.dueAt, Date.now()));
      setReview(due ?? null);
    });
    return () => {
      alive = false;
    };
  }, [exercise.id, exercise.starterCode]);

  const flushDraft = useCallback(() => {
    window.clearTimeout(saveTimer.current);
    const value = pendingDraft.current;
    if (value === null) return Promise.resolve();
    pendingDraft.current = null;
    return saveDraft(exercise.id, lesson.id, value).catch((error: unknown) => reportSaveProblem(error, 'Черновик не сохранён'));
  }, [exercise.id, lesson.id]);

  // Черновик сохраняется при уходе со страницы и при смене задания.
  useEffect(() => {
    const onHide = () => void flushDraft();
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onHide);
      void flushDraft();
    };
  }, [flushDraft]);

  useEffect(() => {
    if (!helpFocus) return;
    document.getElementById(helpFocus.id)?.focus();
  }, [helpFocus]);

  const onCodeChange = (value: string) => {
    setCode(value);
    // В повторении черновик не трогаем: сохранённое решение остаётся, пока новое не пройдёт проверку.
    if (reviewMode) return;
    pendingDraft.current = value;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void flushDraft(), 400);
  };

  const busy = runner.phase === 'busy' || action !== null;
  const passed = !reviewMode && record?.status === 'passed';
  const hintsShown = reviewMode ? reviewHints : (record?.hintsShown ?? 0);
  const solutionViewed = reviewMode ? reviewSolution : (record?.solutionViewed ?? false);
  const help: HelpLevel = solutionViewed ? 4 : (hintsShown as HelpLevel);

  // Повторение начинается со стартового кода, но сохранённое решение не затирается:
  // после перезагрузки или ухода с шага в редакторе снова прежний код.
  function startReview() {
    void flushDraft();
    previousCode.current = code;
    setReviewMode(true);
    setReviewHints(0);
    setReviewSolution(false);
    setLast(null);
    setFeedback(null);
    setCode(exercise.starterCode);
  }

  function leaveReview() {
    setReviewMode(false);
    setLast(null);
    setFeedback(null);
    if (previousCode.current !== null) setCode(previousCode.current);
  }
  const hintsLocked = Boolean(exercise.noHintsBeforeAttempt) && (record?.checks ?? 0) === 0;

  async function check() {
    if (busy) return;
    setAction('check');
    setTab('tests');
    setTestIndex(0);
    setAnnounce('Проверяю…');
    // Проверка занимает Python сразу, в обработчике нажатия: повторное нажатие уже не начнёт вторую,
    // а «Остановить» с первого мгновения есть что останавливать. Черновик сохраняется, пока идёт проверка.
    const running = pythonRunner.check(
      { code, tests: exercise.tests, rules: exercise.rules },
      { perTestMs: exercise.timeLimitMs, onTestStart: setTestIndex },
    );
    await flushDraft();
    const outcome = await running;
    setAction(null);
    setLast({ kind: 'check', outcome, code });
    const ok = checkPassed(outcome);
    setFeedback(ok ? null : buildCheckFeedback(exercise, code, outcome));
    const tests = resultsFromOutcome(exercise, outcome);
    // Объявление — по типу результата: «код не запустился», «не выполнено требование», «не пройдено X из Y».
    setAnnounce(checkAnnouncement(outcome, tests));
    if (outcome.status === 'stopped' || outcome.status === 'failed') return;
    const updated = await recordCheck(exercise.id, lesson.id, {
      passed: ok,
      errorType: attemptErrorType(outcome),
      failed: failedChecks(outcome, tests, exercise.tests.length),
      total: exercise.tests.length,
      help,
    });
    setRecord(updated);
    if (ok && reviewMode && review) {
      // Засчитываем повторение, если справился сам или с одной подсказкой.
      const success = reviewHints <= 1 && !reviewSolution;
      const next = await completeReview(review.key, success, (step) => reviewReasonAfter('exercise', success, step.stage));
      // Новое решение прошло проверку — теперь сохраняется оно.
      pendingDraft.current = code;
      void flushDraft();
      setReviewMode(false);
      setReview(null);
      setReviewDone(
        !success
          ? 'Решено, но с подсказками — вернёмся к заданию завтра.'
          : next?.doneAt
            ? 'Повторение завершено: навык закреплён.'
            : `Повторение засчитано. Следующее — ${new Date(next?.dueAt ?? Date.now()).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}.`,
      );
    }
    if (ok) onPassed();
  }

  async function run() {
    if (busy) return;
    setAction('run');
    setTab('output');
    setAnnounce('Запускаю…');
    // Как в check(): Python занимается сразу, черновик сохраняется параллельно.
    const running = pythonRunner.run(code, stdin, { timeLimitMs: exercise.timeLimitMs ?? undefined });
    await flushDraft();
    const outcome = await running;
    setAction(null);
    setLast({ kind: 'run', outcome, stdin });
    const runFeedback = buildRunFeedback(code, outcome);
    if (runFeedback) setFeedback(runFeedback);
    if (outcome.status === 'done' || outcome.status === 'timeout') {
      const errorType =
        outcome.status === 'timeout' ? 'timeout' : (outcome.result.compileError?.type ?? outcome.result.error?.type ?? null);
      const updated = await recordRun(exercise.id, lesson.id, errorType);
      if (updated) setRecord(updated);
    }
    setAnnounce(outcome.status === 'done' ? 'Программа выполнена.' : 'Запуск прерван.');
  }

  async function showHint() {
    const level = Math.min(3, hintsShown + 1) as 1 | 2 | 3;
    if (reviewMode) {
      setReviewHints(level);
    } else {
      const updated = await markHintShown(exercise.id, lesson.id, level);
      setRecord(updated);
    }
    // После третьей подсказки кнопки больше нет — фокус на саму подсказку.
    if (level === 3) setHelpFocus((value) => ({ id: `${exercise.id}-hint-3`, tick: (value?.tick ?? 0) + 1 }));
    onShowCoach();
  }

  async function showSolution() {
    if (reviewMode) {
      setReviewSolution(true);
    } else {
      const updated = await markSolutionViewed(exercise.id, lesson.id);
      setRecord(updated);
    }
    setHelpFocus((value) => ({ id: `${exercise.id}-solution`, tick: (value?.tick ?? 0) + 1 }));
    onShowCoach();
  }

  async function resetCode() {
    window.clearTimeout(saveTimer.current);
    pendingDraft.current = null;
    // В повторении сохранённое решение не стирается: заменяется только код в редакторе.
    if (!reviewMode) await resetDraft(exercise.id);
    setCode(exercise.starterCode);
    setLast(null);
    setFeedback(null);
  }

  const checkOutcome = last?.kind === 'check' ? last.outcome : null;
  const testResults = checkOutcome ? resultsFromOutcome(exercise, checkOutcome) : [];
  const counter = testCounter(checkOutcome, testResults);
  const errorLine = feedback?.line ?? null;
  const loading = runner.phase === 'loading' || runner.phase === 'restarting';
  const tabId = (value: 'tests' | 'output') => `${exercise.id}-tab-${value}`;

  return (
    <>
      <section className="step-card exercise-card" aria-labelledby={`${exercise.id}-title`} {...pane('task')}>
        <div className="task-meta">
          <span className="badge badge-accent">{KIND_LABEL[exercise.kind]}</span>
          {reviewMode ? (
            <StatusBadge tone="accent">Повторение</StatusBadge>
          ) : passed ? (
            <StatusBadge tone="good">Решено</StatusBadge>
          ) : (record?.checks ?? 0) > 0 ? (
            <StatusBadge tone="warn">
              {record!.checks} {plural(record!.checks, ['попытка', 'попытки', 'попыток'])}
            </StatusBadge>
          ) : (
            <StatusBadge tone="muted">Новое</StatusBadge>
          )}
        </div>
        <h2 id={`${exercise.id}-title`} className="step-title">
          {exercise.title}
        </h2>
        {review && !reviewMode && (
          <Notice
            tone="accent"
            title="Пора повторить"
            action={
              <button type="button" className="btn btn-primary btn-sm" onClick={startReview}>
                Решить заново
              </button>
            }
          >
            {review.reason}. Реши задание с чистого листа — сам или с одной подсказкой. Прежний код можно будет вернуть.
          </Notice>
        )}
        {reviewMode && (
          <Notice
            tone="accent"
            title="Повторение"
            action={
              <button type="button" className="btn btn-ghost btn-sm" onClick={leaveReview}>
                Вернуть прежний код
              </button>
            }
          >
            Подсказки в этом подходе считаются заново. Если справишься сам или с одной подсказкой, следующее повторение будет
            позже. Прежнее решение сохранено, пока новое не пройдёт проверку.
          </Notice>
        )}
        {reviewDone && <Notice tone="good">{reviewDone}</Notice>}
        <Markdown text={exercise.statement} />
        {exercise.id === 'm1-l1-e1' && (
          <details className="order-explorer">
            <summary>
              <img src={illustrationUrl('cafe')} alt="Лена и Артём у ноутбука в кофейне" width="1672" height="941" />
              <span><strong>Наглядный заказ</strong><small>Меняй количество и наблюдай за чеком</small></span>
              <ChevronDown aria-hidden="true" />
            </summary>
            <OrderDemo />
          </details>
        )}
        <ExerciseBrief exercise={exercise} />
        <ExerciseExamples exercise={exercise} />
        <details className="disclosure">
          <summary>Как проверяется решение</summary>
          <div className="disclosure-body stack-sm small">
            <ul className="bullets">
              {exercise.criteria.map((item) => (
                <li key={item}>
                  <InlineText text={item} />
                </li>
              ))}
            </ul>
            <p className="muted">
              Проверок: {exercise.tests.length}. Код выполняется настоящим Python прямо в браузере; результат сравнивается с
              ожидаемым. Пробелы в конце строк не учитываются.
            </p>
          </div>
        </details>
      </section>

      <section className="workbench" aria-label="Редактор и результаты" {...pane('code')}>
        <div className="wb-head">
          <span className="wb-file">
            <FileCode2 aria-hidden="true" />
            {exercise.filename}
          </span>
          <span className="wb-env">
            <span className="nowrap env-text">Python{runner.pythonVersion ? ` ${runner.pythonVersion}` : ''} · в браузере</span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setConfirm('reset')}
              disabled={busy || code === exercise.starterCode}
              title="Вернуть стартовый код"
            >
              <RotateCcw aria-hidden="true" />
              <span>Сначала</span>
            </button>
          </span>
        </div>
        <CodeEditor
          value={code}
          onChange={onCodeChange}
          onSubmit={() => void check()}
          ariaLabel={`Код задания «${exercise.title}». Ctrl+Enter — проверить. Esc, затем Tab — выйти из редактора.`}
          errorLine={errorLine}
          minLines={Math.max(6, exercise.starterCode.split('\n').length + 2)}
        />
        <div className="wb-actions">
          <button type="button" className="btn btn-primary" onClick={() => void check()} disabled={busy}>
            {action === 'check' ? <span className="spinner" aria-hidden="true" /> : <CircleCheck aria-hidden="true" />}
            Проверить
          </button>
          <button type="button" className="btn" onClick={() => void run()} disabled={busy}>
            {action === 'run' ? <span className="spinner" aria-hidden="true" /> : <Play aria-hidden="true" />}
            Запустить
          </button>
          {busy && (
            <button type="button" className="btn btn-danger" onClick={() => pythonRunner.stop()}>
              <Square aria-hidden="true" />
              Остановить
            </button>
          )}
          <span className="hint-keys">
            <kbd>Ctrl</kbd> + <kbd>Enter</kbd> — проверить
          </span>
        </div>
        <div className="wb-stdin" hidden={!usesInput && !code.includes('input(')}>
          <details className="disclosure">
            <summary>Ввод для «Запустить»{stdin ? '' : ' (пусто)'}</summary>
            <div className="disclosure-body stack-sm">
              <label className="field">
                <span className="field-hint">
                  Каждая строка — один ответ на input(). Для проверки используются данные из тестов.
                </span>
                <textarea
                  className="textarea mono"
                  rows={3}
                  value={stdin}
                  onChange={(event) => setStdin(event.target.value)}
                  aria-label="Ввод для запуска"
                />
              </label>
            </div>
          </details>
        </div>
        <div className="wb-results">
          <div className="tabs" role="tablist" aria-label="Результаты" onKeyDown={(event) => rovingKeyDown(event)}>
            {(
              [
                ['tests', 'Проверка'],
                ['output', 'Вывод'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                className="tab"
                id={tabId(value)}
                aria-controls={`${exercise.id}-results`}
                aria-selected={tab === value}
                tabIndex={tab === value ? 0 : -1}
                onClick={() => setTab(value)}
              >
                {label}
                {value === 'tests' && counter && (
                  <span className="count">
                    <span className="visually-hidden">пройдено </span>
                    {counter}
                  </span>
                )}
              </button>
            ))}
          </div>
          <div className="results-body" role="tabpanel" id={`${exercise.id}-results`} aria-labelledby={tabId(tab)}>
            {loading && (
              <div className="run-state">
                <span className="spinner" aria-hidden="true" />
                {runner.phase === 'loading'
                  ? 'Загружаю Python… В первый раз это может занять до минуты.'
                  : 'Перезапускаю Python после остановки…'}
              </div>
            )}
            {runner.phase === 'failed' && !busy && (
              <div className="status-line status-error">
                <CircleAlert aria-hidden="true" />
                <span>{runner.error}</span>
              </div>
            )}
            {action === 'check' && runner.phase === 'busy' && (
              <div className="run-state">
                <span className="spinner" aria-hidden="true" />
                Проверяю: {testLabel(exercise.tests[Math.min(testIndex, exercise.tests.length - 1)], testIndex)} (
                {testIndex + 1} из {exercise.tests.length})
              </div>
            )}
            {action === 'run' && runner.phase === 'busy' && (
              <div className="run-state">
                <span className="spinner" aria-hidden="true" />
                Программа выполняется…
              </div>
            )}
            {tab === 'tests' && !action && <CheckView exercise={exercise} outcome={checkOutcome} results={testResults} />}
            {tab === 'output' && !action && <OutputView last={last} />}
            {feedback && !action && (
              <div className="mobile-only">
                <button type="button" className="btn btn-block btn-wrap" onClick={onShowCoach}>
                  <Lightbulb aria-hidden="true" />
                  <span>Разбор у наставника: {feedback.title}</span>
                </button>
              </div>
            )}
          </div>
        </div>
        <div className="visually-hidden" role="status" aria-live="polite">
          {announce}
        </div>
      </section>

      <CoachPortal>
        <CoachPanel
          footnote="Сначала подсказка, полное решение — по запросу."
          after={
            settings.coach.mode === 'ai' ? (
              <AiCoachBox
                lesson={lesson}
                exercise={exercise}
                code={code}
                checkOutcome={checkOutcome}
                checkedCode={last?.kind === 'check' ? last.code : null}
                hintsUsed={hintsShown}
              />
            ) : undefined
          }
          actions={
            passed ? (
              !solutionViewed && (
                <button type="button" className="btn btn-block" onClick={() => void showSolution()}>
                  Сравнить с решением наставника
                </button>
              )
            ) : (
            <>
              {hintsShown < 3 && (
                <button type="button" className="btn btn-primary btn-block" onClick={() => void showHint()} disabled={hintsLocked}>
                  <Lightbulb aria-hidden="true" />
                  Подсказка {hintsShown + 1} из 3
                </button>
              )}
              {!solutionViewed && (
                <button
                  type="button"
                  className={`btn btn-block${hintsShown >= 3 ? ' btn-primary' : ''}`}
                  onClick={() => setConfirm('solution')}
                  disabled={hintsLocked}
                >
                  Показать решение
                </button>
              )}
            </>
            )
          }
        >
          {hintsLocked && (
            <p className="small muted">
              Это самостоятельная работа: подсказки откроются после первой проверки. Ошибиться — нормально, по результату станет
              понятно, что повторить.
            </p>
          )}
          {!feedback && !passed && hintsShown === 0 && !solutionViewed && !hintsLocked && (
            <p>
              Попробуй сначала сам: напиши код и нажми «Проверить». Если застрянешь — возьми подсказку, решение тоже можно
              открыть.
            </p>
          )}
          {passed && checkPassed(checkOutcome) && (
            <SuccessCard title="Все проверки пройдены">
              {exercise.afterPass ? <Markdown text={exercise.afterPass} className="prose-compact" /> : 'Можно переходить дальше.'}
            </SuccessCard>
          )}
          {passed && !checkPassed(checkOutcome) && !feedback && (
            <SuccessCard title="Задание уже решено">Можно улучшить код или перейти дальше.</SuccessCard>
          )}
          {feedback && <FeedbackCard feedback={feedback} />}
          {/* Открыта последняя подсказка; прежние свёрнуты, чтобы панель не разрасталась. */}
          {Array.from({ length: hintsShown }, (_, index) =>
            index === hintsShown - 1 ? (
              <div key={index} className="hint-card" id={`${exercise.id}-hint-${index + 1}`} tabIndex={-1}>
                <div className="label">Подсказка {index + 1}</div>
                <Markdown text={exercise.hints[index]} className="prose-compact" />
              </div>
            ) : (
              <details key={index} className="disclosure hint-old">
                <summary>Подсказка {index + 1}</summary>
                <div className="disclosure-body">
                  <Markdown text={exercise.hints[index]} className="prose-compact" />
                </div>
              </details>
            ),
          )}
          {solutionViewed && (
            <details className="disclosure solution" open>
              <summary id={`${exercise.id}-solution`}>Решение</summary>
              <div className="disclosure-body stack-sm">
                <CodeBlock code={exercise.solution.code} label="Решение" />
                <Markdown text={exercise.solution.explanation} className="prose-compact" />
                <p className="small muted">
                  Разобраться в решении — полезно. Навык засчитается, когда похожая задача получится без подсказок: она
                  появится в повторении.
                </p>
              </div>
            </details>
          )}
        </CoachPanel>
      </CoachPortal>

      <ConfirmDialog
        open={confirm === 'reset'}
        title="Вернуть стартовый код?"
        confirmLabel="Вернуть"
        danger
        onConfirm={() => void resetCode()}
        onClose={() => setConfirm(null)}
      >
        <p>Твой текущий код в этом задании будет заменён исходным. Попытки и статус задания сохранятся.</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === 'solution'}
        title="Показать решение?"
        confirmLabel="Показать"
        onConfirm={() => void showSolution()}
        onClose={() => setConfirm(null)}
      >
        <p>
          {hintsShown < 3
            ? `Открыто подсказок: ${hintsShown} из 3. Часто следующей подсказки достаточно.`
            : 'Все подсказки уже открыты — посмотреть решение разумно.'}
        </p>
        <p>После просмотра задание можно решить, но оно попадёт в повторение, чтобы закрепить навык самостоятельно.</p>
      </ConfirmDialog>
    </>
  );
}

function CheckView({ exercise, outcome, results }: { exercise: Exercise; outcome: CheckOutcome | null; results: ReturnType<typeof resultsFromOutcome> }) {
  if (!outcome) {
    return <p className="small muted">Здесь появятся результаты проверки: ввод, ожидаемый и полученный результат.</p>;
  }
  if (outcome.status === 'failed') {
    return (
      <div className="status-line status-warn">
        <CircleAlert aria-hidden="true" />
        <span>Проверка не выполнена: {outcome.message} Это не ошибка в твоём коде.</span>
      </div>
    );
  }
  if (outcome.status === 'done' && outcome.result.compileError) {
    const error = outcome.result.compileError;
    return (
      <div className="status-line status-error">
        <CircleAlert aria-hidden="true" />
        <span>
          Код не запустился: {error.type}
          {error.line ? ` в строке ${error.line}` : ''}. Разбор — у наставника.
        </span>
      </div>
    );
  }
  const ok = checkPassed(outcome);
  const failedRules = outcome.status === 'done' ? outcome.result.rules.filter((rule) => !rule.passed) : [];
  const passedCount = results.filter((result) => result.passed).length;
  return (
    <>
      <div className="results-summary">
        {ok ? (
          <div className="status-line status-good">
            <CircleCheck aria-hidden="true" />
            <span>Все проверки пройдены: {results.length} из {results.length}</span>
          </div>
        ) : outcome.status === 'timeout' ? (
          <div className="status-line status-error">
            <CircleAlert aria-hidden="true" />
            <span>Программа работала дольше {Math.round(outcome.limitMs / 1000)} с и была остановлена — похоже на бесконечный цикл.</span>
          </div>
        ) : outcome.status === 'stopped' ? (
          <div className="status-line status-muted">
            <Square aria-hidden="true" />
            <span>Проверка остановлена.</span>
          </div>
        ) : onlyRulesFailed(outcome) ? (
          <div className="status-line status-error">
            <CircleAlert aria-hidden="true" />
            <span>
              Тесты пройдены: {passedCount} из {results.length}, но не выполнено требование к коду
            </span>
          </div>
        ) : (
          <div className="status-line status-error">
            <CircleAlert aria-hidden="true" />
            <span>
              Пройдено {passedCount} из {results.length}
              {failedRules.length > 0 ? ' · не выполнено требование к коду' : ''}
            </span>
          </div>
        )}
      </div>
      {failedRules.map((rule) => (
        <div key={rule.id} className="status-line status-error">
          <CircleAlert aria-hidden="true" />
          <span>{rule.message}</span>
        </div>
      ))}
      <TestList key={outcome.status === 'done' ? JSON.stringify(results.map((r) => r.passed)) : outcome.status} exercise={exercise} results={results} />
    </>
  );
}

function OutputView({ last }: { last: Last | null }) {
  if (!last) {
    return <p className="small muted">«Запустить» выполняет программу с вводом ниже и показывает, что она выводит, — без оценки.</p>;
  }
  if (last.kind === 'check') {
    if (last.outcome.status !== 'done') return <p className="small muted">Вывода нет: проверка была прервана.</p>;
    const tests = last.outcome.result.tests;
    const shown = tests.find((test) => !test.passed) ?? tests[0];
    if (!shown) return <p className="small muted">Вывода нет.</p>;
    return (
      <div className="stack-sm">
        <span className="tiny muted">Вывод в {tests.indexOf(shown) + 1}-й проверке{shown.stdin ? ` (ввод: ${shown.stdin.trim().split('\n').join(', ')})` : ''}</span>
        <Transcript parts={shown.transcript} />
      </div>
    );
  }
  const outcome = last.outcome;
  if (outcome.status === 'timeout') {
    return (
      <div className="status-line status-error">
        <CircleAlert aria-hidden="true" />
        <span>Программа работала дольше {Math.round(outcome.limitMs / 1000)} с и была остановлена. Python перезапущен.</span>
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
  if (result.compileError) {
    return (
      <div className="status-line status-error">
        <CircleAlert aria-hidden="true" />
        <span>
          {result.compileError.line ? `Строка ${result.compileError.line}: ` : ''}
          <span className="mono">{result.compileError.summary}</span> — программа не запустилась.
        </span>
      </div>
    );
  }
  return (
    <div className="stack-sm">
      <span className="tiny muted">
        {last.stdin ? `Ввод: ${last.stdin.trim().split('\n').join(', ')}` : 'Запуск без ввода'} · {result.durationMs} мс
      </span>
      <Transcript parts={result.transcript ?? []} />
      {result.error && (
        <div className="status-line status-error">
          <CircleAlert aria-hidden="true" />
          <span>
            {result.error.line ? `Строка ${result.error.line}: ` : ''}
            <span className="mono">{result.error.summary}</span>
          </span>
        </div>
      )}
      {result.limit && (
        <div className="status-line status-error">
          <CircleAlert aria-hidden="true" />
          <span>Слишком много вывода — программа остановлена.</span>
        </div>
      )}
    </div>
  );
}
