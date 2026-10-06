// Шаг-задание: условие → код → запуск и проверка настоящим Python → короткий разбор →
// подсказки → исправление. Черновик и попытки сохраняются автоматически.
// Панели: «Задание» (условие), «Код» (полоса main.py с «Запустить / Проверить», редактор, «Ввод для „Запустить“»,
// нижняя панель «Проверка / Вывод»), «Наставник» (портал в колонку кадра). На телефоне кнопки — в доке внизу.

import {
  ChevronRight,
  CircleAlert,
  CircleX,
  Ellipsis,
  Eye,
  FileCode2,
  Keyboard,
  Lightbulb,
  ListChecks,
  Lock,
  Play,
  RotateCcw,
  Square,
  WifiOff,
  LoaderCircle,
  Circle,
} from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useOnline, useRunnerState, useSettings } from '../../app/hooks.ts';
import { reportSaveProblem } from '../../app/problems.ts';
import { useShellStatus } from '../../app/shell-status.ts';
import { buildCheckFeedback, buildRunFeedback, testLabel } from '../../coach/feedback.ts';
import type { Feedback } from '../../coach/types.ts';
import { CodeBlock } from '../../components/CodeBlock.tsx';
import { InlineText, Markdown } from '../../components/Markdown.tsx';
import { ConfirmDialog, Disclosure, Kbd, Notice, Spinner, StatusBadge, Tabs, Tag, plural, type TabItem } from '../../components/ui.tsx';
import type { Exercise, ExerciseKind, Lesson } from '../../content/schema.ts';
import { CodeEditor } from '../../editor/CodeEditor.tsx';
import { exerciseEnvironment } from '../../runner/environment.ts';
import { pythonRunner } from '../../runner/runner.ts';
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
import { checkAnnouncement, failedChecks, testCounts } from './check-summary.ts';
import { CoachEmpty, CoachPanel, CoachPortal, CollapseButton, FeedbackCard, HintCard, SuccessCard, useLessonFrame } from './coach.tsx';
import { EnvironmentInfo } from './environment.tsx';
import { ExerciseBrief, ExerciseExamples } from './ExerciseBrief.tsx';
import type { Pane, PaneAttributes } from './LessonScreen.tsx';
import { OrderDemo } from './LessonPlayground.tsx';
import { CheckView, OutputView, RunState, attemptErrorType, checkPassed, resultsFromOutcome, type LastRun } from './results.tsx';
import { reviewReasonAfter } from './review.ts';
import { illustrationUrl } from './StoryIllustration.tsx';

export const KIND_LABEL: Record<ExerciseKind, string> = {
  repeat: 'Повтори приём',
  modify: 'Измени условие',
  write: 'Реши сам',
  fix: 'Найди ошибку',
  read: 'Прочитай код',
};

type ResultsTab = 'tests' | 'output';

/** Высота панели «Проверка / Вывод» запоминается в браузере (без хранилища — по умолчанию). */
const RESULTS_KEY = 'praktika-results-h';
const RESULTS_MIN = 160;

function readResultsHeight(): number | null {
  try {
    const value = Number(window.localStorage.getItem(RESULTS_KEY));
    return Number.isFinite(value) && value >= RESULTS_MIN ? value : null;
  } catch {
    return null;
  }
}

function writeResultsHeight(value: number) {
  try {
    window.localStorage.setItem(RESULTS_KEY, String(Math.round(value)));
  } catch {
    // Хранилище недоступно: высота просто не запомнится.
  }
}

