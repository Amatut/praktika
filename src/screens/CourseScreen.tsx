import { ArrowRight, CircleCheck, Download, Hourglass, Lock } from 'lucide-react';
import { href, paths } from '../app/router.ts';
import { EmptyState, StatusBadge, formatMinutes, plural } from '../components/ui.tsx';
import type { Course, Lesson, ModuleSummary } from '../content/schema.ts';
import { STATE_LABEL, STATE_TONE, exercisesOf, lessonState, moduleState, type LearningState } from '../progress/model.ts';
import { useLearnerData, type LearnerData } from '../progress/useLearnerData.ts';
import { OfflineModuleControl } from './offline-controls.tsx';
import { PathChips } from './TodayScreen.tsx';

const MATERIAL: Record<ModuleSummary['status'], { tone: 'good' | 'accent' | 'muted'; label: string }> = {
  ready: { tone: 'good', label: 'Материалы готовы' },
  partial: { tone: 'accent', label: 'Готова часть уроков' },
  planned: { tone: 'muted', label: 'Материалы пишутся' },
};

const ENV: Record<ModuleSummary['environment'], string> = {
  browser: 'в браузере',
  local: 'на компьютере',
  mixed: 'браузер + компьютер',
};

function hours([min, max]: [number, number]): string {
  const format = (value: number) => String(value).replace('.', ',');
  return min === max ? `≈ ${format(min)} ч` : `≈ ${format(min)}–${format(max)} ч`;
}

export function CourseScreen({ course }: { course: Course }) {
  const { data } = useLearnerData(course);
  const lessonsTotal = course.modules.reduce((sum, module) => sum + module.lessons.length, 0);
  const lessonsReady = course.modules.reduce((sum, module) => sum + module.lessons.filter((lesson) => lesson.ready).length, 0);
  const modulesReady = course.modules.filter((module) => module.status === 'ready').length;
  const labsReady = course.labs.filter((lab) => lab.ready).length;
  const parts: { id: ModuleSummary['part']; title: string }[] = [
    { id: 'basics', title: 'Общая база на Python' },
    { id: 'deepening', title: 'Углубление и итоговый проект' },
  ];

  return (
    <div className="page">
      <header className="page-head">
        <span className="eyebrow">Курс</span>
        <h1>Карта курса</h1>
        <p className="page-lead">
          Основы → короткие пробы разных направлений → твой выбор → проекты. Пробы открываются по ходу базы: не нужно
          проходить её целиком до первой интересной лаборатории.
        </p>
        <div style={{ marginTop: 8 }}>
          <PathChips course={course} current="basics" />
        </div>
      </header>

      <section className="card readiness-card" aria-labelledby="readiness-title">
        <div className="card-head">
          <div>
            <h2 id="readiness-title" className="card-title">
              Что уже готово
            </h2>
            <p className="card-sub">Готовность приложения и полнота курса — разные вещи. Здесь честный счёт материалов.</p>
          </div>
        </div>
        <div className="readiness">
          <div className="readiness-item">
            <span className="readiness-value">
              {lessonsReady} из {lessonsTotal}
            </span>
            <span className="readiness-label">уроков написано</span>
          </div>
          <div className="readiness-item">
            <span className="readiness-value">
              {modulesReady} из {course.modules.length}
            </span>
            <span className="readiness-label">модулей полностью готовы</span>
          </div>
          <div className="readiness-item">
            <span className="readiness-value">
              {labsReady} из {course.labs.length}
            </span>
            <span className="readiness-label">лабораторий готовы</span>
          </div>
          <div className="readiness-item">
            <span className="readiness-value">
              {course.projects.filter((project) => project.ready).length} из {course.projects.length}
            </span>
            <span className="readiness-label">проектов готовы</span>
          </div>
        </div>
      </section>

      {parts.map((part) => (
        <section key={part.id} aria-labelledby={`part-${part.id}`}>
          <h2 id={`part-${part.id}`} className="part-title">
            {part.title}
          </h2>
          <ul className="module-list">
            {course.modules
              .filter((module) => module.part === part.id)
              .map((module) => (
                <li key={module.id}>
                  <ModuleCard module={module} data={data} />
                </li>
              ))}
          </ul>
        </section>
      ))}

      <section className="section" aria-labelledby="projects-link">
        <div className="section-head">
          <h2 id="projects-link" className="section-title">
            Проекты
          </h2>
          <a className="btn btn-ghost btn-sm" href={href(paths.projects())}>
            Все проекты
            <ArrowRight aria-hidden="true" />
          </a>
        </div>
        <p className="small muted">
          Лестница из {course.projects.length} {plural(course.projects.length, ['проекта', 'проектов', 'проектов'])}: от консольной
          программы до личного менеджера задач с базой данных, тестами и README.
        </p>
      </section>
    </div>
  );
}

