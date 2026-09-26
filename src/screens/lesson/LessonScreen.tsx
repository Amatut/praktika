// Экран урока: история → теория → пример → прогноз → практика → закрепление.
// Место остановки сохраняется; по шагам можно ходить свободно.

import { ArrowLeft, ArrowRight, Check } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDataVersion, useMediaQuery } from '../../app/hooks.ts';
import { href, navigate, paths } from '../../app/router.ts';
import { rovingKeyDown } from '../../components/roving.ts';
import { EmptyState, Meter, StatusBadge, formatMinutes } from '../../components/ui.tsx';
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
import { CoachSlotContext } from './coach.tsx';
import { ExerciseStep, KIND_LABEL } from './ExerciseStep.tsx';
import { lessonReviewKey, recapUnchanged, reviewReasonAfter } from './review.ts';
import { ChecklistStep, ExampleStep, IntroStep, OrderStep, PredictStep, QuizStep, RecapStep, TheoryStep } from './steps.tsx';

type ViewStep = { type: 'intro'; id: 'intro'; title: string } | Step;
export type Pane = 'task' | 'code' | 'coach';

/** Атрибуты части шага. На телефоне у задания вкладки «Задание / Код / Тренер», и части — их панели. */
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

// Вкладки на телефоне — только у заданий. Пример читается одной колонкой: пояснения к строкам,
// под ними код с «Запустить» и результат.
const CODE_STEPS = new Set(['exercise']);

const PANES: [Pane, string][] = [
  ['task', 'Задание'],
  ['code', 'Код'],
  ['coach', 'Тренер'],
];

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

export function LessonScreen({ course, lessonId, step }: { course: Course; lessonId: string; step: number | null }) {
  const loaded = useLoadable(() => loadLesson(course, lessonId), [course.contentVersion, lessonId]);
  if (loaded.status === 'loading') {
    return (
      <div className="lesson">
        <p className="muted" role="status">
          Открываю урок…
        </p>
      </div>
    );
  }
  if (loaded.status === 'error') {
    const summary = findLessonSummary(course, lessonId);
    const message =
      loaded.error.message === 'not-ready'
        ? 'Материалы этого урока ещё не написаны. Карта курса показывает, что уже готово.'
        : loaded.error.message === 'not-found'
          ? 'Такого урока нет в курсе.'
          : navigator.onLine
            ? 'Не удалось загрузить урок. Попробуй обновить страницу.'
            : 'Нет сети, а этот модуль ещё не скачан для офлайн-работы. Скачать можно в Настройках → Офлайн, когда появится сеть.';
    return (
      <div className="page page-narrow">
        <EmptyState
          title={summary ? summary.lesson.title : 'Урок недоступен'}
          action={
            <a className="btn" href={href(paths.course())}>
              К карте курса
            </a>
          }
        >
          {message}
        </EmptyState>
      </div>
    );
  }
  return <LessonView key={lessonId} course={course} module={loaded.value.module} lesson={loaded.value.lesson} stepParam={step} />;
}

