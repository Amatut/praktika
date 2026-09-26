import { Copy, Download } from 'lucide-react';
import { useState } from 'react';
import { useSettings } from '../app/hooks.ts';
import { href, paths } from '../app/router.ts';
import { errorCategory } from '../coach/errors-ru.ts';
import { EmptyState, PendingData, StatusBadge, formatDate, plural } from '../components/ui.tsx';
import type { Course, Lesson } from '../content/schema.ts';
import {
  HELP_LABEL,
  SELF_CHECK_LABEL,
  STATE_LABEL,
  STATE_TONE,
  skillProgress,
  suggestNextLesson,
  type SelfMarks,
  type SkillProgress,
} from '../progress/model.ts';
import { useLearnerData, type LearnerData } from '../progress/useLearnerData.ts';
import { isDue, localDateKey } from '../storage/schedule.ts';
import type { InterestRecord } from '../storage/types.ts';

function lastDays(count: number): string[] {
  const days: string[] = [];
  const date = new Date();
  for (let i = count - 1; i >= 0; i -= 1) {
    const day = new Date(date);
    day.setDate(date.getDate() - i);
    days.push(localDateKey(day));
  }
  return days;
}

const INTEREST_STATUS: Record<InterestRecord['status'], string> = { curious: 'интересно', tried: 'пробовал' };
const CONTINUE_LABEL: Record<NonNullable<InterestRecord['continue']>, string> = { yes: 'да', maybe: 'возможно', no: 'пока нет' };

/** Что именно ученик отметил в уроке без автопроверки: пункты чек-листов и самооценка. */
function marksText(marks: SelfMarks): string {
  const parts: string[] = [];
  if (marks.checklistTotal > 0) parts.push(`отмечено пунктов ${marks.checklistDone} из ${marks.checklistTotal}`);
  parts.push(marks.selfCheck ? `самооценка «${SELF_CHECK_LABEL[marks.selfCheck]}»` : 'самооценки в итоге нет');
  return `«${marks.lessonTitle}»: ${parts.join(', ')}`;
}

function selfMarksTouched(progress: SkillProgress): SelfMarks[] {
  return (progress.selfMarks ?? []).filter((marks) => marks.checklistDone > 0 || marks.selfCheck !== null || marks.completedAt !== null);
}

function evidenceText(progress: SkillProgress): string {
  if (progress.selfReported) {
    const touched = selfMarksTouched(progress);
    if (touched.length === 0) return 'Без автоматической проверки: освоение подтверждают твои отметки в уроке. Отметок пока нет.';
    return `По твоим отметкам, без автоматической проверки: ${touched.map(marksText).join('; ')}.`;
  }
  if (progress.evidence.length === 0) {
    return progress.attemptedExercises > 0 ? 'Есть попытки, решённых заданий пока нет.' : 'Ещё не было попыток.';
  }
  return progress.evidence.map((item) => `«${item.exerciseTitle}» — ${HELP_LABEL[item.help]} (${formatDate(item.at)})`).join('; ');
}

