// «Сегодня» — стартовая вкладка «Мастерской»: одна точка входа «продолжить с места» (адрес урока и шага, код
// ученика, одна главная кнопка), минуты сегодня без серий дней, маршрут курса на реальных данных; сбоку —
// повторение и направления. Экран не объясняет сам себя: метки, статусы и учебное содержание уроков.
import {
  ArrowRight,
  Bot,
  Brain,
  Bug,
  CalendarCheck,
  ChevronRight,
  CircleCheck,
  Clock,
  CodeXml,
  Compass,
  Cpu,
  Database,
  FileCode2,
  Gamepad2,
  GitBranch,
  Heart,
  History,
  Lock,
  PenLine,
  Server,
  ShieldCheck,
  Smartphone,
  Timer,
  type LucideIcon,
} from 'lucide-react';
import { useEffect } from 'react';
import { SystemStatus } from '../app/AppShell.tsx';
import { useMediaQuery } from '../app/hooks.ts';
import { href, navigate, paths } from '../app/router.ts';
import { CodeBlock } from '../components/CodeBlock.tsx';
import { FlowSteps, MiniBar, flowGroups, type FlowStep } from '../components/FlowSteps.tsx';
import { RouteGraph, finishedModuleIds } from '../components/RouteGraph.tsx';
import { EmptyState, Notice, PaneHead, PendingData, StatusBadge, Tag, formatDate, plural } from '../components/ui.tsx';
import type { AttemptRecord } from '../storage/types.ts';
import type { Course, Exercise, Lesson, ModuleSummary, Step } from '../content/schema.ts';
import { moduleState, splitReviews, suggestNextLesson, type LearningState } from '../progress/model.ts';
import { useLearnerData, type LearnerData } from '../progress/useLearnerData.ts';
import { addLocalDays, localDateKey } from '../storage/schedule.ts';
import { lessonIllustrationUrl } from './lesson/StoryIllustration.tsx';

/** Цель на день, минут. */
const DAILY_GOAL: [number, number] = [20, 30];
/** Деление шкалы минут — 2 минуты: 15 делений до 30, зона цели — последние 5. */
const TICK_MINUTES = 2;
const PREVIEW_LINES = 8;
const DIRECTIONS_SHOWN = 4;
/** Оценка повторения в шапке «На повторение»: минут на одну тему. */
const REVIEW_MINUTES = 5;
/** Уже — одна колонка (та же граница, что у оболочки). Секции рисуются в видимом порядке, а не переставляются CSS. */
const NARROW_QUERY = '(max-width: 899px)';

/** Строка не переносится перед тире: «Программа — это…» не рвётся на «Программа / — это». */
function keepDash(text: string): string {
  return text.replace(/ —/g, '\u00a0—');
}

// Значки направлений — те же, что в DirectionsScreen (он грузится отдельной частью, поэтому не импортируется).
const LAB_ICON: Record<string, LucideIcon> = {
  web: CodeXml,
  backend: Server,
  automation: Bot,
  data: Database,
  ai: Brain,
  mobile: Smartphone,
  games: Gamepad2,
  qa: Bug,
  security: ShieldCheck,
  systems: Cpu,
};

// Метки шагов — как в шапке урока (LessonScreen): «История», «Идея», «Практика 1», «Итог».
const STEP_LABEL: Record<Step['type'], string> = {
  theory: 'Идея',
  example: 'Пример',
  predict: 'Прогноз',
  order: 'Порядок',
  exercise: 'Практика',
  checklist: 'Шаги',
  quiz: 'Вопрос',
  recap: 'Итог',
};

interface ViewStep extends FlowStep {
  type: 'intro' | Step['type'];
  exercise: Exercise | null;
}