export function ExerciseStep({
  lesson,
  exercise,
  pane,
  onPassed,
  onShowCoach,
}: {
  lesson: Lesson;
  exercise: Exercise;
  /** Атрибуты частей шага (во вкладочной раскладке — панели вкладок «Задание / Код / Наставник»). */
  pane: (value: Pane) => PaneAttributes;
  onPassed: () => void;
  onShowCoach: () => void;
}) {
  const settings = useSettings();
  const runner = useRunnerState();
  const online = useOnline();
  const frame = useLessonFrame();
  const narrow = frame.layout === 'narrow';
  const [record, setRecord] = useState<ExerciseRecord | null>(null);
  const [code, setCode] = useState(exercise.starterCode);
  const [last, setLast] = useState<LastRun | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [tab, setTab] = useState<ResultsTab>('tests');
  const [action, setAction] = useState<'run' | 'check' | null>(null);
  const [testIndex, setTestIndex] = useState(0);
  const [confirm, setConfirm] = useState<'reset' | 'solution' | null>(null);
  const [announce, setAnnounce] = useState('');
  const [save, setSave] = useState<'saving' | 'saved' | 'failed' | null>(null);
  const [cursorLine, setCursorLine] = useState(1);
  const [reveal, setReveal] = useState<{ line: number; tick: number } | null>(null);
  const [resultsHeight, setResultsHeight] = useState<number | null>(readResultsHeight);
  const firstExample = exercise.tests.find((test) => test.example) ?? exercise.tests[0];
  const [stdin, setStdin] = useState(firstExample.stdin ?? '');
  const usesInput = exercise.tests.some((test) => Boolean(test.stdin));
  const saveTimer = useRef<number | undefined>(undefined);
  const pendingDraft = useRef<string | null>(null);
  const codePane = useRef<HTMLElement>(null);
  const ids = useId();
  // Повторение: задание решается заново; подсказки считаются отдельно для этого подхода.
  const [review, setReview] = useState<ReviewRecord | null>(null);
  const [reviewMode, setReviewMode] = useState(false);
  const [reviewHints, setReviewHints] = useState(0);
  const [reviewSolution, setReviewSolution] = useState(false);
  const [reviewDone, setReviewDone] = useState<string | null>(null);
  const previousCode = useRef<string | null>(null);
  // Кнопка, которую нажали, исчезла («Подсказка 3 из 3», «Показать решение») — фокус к тому, что появилось.
  const [helpFocus, setHelpFocus] = useState<{ id: string; tick: number } | null>(null);
  // Код, с которым задание решено: пока он не менялся, «Проверить» — не главная кнопка (главная — «Далее»).
  const [settledCode, setSettledCode] = useState<string | null>(null);
  // После проверки с непройденными тестами «Проверка» прокручивается к раскрытому тесту.
  const [failTick, setFailTick] = useState(0);

  // Загрузка сохранённого черновика и статуса.
  useEffect(() => {
    let alive = true;
    setLast(null);
    setFeedback(null);
    setTab('tests');
    setSave(null);
    setSettledCode(null);
    getExercise(exercise.id).then((stored) => {
      if (!alive) return;
      setRecord(stored ?? null);
      setCode(stored?.draft ?? exercise.starterCode);
      if (stored?.draft) setSave('saved');
      if (stored?.status === 'passed') setSettledCode(stored.draft ?? exercise.starterCode);
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
    setSave('saving');
    return saveDraft(exercise.id, lesson.id, value).then(
      () => setSave('saved'),
      (error: unknown) => {
        setSave('failed');
        reportSaveProblem(error, 'Черновик не сохранён');
      },
    );
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

  // Непройденный тест раскрыт — «получилось» должно быть видно без поиска. Прокручивается только панель
  // «Проверка» (на телефоне она не прокручивается сама — там ничего не происходит), фокус не трогается.
  useEffect(() => {
    if (failTick === 0) return;
    const frame = requestAnimationFrame(() => {
      const body = codePane.current?.querySelector<HTMLElement>('.results-body');
      const item = body?.querySelector<HTMLElement>('.test-item[data-state="fail"]:has(.test-detail)');
      if (!body || !item || body.scrollHeight <= body.clientHeight) return;
      const box = body.getBoundingClientRect();
      const rect = item.getBoundingClientRect();
      const gap = 12;
      if (rect.bottom + gap <= box.bottom && rect.top >= box.top) return;
      // Тест целиком, если помещается; иначе — от его строки вниз.
      const shift = rect.height + gap * 2 <= box.height ? rect.bottom + gap - box.bottom : rect.top - gap - box.top;
      body.scrollTop += shift;
    });
    return () => cancelAnimationFrame(frame);
  }, [failTick]);

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
  const selfStudy = Boolean(exercise.noHintsBeforeAttempt);
  const hintsLocked = selfStudy && (record?.checks ?? 0) === 0;

  async function check() {
    if (busy) return;
    setAction('check');
    setTab('tests');
    setTestIndex(0);
    setAnnounce('Проверяю…');
    // Проверка занимает Python сразу, в обработчике нажатия: повторное нажатие уже не начнёт вторую,
    // а «Остановить» с первого мгновения есть что останавливать. Черновик сохраняется, пока идёт проверка.
    // Окружение задания (файл кода, учебные файлы, базы, seed, ответы сети); тесты дополняют его своими полями.
    const running = pythonRunner.check(
      { code, tests: exercise.tests, rules: exercise.rules, ...exerciseEnvironment(exercise) },
      { perTestMs: exercise.timeLimitMs, onTestStart: setTestIndex },
    );
    await flushDraft();
    const outcome = await running;
    setAction(null);
    setLast({ kind: 'check', outcome, code });
    const ok = checkPassed(outcome);
    const nextFeedback = ok ? null : buildCheckFeedback(exercise, code, outcome);
    setFeedback(nextFeedback);
    if (nextFeedback) frame.notifyFeedback();
    const tests = resultsFromOutcome(exercise, outcome);
    // Объявление — по типу результата: «код не запустился», «не выполнено требование», «не пройдено X из Y».
    setAnnounce(checkAnnouncement(outcome, tests));
    if (ok) setSettledCode(code);
    if (tests.some((test) => !test.passed && test.interrupted !== 'skipped')) setFailTick((value) => value + 1);
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
    const running = pythonRunner.run(code, stdin, {
      timeLimitMs: exercise.timeLimitMs ?? undefined,
      environment: exerciseEnvironment(exercise),
    });
    await flushDraft();
    const outcome = await running;
    setAction(null);
    setLast({ kind: 'run', outcome, stdin });
    const runFeedback = buildRunFeedback(code, outcome);
    if (runFeedback) {
      setFeedback(runFeedback);
      frame.notifyFeedback();
    }
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

  function showLine(line: number) {
    frame.showPane('code');
    setReveal((value) => ({ line, tick: (value?.tick ?? 0) + 1 }));
  }

  const checkOutcome = last?.kind === 'check' ? last.outcome : null;
  const testResults = checkOutcome ? resultsFromOutcome(exercise, checkOutcome) : [];
  const counts = testCounts(checkOutcome, testResults, exercise.tests.length);
  const errorLine = feedback?.line ?? null;
  const loading = runner.phase === 'loading' || runner.phase === 'restarting';
  const resultsPrefix = `${ids}-results`;

  function openResults() {
    setTab('tests');
    frame.showPane('code', '.results-body');
  }

  useShellStatus({
    tests: counts ? { failed: counts.failed, passed: counts.passed, open: openResults } : null,
    cursor: { file: exercise.filename, line: cursorLine },
    save,
    minutes: lesson.minutes,
  });

  const resultTabs: TabItem<ResultsTab>[] = [
    {
      value: 'tests',
      label: 'Проверка',
      badge: counts ? (
        counts.failed > 0 ? (
          <StatusBadge tone="err">
            <span className="n">{counts.failed}</span>
            <span className="visually-hidden"> не прошли</span>
          </StatusBadge>
        ) : (
          <StatusBadge tone="ok">
            <span className="n">
              {counts.passed}/{counts.total}
            </span>
            <span className="visually-hidden"> пройдено</span>
          </StatusBadge>
        )
      ) : undefined,
    },
    { value: 'output', label: 'Вывод' },
  ];

  // Одна главная кнопка на зону: задание решено и код не менялся — главное «Далее»; ждёт повторение — «Решить заново».
  const quietCheck = (passed && settledCode !== null && code === settledCode) || (review !== null && !reviewMode);

  const actions = (
    <div className="wb-actions">
      {/* Во время запуска или проверки «Запустить» заменяется на «Остановить». */}
      {busy ? (
        <button type="button" className="btn btn-danger btn-sm wb-stop" onClick={() => pythonRunner.stop()}>
          <Square aria-hidden="true" />
          Остановить
        </button>
      ) : (
        <button type="button" className="btn btn-sm wb-run" onClick={() => void run()}>
          <Play aria-hidden="true" />
          Запустить
        </button>
      )}
      <button
        type="button"
        className={`btn${quietCheck ? '' : ' btn-primary'} btn-sm wb-check`}
        onClick={() => void check()}
        disabled={busy}
        aria-keyshortcuts="Control+Enter"
      >
        {action === 'check' ? <Spinner /> : <ListChecks aria-hidden="true" />}
        Проверить
        <Kbd>Ctrl ↵</Kbd>
      </button>
    </div>
  );

  const moreMenu = <MoreMenu file={exercise.filename} disabled={busy || code === exercise.starterCode} onReset={() => setConfirm('reset')} />;

  const stdinLines = stdin.trim() ? stdin.replace(/\n$/, '').split('\n').length : 0;
  const coachHidden = !frame.coachVisible;
  // Редактор по высоте кода (не меньше minLines строк, не больше 60 % панели), остальное — «Проверке».
  // Высота «Проверки», выставленная рукой, главнее.
  const minLines = Math.max(6, exercise.starterCode.split('\n').length + 2);
  const editorLines = Math.max(minLines, code.split('\n').length + 1);
  const codeStyle = {
    '--editor-lines': String(editorLines),
    ...(resultsHeight ? { '--results-h': `${resultsHeight}px` } : {}),
  } as CSSProperties;

  // Ожидание Python и сбой — в той вкладке, что открыта: под строкой прогона или под итогом, а не над ними.
  const waitState = loading ? (
    <RunState>{runner.phase === 'loading' ? 'Загружаю Python…' : 'Перезапускаю Python…'}</RunState>
  ) : runner.phase === 'failed' && !busy ? (
    <p className="status-line status-err is-long">
      <CircleAlert aria-hidden="true" />
      <span>{runner.error}</span>
    </p>
  ) : null;
  const checkState =
    action === 'check' && !loading ? (
      <RunState>
        Проверяю: {testLabel(exercise.tests[Math.min(testIndex, exercise.tests.length - 1)], testIndex)} (
        <span className="n">{testIndex + 1}</span> из <span className="n">{exercise.tests.length}</span>)
      </RunState>
    ) : (
      waitState
    );
  const runState = action === 'run' && !loading ? <RunState>Программа выполняется…</RunState> : waitState;

  return (
    <>
      <section className="pane pane-task step-card exercise-card" aria-labelledby={`${exercise.id}-title`} {...pane('task')}>
        <div className="pane-head task-head">
          <span className="plabel">Задание</span>
          <span className="pane-actions">
            <CollapseButton pane="task" />
          </span>
        </div>
        <div className="pane-body task-body">
          <div className="task-meta">
            <Tag>{KIND_LABEL[exercise.kind]}</Tag>
            {selfStudy && <Tag icon={Lock}>Самостоятельно</Tag>}
            {reviewMode ? (
              <StatusBadge tone="accent">Повторение</StatusBadge>
            ) : passed ? (
              <StatusBadge tone="ok">Решено</StatusBadge>
            ) : (record?.checks ?? 0) > 0 ? (
              <StatusBadge tone="warn">
                <span className="n">{record!.checks}</span> {plural(record!.checks, ['попытка', 'попытки', 'попыток'])}
              </StatusBadge>
            ) : (
              <StatusBadge tone="muted">Новое</StatusBadge>
            )}
          </div>
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
              {review.reason}.
            </Notice>
          )}
          {reviewMode && (
            <Notice
              tone="accent"
              title="Повторение"
              action={
                <button type="button" className="btn btn-sm" onClick={leaveReview}>
                  Вернуть прежний код
                </button>
              }
            />
          )}
          {reviewDone && <Notice tone="ok">{reviewDone}</Notice>}
          <h2 id={`${exercise.id}-title`} className="step-title task-title">
            {exercise.title}
          </h2>
          <Markdown text={exercise.statement} className="task-statement" />
          {exercise.id === 'm1-l1-e1' && (
            <details className="order-explorer">
              <summary>
                <ChevronRight aria-hidden="true" className="disclosure-chevron" />
                <img src={illustrationUrl('cafe')} alt="" width="96" height="54" />
                <span className="oe-title">Наглядный заказ</span>
              </summary>
              <div className="oe-body">
                <OrderDemo />
              </div>
            </details>
          )}
          <ExerciseBrief exercise={exercise} />
          <ExerciseExamples exercise={exercise} />
          <Disclosure
            className="task-how"
            summary={
              <>
                Как проверяется решение · <span className="n">{exercise.tests.length}</span>{' '}
                {plural(exercise.tests.length, ['тест', 'теста', 'тестов'])}
              </>
            }
          >
            <ul className="bullets task-criteria">
              {exercise.criteria.map((item) => (
                <li key={item}>
                  <InlineText text={item} />
                </li>
              ))}
            </ul>
          </Disclosure>
          <EnvironmentInfo source={exercise} />
        </div>
      </section>

      <section
        className="pane pane-code workbench"
        aria-label="Код и проверка"
        ref={codePane}
        style={codeStyle}
        data-results={resultsHeight ? 'manual' : 'auto'}
        {...pane('code')}
      >
        {!narrow && (
          <div className="editor-bar">
            <span className="etab" title={exercise.filename}>
              <FileCode2 aria-hidden="true" />
              <span className="etab-name">{exercise.filename}</span>
            </span>
            {moreMenu}
            {actions}
          </div>
        )}
        <div className="editor-wrap">
          <CodeEditor
            value={code}
            onChange={onCodeChange}
            onSubmit={() => void check()}
            ariaLabel={`Код задания «${exercise.title}». Ctrl+Enter — проверить. Esc, затем Tab — выйти из редактора.`}
            errorLine={errorLine}
            errorKey={feedback}
            minLines={minLines}
            onCursor={setCursorLine}
            revealLine={reveal}
          />
        </div>
        {feedback && coachHidden && (
          <div className="error-strip">
            <CircleX aria-hidden="true" />
            <button
              type="button"
              className="error-strip-btn"
              onClick={() => frame.showPane('coach', '.coach .feedback')}
            >
              <span>Разбор у наставника: {feedback.title}</span>
              <ChevronRight aria-hidden="true" />
            </button>
          </div>
        )}
        {(usesInput || code.includes('input(')) && (
          <details className="stdin">
            <summary>
              <span className="stdin-gut" aria-hidden="true">
                <ChevronRight className="stdin-chev" />
                <Keyboard />
              </span>
              <span className="stdin-label">Ввод для «Запустить»</span>
              <span className="stdin-meta">
                {stdinLines === 0 ? (
                  'пусто'
                ) : (
                  <>
                    <span className="n">{stdinLines}</span> {plural(stdinLines, ['строка', 'строки', 'строк'])}
                  </>
                )}
              </span>
            </summary>
            <div className="stdin-body">
              <textarea
                className="textarea mono"
                rows={3}
                value={stdin}
                spellCheck={false}
                onChange={(event) => setStdin(event.target.value)}
                aria-label="Ввод для «Запустить»"
                aria-describedby={`${ids}-stdin-note`}
              />
              <span id={`${ids}-stdin-note`} className="visually-hidden">
                Каждая строка — ответ на один input(). «Проверить» берёт ввод из тестов.
              </span>
            </div>
          </details>
        )}
        {!narrow && (
          <ResultsSplitter
            pane={codePane}
            height={resultsHeight}
            onResize={(value) => {
              setResultsHeight(value);
              writeResultsHeight(value);
            }}
          />
        )}
        <section className="results" aria-label="Проверка и вывод">
          <Tabs label="Результаты" items={resultTabs} value={tab} onChange={setTab} idPrefix={resultsPrefix} className="results-tabs" />
          <div
            className="results-body"
            role="tabpanel"
            id={`${resultsPrefix}-panel-${tab}`}
            aria-labelledby={`${resultsPrefix}-tab-${tab}`}
            tabIndex={-1}
          >
            {tab === 'tests' && (
              <CheckView exercise={exercise} outcome={checkOutcome} results={testResults} state={checkState} checking={action === 'check'} />
            )}
            {tab === 'output' && <OutputView last={last} file={exercise.filename} state={runState} running={action === 'run'} />}
          </div>
        </section>
        <div className="visually-hidden" role="status" aria-live="polite">
          {announce}
        </div>
      </section>

      {narrow && frame.dock && createPortal(
        <>
          <DockStatus online={online} />
          {actions}
        </>,
        frame.dock,
      )}
      {narrow && frame.menu && createPortal(moreMenu, frame.menu)}

      <CoachPortal>
        <CoachPanel
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
          note={
            hintsLocked && !passed ? (
              <>
                <Lock aria-hidden="true" />
                Подсказки — после первой проверки
              </>
            ) : undefined
          }
          actions={
            passed ? (
              !solutionViewed && (
                <button type="button" className="btn btn-sm coach-compare" onClick={() => void showSolution()}>
                  <Eye aria-hidden="true" />
                  Сравнить с решением наставника
                </button>
              )
            ) : (
              <>
                {/* До первой проверки самостоятельной работы кнопки выключены — и значок замка, а не только цвет. */}
                {hintsShown < 3 && (
                  <button type="button" className="btn btn-sm coach-hint" onClick={() => void showHint()} disabled={hintsLocked}>
                    {hintsLocked ? <Lock aria-hidden="true" /> : <Lightbulb aria-hidden="true" />}
                    Подсказка {hintsShown + 1} из 3
                  </button>
                )}
                {!solutionViewed && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm coach-solution"
                    onClick={() => setConfirm('solution')}
                    disabled={hintsLocked}
                    aria-label="Показать решение"
                  >
                    {hintsLocked ? <Lock aria-hidden="true" /> : <Eye aria-hidden="true" />}
                    <span className="lbl-long">Показать решение</span>
                    <span className="lbl-short" aria-hidden="true">
                      Решение
                    </span>
                  </button>
                )}
              </>
            )
          }
        >
          {!feedback && !passed && hintsShown === 0 && !solutionViewed && <CoachEmpty>Разбора пока нет</CoachEmpty>}
          {passed && checkPassed(checkOutcome) && (
            <SuccessCard title="Все проверки пройдены">
              {exercise.afterPass ? <Markdown text={exercise.afterPass} className="prose-compact" /> : null}
            </SuccessCard>
          )}
          {passed && !checkPassed(checkOutcome) && !feedback && <SuccessCard title="Задание уже решено" />}
          {feedback && <FeedbackCard feedback={feedback} file={exercise.filename} onShowLine={showLine} />}
          {hintsShown > 0 && (
            <section className="hints" aria-labelledby={`${ids}-hints`}>
              <div className="hints-head">
                <h3 id={`${ids}-hints`}>Подсказки</h3>
                <span className="hints-count">
                  открыта <span className="n">{hintsShown}</span> из <span className="n">3</span>
                </span>
              </div>
              {/* Открыта последняя подсказка; прежние свёрнуты, чтобы панель не разрасталась. */}
              {Array.from({ length: hintsShown }, (_, index) =>
                index === hintsShown - 1 ? (
                  <HintCard key={index} id={`${exercise.id}-hint-${index + 1}`} label={`Подсказка ${index + 1} из 3`}>
                    <Markdown text={exercise.hints[index]} className="prose-compact" />
                  </HintCard>
                ) : (
                  <Disclosure key={index} className="hint-old" summary={`Подсказка ${index + 1}`}>
                    <Markdown text={exercise.hints[index]} className="prose-compact" />
                  </Disclosure>
                ),
              )}
            </section>
          )}
          {solutionViewed && (
            <details className="disclosure solution" open>
              <summary id={`${exercise.id}-solution`}>
                <ChevronRight aria-hidden="true" className="disclosure-chevron" />
                <span className="disclosure-summary">Решение</span>
              </summary>
              <div className="disclosure-body solution-body">
                <CodeBlock code={exercise.solution.code} file="решение" label={`Решение наставника, ${exercise.filename}`} wrap />
                <Markdown text={exercise.solution.explanation} className="prose-compact" />
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
        <p>Твой код заменится исходным. Попытки и статус сохранятся.</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === 'solution'}
        title="Показать решение?"
        confirmLabel="Показать"
        onConfirm={() => void showSolution()}
        onClose={() => setConfirm(null)}
      >
        <p>Открыто подсказок: {hintsShown} из 3.</p>
        <p>Задание попадёт в повторение.</p>
      </ConfirmDialog>
    </>
  );
}

/** Меню «⋯» файла: «Начать заново» стирает код, поэтому не стоит рядом с «Запустить / Проверить». */
function MoreMenu({ file, disabled, onReset }: { file: string; disabled: boolean; onReset: () => void }) {
  const ref = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const details = ref.current;
    if (!details) return;
    const close = (event: Event) => {
      if (!details.open) return;
      if (event instanceof globalThis.KeyboardEvent) {
        if (event.key !== 'Escape') return;
        details.open = false;
        details.querySelector('summary')?.focus();
        return;
      }
      if (!details.contains(event.target as Node)) details.open = false;
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, []);

  return (
    <details className="more" ref={ref}>
      <summary className="btn btn-ghost btn-sm btn-icon" aria-label={`Ещё: действия с файлом ${file}`} title="Ещё">
        <Ellipsis aria-hidden="true" />
      </summary>
      <div className="more-pop">
        <button
          type="button"
          className="more-item"
          disabled={disabled}
          onClick={() => {
            if (ref.current) ref.current.open = false;
            onReset();
          }}
        >
          <RotateCcw aria-hidden="true" />
          Начать заново
        </button>
      </div>
    </details>
  );
}

/** Граница панели «Проверка / Вывод»: тянуть мышью или стрелками вверх и вниз по 16 px. */
function ResultsSplitter({
  pane,
  height,
  onResize,
}: {
  pane: RefObject<HTMLElement | null>;
  height: number | null;
  onResize: (height: number) => void;
}) {
  const drag = useRef<{ y: number; height: number } | null>(null);
  const [active, setActive] = useState(false);

  function limits() {
    const total = pane.current?.clientHeight ?? 600;
    return { min: RESULTS_MIN, max: Math.max(RESULTS_MIN, Math.round(total * 0.7)) };
  }

  function current(): number {
    const results = pane.current?.querySelector<HTMLElement>('.results');
    return height ?? results?.offsetHeight ?? 280;
  }

  function apply(value: number) {
    const { min, max } = limits();
    onResize(Math.min(max, Math.max(min, Math.round(value))));
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // Стрелка вверх поднимает границу — панель результатов становится выше.
    const step = event.key === 'ArrowUp' ? 16 : event.key === 'ArrowDown' ? -16 : 0;
    if (step) {
      event.preventDefault();
      apply(current() + step);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const { min, max } = limits();
      apply(event.key === 'Home' ? max : min);
    }
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { y: event.clientY, height: current() };
    setActive(true);
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    apply(drag.current.height - (event.clientY - drag.current.y));
  }

  function onPointerUp() {
    drag.current = null;
    setActive(false);
  }

  const { min, max } = limits();
  return (
    <div
      className={`hsplit${active ? ' is-drag' : ''}`}
      role="separator"
      tabIndex={0}
      aria-orientation="horizontal"
      aria-label="Высота панели «Проверка»"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(current())}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    />
  );
}

/**
 * Строка состояния дока на телефоне: Python и сеть — значок + слово. Только когда что-то не так:
 * «Python готов» и «в сети» — норма, их видно по рабочим кнопкам, а высота экрана на телефоне дорога.
 */
function DockStatus({ online }: { online: boolean }) {
  const runner = useRunnerState();
  const ready = runner.phase === 'ready' || runner.phase === 'busy';
  if (ready && online) return null;
  const python = ready
    ? null
    : runner.phase === 'loading' || runner.phase === 'restarting'
      ? { icon: LoaderCircle, text: runner.phase === 'loading' ? 'Python загружается…' : 'Python перезапускается…', tone: 'busy' }
      : runner.phase === 'failed'
        ? { icon: CircleAlert, text: 'Python не запустился', tone: 'err' }
        : { icon: Circle, text: 'Python запустится с уроком', tone: '' };
  const PythonIcon = python?.icon;
  return (
    <p className="dock-status">
      {python && PythonIcon && (
        <span className={`dock-item${python.tone ? ` tone-${python.tone}` : ''}`}>
          <PythonIcon aria-hidden="true" className={python.tone === 'busy' ? 'spin' : undefined} />
          {python.text}
        </span>
      )}
      {!online && (
        <span className="dock-item tone-warn" title="Работают скачанные уроки">
          <WifiOff aria-hidden="true" />
          Без сети
        </span>
      )}
    </p>
  );
}
