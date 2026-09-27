import { ArrowRight, BookOpen, CalendarClock, Clock, History, PenLine, Timer } from 'lucide-react';
import { href, paths } from '../app/router.ts';
import { EmptyState, Meter, PendingData, StatusBadge, formatDate, formatMinutes, plural } from '../components/ui.tsx';
import type { Course, Lesson, ModuleSummary } from '../content/schema.ts';
import { exercisesOf, splitReviews, suggestNextLesson } from '../progress/model.ts';
import { useLearnerData, type LearnerData } from '../progress/useLearnerData.ts';
import { localDateKey } from '../storage/schedule.ts';

function findLesson(data: LearnerData, course: Course, lessonId: string | null): { module: ModuleSummary; lesson: Lesson } | null {
  if (!lessonId) return null;
  for (const module of course.modules) {
    const lesson = data.files.get(module.id)?.lessons.find((item) => item.id === lessonId);
    if (lesson) return { module, lesson };
  }
  return null;
}

export function PathChips({ course, current }: { course: Course; current: string }) {
  return (
    <ol className="path" aria-label="Маршрут обучения">
      {course.stages.map((stage, index) => (
        <li key={stage.id}>
          <span className="path-chip" aria-current={stage.id === current ? 'step' : undefined} title={stage.description}>
            <span className="path-number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
            {stage.title}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function TodayScreen({ course }: { course: Course }) {
  const { data, error } = useLearnerData(course);
  if (!data) return <PendingData error={error} />;

  const firstTime = data.lessons.size === 0;
  const currentRecord = data.meta.currentLessonId ? data.lessons.get(data.meta.currentLessonId) : undefined;
  const fromMeta = findLesson(data, course, data.meta.currentLessonId);
  const continueTarget =
    fromMeta && !currentRecord?.completedAt ? fromMeta : suggestNextLesson(course, data.files, data.lessons, data.exercises);
  const record = continueTarget ? data.lessons.get(continueTarget.lesson.id) : undefined;
  const stepIndex = record?.stepIndex ?? 0;
  // Шкала — по сделанному (пройденные шаги и решённые задания), а не по номеру открытого шага.
  const lessonSteps: { id: string; exerciseId: string | null }[] = continueTarget
    ? [
        { id: 'intro', exerciseId: null },
        ...continueTarget.lesson.steps.map((step) => ({ id: step.id, exerciseId: step.type === 'exercise' ? step.exercise.id : null })),
      ]
    : [];
  const stepsDone = lessonSteps.filter(
    (step) => record?.completedSteps.includes(step.id) || (step.exerciseId !== null && data.exercises.get(step.exerciseId)?.status === 'passed'),
  ).length;

  // Повторения — по календарным дням: «на завтра» не появляется сегодня вечером.
  const { due, upcoming } = splitReviews(data.reviews);

  const lessonById = new Map<string, { module: ModuleSummary; lesson: Lesson }>();
  for (const module of course.modules) {
    for (const lesson of data.files.get(module.id)?.lessons ?? []) lessonById.set(lesson.id, { module, lesson });
  }

  // Ближайшая практика: первое нерешённое задание в текущем или следующем уроке.
  let practice: { lesson: Lesson; title: string; step: number } | null = null;
  if (continueTarget) {
    const steps = continueTarget.lesson.steps;
    const index = steps.findIndex(
      (step) => step.type === 'exercise' && data.exercises.get(step.exercise.id)?.status !== 'passed',
    );
    const step = steps[index];
    if (index >= 0 && step.type === 'exercise') practice = { lesson: continueTarget.lesson, title: step.exercise.title, step: index + 1 };
  }

  // «Только 10 минут»: итог последнего завершённого урока или нерешённое задание.
  const lastDone = [...data.lessons.values()]
    .filter((item) => item.completedAt)
    .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))[0];
  const lastDoneLesson = lastDone ? lessonById.get(lastDone.lessonId) : undefined;

  const today = localDateKey(new Date());
  const todayMinutes = Math.round((data.activity.find((item) => item.date === today)?.activeMs ?? 0) / 60000);
  const readyLessons = course.modules.flatMap((module) => module.lessons).filter((lesson) => lesson.ready).length;

  return (
    <div className="page today-page">
      <header className="page-head">
        <span className="eyebrow">Сегодня</span>
        <h1>{firstTime ? 'Начнём с первой истории' : continueTarget ? 'Продолжим?' : 'Готовые уроки пройдены'}</h1>
        <p className="page-lead">
          {firstTime
            ? 'Каждое занятие — 20–30 минут: короткая история, одна идея и практика с настоящим Python. Выбирать профессию сейчас не нужно.'
            : 'Место остановки сохранено. Пропущенный день ничего не обнуляет.'}
        </p>
        <div style={{ marginTop: 8 }}>
          <PathChips course={course} current="basics" />
        </div>
      </header>

      <div className="today-grid">
        <div className="stack today-primary">
          {continueTarget ? (
            <section className="continue-card" aria-labelledby="continue-title">
              <span className="eyebrow">
                Модуль {continueTarget.module.number} · {continueTarget.module.title}
              </span>
              <h2 id="continue-title">
                {continueTarget.lesson.number}. {continueTarget.lesson.title}
              </h2>
              <p className="muted">{continueTarget.lesson.objective}</p>
              <div className="continue-meta">
                <span className="row" style={{ gap: 6 }}>
                  <Clock aria-hidden="true" width={15} height={15} />
                  {formatMinutes(continueTarget.lesson.minutes)}
                </span>
                <span aria-hidden="true">·</span>
                <span>
                  {exercisesOf(continueTarget.lesson).length}{' '}
                  {plural(exercisesOf(continueTarget.lesson).length, ['задание', 'задания', 'заданий'])}
                </span>
                {record && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>
                      Выполнено {stepsDone} из {lessonSteps.length} {plural(lessonSteps.length, ['шага', 'шагов', 'шагов'])}
                    </span>
                  </>
                )}
              </div>
              {record && <Meter value={stepsDone} max={lessonSteps.length} label="Выполнено шагов урока" />}
              <div className="row">
                <a className="btn btn-primary" href={href(paths.lesson(continueTarget.lesson.id, record ? stepIndex : 0))}>
                  {record ? 'Продолжить урок' : 'Начать урок'}
                  <ArrowRight aria-hidden="true" />
                </a>
                <a className="btn btn-ghost" href={href(paths.module(continueTarget.module.id))}>
                  Все уроки модуля
                </a>
              </div>
            </section>
          ) : (
            <EmptyState
              title="Все готовые уроки пройдены"
              action={
                <a className="btn" href={href(paths.course())}>
                  Открыть карту курса
                </a>
              }
            >
              Сейчас в приложении {readyLessons} {plural(readyLessons, ['готовый урок', 'готовых урока', 'готовых уроков'])}. Следующие
              модули ещё пишутся — пока можно повторить трудные задания и заглянуть в «Направления».
            </EmptyState>
          )}

          {data.unavailable.length > 0 && (
            <div className="notice notice-warn">
              <History aria-hidden="true" />
              <div>
                Часть уроков недоступна без сети: они ещё не скачаны. Скачать можно в{' '}
                <a href={href(paths.settings('offline'))}>Настройках → Офлайн</a>.
              </div>
            </div>
          )}
        </div>

        <div className="stack today-support">
          <section className="card list-card review-card" aria-labelledby="review-title">
            <div className="card-head">
              <span className="review-symbol" aria-hidden="true"><CalendarClock /></span>
              <div>
                <h2 id="review-title" className="card-title">
                  На повторение
                </h2>
                <p className="card-sub">Темы возвращаются через 1, 3, 7 и 14 дней</p>
              </div>
            </div>
            {due.length === 0 ? (
              <p className="small muted" style={{ padding: '0 16px 16px' }}>
                {upcoming.length > 0
                  ? `Ближайшее повторение — ${formatDate(upcoming[0].dueAt)}.`
                  : 'Пока нечего повторять. Тема появится здесь, если задание далось с трудом.'}
              </p>
            ) : (
              <ul className="list-rows">
                {due.map((review) => {
                  const target = lessonById.get(review.lessonId);
                  // Задание — к его шагу; тема урока без задания — к шагу «Итог».
                  const stepIndex = review.exerciseId
                    ? target?.lesson.steps.findIndex((step) => step.type === 'exercise' && step.exercise.id === review.exerciseId)
                    : target
                      ? target.lesson.steps.length - 1
                      : undefined;
                  const exerciseStep = target?.lesson.steps.find(
                    (step) => step.type === 'exercise' && step.exercise.id === review.exerciseId,
                  );
                  const title =
                    exerciseStep?.type === 'exercise'
                      ? exerciseStep.exercise.title
                      : target
                        ? `Итог урока «${target.lesson.title}»`
                        : review.key;
                  return (
                    <li key={review.key}>
                      <a
                        className="list-row"
                        href={href(paths.lesson(review.lessonId, stepIndex !== undefined && stepIndex >= 0 ? stepIndex + 1 : undefined))}
                      >
                        <span className="row-icon is-warn" aria-hidden="true">
                          <CalendarClock />
                        </span>
                        <span className="list-row-main">
                          <span className="list-row-title">{title}</span>
                          <span className="list-row-sub">{review.reason}</span>
                        </span>
                        <ArrowRight aria-hidden="true" />
                      </a>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="card list-card shortcuts-card" aria-labelledby="short-title">
            <div className="card-head">
              <h2 id="short-title" className="card-title">
                Коротко
              </h2>
            </div>
            <ul className="list-rows">
              {practice && (
                <li>
                  <a className="list-row" href={href(paths.lesson(practice.lesson.id, practice.step))}>
                    <span className="row-icon is-accent" aria-hidden="true">
                      <PenLine />
                    </span>
                    <span className="list-row-main">
                      <span className="list-row-title">Ближайшая практика</span>
                      <span className="list-row-sub">{practice.title}</span>
                    </span>
                    <ArrowRight aria-hidden="true" />
                  </a>
                </li>
              )}
              <li>
                <a
                  className="list-row"
                  href={href(
                    lastDoneLesson
                      ? paths.lesson(lastDoneLesson.lesson.id, lastDoneLesson.lesson.steps.length)
                      : continueTarget
                        ? paths.lesson(continueTarget.lesson.id, 0)
                        : paths.course(),
                  )}
                >
                  <span className="row-icon" aria-hidden="true">
                    <Timer />
                  </span>
                  <span className="list-row-main">
                    <span className="list-row-title">Если только 10 минут</span>
                    <span className="list-row-sub">
                      {lastDoneLesson ? `Повтори итог урока «${lastDoneLesson.lesson.title}»` : 'Прочитай историю урока — это 3 минуты'}
                    </span>
                  </span>
                  <ArrowRight aria-hidden="true" />
                </a>
              </li>
              <li>
                <a className="list-row" href={href(paths.directions())}>
                  <span className="row-icon" aria-hidden="true">
                    <BookOpen />
                  </span>
                  <span className="list-row-main">
                    <span className="list-row-title">Истории о направлениях</span>
                    <span className="list-row-sub">Чем занимаются в вебе, данных, играх и других областях</span>
                  </span>
                  <ArrowRight aria-hidden="true" />
                </a>
              </li>
            </ul>
          </section>

          <p className="small muted row today-activity" style={{ gap: 6 }}>
            <Clock aria-hidden="true" width={14} height={14} />
            Сегодня в уроках: {todayMinutes} {plural(todayMinutes, ['минута', 'минуты', 'минут'])}
            {due.length > 0 && <StatusBadge tone="warn">{due.length} на повторение</StatusBadge>}
          </p>
        </div>
      </div>
    </div>
  );
}
