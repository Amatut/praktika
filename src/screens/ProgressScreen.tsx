// «Прогресс»: навыки с доказательствами по модулям, карточка ученика, а сбоку — повторяющиеся ошибки, план
// повторения, время занятий и карта интересов. Только реальные данные: без процентов и серий.
// Вид — src/styles/screens/progress.css.
import { Check, ChevronRight, CircleAlert, Clock, Compass, Copy, Download, FileText, RotateCcw, TriangleAlert, type LucideIcon } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useMediaQuery, useSettings } from '../app/hooks.ts';
import { href, paths } from '../app/router.ts';
import { errorCategory } from '../coach/errors-ru.ts';
import { Disclosure, EmptyState, PendingData, StatusBadge, Tag, formatDate, plural } from '../components/ui.tsx';
import type { Course, Lesson, ModuleSummary } from '../content/schema.ts';
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

/** Узкая колонка: тире не начинает строку, дата «29 сентября» не разрывается. */
function keepDash(text: string): string {
  return text.replace(/ —/g, ' —');
}

function shortDate(timestamp: number): string {
  return formatDate(timestamp).replace(/\s+/g, ' ');
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

/** Были ли у навыка попытки или отметки: модуль без них свёрнут. */
function touched(progress: SkillProgress): boolean {
  return progress.state !== 'not-started' || progress.attemptedExercises > 0 || progress.evidence.length > 0 || selfMarksTouched(progress).length > 0;
}

/** Доказательства навыка: решённые задания с помощью и датой, отметки ученика или честное «пока нет». */
function Evidence({ progress }: { progress: SkillProgress }) {
  if (progress.selfReported) {
    const marks = selfMarksTouched(progress);
    return (
      <div className="prog-evidence">
        <span>{marks.length === 0 ? 'Отметок пока нет' : `По твоим отметкам: ${marks.map(marksText).join('; ')}`}</span>
        <Tag className="prog-self">без автопроверки</Tag>
      </div>
    );
  }
  if (progress.evidence.length === 0) {
    return <p className="prog-evidence">{progress.attemptedExercises > 0 ? 'Есть попытки, решённых нет' : 'Ещё не было попыток'}</p>;
  }
  // Пункт с маркером и висячим отступом. В узкой колонке строка переносится после тире («…» —), тире не начинает
  // строку, а «сам (29 сентября)» не разрывается.
  return (
    <ul className="prog-evidence prog-proofs">
      {progress.evidence.map((item) => (
        <li key={`${item.exerciseId}-${item.at}`}>
          «{item.exerciseTitle}»{'\u00a0'}—{' '}
          <span className="nowrap">
            {HELP_LABEL[item.help]} ({shortDate(item.at)})
          </span>
        </li>
      ))}
    </ul>
  );
}

function SkillRows({ course, module, skillStates }: { course: Course; module: ModuleSummary; skillStates: Map<string, SkillProgress> }) {
  const skills = course.skills.filter((skill) => skill.module === module.id);
  return (
    <ul className="prog-skills">
      {skills.map((skill) => {
        const progress = skillStates.get(skill.id)!;
        return (
          <li key={skill.id} className="skill-row">
            <span className="skill-title">{skill.title}</span>
            <StatusBadge tone={STATE_TONE[progress.state]}>{STATE_LABEL[progress.state]}</StatusBadge>
            <Evidence progress={progress} />
          </li>
        );
      })}
    </ul>
  );
}

/** Секция боковой панели: метка капсом (1–2 слова), справа короткая пометка. */
function SideSection({ id, label, icon: Icon, aside, children }: { id: string; label: string; icon?: LucideIcon; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="prog-side-sec" aria-labelledby={id}>
      <div className="pane-head">
        <h2 className="plabel" id={id}>
          {Icon && <Icon aria-hidden="true" />}
          {label}
        </h2>
        {aside && <span className="pane-aside">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

export function ProgressScreen({ course }: { course: Course }) {
  const { data, error } = useLearnerData(course);
  const settings = useSettings();
  // ≥ 1200: карточка ученика — под навыками в основной колонке. В одну колонку — в самом конце, после боковой панели:
  // план повторения со ссылками на задания важнее самого редкого действия экрана.
  const wide = useMediaQuery('(min-width: 1200px)');
  if (!data) return <PendingData error={error} />;
  const lessons: Lesson[] = [...data.files.values()].flatMap((file) => file.lessons);
  const modulesWithContent = course.modules.filter((module) => data.files.has(module.id) && course.skills.some((skill) => skill.module === module.id));
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
  const interests = [...data.interests.values()];
  // Модуль, в котором идёт ученик, раскрыт и без попыток: новому ученику есть на что опереться.
  const next = suggestNextLesson(course, data.files, data.lessons, data.exercises);
  const card = <StudentCard course={course} data={data} next={next} skillStates={skillStates} recurring={recurring} region={settings.market} />;

  return (
    <div className="page-split prog">
      <div className="prog-main">
        <div className="page prog-page">
          <header className="page-head">
            <h1>Что ты уже умеешь</h1>
          </header>

          {modulesWithContent.length === 0 ? (
            <EmptyState title="Пока нет готовых модулей" />
          ) : (
            <div className="prog-modules">
              {modulesWithContent.map((module) => {
                const skills = course.skills.filter((skill) => skill.module === module.id);
                const states = skills.map((skill) => skillStates.get(skill.id)!);
                const mastered = states.filter((progress) => progress.state === 'mastered').length;
                const name = `Модуль ${module.number} · ${module.title}`;
                if (!states.some(touched) && module.id !== next?.module.id) {
                  return (
                    <Disclosure key={module.id} className="prog-module-closed" summary={
                        <>
                          {name}{'\u00a0'}
                          <span className="prog-closed-st">·{'\u00a0'}не начат</span>
                        </>
                      }>
                      <SkillRows course={course} module={module} skillStates={skillStates} />
                    </Disclosure>
                  );
                }
                return (
                  <section key={module.id} className="prog-module" aria-labelledby={`skills-${module.id}`}>
                    <div className="prog-module-head">
                      <h2 id={`skills-${module.id}`}>{name}</h2>
                      <span className="prog-count">
                        освоено <span className="n">{mastered}</span> из <span className="n">{skills.length}</span>
                      </span>
                    </div>
                    <SkillRows course={course} module={module} skillStates={skillStates} />
                  </section>
                );
              })}
            </div>
          )}

          {wide && card}
        </div>
      </div>

      <aside className="prog-side" aria-label="Ошибки, повторение, время и интересы">
        <SideSection id="errors-title" label="Повторяющиеся ошибки" icon={TriangleAlert}>
          {recurring.length === 0 ? (
            <p className="prog-empty">Пока нет</p>
          ) : (
            <ul className="rows">
              {recurring.map((item) => (
                <li key={item.label}>
                  <div className="row prog-row">
                    <span className="row-main row-title prog-row-name">{item.label}</span>
                    <span className="row-meta">
                      <span className="n">{item.count}</span> {plural(item.count, ['раз', 'раза', 'раз'])} · {formatDate(item.last)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </SideSection>

        <SideSection id="plan-title" label="План повторения" icon={RotateCcw}>
          {reviews.length === 0 ? (
            <p className="prog-empty">Повторений нет</p>
          ) : (
            <ul className="rows">
              {reviews.map((review) => {
                const lesson = lessons.find((item) => item.id === review.lessonId);
                const due = isDue(review.dueAt, Date.now());
                // Как на «Сегодня»: задание — к его шагу, тема урока без задания — к шагу «Итог».
                const index = lesson
                  ? review.exerciseId
                    ? lesson.steps.findIndex((step) => step.type === 'exercise' && step.exercise.id === review.exerciseId)
                    : lesson.steps.length - 1
                  : -1;
                const step = lesson && index >= 0 ? lesson.steps[index] : undefined;
                const title =
                  step?.type === 'exercise' ? step.exercise.title : lesson ? `Итог урока «${lesson.title}»` : review.lessonId;
                return (
                  <li key={review.key}>
                    <a className="row prog-row" href={href(paths.lesson(review.lessonId, index >= 0 ? index + 1 : undefined))}>
                      <span className="row-ic prog-num" aria-hidden="true">
                        {lesson?.number ?? <RotateCcw />}
                      </span>
                      <span className="row-main">
                        <span className="row-title">{keepDash(title)}</span>
                        <span className="row-sub">{review.reason}</span>
                      </span>
                      <span className={`row-meta${due ? ' prog-due' : ''}`}>{due ? 'сегодня' : shortDate(review.dueAt)}</span>
                      <ChevronRight aria-hidden="true" />
                    </a>
                  </li>
                );
              })}
            </ul>
          )}
        </SideSection>

        <SideSection id="time-title" label="Время занятий" icon={Clock}>
          <div className="prog-time">
            <p className="prog-total">
              За 14 дней: <span className="n">{totalMinutes}</span> мин
            </p>
            {/* Шкала: пунктир на высоте максимума (не меньше 30 минут) с подписью — столбики читаются без мыши. */}
            <div className="activity-chart">
              <span className="activity-scale" aria-hidden="true">
                <span className="n">{maxMinutes}</span> мин
              </span>
              <div
                className="activity-bars"
                role="img"
                aria-label={`Минуты занятий по дням: ${days.map((day, index) => `${formatDate(day)} — ${minutes[index]}`).join(', ')}`}
              >
                {minutes.map((value, index) => (
                  <span key={days[index]} title={`${formatDate(days[index])}: ${value} мин`}>
                    <i data-empty={value === 0} style={{ height: value === 0 ? undefined : `${Math.max(4, (value / maxMinutes) * 100)}%` }} />
                  </span>
                ))}
              </div>
            </div>
            <div className="activity-axis" aria-hidden="true">
              <span>{formatDate(days[0])}</span>
              <span>сегодня</span>
            </div>
          </div>
        </SideSection>

        <SideSection id="interests-title" label="Карта интересов" icon={Compass}>
          {interests.length === 0 ? (
            <div className="prog-empty">
              <p>Пока пусто</p>
              <a className="btn btn-sm" href={href(paths.directions())}>
                <Compass aria-hidden="true" />
                Направления
              </a>
            </div>
          ) : (
            <ul className="rows">
              {interests.map((interest) => {
                const lab = course.labs.find((item) => item.id === interest.labId);
                return (
                  <li key={interest.labId}>
                    <a className="row prog-row" href={href(paths.directions(interest.labId))}>
                      <span className="row-main">
                        <span className="row-title">{lab?.title ?? interest.labId}</span>
                        <span className="row-sub">
                          {INTEREST_STATUS[interest.status]}
                          {interest.continue ? ` · продолжить: ${CONTINUE_LABEL[interest.continue]}` : ''}
                        </span>
                      </span>
                      <ChevronRight aria-hidden="true" />
                    </a>
                  </li>
                );
              })}
            </ul>
          )}
        </SideSection>
      </aside>

      {!wide && <div className="page prog-page prog-card-end">{card}</div>}
    </div>
  );
}

function StudentCard({
  course,
  data,
  next,
  skillStates,
  recurring,
  region,
}: {
  course: Course;
  data: LearnerData;
  next: ReturnType<typeof suggestNextLesson>;
  skillStates: Map<string, SkillProgress>;
  recurring: { label: string; count: number }[];
  region: { region: string | null; currency: string | null };
}) {
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null);
  // «Скопировано» гаснет через 3 секунды — кнопкой можно скопировать снова.
  useEffect(() => {
    if (copied !== 'yes') return;
    const timer = window.setTimeout(() => setCopied(null), 3000);
    return () => window.clearTimeout(timer);
  }, [copied]);
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
    <section className="prog-card" aria-labelledby="card-title">
      <h2 id="card-title">Карточка ученика</h2>
      <div className="prog-file">
        <div className="prog-file-tab">
          <span className="prog-file-name">
            <FileText aria-hidden="true" />
            student-card.md
          </span>
          <span className="prog-file-actions">
            {/* Уже 480 px — кнопки-значки 44 × 44: подпись остаётся для скринридера и во всплывающей подсказке. */}
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              title={copied === 'yes' ? 'Скопировано' : 'Скопировать'}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(text);
                  setCopied('yes');
                } catch {
                  setCopied('failed');
                }
              }}
            >
              {copied === 'yes' ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
              <span className="prog-btn-text">{copied === 'yes' ? 'Скопировано' : 'Скопировать'}</span>
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              title="Скачать .md"
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
              <span className="prog-btn-text">Скачать .md</span>
            </button>
          </span>
          <span className="visually-hidden" role="status">
            {copied === 'yes' ? 'Скопировано' : ''}
          </span>
        </div>
        {copied === 'failed' && (
          <p className="status-line status-err prog-copy-failed" role="alert">
            <CircleAlert aria-hidden="true" />
            <span>Не скопировалось — выдели текст вручную</span>
          </p>
        )}
        <pre className="prog-file-body" tabIndex={0} aria-label="Текст карточки ученика">
          {text}
        </pre>
      </div>
    </section>
  );
}
