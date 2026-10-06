// Экран урока: история → теория → пример → прогноз → практика → закрепление.
// Кадр урока «Мастерской»: шапка с конвейером шагов «Понять — Сделать — Закрепить» и рабочее место из панелей.
// ПК (≥ 1200) — «Задание | Код + Проверка | Наставник» с разделителями и сворачиванием; 900–1199 — вкладки
// «Задание | Наставник» слева и код справа; телефон и планшет в портрете (< 900) — вкладки «Задание / Код /
// Наставник» и док «Запустить / Проверить» внизу. Место в уроке сохраняется; по шагам можно ходить свободно.

import { ArrowLeft, ArrowRight, Check, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { useDataVersion, useMediaQuery } from '../../app/hooks.ts';
import { href, navigate, paths } from '../../app/router.ts';
import { useShellStatus, useShellStatusValue } from '../../app/shell-status.ts';
import { FLOW_GROUP_LABEL, FlowSteps, MiniBar, StepPicker, flowGroups, type FlowGroup, type FlowStep } from '../../components/FlowSteps.tsx';
import { EmptyState, Spinner, StatusBadge, Tabs, type TabItem } from '../../components/ui.tsx';
import { findLessonSummary, loadLesson, nextLessonId, useLoadable } from '../../content/loader.ts';
import type { Course, Lesson, ModuleSummary, Step } from '../../content/schema.ts';
import { pythonRunner } from '../../runner/runner.ts';
import {
  completeReview,
  getAllReviews,
  getExercisesByLesson,
  getLesson,
  saveLesson,
  scheduleReview,
  updateMeta,
} from '../../storage/repo.ts';
import type { ExerciseRecord, LessonRecord, ReviewRecord } from '../../storage/types.ts';
import { CoachSlotContext, LessonFrameContext, type LessonFrame, type LessonLayout, type LessonPane, type SidePane } from './coach.tsx';
import { ExerciseStep } from './ExerciseStep.tsx';
import { lessonReviewKey, recapUnchanged, reviewReasonAfter } from './review.ts';
import { ChecklistStep, ExampleStep, IntroStep, OrderStep, PredictStep, QuizStep, RecapStep, TheoryStep } from './steps.tsx';

type ViewStep = { type: 'intro'; id: 'intro'; title: string } | Step;
export type Pane = LessonPane;

/** Атрибуты части шага. Во вкладочной раскладке (планшет, телефон) части — панели вкладок. */
export interface PaneAttributes {
  'data-pane': Pane;
  'data-pane-active': boolean;
  id?: string;
  role?: 'tabpanel';
  'aria-labelledby'?: string;
}

const STEP_LABEL: Record<ViewStep['type'], string> = {
  intro: 'История',
  theory: 'Идея',
  example: 'Пример',
  predict: 'Прогноз',
  order: 'Порядок',
  exercise: 'Практика',
  checklist: 'Шаги',
  quiz: 'Вопрос',
  recap: 'Итог',
};

function stepLabel(step: ViewStep, index: number, steps: ViewStep[]): string {
  if (step.type === 'exercise') {
    const number = steps.slice(0, index + 1).filter((item) => item.type === 'exercise').length;
    return `${STEP_LABEL.exercise} ${number}`;
  }
  return STEP_LABEL[step.type];
}

/** Название шага по содержанию: у задания — название задачи, у истории — название истории. */
function stepTitle(step: ViewStep, lesson: Lesson): string {
  if (step.type === 'exercise') return step.exercise.title;
  if (step.type === 'intro') return lesson.story.title;
  return step.title;
}

/** Шаги с кодом раскладываются панелями «Задание | Код | Наставник»; остальные читаются как документ. */
const WORK_STEPS = new Set<ViewStep['type']>(['exercise', 'example']);

/** Ширины боковых панелей и высота «Проверки» запоминаются в браузере (не обязательно: без хранилища — по умолчанию). */
const WIDTH_KEY: Record<SidePane, string> = { task: 'praktika-pane-task', coach: 'praktika-pane-mentor' };
const SIDE_MIN = 280;
const SIDE_MAX = 560;

function readNumber(key: string): number | null {
  try {
    const value = Number(window.localStorage.getItem(key));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function writeNumber(key: string, value: number) {
  try {
    window.localStorage.setItem(key, String(Math.round(value)));
  } catch {
    // Хранилище недоступно (приватное окно): ширина просто не запомнится.
  }
}

/** Ширина боковой панели по умолчанию — та же формула, что --w-side в tokens.css. */
function defaultSideWidth(): number {
  return Math.round(Math.min(460, Math.max(320, window.innerWidth * 0.12 + 200)));
}

/** Запись урока, если хранилище недоступно: урок открывается, но прогресс не сохранится. */
function blankRecord(lessonId: string, stepIndex: number): LessonRecord {
  const ts = Date.now();
  return {
    lessonId,
    stepIndex,
    completedSteps: [],
    startedAt: ts,
    completedAt: null,
    predictions: {},
    orders: {},
    quizzes: {},
    checklists: {},
    recap: null,
    updatedAt: ts,
  };
}

function LoadingLesson() {
  return (
    <div className="lesson lesson-status">
      <p className="loading-line" role="status">
        <Spinner />
        Открываю урок…
      </p>
    </div>
  );
}

export function LessonScreen({ course, lessonId, step }: { course: Course; lessonId: string; step: number | null }) {
  const loaded = useLoadable(() => loadLesson(course, lessonId), [course.contentVersion, lessonId]);
  if (loaded.status === 'loading') return <LoadingLesson />;
  if (loaded.status === 'error') {
    const summary = findLessonSummary(course, lessonId);
    const offline = loaded.error.message !== 'not-ready' && loaded.error.message !== 'not-found' && !navigator.onLine;
    const message =
      loaded.error.message === 'not-ready'
        ? 'Урок ещё не написан'
        : loaded.error.message === 'not-found'
          ? 'Такого урока нет'
          : offline
            ? 'Нет сети, модуль не скачан'
            : 'Не удалось загрузить урок';
    return (
      <div className="page page-narrow">
        <EmptyState
          as="h1"
          title={summary ? summary.lesson.title : 'Урок недоступен'}
          icon={CircleAlert}
          action={
            <>
              <a className="btn" href={href(paths.course())}>
                К карте курса
              </a>
              {offline && (
                <a className="btn btn-ghost" href={href(paths.settings('offline'))}>
                  Скачать
                </a>
              )}
            </>
          }
        >
          {message}
        </EmptyState>
      </div>
    );
  }
  return <LessonView key={lessonId} course={course} module={loaded.value.module} lesson={loaded.value.lesson} stepParam={step} />;
}

/** Время урока в строке состояния — на шагах без своего статуса (у задания его публикует само задание). */
function LessonMinutes({ minutes }: { minutes: [number, number] }) {
  useShellStatus({ minutes });
  return null;
}

function LessonView({ course, module, lesson, stepParam }: { course: Course; module: ModuleSummary; lesson: Lesson; stepParam: number | null }) {
  const steps = useMemo<ViewStep[]>(() => [{ type: 'intro', id: 'intro', title: 'История' }, ...lesson.steps], [lesson]);
  const groups = useMemo<FlowGroup[]>(() => flowGroups(steps), [steps]);
  // Пока запись урока и задания не прочитаны, шаги не показываются: иначе они взяли бы
  // начальное состояние из пустой записи (ответ можно дать заново, пустой итог затёр бы сохранённый).
  const [record, setRecord] = useState<LessonRecord | null>(null);
  const [exercises, setExercises] = useState<Map<string, ExerciseRecord> | null>(null);
  const [review, setReview] = useState<ReviewRecord | null>(null);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [dock, setDock] = useState<HTMLElement | null>(null);
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [pane, setPane] = useState<Pane>('task');
  const [fresh, setFresh] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<SidePane, boolean>>({ task: false, coach: false });
  const [widths, setWidths] = useState<Record<SidePane, number | null>>(() => ({
    task: readNumber(WIDTH_KEY.task),
    coach: readNumber(WIDTH_KEY.coach),
  }));
  const [coachEmpty, setCoachEmpty] = useState(true);
  const [announce, setAnnounce] = useState('');
  const [headingFocus, setHeadingFocus] = useState(0);
  const [focusRequest, setFocusRequest] = useState<{ selector: string; tick: number } | null>(null);
  const exerciseVersion = useDataVersion(['exercises']);
  const reviewVersion = useDataVersion(['reviews']);
  const narrow = useMediaQuery('(max-width: 899px)');
  const mid = useMediaQuery('(max-width: 1199px)');
  const layout: LessonLayout = narrow ? 'narrow' : mid ? 'mid' : 'wide';
  const rootRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const shell = useShellStatusValue();

  const index = Math.min(Math.max(stepParam ?? record?.stepIndex ?? 0, 0), steps.length - 1);
  const current = steps[index];
  const work = WORK_STEPS.has(current.type);

  // Вкладки: у задания — на планшете «Задание | Наставник», на телефоне ещё «Код»; у примера — только на планшете
  // (на телефоне пример читается одной колонкой: пояснения, код, результат).
  const tabValues: Pane[] =
    current.type === 'exercise'
      ? layout === 'narrow'
        ? ['task', 'code', 'coach']
        : layout === 'mid'
          ? coachEmpty
            ? []
            : ['task', 'coach']
          : []
      : current.type === 'example' && layout === 'mid' && !coachEmpty
        ? ['task', 'coach']
        : [];
  const hasTabs = tabValues.length > 0;
  const activeTab: Pane = tabValues.includes(pane) ? pane : 'task';

  // Запись об уроке создаётся при первом открытии; урок становится «текущим».
  useEffect(() => {
    let alive = true;
    getLesson(lesson.id)
      .then((stored) => stored ?? saveLesson(lesson.id, { stepIndex: stepParam ?? 0 }))
      .then(
        (value) => alive && setRecord(value),
        () => alive && setRecord(blankRecord(lesson.id, stepParam ?? 0)),
      );
    void updateMeta({ currentLessonId: lesson.id, lastOpenedAt: Date.now() });
    // Python готовится заранее, пока ученик читает историю.
    if (lesson.environment === 'python') void pythonRunner.prepare().catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lesson.id]);

  useEffect(() => {
    let alive = true;
    getExercisesByLesson(lesson.id).then(
      (items) => alive && setExercises(new Map(items.map((item) => [item.exerciseId, item]))),
      () => alive && setExercises((previous) => previous ?? new Map()),
    );
    return () => {
      alive = false;
    };
  }, [lesson.id, exerciseVersion]);

  // Повторение темы урока (ставится по самооценке в итоге).
  useEffect(() => {
    let alive = true;
    getAllReviews().then(
      (items) => alive && setReview(items.find((item) => item.key === lessonReviewKey(lesson.id)) ?? null),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [lesson.id, reviewVersion]);

  // Есть ли у шага содержимое наставника: без него колонка и вкладка «Наставник» не показываются.
  useEffect(() => {
    if (!slot) return;
    const update = () => setCoachEmpty(slot.childElementCount === 0);
    update();
    const observer = new MutationObserver(update);
    observer.observe(slot, { childList: true });
    return () => observer.disconnect();
  }, [slot]);

  const patchRecord = useCallback(
    async (patch: Partial<LessonRecord>) => {
      const saved = await saveLesson(lesson.id, patch);
      setRecord(saved);
      return saved;
    },
    [lesson.id],
  );

  const goTo = useCallback(
    (target: number) => {
      const clamped = Math.min(Math.max(target, 0), steps.length - 1);
      navigate(paths.lesson(lesson.id, clamped), { replace: true });
      setPane('task');
      setFresh(false);
      void patchRecord({ stepIndex: clamped });
      // Фокус — на заголовок нового шага: кнопка «Далее» после прокрутки наверх осталась бы за краем экрана.
      setHeadingFocus((value) => value + 1);
      setAnnounce(`Шаг ${clamped + 1} из ${steps.length}: ${stepLabel(steps[clamped], clamped, steps)}`);
      for (const area of rootRef.current?.querySelectorAll<HTMLElement>('.workspace, .workspace .pane, .lesson-main, .coach-body') ?? []) {
        area.scrollTop = 0;
      }
      document.getElementById('main')?.scrollTo?.({ top: 0 });
      window.scrollTo({ top: 0 });
    },
    [lesson.id, patchRecord, steps],
  );

  useEffect(() => {
    const onGoto = (event: Event) => goTo((event as CustomEvent<number>).detail);
    window.addEventListener('praktika:goto-step', onGoto);
    return () => window.removeEventListener('praktika:goto-step', onGoto);
  }, [goTo]);

  useEffect(() => {
    if (!headingFocus) return;
    const heading = mainRef.current?.querySelector<HTMLElement>('h2');
    if (!heading) return;
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }, [headingFocus]);

  // «Разбор у наставника», «Показать в коде», счётчик в строке состояния: после смены вкладки фокус — к цели.
  useEffect(() => {
    if (!focusRequest) return;
    const target = rootRef.current?.querySelector<HTMLElement>(focusRequest.selector);
    if (!target) return;
    if (target.tabIndex < 0 && !target.matches('button, a, input, textarea, [contenteditable]')) target.tabIndex = -1;
    target.scrollIntoView?.({ block: 'nearest' });
    target.focus({ preventScroll: true });
  }, [focusRequest]);

  const markDone = useCallback(
    (stepId: string) => {
      setRecord((previous) => {
        if (!previous || previous.completedSteps.includes(stepId)) return previous;
        const next = { ...previous, completedSteps: [...previous.completedSteps, stepId] };
        void saveLesson(lesson.id, { completedSteps: next.completedSteps });
        return next;
      });
    },
    [lesson.id],
  );

  const showPane = useCallback(
    (target: Pane, focus?: string) => {
      if (layout === 'wide') {
        if (target !== 'code') setCollapsed((value) => (value[target] ? { ...value, [target]: false } : value));
      } else if (!(layout === 'mid' && target === 'code')) {
        setPane(target);
      }
      if (target === 'coach') setFresh(false);
      if (focus) setFocusRequest((value) => ({ selector: focus, tick: (value?.tick ?? 0) + 1 }));
    },
    [layout],
  );

  const notifyFeedback = useCallback(() => {
    if (layout === 'mid') {
      setPane('coach');
      setFresh(false);
    } else if (layout === 'narrow') {
      setFresh(pane !== 'coach');
    } else {
      setFresh(collapsed.coach);
    }
  }, [layout, pane, collapsed.coach]);

  const toggleCollapsed = useCallback((target: SidePane) => {
    setCollapsed((value) => ({ ...value, [target]: !value[target] }));
    if (target === 'coach') setFresh(false);
  }, []);

  const coachVisible = layout === 'wide' ? !collapsed.coach : hasTabs ? activeTab === 'coach' : layout === 'mid';
  const frame = useMemo<LessonFrame>(
    () => ({ layout, coachVisible, collapsed, toggleCollapsed, showPane, notifyFeedback, fresh, dock, menu }),
    [layout, coachVisible, collapsed, toggleCollapsed, showPane, notifyFeedback, fresh, dock, menu],
  );

  if (!record || !exercises) return <LoadingLesson />;

  const completed = new Set(record.completedSteps);
  const isDone = (step: ViewStep) =>
    step.type === 'exercise' ? exercises.get(step.exercise.id)?.status === 'passed' : completed.has(step.id);

  const flow: FlowStep[] = steps.map((step, stepIndex) => ({
    id: step.id,
    label: stepLabel(step, stepIndex, steps),
    title: stepTitle(step, lesson),
    done: isDone(step),
  }));

  function next() {
    if (current.type === 'intro' || current.type === 'theory') markDone(current.id);
    goTo(index + 1);
  }

  function selectTab(value: Pane) {
    setPane(value);
    if (value === 'coach') setFresh(false);
    // Телефон: одна прокрутка на все части — новая вкладка открывается с начала.
    if (narrow) rootRef.current?.querySelector<HTMLElement>('.workspace')?.scrollTo?.({ top: 0 });
  }

  const paneProps = (value: Pane): PaneAttributes => {
    const tabbed = hasTabs && tabValues.includes(value);
    return {
      'data-pane': value,
      'data-pane-active': !hasTabs || !tabValues.includes(value) || activeTab === value,
      ...(tabbed ? { id: `pane-panel-${value}`, role: 'tabpanel' as const, 'aria-labelledby': `pane-tab-${value}` } : {}),
    };
  };

  const exercisesLeft = steps
    .map((step, stepIndex) => ({ step, stepIndex }))
    .filter(({ step }) => step.type === 'exercise' && exercises.get(step.exercise.id)?.status !== 'passed')
    .map(({ step, stepIndex }) => ({
      id: step.id,
      title: step.type === 'exercise' ? step.exercise.title : step.title,
      index: stepIndex,
    }));

  const nextId = nextLessonId(course, lesson.id);
  const nextSummary = nextId ? findLessonSummary(course, nextId) : null;
  const currentDone = isDone(current);
  const last = index >= steps.length - 1;
  const primaryNext = currentDone || current.type === 'intro' || current.type === 'theory';
  const lessonDone = Boolean(record.completedAt) && current.type !== 'recap';

  // Кнопка «Далее» на экране одна: на ПК — в шапке урока, на телефоне — внизу содержимого.
  // На первом шаге «Назад» нет совсем: выключенная прозрачная кнопка выглядела бы нажимаемой.
  const backButton =
    index > 0 ? (
      <button type="button" className={`btn step-nav-back${narrow ? '' : ' btn-ghost btn-sm'}`} onClick={() => goTo(index - 1)}>
        <ArrowLeft aria-hidden="true" />
        Назад
      </button>
    ) : null;
  const nextButton = last ? (
    <a className={`btn step-nav-next${narrow ? '' : ' btn-sm'}`} href={href(paths.module(module.id))}>
      К модулю
      <ArrowRight aria-hidden="true" />
    </a>
  ) : (
    <button type="button" className={`btn step-nav-next${narrow ? '' : ' btn-sm'}${primaryNext ? ' btn-primary' : ''}`} onClick={next}>
      {current.type === 'intro' ? 'Начать' : 'Далее'}
      <ArrowRight aria-hidden="true" />
    </button>
  );

  const counts = current.type === 'exercise' ? shell.tests : null;
  const tabItems: TabItem<Pane>[] = tabValues.map((value) => ({
    value,
    label: value === 'task' ? (current.type === 'example' ? 'Пример' : 'Задание') : value === 'code' ? 'Код' : 'Наставник',
    badge:
      value === 'code' && counts && counts.failed > 0 ? (
        <StatusBadge tone="err">
          <span className="n">{counts.failed}</span>
          <span className="visually-hidden"> не прошли</span>
        </StatusBadge>
      ) : undefined,
    fresh: value === 'coach' && fresh && activeTab !== 'coach' ? 'новое — разбор ошибки' : null,
  }));

  const workspaceClass = [
    'workspace',
    hasTabs ? 'has-tabs' : '',
    coachEmpty ? 'is-coach-empty' : '',
    layout === 'wide' && collapsed.task && work ? 'is-task-collapsed' : '',
    layout === 'wide' && collapsed.coach && !coachEmpty ? 'is-coach-collapsed' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const workspaceStyle = {
    ...(widths.task ? { '--w-task-set': `${widths.task}px` } : {}),
    ...(widths.coach ? { '--w-coach-set': `${widths.coach}px` } : {}),
  } as CSSProperties;

  // Вкладки частей шага: на планшете — над левой колонкой, на телефоне — отдельной строкой кадра между шапкой и
  // содержимым (строка сетки, а не «липкая» полоса поверх прокрутки).
  const paneTabs = hasTabs ? (
    <Tabs label="Части шага" items={tabItems} value={activeTab} onChange={selectTab} idPrefix="pane" className="pane-tabs" />
  ) : null;

  function resize(target: SidePane, value: number) {
    const width = Math.round(Math.min(SIDE_MAX, Math.max(SIDE_MIN, value)));
    setWidths((previous) => ({ ...previous, [target]: width }));
    writeNumber(WIDTH_KEY[target], width);
  }

  return (
    <LessonFrameContext.Provider value={frame}>
      <CoachSlotContext.Provider value={slot}>
        {current.type !== 'exercise' && <LessonMinutes minutes={lesson.minutes} />}
        <div className="lesson" ref={rootRef} data-layout={layout}>
          <header className="lesson-head">
            {narrow ? (
              <>
                <div className="lh-top">
                  <h1 className="lesson-title">
                    <span className="n lesson-num">{lesson.number}</span> {lesson.title}
                  </h1>
                  <span className="lh-menu" ref={setMenu} />
                  <a className="btn btn-ghost btn-icon lh-close" href={href(paths.today())} aria-label="Закрыть урок" title="Закрыть урок">
                    <X aria-hidden="true" />
                  </a>
                </div>
                <div className="lh-steps">
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon"
                    aria-label="Предыдущий шаг"
                    title="Предыдущий шаг"
                    disabled={index === 0}
                    onClick={() => goTo(index - 1)}
                  >
                    <ChevronLeft aria-hidden="true" />
                  </button>
                  <StepSheet steps={flow} groups={groups} current={index} onSelect={goTo} />
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon"
                    aria-label="Следующий шаг"
                    title="Следующий шаг"
                    disabled={last}
                    onClick={next}
                  >
                    <ChevronRight aria-hidden="true" />
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="lesson-id">
                  <h1 className="lesson-title">
                    <span className="n lesson-num">{lesson.number}</span> {lesson.title}
                  </h1>
                  <a className="lesson-module" href={href(paths.module(module.id))}>
                    Модуль {module.number} · {module.title}
                  </a>
                </div>
                <nav className="lesson-nav" aria-label="Переход между шагами">
                  {lessonDone && <StatusBadge tone="ok">Урок завершён</StatusBadge>}
                  {backButton}
                  {nextButton}
                </nav>
                <div className="flow-row">
                  <FlowSteps steps={flow} groups={groups} current={index} variant="lesson" onSelect={goTo} label="Шаги урока" />
                  <StepPicker steps={flow} groups={groups} current={index} onSelect={goTo} />
                </div>
              </>
            )}
          </header>
          {narrow && paneTabs}
          <div className="visually-hidden" role="status" aria-live="polite">
            {announce}
          </div>

          <div
            className={workspaceClass}
            data-layout={work ? 'work' : 'doc'}
            data-tab={hasTabs ? activeTab : undefined}
            data-step={current.type}
            style={workspaceStyle}
          >
            {!narrow && paneTabs}
            <div className="lesson-main" ref={mainRef}>
              {current.type === 'intro' && <IntroStep lesson={lesson} />}
              {current.type === 'theory' && <TheoryStep key={current.id} step={current} />}
              {current.type === 'example' && (
                <ExampleStep key={current.id} step={current} pane={paneProps} onDone={() => markDone(current.id)} />
              )}
              {current.type === 'predict' && (
                <PredictStep
                  key={current.id}
                  step={current}
                  record={record}
                  onAnswer={(answer, matched) => {
                    markDone(current.id);
                    void patchRecord({ predictions: { ...record.predictions, [current.id]: { answer, matched } } });
                  }}
                />
              )}
              {current.type === 'order' && (
                <OrderStep
                  key={current.id}
                  step={current}
                  record={record}
                  onResult={(solved) => {
                    const previous = record.orders[current.id];
                    if (solved) markDone(current.id);
                    void patchRecord({
                      orders: { ...record.orders, [current.id]: { attempts: (previous?.attempts ?? 0) + 1, solved: solved || Boolean(previous?.solved) } },
                    });
                  }}
                />
              )}
              {current.type === 'quiz' && (
                <QuizStep
                  key={current.id}
                  step={current}
                  record={record}
                  onAnswer={(choice, correct) => {
                    markDone(current.id);
                    void patchRecord({ quizzes: { ...record.quizzes, [current.id]: { choice, correct } } });
                  }}
                />
              )}
              {current.type === 'checklist' && (
                <ChecklistStep
                  key={current.id}
                  step={current}
                  record={record}
                  onChange={(done) => {
                    if (done.length === current.items.length) markDone(current.id);
                    void patchRecord({ checklists: { ...record.checklists, [current.id]: done } });
                  }}
                />
              )}
              {current.type === 'exercise' && (
                <ExerciseStep
                  key={current.exercise.id}
                  lesson={lesson}
                  exercise={current.exercise}
                  pane={paneProps}
                  onPassed={() => markDone(current.id)}
                  onShowCoach={() => showPane('coach')}
                />
              )}
              {current.type === 'recap' && (
                <RecapStep
                  key={current.id}
                  step={current}
                  record={record}
                  review={review}
                  exercisesLeft={exercisesLeft}
                  nextLesson={nextSummary ? { href: href(paths.lesson(nextSummary.lesson.id)), title: nextSummary.lesson.title } : null}
                  onSave={(answer, selfCheck) => {
                    // Уход с поля без изменений ничего не записывает.
                    if (recapUnchanged(record.recap, answer, selfCheck)) return;
                    const previous = record.recap?.selfCheck ?? null;
                    void patchRecord({ recap: { answer, selfCheck } });
                    if (selfCheck === previous) return;
                    // «Пока нет» и «частично» ставят тему на повторение с первой ступени. «Понимаю» повторение
                    // не засчитывает: это делает только ответ «Повторил» в день повторения.
                    if (selfCheck === 'not-yet' || selfCheck === 'partly') {
                      void scheduleReview({
                        key: lessonReviewKey(lesson.id),
                        lessonId: lesson.id,
                        reason: selfCheck === 'not-yet' ? 'В итоге урока отмечено «пока нет»' : 'В итоге урока отмечено «частично»',
                      });
                    }
                  }}
                  onReview={(success) =>
                    completeReview(lessonReviewKey(lesson.id), success, (step) => reviewReasonAfter('lesson', success, step.stage))
                  }
                  onFinish={() => {
                    markDone(current.id);
                    void patchRecord({ completedAt: Date.now() });
                  }}
                />
              )}
            </div>
            {layout === 'wide' && work && (
              <Splitter
                pane="task"
                name={current.type === 'example' ? 'Пример' : 'Задание'}
                width={widths.task}
                disabled={collapsed.task}
                onResize={(value) => resize('task', value)}
              />
            )}
            {layout === 'wide' && !coachEmpty && (
              <Splitter pane="coach" name="Наставник" width={widths.coach} disabled={collapsed.coach} onResize={(value) => resize('coach', value)} />
            )}
            <aside className="lesson-coach" ref={setSlot} aria-label="Наставник" {...paneProps('coach')} />
            {narrow && lessonDone && (
              <p className="step-done">
                <StatusBadge tone="ok">Урок завершён</StatusBadge>
              </p>
            )}
            {narrow && (
              <nav className="step-nav" aria-label="Переход между шагами">
                {backButton}
                {nextButton}
              </nav>
            )}
          </div>
          {narrow && current.type === 'exercise' && <div className="lesson-dock" ref={setDock} />}
        </div>
      </CoachSlotContext.Provider>
    </LessonFrameContext.Provider>
  );
}

/**
 * Граница боковой панели: линия 1 px с зоной захвата. Мышь или палец — тянуть, клавиатура — стрелки по 16 px,
 * Home / End — самая узкая и самая широкая.
 */
function Splitter({
  pane,
  name,
  width,
  disabled,
  onResize,
}: {
  pane: SidePane;
  name: string;
  width: number | null;
  disabled: boolean;
  onResize: (width: number) => void;
}) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  const [active, setActive] = useState(false);
  const value = width ?? defaultSideWidth();
  // Панель «Задание» слева: движение вправо её расширяет; «Наставник» справа — наоборот.
  const direction = pane === 'task' ? 1 : -1;

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.key === 'ArrowRight' ? 16 : event.key === 'ArrowLeft' ? -16 : 0;
    if (step) {
      event.preventDefault();
      onResize(value + step * direction);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      onResize(event.key === 'Home' ? SIDE_MIN : SIDE_MAX);
    }
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (disabled) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, width: value };
    setActive(true);
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    onResize(drag.current.width + (event.clientX - drag.current.x) * direction);
  }

  function onPointerUp() {
    drag.current = null;
    setActive(false);
  }

  if (disabled) return <div className={`vsplit vsplit-${pane} is-off`} aria-hidden="true" />;
  return (
    <div
      className={`vsplit vsplit-${pane}${active ? ' is-drag' : ''}`}
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={`Ширина панели «${name}»`}
      aria-valuemin={SIDE_MIN}
      aria-valuemax={SIDE_MAX}
      aria-valuenow={value}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    />
  );
}

/** Телефон: название шага, мини-конвейер и «7 из 10» — кнопка открывает шторку со списком шагов. */
function StepSheet({
  steps,
  groups,
  current,
  onSelect,
}: {
  steps: FlowStep[];
  groups: FlowGroup[];
  current: number;
  onSelect: (index: number) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const now = steps[current];
  const title = now.title || now.label;
  const parts: { group: FlowGroup; items: number[] }[] = [];
  steps.forEach((_, index) => {
    const group = groups[index] ?? 'understand';
    const lastPart = parts[parts.length - 1];
    if (lastPart && lastPart.group === group) lastPart.items.push(index);
    else parts.push({ group, items: [index] });
  });

  return (
    <>
      <button
        type="button"
        className="lh-picker"
        aria-haspopup="dialog"
        aria-label={`Список шагов: шаг ${current + 1} из ${steps.length}, ${title}`}
        onClick={() => ref.current?.showModal()}
      >
        <span className="lh-picker-title">
          <span className="lh-picker-text" title={title}>
            {title}
          </span>
          <ChevronDown aria-hidden="true" />
        </span>
        <MiniBar steps={steps} groups={groups} current={current} />
      </button>
      <dialog
        ref={ref}
        className="step-sheet"
        aria-labelledby="step-sheet-title"
        onClick={(event) => {
          // Нажатие на затемнение (мимо шторки) закрывает список.
          if (event.target === event.currentTarget) event.currentTarget.close();
        }}
      >
        <div className="sheet-head">
          <h2 id="step-sheet-title">
            Шаги урока · <span className="n">{current + 1}</span> из <span className="n">{steps.length}</span>
          </h2>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            aria-label="Закрыть список шагов"
            title="Закрыть список шагов"
            onClick={() => ref.current?.close()}
          >
            <X aria-hidden="true" />
          </button>
        </div>
        {parts.map((part, partIndex) => (
          <div key={`${part.group}-${partIndex}`} className="sheet-group">
            <div className="plabel">{FLOW_GROUP_LABEL[part.group]}</div>
            <ul>
              {part.items.map((index) => {
                const step = steps[index];
                const state = index === current ? 'current' : step.done ? 'done' : '';
                return (
                  <li key={step.id}>
                    <button
                      type="button"
                      className={`flow-pop-item${state ? ` is-${state}` : ''}`}
                      aria-current={index === current ? 'step' : undefined}
                      aria-label={`Шаг ${index + 1}. ${step.label}${step.title && step.title !== step.label ? ` — ${step.title}` : ''}${
                        step.done ? ', пройден' : ''
                      }`}
                      onClick={() => {
                        ref.current?.close();
                        onSelect(index);
                      }}
                    >
                      <span className="step-node" aria-hidden="true">
                        {step.done && index !== current ? <Check /> : index + 1}
                      </span>
                      <span className="flow-pop-text">
                        <span className="flow-pop-label">{step.label}</span>
                        {step.title && step.title !== step.label && <span className="flow-pop-title">{step.title}</span>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </dialog>
    </>
  );
}