/** Шаги урока, как их видит ученик: история + шаги из материалов. */
function viewSteps(lesson: Lesson, data: LearnerData): ViewStep[] {
  const record = data.lessons.get(lesson.id);
  const done = (id: string, exercise: Exercise | null) =>
    Boolean(record?.completedSteps.includes(id)) || (exercise !== null && data.exercises.get(exercise.id)?.status === 'passed');
  const steps: ViewStep[] = [
    { id: 'intro', type: 'intro', label: 'История', title: lesson.story.title, exercise: null, done: done('intro', null) },
  ];
  let practice = 0;
  for (const step of lesson.steps) {
    if (step.type === 'exercise') {
      practice += 1;
      steps.push({
        id: step.id,
        type: step.type,
        label: `${STEP_LABEL.exercise} ${practice}`,
        title: step.exercise.title,
        exercise: step.exercise,
        done: done(step.id, step.exercise),
      });
    } else {
      steps.push({ id: step.id, type: step.type, label: STEP_LABEL[step.type], title: step.title, exercise: null, done: done(step.id, null) });
    }
  }
  return steps;
}

/** «сегодня, 21:40», «вчера, 21:40», «27 сентября, 21:40». */
function formatWhen(at: number): { day: string; time: string } {
  const key = localDateKey(at);
  const day =
    key === localDateKey(new Date()) ? 'сегодня' : key === localDateKey(addLocalDays(Date.now(), -1)) ? 'вчера' : formatDate(at);
  return { day, time: new Date(at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) };
}

/** Минуты сегодня — шкала как у сборки: 15 делений по 2 минуты, зона цели 20–30 отделена. Без серий дней. */
function MinutesMeter({ minutes }: { minutes: number }) {
  const ticks = DAILY_GOAL[1] / TICK_MINUTES;
  const goalFrom = DAILY_GOAL[0] / TICK_MINUTES;
  const filled = Math.min(ticks, Math.floor(minutes / TICK_MINUTES));
  const tick = (index: number) => <i key={index} className={index < filled ? 'is-on' : undefined} />;
  return (
    <p className="today-minutes">
      <span className="visually-hidden">
        Сегодня {minutes} {plural(minutes, ['минута', 'минуты', 'минут'])} занятий, цель {DAILY_GOAL[0]}–{DAILY_GOAL[1]}
      </span>
      <span aria-hidden="true">сегодня</span>
      <span className="today-minutes-bar" aria-hidden="true">
        <span>{Array.from({ length: goalFrom }, (_, index) => tick(index))}</span>
        <span className="today-minutes-goal">{Array.from({ length: ticks - goalFrom }, (_, index) => tick(goalFrom + index))}</span>
      </span>
      <span className="today-minutes-value" aria-hidden="true">
        <span className="n">{minutes}</span> / <span className="n">{DAILY_GOAL[0]}–{DAILY_GOAL[1]}</span> мин
      </span>
    </p>
  );
}

/** Бейдж последней проверки — те же слова и тон, что у итога проверки в уроке: «Пройдено 1 из 4». */
function CheckBadge({ attempt }: { attempt: AttemptRecord | null }) {
  if (!attempt) return <StatusBadge tone="muted">Проверок ещё не было</StatusBadge>;
  const passed = Math.max(0, attempt.total - attempt.failed);
  return (
    <StatusBadge tone={passed >= attempt.total ? 'ok' : 'err'}>
      Пройдено {passed} из {attempt.total}
    </StatusBadge>
  );
}

/**
 * Enter на странице открывает урок — как главная кнопка. Только когда фокус ни на чём (страница или main):
 * у ссылок, кнопок и полей Enter остаётся своим. Подсказки клавиши на экране нет — aria-keyshortcuts у кнопки.
 */
function EnterOpens({ path }: { path: string }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || event.defaultPrevented || event.repeat) return;
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      const active = document.activeElement;
      if (active && active !== document.body && active.id !== 'main') return;
      event.preventDefault();
      navigate(path);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [path]);
  return null;
}