function LessonView({ course, module, lesson, stepParam }: { course: Course; module: ModuleSummary; lesson: Lesson; stepParam: number | null }) {
  const steps = useMemo<ViewStep[]>(() => [{ type: 'intro', id: 'intro', title: 'История' }, ...lesson.steps], [lesson]);
  // Пока запись урока и задания не прочитаны, шаги не показываются: иначе они взяли бы
  // начальное состояние из пустой записи (ответ можно дать заново, пустой итог затёр бы сохранённый).
  const [record, setRecord] = useState<LessonRecord | null>(null);
  const [exercises, setExercises] = useState<Map<string, ExerciseRecord> | null>(null);
  const [review, setReview] = useState<ReviewRecord | null>(null);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [pane, setPane] = useState<Pane>('task');
  const [announce, setAnnounce] = useState('');
  const [headingFocus, setHeadingFocus] = useState(0);
  const [coachFocus, setCoachFocus] = useState(0);
  const exerciseVersion = useDataVersion(['exercises']);
  const reviewVersion = useDataVersion(['reviews']);
  const narrow = useMediaQuery('(max-width: 899px)');
  const mainRef = useRef<HTMLDivElement>(null);
  const stepperRef = useRef<HTMLOListElement>(null);
  const loaded = record !== null && exercises !== null;

  const index = Math.min(Math.max(stepParam ?? record?.stepIndex ?? 0, 0), steps.length - 1);
  const current = steps[index];
  const isCodeStep = CODE_STEPS.has(current.type);
  const panes = isCodeStep && narrow;

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
      void patchRecord({ stepIndex: clamped });
      // Фокус — на заголовок нового шага: кнопка «Далее» после прокрутки наверх осталась бы за краем экрана.
      setHeadingFocus((value) => value + 1);
      setAnnounce(`Шаг ${clamped + 1} из ${steps.length}: ${stepLabel(steps[clamped], clamped, steps)}`);
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

  // На телефоне «Разбор у наставника» открывает вкладку «Тренер» — фокус переходит к разбору.
  useEffect(() => {
    if (!coachFocus || !slot) return;
    const target = slot.querySelector<HTMLElement>('.feedback') ?? slot.querySelector<HTMLElement>('.coach');
    if (!target) return;
    target.tabIndex = -1;
    target.focus();
  }, [coachFocus, slot]);

  // Текущий шаг всегда виден в ленте шагов; у скрытых за краем шагов — затухание.
  useEffect(() => {
    const list = stepperRef.current;
    if (!list) return;
    const chip = list.querySelector<HTMLElement>('[aria-current="step"]');
    if (chip) {
      const box = list.getBoundingClientRect();
      const item = chip.getBoundingClientRect();
      if (item.left < box.left) list.scrollLeft -= box.left - item.left + 32;
      else if (item.right > box.right) list.scrollLeft += item.right - box.right + 32;
    }
  }, [index, loaded]);

  useEffect(() => {
    const list = stepperRef.current;
    if (!list) return;
    const update = () => {
      list.dataset.moreStart = String(list.scrollLeft > 1);
      list.dataset.moreEnd = String(list.scrollLeft + list.clientWidth < list.scrollWidth - 1);
    };
    update();
    list.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      list.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [loaded]);

  // Панель наставника прилипает без своей прокрутки: если она выше окна, прилипает нижним краем,
  // и длинный разбор или решение дочитываются обычной прокруткой страницы.
  useEffect(() => {
    if (!slot) return;
    const update = () => slot.style.setProperty('--coach-top', `${Math.min(16, window.innerHeight - slot.offsetHeight - 16)}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(slot);
    window.addEventListener('resize', update);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [slot]);

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

  if (!record || !exercises) {
    return (
      <div className="lesson">
        <p className="muted" role="status">
          Открываю урок…
        </p>
      </div>
    );
  }

  const completed = new Set(record.completedSteps);
  const isDone = (step: ViewStep) =>
    step.type === 'exercise' ? exercises.get(step.exercise.id)?.status === 'passed' : completed.has(step.id);

  function next() {
    if (current.type === 'intro' || current.type === 'theory') markDone(current.id);
    goTo(index + 1);
  }

  function showCoach() {
    if (panes && pane !== 'coach') setCoachFocus((value) => value + 1);
    setPane('coach');
  }

  const paneProps = (value: Pane): PaneAttributes => ({
    'data-pane': value,
    'data-pane-active': !isCodeStep || pane === value,
    ...(panes ? { id: `pane-${value}`, role: 'tabpanel' as const, 'aria-labelledby': `pane-tab-${value}` } : {}),
  });

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

  return (
    <CoachSlotContext.Provider value={slot}>
      <div className="lesson">
        <header className="lesson-head">
          <div className="eyebrow">
            <a href={href(paths.module(module.id))} style={{ color: 'inherit', textDecoration: 'none' }}>
              Модуль {module.number} · {module.title}
            </a>
          </div>
          <div className="lesson-head-row">
            <h1>
              {lesson.number}. {lesson.title}
            </h1>
            <div className="lesson-meta">
              <span>{formatMinutes(lesson.minutes)}</span>
              <span className="meta-sep" aria-hidden="true">
                ·
              </span>
              <span className="lesson-objective">{lesson.objective}</span>
            </div>
          </div>
          <ol className="stepper" aria-label="Шаги урока" ref={stepperRef}>
            {steps.map((step, stepIndex) => {
              const done = isDone(step);
              return (
                <li key={step.id}>
                  <button
                    type="button"
                    className="step-chip"
                    aria-current={stepIndex === index ? 'step' : undefined}
                    data-state={done ? 'done' : undefined}
                    onClick={() => goTo(stepIndex)}
                    title={step.type === 'exercise' ? `${KIND_LABEL[step.exercise.kind]}: ${step.exercise.title}` : step.title}
                  >
                    <span className="step-num" aria-hidden="true">
                      {done && stepIndex !== index ? <Check /> : stepIndex + 1}
                    </span>
                    {stepLabel(step, stepIndex, steps)}
                    {done && <span className="visually-hidden"> — выполнено</span>}
                  </button>
                </li>
              );
            })}
          </ol>
          <div className="step-progress">
            <span className="step-progress-label">
              Шаг {index + 1} из {steps.length}: {stepLabel(current, index, steps)}
            </span>
            <Meter value={index + 1} max={steps.length} label="Шаг урока" />
          </div>
        </header>
        <div className="visually-hidden" role="status" aria-live="polite">
          {announce}
        </div>

        {isCodeStep && (
          <div className="pane-tabs">
            <div className="segmented" role="tablist" aria-label="Части шага" onKeyDown={(event) => rovingKeyDown(event)}>
              {PANES.map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  id={`pane-tab-${value}`}
                  aria-controls={`pane-${value}`}
                  aria-selected={pane === value}
                  tabIndex={pane === value ? 0 : -1}
                  onClick={() => setPane(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className={`lesson-grid${isCodeStep ? ' has-panes' : ''}`}>
          <div className="lesson-main" ref={mainRef}>
            {current.type === 'intro' && <IntroStep lesson={lesson} />}
            {current.type === 'theory' && <TheoryStep key={current.id} step={current} />}
            {current.type === 'example' && <ExampleStep key={current.id} step={current} onDone={() => markDone(current.id)} />}
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
                onShowCoach={showCoach}
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
          <aside className="lesson-coach" ref={setSlot} aria-label="Наставник" {...paneProps('coach')} />
          <nav className="step-nav" aria-label="Переход между шагами">
            <button type="button" className="btn step-nav-back" onClick={() => goTo(index - 1)} disabled={index === 0}>
              <ArrowLeft aria-hidden="true" />
              Назад
            </button>
            {current.type === 'exercise' && !currentDone && <span className="step-nav-hint">Можно вернуться к заданию позже</span>}
            {index < steps.length - 1 ? (
              <button
                type="button"
                className={`btn step-nav-next${currentDone || current.type === 'intro' || current.type === 'theory' ? ' btn-primary' : ''}`}
                onClick={next}
              >
                {current.type === 'intro' ? 'Начать' : 'Далее'}
                <ArrowRight aria-hidden="true" />
              </button>
            ) : (
              <a className="btn step-nav-next" href={href(paths.module(module.id))}>
                К модулю
              </a>
            )}
          </nav>
        </div>
        {record.completedAt && current.type !== 'recap' && (
          <p className="small muted" style={{ marginTop: 16 }}>
            <StatusBadge tone="good">Урок завершён</StatusBadge>
          </p>
        )}
      </div>
    </CoachSlotContext.Provider>
  );
}