function ModuleCard({ module, data }: { module: ModuleSummary; data: LearnerData | null }) {
  const state: LearningState = data
    ? moduleState(module, data.files.get(module.id), data.lessons, data.exercises, data.reviews)
    : 'not-started';
  const material = MATERIAL[module.status];
  const readyCount = module.lessons.filter((lesson) => lesson.ready).length;
  return (
    <a
      className="module-card"
      href={href(paths.module(module.id))}
      data-state={state}
      data-planned={module.status === 'planned'}
      aria-label={`Модуль ${module.number}. ${module.title}. ${STATE_LABEL[state]}. ${material.label}.`}
    >
      <span className="module-num" aria-hidden="true">
        {module.number}
      </span>
      <span>
        <span className="module-title">{module.title}</span>
        <span className="module-sub">
          {module.lessons.length} {plural(module.lessons.length, ['урок', 'урока', 'уроков'])} · {hours(module.hours)} ·{' '}
          {ENV[module.environment]}
          {module.status === 'partial' ? ` · готово ${readyCount}` : ''}
        </span>
      </span>
      <span className="module-badges">
        {module.status !== 'planned' && <StatusBadge tone={STATE_TONE[state]}>{STATE_LABEL[state]}</StatusBadge>}
        <StatusBadge tone={material.tone} icon={module.status !== 'planned'}>
          {material.label}
        </StatusBadge>
      </span>
    </a>
  );
}