export function TodayScreen({ course }: { course: Course }) {
  const { data, error } = useLearnerData(course);
  const narrow = useMediaQuery(NARROW_QUERY);
  if (!data) return <PendingData error={error} />;

  const lessonById = new Map<string, { module: ModuleSummary; lesson: Lesson }>();
  for (const module of course.modules) {
    for (const lesson of data.files.get(module.id)?.lessons ?? []) lessonById.set(lesson.id, { module, lesson });
  }

  // Продолжить с места: открытый урок, если он не завершён; иначе — первый незавершённый.
  const currentRecord = data.meta.currentLessonId ? data.lessons.get(data.meta.currentLessonId) : undefined;
  const fromMeta = data.meta.currentLessonId ? lessonById.get(data.meta.currentLessonId) : undefined;
  const target = fromMeta && !currentRecord?.completedAt ? fromMeta : suggestNextLesson(course, data.files, data.lessons, data.exercises);
  const record = target ? data.lessons.get(target.lesson.id) : undefined;
  const steps = target ? viewSteps(target.lesson, data) : [];
  // Место остановки. Если этот шаг уже пройден (задание решено, «Далее» не нажато) — следующий непройденный:
  // адрес, превью, конвейер и главная кнопка ведут туда, а не к решённому заданию.
  const stopped = Math.min(Math.max(record?.stepIndex ?? 0, 0), Math.max(steps.length - 1, 0));
  const ahead = steps[stopped]?.done ? steps.findIndex((item, index) => index > stopped && !item.done) : -1;
  const current = ahead >= 0 ? ahead : stopped;
  const step = steps[current];
  const exercise = step?.exercise ?? null;
  const exerciseRecord = exercise ? data.exercises.get(exercise.id) : undefined;
  const lastCheck = exercise
    ? data.attempts
        .filter((attempt) => attempt.kind === 'check' && attempt.exerciseId === exercise.id)
        .reduce<AttemptRecord | null>((latest, attempt) => (!latest || attempt.at > latest.at ? attempt : latest), null)
    : null;
  // Превью — та же сцена, что у истории урока (список сцен один — в StoryIllustration).
  const scene = target ? lessonIllustrationUrl(target.lesson.id) : null;
  const lessonPath = target ? paths.lesson(target.lesson.id, record ? current : 0) : null;

  // Повторения — по календарным дням: «на завтра» не появляется сегодня вечером.
  const { due, upcoming } = splitReviews(data.reviews);

  // Ближайшая практика — только в начатом уроке и только впереди: первое нерешённое задание после текущего шага.
  // Текущее задание здесь не повторяется — на него ведёт главная кнопка.
  const practiceIndex = steps.findIndex((item) => item.exercise && data.exercises.get(item.exercise.id)?.status !== 'passed');
  const practice = record && target && practiceIndex > current ? { step: steps[practiceIndex], index: practiceIndex } : null;

  // «Если только 10 минут»: итог последнего завершённого урока или история текущего — только если это другой путь,
  // чем у главной кнопки (у нового ученика оба ведут в начало урока).
  const lastDone = [...data.lessons.values()]
    .filter((item) => item.completedAt)
    .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))[0];
  const lastDoneLesson = lastDone ? lessonById.get(lastDone.lessonId) : undefined;
  const shortPath = lastDoneLesson
    ? { href: paths.lesson(lastDoneLesson.lesson.id, lastDoneLesson.lesson.steps.length), text: `Повтори итог урока «${lastDoneLesson.lesson.title}»` }
    : target
      ? { href: paths.lesson(target.lesson.id, 0), text: 'История урока · 3 мин' }
      : null;
  const short = shortPath && shortPath.href !== lessonPath ? shortPath : null;

  const today = localDateKey(new Date());
  const todayMinutes = Math.round((data.activity.find((item) => item.date === today)?.activeMs ?? 0) / 60000);
  const readyLessons = course.modules.flatMap((module) => module.lessons).filter((lesson) => lesson.ready).length;

  // Маршрут — честные числа: пройденные уроки «Основ» из готовых.
  const basicsModules = course.modules.filter((module) => module.part === 'basics');
  const basicsLessons = basicsModules.flatMap((module) => module.lessons.filter((lesson) => lesson.ready));
  const lessonsDone = basicsLessons.filter((lesson) => data.lessons.get(lesson.id)?.completedAt).length;
  // «Основы» пройдены целиком: все уроки готовы и завершены.
  const basicsComplete =
    basicsModules.length > 0 && basicsModules.every((module) => module.lessons.every((lesson) => lesson.ready && data.lessons.get(lesson.id)?.completedAt));
  const moduleStates = new Map<string, LearningState>(
    course.modules.map((module) => [module.id, moduleState(module, data.files.get(module.id), data.lessons, data.exercises, data.reviews)]),
  );

  // Все готовые уроки пройдены — место на маршруте там, где появятся следующие уроки (первый модуль с неготовым
  // уроком), а если готово всё — последний модуль курса (он за «Основами»): пробы и проект открыты, текущего узла
  // в «Основах» нет. С null маршрут посчитал бы пробы и проект ещё закрытыми.
  const routeModuleId =
    target?.module.id ??
    course.modules.find((module) => module.lessons.some((lesson) => !lesson.ready))?.id ??
    course.modules[course.modules.length - 1]?.id ??
    null;

  // Направления: по порядку открытия; закрыта, пока текущий модуль не прошёл модуль открытия.
  const numberOf = (moduleId: string) => course.modules.find((module) => module.id === moduleId)?.number ?? Number.POSITIVE_INFINITY;
  const currentNumber = target ? target.module.number : Number.POSITIVE_INFINITY;
  const labs = course.labs
    .map((lab, order) => ({ lab, order, unlock: numberOf(lab.unlockAfter) }))
    .sort((a, b) => a.unlock - b.unlock || a.order - b.order)
    .slice(0, DIRECTIONS_SHOWN);

  const date = new Date().toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
  const code = exercise ? (exerciseRecord?.draft ?? exercise.starterCode) : '';
  const when = lastCheck ? formatWhen(lastCheck.at) : null;
  // Единственная главная кнопка экрана (e2e клавиатуры ищет «Начать урок» у нового ученика); Enter на странице — то же.
  const go = lessonPath && (
    <a className="btn btn-primary today-go" href={href(lessonPath)} aria-keyshortcuts="Enter">
      {record ? 'Продолжить урок' : 'Начать урок'}
      <ArrowRight aria-hidden="true" />
    </a>
  );

  const resume = (
    <section className="today-resume" aria-labelledby={target ? 'today-resume-label' : undefined}>
      <div className="today-top">
        {/* Всё пройдено — продолжать нечего: метки нет, только минуты сегодня. */}
        {target && (
          <p className="plabel" id="today-resume-label">
            {record ? 'Продолжить' : 'Начать'}
          </p>
        )}
        <MinutesMeter minutes={todayMinutes} />
      </div>

      {target && step ? (
        <>
          <div className={`today-id${scene ? '' : ' no-thumb'}`}>
            {scene && <img className="today-thumb" src={scene} alt="" width={128} height={72} decoding="async" />}
            <div className="today-names">
              <p className="today-addr" aria-hidden="true">
                <span className="today-addr-num">{target.lesson.number}</span>
                <span className="today-addr-sep">·</span>
                <span className="today-addr-file">{exercise ? exercise.filename : step.label}</span>
                <span className="today-caret" />
              </p>
              <h2>
                <span className="visually-hidden">Урок {target.lesson.number}: </span>
                {keepDash(target.lesson.title)}
              </h2>
              <p className="today-meta">
                <span>
                  Модуль <span className="n">{target.module.number}</span> · {keepDash(target.module.title)}
                </span>
                <a href={href(paths.module(target.module.id))}>Все уроки модуля</a>
              </p>
            </div>
          </div>

          <div className="today-flow">
            <FlowSteps steps={steps} groups={flowGroups(steps)} current={current} variant="home" label="Шаги урока" />
            <MiniBar steps={steps} groups={flowGroups(steps)} current={current} />
            <Tag icon={Clock} className="today-len" title="Длительность урока">
              <span className="visually-hidden">Длительность урока: </span>
              <span className="n">
                {target.lesson.minutes[0] === target.lesson.minutes[1]
                  ? target.lesson.minutes[0]
                  : `${target.lesson.minutes[0]}–${target.lesson.minutes[1]}`}
              </span>{' '}
              мин
            </Tag>
          </div>

          {exercise ? (
            <div className="today-peek">
              <div className="today-peek-bar">
                <span className="today-peek-tab">
                  <FileCode2 aria-hidden="true" />
                  {exercise.filename}
                </span>
                <CheckBadge attempt={lastCheck} />
              </div>
              <CodeBlock code={code.split('\n').slice(0, PREVIEW_LINES).join('\n')} label={`Код в ${exercise.filename}`} bare />
              <div className="today-peek-foot">
                {when && (
                  <p className="today-when">
                    Последняя проверка: {when.day}, <span className="n">{when.time}</span>
                  </p>
                )}
                {go}
              </div>
            </div>
          ) : (
            <div className="today-next">
              <div className="today-goal">
                <p className="plabel">Цель урока</p>
                <p className="today-objective">{target.lesson.objective}</p>
              </div>
              {go}
            </div>
          )}
        </>
      ) : (
        <EmptyState
          title="Готовые уроки пройдены"
          icon={CircleCheck}
          action={
            <a className="btn" href={href(paths.course())}>
              Открыть карту курса
            </a>
          }
        >
          Готово уроков: <span className="n">{readyLessons}</span>
        </EmptyState>
      )}
    </section>
  );

  const notice = data.unavailable.length > 0 && (
    <div className="today-notice">
      <Notice
        tone="warn"
        title="Часть уроков не скачана"
        action={
          <a className="btn btn-sm" href={href(paths.settings('offline'))}>
            Скачать
          </a>
        }
      />
    </div>
  );

  const route = (
    <section className={`today-route${basicsComplete ? ' is-complete' : ''}`} aria-labelledby="today-route-title">
      <h2 className="plabel" id="today-route-title">
        <GitBranch aria-hidden="true" />
        Маршрут
      </h2>
      <RouteGraph
        course={course}
        moduleStates={moduleStates}
        currentModuleId={routeModuleId}
        lessonsDone={lessonsDone}
        lessonsTotal={basicsLessons.length}
        finishedModules={finishedModuleIds(course, (id) => Boolean(data.lessons.get(id)?.completedAt))}
      />
    </section>
  );

  const review = (
    <section className="today-sec today-review" aria-labelledby="today-review-title">
      <PaneHead
        id="today-review-title"
        label="На повторение"
        icon={History}
        aside={
          due.length > 0 ? (
            <>
              <span className="n">{due.length}</span> {plural(due.length, ['тема', 'темы', 'тем'])} · ≈{' '}
              <span className="n">{due.length * REVIEW_MINUTES}</span> мин
            </>
          ) : undefined
        }
      />
      {due.length === 0 && (
        <p className="today-empty">
          <span className="today-empty-ic" aria-hidden="true">
            <CalendarCheck />
          </span>
          <span>{upcoming.length > 0 ? `Ближайшее повторение — ${formatDate(upcoming[0].dueAt)}` : 'Повторять пока нечего'}</span>
        </p>
      )}
      {(due.length > 0 || short || practice) && (
        <ul className="rows">
          {due.map((item) => {
            const found = lessonById.get(item.lessonId);
            // Задание — к его шагу; тема урока без задания — к шагу «Итог».
            const index = item.exerciseId
              ? found?.lesson.steps.findIndex((entry) => entry.type === 'exercise' && entry.exercise.id === item.exerciseId)
              : found
                ? found.lesson.steps.length - 1
                : undefined;
            const exerciseStep = found?.lesson.steps.find((entry) => entry.type === 'exercise' && entry.exercise.id === item.exerciseId);
            const title =
              exerciseStep?.type === 'exercise'
                ? exerciseStep.exercise.title
                : found
                  ? `Итог урока «${found.lesson.title}»`
                  : item.key;
            return (
              <li key={item.key}>
                <a className="row" href={href(paths.lesson(item.lessonId, index !== undefined && index >= 0 ? index + 1 : undefined))}>
                  <span className="row-ic today-num" aria-hidden="true">
                    {found?.lesson.number ?? <History />}
                  </span>
                  <span className="row-main">
                    <span className="row-title">{keepDash(title)}</span>
                    <span className="row-sub">{item.reason}</span>
                  </span>
                  <ChevronRight aria-hidden="true" />
                </a>
              </li>
            );
          })}
          {short && (
            <li>
              <div className="row today-short">
                <span className="row-ic today-num" aria-hidden="true">
                  <Timer />
                </span>
                <span className="row-main">
                  <span className="row-title">Если только 10 минут</span>
                  <span className="row-sub">{keepDash(short.text)}</span>
                </span>
                <a className="btn btn-sm" href={href(short.href)} aria-label={`Начать: ${short.text}`}>
                  Начать
                </a>
              </div>
            </li>
          )}
          {practice && target && (
            <li>
              <a className="row" href={href(paths.lesson(target.lesson.id, practice.index))}>
                <span className="row-ic today-num" aria-hidden="true">
                  <PenLine />
                </span>
                <span className="row-main">
                  <span className="row-title">Практика: {keepDash(practice.step.title)}</span>
                  <span className="row-sub">
                    Урок <span className="n">{target.lesson.number}</span> · {practice.step.label}
                  </span>
                </span>
                <ChevronRight aria-hidden="true" />
              </a>
            </li>
          )}
        </ul>
      )}
    </section>
  );

  const dirs = (
    <section className="today-sec today-dirs" aria-labelledby="today-dirs-title">
      <PaneHead
        id="today-dirs-title"
        label="Направления"
        icon={Compass}
        aside={
          <>
            <span className="n">{course.labs.length}</span> {plural(course.labs.length, ['проба', 'пробы', 'проб'])}
          </>
        }
      />
      <ul className="rows">
        {labs.map(({ lab, unlock }) => {
          const Icon = LAB_ICON[lab.id] ?? CodeXml;
          const interest = data.interests.get(lab.id);
          const locked = currentNumber <= unlock;
          return (
            <li key={lab.id}>
              <a className="row" href={href(paths.directions(lab.id))}>
                <span className="row-ic today-num" aria-hidden="true">
                  <Icon />
                </span>
                <span className="row-main">
                  <span className="row-title">{lab.title}</span>
                  {/* Отметка интереса — в строке подписи: название не теряет ширину и не рвётся. */}
                  <span className="row-sub today-dir-sub">
                    <span>
                      {locked ? (
                        <>
                          после модуля <span className="n">{unlock}</span>
                        </>
                      ) : (
                        'открыта'
                      )}
                    </span>
                    {interest && (
                      <StatusBadge tone="accent" icon={Heart}>
                        {interest.status === 'tried' ? 'Пробовал' : 'Интересно'}
                      </StatusBadge>
                    )}
                  </span>
                </span>
                {locked ? (
                  <>
                    <Lock aria-hidden="true" className="today-lock" />
                    <span className="visually-hidden">, закрыто</span>
                  </>
                ) : (
                  <ChevronRight aria-hidden="true" />
                )}
              </a>
            </li>
          );
        })}
      </ul>
      <p className="today-more">
        <a href={href(paths.directions())}>
          Все направления
          <ArrowRight aria-hidden="true" />
        </a>
      </p>
    </section>
  );

  const heading = <h1 className="visually-hidden">Сегодня, {date}</h1>;
  const enter = lessonPath && <EnterOpens path={lessonPath} />;

  // Телефон и планшет в портрете: одна колонка, разметка в видимом порядке (скринридер читает так же, как видно):
  // Продолжить → На повторение → Маршрут → Направления → состояние.
  if (narrow) {
    return (
      <div className="today today-one">
        {heading}
        {enter}
        {resume}
        {notice}
        {review}
        {route}
        {dirs}
        {/* Состояние (Python, сеть, наставник) строкой: на ПК оно в строке состояния. */}
        <div className="today-status">
          <SystemStatus variant="inline" />
        </div>
      </div>
    );
  }

  return (
    <div className="page-split today">
      <div className="today-work">
        <div className="today-main">
          {heading}
          {enter}
          {resume}
          {notice}
          {route}
        </div>
      </div>
      <div className="side today-side">
        {review}
        {dirs}
      </div>
    </div>
  );
}
