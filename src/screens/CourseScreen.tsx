import { ArrowRight, ChevronLeft, ChevronRight, Clock, CloudOff, Flag, FolderCode, Hourglass, ListChecks, Lock, Monitor, SearchX, Target } from 'lucide-react';
import { Fragment, type ReactNode } from 'react';
import { href, paths } from '../app/router.ts';
import { RouteGraph, finishedModuleIds } from '../components/RouteGraph.tsx';
import { Disclosure, EmptyState, PaneHead, StatusBadge, Tag, formatMinutes, plural } from '../components/ui.tsx';
import type { Course, Lesson, ModuleSummary } from '../content/schema.ts';
import {
  STATE_LABEL,
  STATE_TONE,
  exercisesOf,
  lessonState,
  moduleState,
  skillProgress,
  suggestNextLesson,
  type LearningState,
} from '../progress/model.ts';
import { useLearnerData, type LearnerData } from '../progress/useLearnerData.ts';
import { OfflineModuleControl } from './offline-controls.tsx';

// Карта курса и экран модуля в духе проводника редактора: ряды на линиях, моноширинные номера, статус — значок + слово.
// Пояснений «как устроен экран» нет: только данные курса (why, outcomes, completion…) и короткие метки.

const MATERIAL: Record<ModuleSummary['status'], { tone: 'ok' | 'muted'; label: string; short: string }> = {
  ready: { tone: 'ok', label: 'Материалы готовы', short: 'Готово' },
  partial: { tone: 'muted', label: 'Готова часть уроков', short: 'Готова часть' },
  planned: { tone: 'muted', label: 'Материалы пишутся', short: 'Пишется' },
};

const ENV: Record<ModuleSummary['environment'], string> = {
  browser: 'в браузере',
  local: 'на компьютере',
  mixed: 'браузер + компьютер',
};

const PARTS: { id: ModuleSummary['part']; title: string }[] = [
  { id: 'basics', title: 'Общая база на Python' },
  { id: 'deepening', title: 'Углубление и итоговый проект' },
];

const decimal = (value: number) => String(value).replace('.', ',');

function hours([min, max]: [number, number]): string {
  return min === max ? `${decimal(min)} ч` : `${decimal(min)}–${decimal(max)} ч`;
}

/** Подпись ряда «4 урока · ≈ 1,5–3 ч · браузер + компьютер»: строка ломается только на точках, точка остаётся в конце строки. */
function Parts({ items }: { items: (ReactNode | false | null)[] }) {
  const shown = items.filter((item) => item !== false && item !== null);
  return (
    <>
      {shown.map((item, index) => (
        <Fragment key={index}>
          {index > 0 && <>&nbsp;·{' '}</>}
          <span className="nowrap">{item}</span>
        </Fragment>
      ))}
    </>
  );
}

/** Урок, на котором ученик сейчас: открытый и не завершённый, иначе первый незавершённый (как на «Сегодня»). */
function currentLesson(course: Course, data: LearnerData): { module: ModuleSummary; lesson: Lesson } | null {
  const id = data.meta.currentLessonId;
  if (id && !data.lessons.get(id)?.completedAt) {
    for (const module of course.modules) {
      const lesson = data.files.get(module.id)?.lessons.find((item) => item.id === id);
      if (lesson) return { module, lesson };
    }
  }
  return suggestNextLesson(course, data.files, data.lessons, data.exercises);
}

function statesOf(course: Course, data: LearnerData | null): Map<string, LearningState> {
  const states = new Map<string, LearningState>();
  for (const module of course.modules) {
    states.set(module.id, data ? moduleState(module, data.files.get(module.id), data.lessons, data.exercises, data.reviews) : 'not-started');
  }
  return states;
}

function lessonsCompleted(module: ModuleSummary, data: LearnerData | null): number {
  if (!data) return 0;
  return module.lessons.filter((lesson) => data.lessons.get(lesson.id)?.completedAt).length;
}