export function ProgressScreen({ course }: { course: Course }) {
  const { data, error } = useLearnerData(course);
  const settings = useSettings();
  if (!data) return <PendingData error={error} />;
  const lessons: Lesson[] = [...data.files.values()].flatMap((file) => file.lessons);
  const modulesWithContent = course.modules.filter((module) => data.files.has(module.id));
  const skillStates = new Map(
    course.skills.map((skill) => [skill.id, skillProgress(skill.id, lessons, data.lessons, data.exercises, data.reviews)]),
  );

  // Повторяющиеся ошибки — по реальным попыткам.
  const errors = new Map<string, { label: string; count: number; last: number }>();
  for (const attempt of data.attempts) {
    if (!attempt.errorType) continue;
    const category = errorCategory(attempt.errorType);
    const item = errors.get(category.key) ?? { label: category.label, count: 0, last: 0 };
    item.count += 1;
    item.last = Math.max(item.last, attempt.at);
    errors.set(category.key, item);
  }
  const recurring = [...errors.values()].sort((a, b) => b.count - a.count).slice(0, 6);

  const reviews = data.reviews.filter((review) => review.doneAt === null).sort((a, b) => a.dueAt - b.dueAt);
  const days = lastDays(14);
  const byDay = new Map(data.activity.map((item) => [item.date, item.activeMs]));
  const minutes = days.map((day) => Math.round((byDay.get(day) ?? 0) / 60000));
  const maxMinutes = Math.max(30, ...minutes);
  const totalMinutes = minutes.reduce((sum, value) => sum + value, 0);

  return (
    <div className="page">
      <header className="page-head">
        <span className="eyebrow">Прогресс</span>
        <h1>Что ты уже умеешь</h1>
        <p className="page-lead">
          Навык считается освоенным, когда несколько заданий решены без существенной помощи. Прочитанный урок и открытое решение
          навыком не считаются.
        </p>
      </header>

      <div className="today-grid">
        <div className="stack">
          {modulesWithContent.length === 0 ? (
            <EmptyState title="Пока нет готовых модулей">Навыки появятся вместе с уроками.</EmptyState>
          ) : (
            modulesWithContent.map((module) => {
              const skills = course.skills.filter((skill) => skill.module === module.id);
              if (skills.length === 0) return null;
              return (
                <section key={module.id} className="card" aria-labelledby={`skills-${module.id}`}>
                  <h2 id={`skills-${module.id}`} className="card-title">
                    Модуль {module.number}. {module.title}
                  </h2>
                  <div>
                    {skills.map((skill) => {
                      const progress = skillStates.get(skill.id)!;
                      return (
                        <div key={skill.id} className="skill-row">
                          <div>
                            <div className="list-row-title">{skill.title}</div>
                            <div className="skill-evidence">{evidenceText(progress)}</div>
                          </div>
                          <StatusBadge tone={STATE_TONE[progress.state]}>{STATE_LABEL[progress.state]}</StatusBadge>
                        </div>
                      );
                    })}
                  </div>
                </section>
              );
            })
          )}
          <StudentCard course={course} data={data} skillStates={skillStates} recurring={recurring} region={settings.market} />
        </div>

        <div className="stack">
          <section className="card" aria-labelledby="errors-title">
            <h2 id="errors-title" className="card-title">
              Повторяющиеся ошибки
            </h2>
            {recurring.length === 0 ? (
              <p className="small muted" style={{ marginTop: 8 }}>
                Пока нет. Здесь соберутся типы ошибок из твоих попыток — чтобы видеть, что стоит повторить.
              </p>
            ) : (
              <ul className="plain-list" style={{ marginTop: 8 }}>
                {recurring.map((item) => (
                  <li key={item.label} className="row-between small">
                    <span>{item.label}</span>
                    <span className="muted">
                      {item.count} {plural(item.count, ['раз', 'раза', 'раз'])} · {formatDate(item.last)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card" aria-labelledby="plan-title">
            <h2 id="plan-title" className="card-title">
              План повторения
            </h2>
            {reviews.length === 0 ? (
              <p className="small muted" style={{ marginTop: 8 }}>
                Нет запланированных повторений. Они появятся, если задание решено с третьей подсказкой, после просмотра решения
                или после многих попыток.
              </p>
            ) : (
              <ul className="plain-list" style={{ marginTop: 8 }}>
                {reviews.map((review) => {
                  const lesson = lessons.find((item) => item.id === review.lessonId);
                  return (
                    <li key={review.key} className="small">
                      <a href={href(paths.lesson(review.lessonId))}>{lesson?.title ?? review.lessonId}</a>
                      <span className="muted">
                        {' '}
                        — {isDue(review.dueAt, Date.now()) ? 'сегодня' : formatDate(review.dueAt)} · {review.reason}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="card" aria-labelledby="time-title">
            <h2 id="time-title" className="card-title">
              Время в уроках
            </h2>
            <p className="card-sub">
              За 14 дней: {totalMinutes} {plural(totalMinutes, ['минута', 'минуты', 'минут'])}. Пропуски — это нормально.
            </p>
            <div className="activity-bars" style={{ marginTop: 12 }} role="img" aria-label={`Минуты занятий по дням: ${minutes.join(', ')}`}>
              {minutes.map((value, index) => (
                <span
                  key={days[index]}
                  data-empty={value === 0}
                  style={{ height: `${Math.max(3, (value / maxMinutes) * 100)}%` }}
                  title={`${days[index]}: ${value} мин`}
                />
              ))}
            </div>
            <div className="activity-axis">
              <span>{formatDate(days[0])}</span>
              <span>сегодня</span>
            </div>
          </section>

          <section className="card" aria-labelledby="interests-title">
            <h2 id="interests-title" className="card-title">
              Карта интересов
            </h2>
            <p className="card-sub">«Интересно» и «пробовал» — разные отметки. Интерес не влияет на навыки.</p>
            {data.interests.size === 0 ? (
              <p className="small muted" style={{ marginTop: 8 }}>
                Пока пусто. Отметь интересные направления на экране <a href={href(paths.directions())}>«Направления»</a>.
              </p>
            ) : (
              <ul className="plain-list" style={{ marginTop: 8 }}>
                {[...data.interests.values()].map((interest) => {
                  const lab = course.labs.find((item) => item.id === interest.labId);
                  return (
                    <li key={interest.labId} className="row-between small">
                      <a href={href(paths.directions(interest.labId))}>{lab?.title ?? interest.labId}</a>
                      <span className="muted">
                        {INTEREST_STATUS[interest.status]}
                        {interest.continue ? ` · продолжить: ${CONTINUE_LABEL[interest.continue]}` : ''}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function StudentCard({
  course,
  data,
  skillStates,
  recurring,
  region,
}: {
  course: Course;
  data: LearnerData;
  skillStates: Map<string, SkillProgress>;
  recurring: { label: string; count: number }[];
  region: { region: string | null; currency: string | null };
}) {
  const [copied, setCopied] = useState(false);
  const next = suggestNextLesson(course, data.files, data.lessons, data.exercises);
  const mastered = course.skills.filter((skill) => skillStates.get(skill.id)?.state === 'mastered');
  const helped = [...data.exercises.values()].filter((record) => (record.firstPassHelp ?? 0) >= 1);
  const nextReview = data.reviews.filter((review) => review.doneAt === null).sort((a, b) => a.dueAt - b.dueAt)[0];
  const lessons = [...data.files.values()].flatMap((file) => file.lessons);
  const titleOf = (exerciseId: string) =>
    lessons.flatMap((lesson) => lesson.steps).find((step) => step.type === 'exercise' && step.exercise.id === exerciseId)?.title ?? exerciseId;
  const labTitle = (labId: string) => course.labs.find((lab) => lab.id === labId)?.title ?? labId;
  const interests = [...data.interests.values()];
  const tried = interests.filter((item) => item.status === 'tried');
  const curious = interests.filter((item) => item.status === 'curious');
  const interestMap = interests
    .map((item) => {
      const parts = [
        item.liked.trim() ? `понравилось: ${item.liked.trim()}` : '',
        item.tiring.trim() ? `утомило: ${item.tiring.trim()}` : '',
        item.continue ? `продолжить: ${CONTINUE_LABEL[item.continue]}` : '',
      ].filter(Boolean);
      return parts.length ? `- ${labTitle(item.labId)}: ${parts.join('; ')}` : '';
    })
    .filter(Boolean);
  const projects = course.projects
    .map((project) => ({ project, record: data.projects.get(project.id) }))
    .filter(({ record }) => record && (record.stagesDone.length > 0 || record.notes.trim()))
    .map(
      ({ project, record }) =>
        `- ${project.title}: отмечено этапов ${record?.stagesDone.length ?? 0} из ${project.stages.length}${record?.notes.trim() ? ', есть записи решений' : ''}`,
    );
  const latestMarket = [...data.market].sort((a, b) => b.importedAt - a.importedAt)[0];

  const text = [
    '# Карточка ученика «Практики»',
    `Дата: ${new Date().toLocaleDateString('ru-RU')}`,
    'Цель: попробовать основные направления программирования и выбрать, что изучать глубже.',
    'Язык общей базы: Python 3. Среда: тренажёр в браузере (ПК и Android), локальный редактор — по мере курса.',
    `Текущая тема: ${next ? `${next.lesson.number}. ${next.lesson.title}` : 'все готовые уроки пройдены'}`,
    '',
    '## Освоенные навыки (с доказательствами)',
    ...(mastered.length
      ? mastered.map((skill) => {
          const progress = skillStates.get(skill.id)!;
          return `- ${skill.title}: ${
            progress.selfReported
              ? `по отметкам ученика (${selfMarksTouched(progress).map(marksText).join('; ')})`
              : progress.evidence.map((item) => `${item.exerciseTitle} (${HELP_LABEL[item.help]})`).join(', ')
          }`;
        })
      : ['- пока нет']),
    '',
    '## Повторяющиеся ошибки',
    ...(recurring.length ? recurring.map((item) => `- ${item.label}: ${item.count}`) : ['- нет']),
    '',
    '## Задачи, решённые с подсказками',
    ...(helped.length ? helped.map((record) => `- ${titleOf(record.exerciseId)}: ${HELP_LABEL[record.firstPassHelp ?? 0]}`) : ['- нет']),
    '',
    '## Проекты',
    ...(projects.length ? projects : ['- пока не начаты']),
    '',
    `Опробованные направления: ${tried.map((item) => labTitle(item.labId)).join(', ') || 'нет'}`,
    `Интересные направления (ещё не пробовал): ${curious.map((item) => labTitle(item.labId)).join(', ') || 'нет'}`,
    '',
    '## Карта интересов',
    ...(interestMap.length ? interestMap : ['- пока не заполнена']),
    '',
    `Ближайшее повторение: ${nextReview ? `${formatDate(nextReview.dueAt)} (${nextReview.reason})` : 'нет'}`,
    `Следующий шаг: ${next ? `урок «${next.lesson.title}»` : 'повторение и выбор направления'}`,
    `Рынок для обзоров: ${region.region ? `${region.region}${region.currency ? `, ${region.currency}` : ''}` : 'не выбран'}`,
    `Последнее обновление обзора рынка: ${
      latestMarket
        ? `«${latestMarket.title}» (${latestMarket.region}, ${latestMarket.currency}), данные проверены ${formatDate(latestMarket.checkedAt, { year: true })}, импортирован ${formatDate(latestMarket.importedAt, { year: true })}`
        : 'обзор ещё не импортирован'
    }`,
  ].join('\n');

  return (
    <section className="card stack" aria-labelledby="card-title">
      <div className="card-head" style={{ marginBottom: 0 }}>
        <div>
          <h2 id="card-title" className="card-title">
            Карточка ученика
          </h2>
          <p className="card-sub">Коротко о прогрессе — можно передать наставнику в другом чате.</p>
        </div>
      </div>
      <pre className="card-code">{text}</pre>
      <div className="row">
        <button
          type="button"
          className="btn btn-sm"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text);
              setCopied(true);
            } catch {
              setCopied(false);
            }
          }}
        >
          <Copy aria-hidden="true" />
          {copied ? 'Скопировано' : 'Скопировать'}
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => {
            const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
            const link = document.createElement('a');
            link.href = url;
            link.download = `praktika-card-${new Date().toISOString().slice(0, 10)}.md`;
            link.click();
            URL.revokeObjectURL(url);
          }}
        >
          <Download aria-hidden="true" />
          Скачать .md
        </button>
      </div>
    </section>
  );
}