export function ModuleScreen({ course, moduleId }: { course: Course; moduleId: string }) {
  const { data } = useLearnerData(course);
  const module = course.modules.find((item) => item.id === moduleId);
  if (!module) {
    return (
      <div className="page page-narrow">
        <EmptyState
          title="Модуль не найден"
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

  return (
    <div className="page">
      <header className="page-head">
        <a className="eyebrow" href={href(paths.course())} style={{ textDecoration: 'none' }}>
          ← Курс · модуль {module.number}
        </a>
        <h1>{module.title}</h1>
        <p className="page-lead">{module.why}</p>
        <div className="row" style={{ marginTop: 4 }}>
          {module.status !== 'planned' && <StatusBadge tone={STATE_TONE[state]}>{STATE_LABEL[state]}</StatusBadge>}
          <StatusBadge tone={MATERIAL[module.status].tone}>{MATERIAL[module.status].label}</StatusBadge>
          <span className="badge">{hours(module.hours)} учебного времени</span>
          <span className="badge">Среда: {ENV[module.environment]}</span>
        </div>
      </header>

      <div className="module-detail">
        <section aria-labelledby="lessons-title" className="stack">
          <div className="section-head">
            <h2 id="lessons-title" className="section-title">
              Уроки
            </h2>
            {module.file && <OfflineModuleControl moduleId={module.id} compact />}
          </div>
          <ul className="lesson-rows">
            {module.lessons.map((summary, lessonIndex) => {
              const lesson = lessonsById.get(summary.id);
              if (summary.ready && !data) {
                // Данные ещё загружаются или хранилище недоступно (об этом говорит баннер): урок открывается,
                // а «нет сети» писать нельзя — это ещё не известно.
                return (
                  <li key={summary.id}>
                    <a className="lesson-row" href={href(paths.lesson(summary.id))}>
                      <span className="lesson-row-num">{summary.number ?? `${module.number}.${lessonIndex + 1}`}</span>
                      <span>
                        <span className="list-row-title">{summary.title}</span>
                        {summary.minutes && (
                          <span className="list-row-sub" style={{ display: 'block' }}>
                            {formatMinutes(summary.minutes)}
                          </span>
                        )}
                      </span>
                      <span />
                    </a>
                  </li>
                );
              }
              if (!summary.ready || !lesson) {
                return (
                  <li key={summary.id}>
                    <div className="lesson-row" data-ready="false">
                      <span className="lesson-row-num">
                        {module.number}.{lessonIndex + 1}
                      </span>
                      <span>
                        <span className="list-row-title">{summary.title}</span>
                        <span className="list-row-sub" style={{ display: 'block' }}>
                          {summary.ready ? 'Нет сети: урок не скачан' : 'Урок ещё не написан'}
                        </span>
                      </span>
                      <span className="badge">
                        <Lock aria-hidden="true" />
                        {summary.ready ? 'Недоступен офлайн' : 'Скоро'}
                      </span>
                    </div>
                  </li>
                );
              }
              const lessonStateValue = data
                ? lessonState(lesson, data.lessons.get(lesson.id), data.exercises, data.reviews)
                : 'not-started';
              const exercises = exercisesOf(lesson);
              const passed = exercises.filter((exercise) => data?.exercises.get(exercise.id)?.status === 'passed').length;
              return (
                <li key={summary.id}>
                  <a className="lesson-row" href={href(paths.lesson(lesson.id))}>
                    <span className="lesson-row-num">{lesson.number}</span>
                    <span>
                      <span className="list-row-title">{lesson.title}</span>
                      <span className="list-row-sub" style={{ display: 'block' }}>
                        {formatMinutes(lesson.minutes)} ·{' '}
                        {exercises.length > 0 ? `заданий решено ${passed} из ${exercises.length}` : 'без автопроверки'}
                        {lesson.environment === 'external' ? ' · на компьютере' : ''}
                      </span>
                    </span>
                    <StatusBadge tone={STATE_TONE[lessonStateValue]}>{STATE_LABEL[lessonStateValue]}</StatusBadge>
                  </a>
                </li>
              );
            })}
          </ul>
          <div className="row-between">
            {previous ? (
              <a className="btn btn-ghost" href={href(paths.module(previous.id))}>
                ← Модуль {previous.number}
              </a>
            ) : (
              <span />
            )}
            {next && (
              <a className="btn btn-ghost" href={href(paths.module(next.id))}>
                Модуль {next.number} →
              </a>
            )}
          </div>
        </section>

        <aside className="stack" aria-label="О модуле">
          <section className="card card-tight">
            <h2 className="card-title">Навыки на выходе</h2>
            <ul className="bullets small" style={{ marginTop: 8 }}>
              {module.outcomes.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>
          <section className="card card-tight">
            <h2 className="card-title">Модуль завершён, когда</h2>
            <p className="small" style={{ marginTop: 8 }}>
              {module.completion}
            </p>
            {skills.length > 0 && (
              <p className="small muted" style={{ marginTop: 8 }}>
                Навыки: {skills.map((skill) => skill.title).join(', ')}.
              </p>
            )}
          </section>
          <details className="disclosure">
            <summary>Что нужно знать заранее</summary>
            <div className="disclosure-body">
              <ul className="bullets small">
                {module.prerequisites.length > 0 ? module.prerequisites.map((item) => <li key={item}>{item}</li>) : <li>Ничего — можно начинать с нуля.</li>}
              </ul>
            </div>
          </details>
          <details className="disclosure">
            <summary>Практика в модуле</summary>
            <div className="disclosure-body small">{module.practice}</div>
          </details>
          <details className="disclosure">
            <summary>Типичные ошибки</summary>
            <div className="disclosure-body">
              <ul className="bullets small">
                {module.mistakes.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          </details>
          {module.status !== 'ready' && (
            <p className="small muted row" style={{ gap: 6 }}>
              <Hourglass aria-hidden="true" width={14} height={14} />
              Недостающие уроки появятся с обновлением материалов. Прогресс при этом сохранится.
            </p>
          )}
          {module.status === 'ready' && data && state === 'mastered' && (
            <p className="small status-good row" style={{ gap: 6 }}>
              <CircleCheck aria-hidden="true" width={14} height={14} />
              Все уроки модуля освоены: задания решены сам или с первой подсказкой.
            </p>
          )}
          {module.file && (
            <p className="tiny muted row" style={{ gap: 6 }}>
              <Download aria-hidden="true" width={13} height={13} />
              Уроки модуля можно скачать для работы без сети.
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}