/** Номер в квадрате: текущий — янтарный, освоенный — на зелёной подложке. Слово «Сейчас» / состояние — в бейдже ряда. */
function RowNumber({ value, current, mastered }: { value: string | number; current?: boolean; mastered?: boolean }) {
  const kind = current ? ' is-current' : mastered ? ' is-mastered' : '';
  return (
    <span className={`row-ic cmap-num n${kind}`} aria-hidden="true">
      {value}
    </span>
  );
}

/**
 * Состояние ряда словом. «Не начат» у каждого ряда — шум: он остаётся только для скринридера (hidden),
 * а у текущего не начатого ряда видно «Сейчас».
 */
function stateBadge(state: LearningState, current: boolean): { badge: ReactNode; hidden: string | null } {
  if (state !== 'not-started') return { badge: <StatusBadge tone={STATE_TONE[state]}>{STATE_LABEL[state]}</StatusBadge>, hidden: null };
  if (current) return { badge: <StatusBadge tone="accent">Сейчас</StatusBadge>, hidden: null };
  return { badge: null, hidden: STATE_LABEL[state] };
}

// ------------------------------------------------------------ карта курса

export function CourseScreen({ course }: { course: Course }) {
  const { data } = useLearnerData(course);
  const lessonsTotal = course.modules.reduce((sum, module) => sum + module.lessons.length, 0);
  const lessonsReady = course.modules.reduce((sum, module) => sum + module.lessons.filter((lesson) => lesson.ready).length, 0);
  const modulesReady = course.modules.filter((module) => module.status === 'ready').length;
  const labsReady = course.labs.filter((lab) => lab.ready).length;
  const projectsReady = course.projects.filter((project) => project.ready).length;
  const states = statesOf(course, data);
  const current = data ? currentLesson(course, data) : null;
  // Под узлом «Основы» — готовые уроки части «Основы», как на «Сегодня» (тот же граф — те же числа).
  const basicsLessons = course.modules.filter((module) => module.part === 'basics').flatMap((module) => module.lessons.filter((lesson) => lesson.ready));
  const basicsDone = data ? basicsLessons.filter((lesson) => data.lessons.get(lesson.id)?.completedAt).length : 0;
  const firstProjectAfter = course.modules.find((module) => module.id === course.projects[0]?.after);

  const counts: { label: string; done: number; total: number; sr: string }[] = [
    { label: 'Уроки', done: lessonsReady, total: lessonsTotal, sr: 'уроков готово' },
    { label: 'Модули', done: modulesReady, total: course.modules.length, sr: 'модулей готово' },
    { label: 'Пробы', done: labsReady, total: course.labs.length, sr: 'проб направлений готово' },
    { label: 'Проекты', done: projectsReady, total: course.projects.length, sr: 'проектов готово' },
  ];

  return (
    <div className="page cmap">
      <header className="page-head">
        <h1>Карта курса</h1>
        {/* Счёт написанных материалов, не прогресс ученика: метка «Материалы» стоит перед числами. */}
        <div className="cmap-materials">
          <span className="plabel" id="cmap-materials">
            Материалы
          </span>
          <ul className="cmap-counts" aria-labelledby="cmap-materials">
            {counts.map((item) => (
              <li key={item.label}>
                <span aria-hidden="true">{item.label}</span>
                <span className="n cmap-count-value" aria-hidden="true">
                  {item.done} / {item.total}
                </span>
                <span className="visually-hidden">
                  {item.done} из {item.total} {item.sr}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </header>

      <section className="cmap-section" aria-labelledby="route-title">
        <h2 id="route-title" className="plabel cmap-label">
          Маршрут
        </h2>
        <RouteGraph
          course={course}
          moduleStates={states}
          currentModuleId={current?.module.id ?? null}
          lessonsDone={basicsDone}
          lessonsTotal={basicsLessons.length}
          finishedModules={data ? finishedModuleIds(course, (id) => Boolean(data.lessons.get(id)?.completedAt)) : undefined}
        />
      </section>

      {PARTS.map((part) => {
        const modules = course.modules.filter((module) => module.part === part.id);
        if (modules.length === 0) return null;
        const min = modules.reduce((sum, module) => sum + module.hours[0], 0);
        const max = modules.reduce((sum, module) => sum + module.hours[1], 0);
        return (
          <section key={part.id} className="cmap-section" aria-labelledby={`part-${part.id}`}>
            <div className="cmap-part-head">
              <h2 id={`part-${part.id}`}>{part.title}</h2>
              <span className="cmap-part-meta">
                <Parts items={[`${modules.length} ${plural(modules.length, ['модуль', 'модуля', 'модулей'])}`, `≈ ${hours([min, max])}`]} />
              </span>
            </div>
            <ul className="rows cmap-rows">
              {modules.map((module) => (
                <li key={module.id}>
                  <ModuleRow
                    module={module}
                    state={states.get(module.id) ?? 'not-started'}
                    current={current?.module.id === module.id}
                    completed={lessonsCompleted(module, data)}
                    known={Boolean(data)}
                  />
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      <section className="cmap-section" aria-labelledby="course-projects">
        <div className="cmap-part-head">
          <h2 id="course-projects">Проекты</h2>
          <span className="cmap-part-meta">
            <span className="n">{course.projects.length}</span> {plural(course.projects.length, ['проект', 'проекта', 'проектов'])}
          </span>
        </div>
        <ul className="rows cmap-rows">
          <li>
            <a className="row cmap-row" href={href(paths.projects())}>
              <span className="row-ic" aria-hidden="true">
                <FolderCode />
              </span>
              <span className="row-main">
                <span className="row-title cmap-title">Лестница проектов</span>
                {firstProjectAfter && <span className="row-sub">первый — после модуля {firstProjectAfter.number}</span>}
              </span>
              {projectsReady < course.projects.length && (
                <span className="cmap-badges">
                  <StatusBadge tone="muted" icon={Hourglass}>
                    {projectsReady === 0 ? 'Материалы пишутся' : `Готово ${projectsReady} из ${course.projects.length}`}
                  </StatusBadge>
                </span>
              )}
              <ChevronRight className="cmap-chevron" aria-hidden="true" />
            </a>
          </li>
        </ul>
      </section>
    </div>
  );
}

function ModuleRow({
  module,
  state,
  current,
  completed,
  known,
}: {
  module: ModuleSummary;
  state: LearningState;
  current: boolean;
  completed: number;
  known: boolean;
}) {
  const material = MATERIAL[module.status];
  const readyCount = module.lessons.filter((lesson) => lesson.ready).length;
  const total = module.lessons.length;
  const planned = module.status === 'planned';
  const learning = !planned && known ? stateBadge(state, current) : { badge: null, hidden: null };
  // «Материалы готовы» у каждого ряда — шум; готовность всех модулей — в счётчиках шапки.
  const materialBadge = module.status !== 'ready' && (
    <StatusBadge tone={material.tone} icon={Hourglass}>
      {material.short}
    </StatusBadge>
  );

  // Имя ряда для скринридера — его видимый текст: «Модуль 0. Что такое программа, 4 урока · … Сейчас».
  const body = (
    <>
      <RowNumber value={module.number} current={current} mastered={state === 'mastered'} />
      <span className="row-main">
        <span className="row-title cmap-title">
          <span className="visually-hidden">Модуль {module.number}. </span>
          {module.title}
        </span>
        <span className="row-sub">
          <Parts
            items={[
              `${total} ${plural(total, ['урок', 'урока', 'уроков'])}`,
              `≈ ${hours(module.hours)}`,
              ENV[module.environment],
              module.status === 'partial' && `готово ${readyCount}`,
              completed > 0 && `пройдено ${completed} из ${total}`,
            ]}
          />
        </span>
        {learning.hidden && <span className="visually-hidden">, {learning.hidden}</span>}
      </span>
      {(learning.badge || materialBadge) && (
        <span className="cmap-badges">
          {learning.badge}
          {materialBadge}
        </span>
      )}
    </>
  );

  if (planned) {
    return (
      <div className="row cmap-row is-planned">
        {body}
        <span className="cmap-chevron" aria-hidden="true" />
      </div>
    );
  }
  return (
    <a className="row cmap-row" href={href(paths.module(module.id))}>
      {body}
      <ChevronRight className="cmap-chevron" aria-hidden="true" />
    </a>
  );
}

// ------------------------------------------------------------ модуль

/** Урок для главной кнопки модуля: текущий, если он в этом модуле, иначе первый незавершённый из скачанных. */
function nextLessonIn(module: ModuleSummary, data: LearnerData | null, current: { module: ModuleSummary; lesson: Lesson } | null): Lesson | null {
  const file = data?.files.get(module.id);
  if (!data || !file) return null;
  if (current?.module.id === module.id) return current.lesson;
  const ready = new Set(module.lessons.filter((lesson) => lesson.ready).map((lesson) => lesson.id));
  return file.lessons.find((lesson) => ready.has(lesson.id) && !data.lessons.get(lesson.id)?.completedAt) ?? null;
}

export function ModuleScreen({ course, moduleId }: { course: Course; moduleId: string }) {
  const { data } = useLearnerData(course);
  const module = course.modules.find((item) => item.id === moduleId);
  if (!module) {
    return (
      <div className="page">
        <EmptyState
          as="h1"
          title="Модуль не найден"
          icon={SearchX}
          action={
            <a className="btn" href={href(paths.course())}>
              К карте курса
            </a>
          }
        />
      </div>
    );
  }
  const file = data?.files.get(module.id);
  const lessonsById = new Map<string, Lesson>((file?.lessons ?? []).map((lesson) => [lesson.id, lesson]));
  const state = data ? moduleState(module, file, data.lessons, data.exercises, data.reviews) : 'not-started';
  const index = course.modules.indexOf(module);
  const previous = course.modules[index - 1];
  const next = course.modules[index + 1];
  const skills = course.skills.filter((skill) => skill.module === module.id);
  const current = data ? currentLesson(course, data) : null;
  const material = MATERIAL[module.status];
  const target = nextLessonIn(module, data, current);

  // Навыки считаются по всем урокам курса: задание позднего модуля тоже может тренировать навык этого.
  const allLessons = data ? [...data.files.values()].flatMap((item) => item.lessons) : [];
  const skillStates = new Map<string, LearningState>(
    data ? skills.map((skill) => [skill.id, skillProgress(skill.id, allLessons, data.lessons, data.exercises, data.reviews).state]) : [],
  );
  const skillsMastered = [...skillStates.values()].filter((value) => value === 'mastered').length;

  const exercisesTotal = file ? file.lessons.reduce((sum, lesson) => sum + exercisesOf(lesson).length, 0) : 0;
  const exercisesPassed = file && data
    ? file.lessons.reduce((sum, lesson) => sum + exercisesOf(lesson).filter((item) => data.exercises.get(item.id)?.status === 'passed').length, 0)
    : 0;

  return (
    <div className="page-split module-split">
      <div className="page module-main">
        <a className="btn btn-ghost btn-sm module-back" href={href(paths.course())}>
          <ChevronLeft aria-hidden="true" />
          Карта курса
        </a>
        <header className="page-head module-head">
          {/* Номер — шрифтом заголовка: моноширинный ноль с точкой посреди фразы читается как «θ». */}
          <h1>
            <span className="module-h1-num">Модуль {module.number} ·</span> {module.title}
          </h1>
          <p className="prose module-why">{module.why}</p>
          <div className="module-tags">
            {module.status !== 'planned' && data && <StatusBadge tone={STATE_TONE[state]}>{STATE_LABEL[state]}</StatusBadge>}
            <StatusBadge tone={material.tone} icon={module.status === 'ready' ? true : Hourglass}>
              {material.label}
            </StatusBadge>
            <Tag icon={Clock}>≈ {hours(module.hours)}</Tag>
            <Tag icon={Monitor}>{ENV[module.environment]}</Tag>
          </div>
          {target && (
            <div className="module-actions">
              <a className="btn btn-primary btn-sm" href={href(paths.lesson(target.id))}>
                <span>
                  {data?.lessons.get(target.id) ? 'Продолжить урок' : 'Начать урок'} {target.number}
                </span>
                <ArrowRight aria-hidden="true" />
              </a>
            </div>
          )}
        </header>

        <section className="module-lessons" aria-labelledby="lessons-title">
          <div className="module-lessons-head">
            <h2 id="lessons-title" className="plabel">
              Уроки
            </h2>
            <span className="module-lessons-meta">
              <Parts
                items={[
                  <span key="count" className="n">
                    {module.lessons.length}
                  </span>,
                  exercisesTotal > 0 && (
                    <>
                      решено заданий <span className="n">{exercisesPassed}</span> из <span className="n">{exercisesTotal}</span>
                    </>
                  ),
                ]}
              />
            </span>
            {module.file && (
              <span className="module-offline">
                <OfflineModuleControl moduleId={module.id} number={module.number} compact />
              </span>
            )}
          </div>
          <ul className="rows cmap-rows">
            {module.lessons.map((summary, lessonIndex) => (
              <li key={summary.id}>
                <LessonRow
                  summary={summary}
                  number={summary.number ?? `${module.number}.${lessonIndex + 1}`}
                  lesson={lessonsById.get(summary.id)}
                  data={data}
                  current={current?.lesson.id === summary.id}
                />
              </li>
            ))}
          </ul>
          <nav className="module-pager" aria-label="Соседние модули">
            {previous ? <PagerLink module={previous} direction="prev" /> : <span />}
            {next && <PagerLink module={next} direction="next" />}
          </nav>
        </section>
      </div>

      {/* Боковые секции — как у «Сегодня» и «Прогресса»: метка панели (1–2 слова) со значком на линии. */}
      <aside className="side module-side" aria-label="О модуле">
        <section className="module-sec" aria-labelledby="outcomes-title">
          <PaneHead id="outcomes-title" label="Результат" icon={Target} />
          <div className="module-sec-body">
            <ul className="bullets module-text">
              {module.outcomes.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        </section>

        <section className="module-sec" aria-labelledby="completion-title">
          <PaneHead id="completion-title" label="Завершение" icon={Flag} />
          <div className="module-sec-body">
            <p className="module-text">{module.completion}</p>
            {module.status === 'ready' && data && state === 'mastered' && <StatusBadge tone="ok">Модуль освоен</StatusBadge>}
          </div>
        </section>

        {skills.length > 0 && (
          <section className="module-sec" aria-labelledby="skills-title">
            <PaneHead
              id="skills-title"
              label="Навыки"
              icon={ListChecks}
              aside={
                data ? (
                  <>
                    освоено <span className="n">{skillsMastered}</span> из <span className="n">{skills.length}</span>
                  </>
                ) : undefined
              }
            />
            <div className="module-sec-body">
              <ul className="module-skills">
                {skills.map((skill) => {
                  const skillState = skillStates.get(skill.id);
                  return (
                    <li key={skill.id}>
                      <span className="module-skill-main">
                        <span className="module-skill-name">{skill.title}</span>
                        <span className="module-skill-text">{skill.description}</span>
                      </span>
                      {skillState &&
                        (skillState === 'not-started' ? (
                          <span className="visually-hidden">, {STATE_LABEL[skillState]}</span>
                        ) : (
                          <StatusBadge tone={STATE_TONE[skillState]}>{STATE_LABEL[skillState]}</StatusBadge>
                        ))}
                    </li>
                  );
                })}
              </ul>
            </div>
          </section>
        )}

        <div className="module-more">
          {module.prerequisites.length > 0 && (
            <Disclosure summary="Что нужно знать заранее">
              <ul className="bullets module-text">
                {module.prerequisites.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </Disclosure>
          )}
          <Disclosure summary="Практика в модуле">
            <p className="module-text">{module.practice}</p>
          </Disclosure>
          <Disclosure summary="Типичные ошибки">
            <ul className="bullets module-text">
              {module.mistakes.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </Disclosure>
        </div>
      </aside>
    </div>
  );
}

/** Соседний модуль: номер и название (название видно и на касании, не только во всплывающей подсказке). */
function PagerLink({ module, direction }: { module: ModuleSummary; direction: 'prev' | 'next' }) {
  const Icon = direction === 'prev' ? ChevronLeft : ChevronRight;
  return (
    <a className={`module-pager-link is-${direction}`} href={href(paths.module(module.id))}>
      <Icon aria-hidden="true" />
      <span className="module-pager-text">
        <span className="module-pager-num">Модуль {module.number}</span>
        <span className="module-pager-title">{module.title}</span>
      </span>
    </a>
  );
}

function LessonRow({
  summary,
  number,
  lesson,
  data,
  current,
}: {
  summary: ModuleSummary['lessons'][number];
  number: string;
  lesson: Lesson | undefined;
  data: LearnerData | null;
  current: boolean;
}) {
  // Номер урока для скринридера — в начале названия (квадрат с номером скрыт): «Урок 0.1. Программа…».
  const title = (text: string, value: string) => (
    <span className="row-title">
      <span className="visually-hidden">Урок {value}. </span>
      {text}
    </span>
  );

  // Данные ещё загружаются или хранилище недоступно (об этом говорит баннер): урок открывается,
  // а «не скачан» писать нельзя — это ещё не известно.
  if (summary.ready && !data) {
    return (
      <a className="row cmap-row" href={href(paths.lesson(summary.id))}>
        <RowNumber value={number} />
        <span className="row-main">
          {title(summary.title, number)}
          {summary.minutes && <span className="row-sub">{formatMinutes(summary.minutes)}</span>}
        </span>
        <ChevronRight className="cmap-chevron" aria-hidden="true" />
      </a>
    );
  }

  if (!summary.ready || !lesson) {
    const offline = summary.ready;
    return (
      <div className="row cmap-row is-planned">
        <RowNumber value={number} />
        <span className="row-main">
          {title(summary.title, number)}
          {summary.minutes && <span className="row-sub">{formatMinutes(summary.minutes)}</span>}
        </span>
        <span className="cmap-badges">
          <StatusBadge tone="muted" icon={offline ? CloudOff : Lock}>
            {offline ? 'Не скачан' : 'Скоро'}
          </StatusBadge>
        </span>
        <span className="cmap-chevron" aria-hidden="true" />
      </div>
    );
  }

  const state = lessonState(lesson, data?.lessons.get(lesson.id), data?.exercises ?? new Map(), data?.reviews ?? []);
  const exercises = exercisesOf(lesson);
  const passed = exercises.filter((exercise) => data?.exercises.get(exercise.id)?.status === 'passed').length;
  const learning = stateBadge(state, current);
  return (
    <a className="row cmap-row" href={href(paths.lesson(lesson.id))}>
      <RowNumber value={lesson.number} current={current} mastered={state === 'mastered'} />
      <span className="row-main">
        {title(lesson.title, lesson.number)}
        <span className="row-sub">
          <Parts
            items={[
              formatMinutes(lesson.minutes),
              exercises.length > 0 ? `решено ${passed} из ${exercises.length}` : 'без автопроверки',
              lesson.environment === 'external' && 'на компьютере',
            ]}
          />
        </span>
        {learning.hidden && <span className="visually-hidden">, {learning.hidden}</span>}
      </span>
      {learning.badge && <span className="cmap-badges">{learning.badge}</span>}
      <ChevronRight className="cmap-chevron" aria-hidden="true" />
    </a>
  );
}
