// Маршрут курса как граф веток в git: основная линия — модули «Основ» (квадраты), после модулей из
// lab.unlockAfter отходит ветка проб (круги), она сливается в «Твой выбор» (ромб), дальше пунктир — «Свой проект».
// Широкая колонка (≥ 720 px, контейнерный запрос) — граф по горизонтали, узкая — по вертикали, как `git log --graph`.
// Рисунок декоративный (aria-hidden), стадии — список <ol> с текстом для скринридера. Пояснения стадий — в title.
import type { CSSProperties } from 'react';
import type { Course } from '../content/schema.ts';
import type { LearningState } from '../progress/model.ts';

type StageKind = 'basics' | 'labs' | 'choice' | 'projects';

function moduleNumber(course: Course, moduleId: string): number | null {
  return course.modules.find((module) => module.id === moduleId)?.number ?? null;
}

/** Модули, все уроки которых готовы и завершены (lessonDone — урок завершён). */
export function finishedModuleIds(course: Course, lessonDone: (lessonId: string) => boolean): Set<string> {
  return new Set(
    course.modules
      .filter((module) => module.lessons.length > 0 && module.lessons.every((lesson) => lesson.ready && lessonDone(lesson.id)))
      .map((module) => module.id),
  );
}

export function RouteGraph({
  course,
  moduleStates,
  currentModuleId,
  lessonsDone,
  lessonsTotal,
  finishedModules,
}: {
  course: Course;
  moduleStates: Map<string, LearningState>;
  currentModuleId: string | null;
  lessonsDone: number;
  lessonsTotal: number;
  /** Модули, все уроки которых завершены: на маршруте они пройдены, даже если навыки ещё «изучаю». */
  finishedModules?: ReadonlySet<string>;
}) {
  const basics = course.modules.filter((module) => module.part === 'basics');
  const last = Math.max(1, basics.length - 1);
  const currentNumber = currentModuleId ? moduleNumber(course, currentModuleId) : null;

  // Отводы проб: после каких модулей основы открываются направления (по порядку, без повторов).
  const unlocks = [...new Set(course.labs.map((lab) => lab.unlockAfter))]
    .map((id) => basics.findIndex((module) => module.id === id))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b);
  const firstUnlock = unlocks[0];
  const firstUnlockNumber = firstUnlock !== undefined ? basics[firstUnlock].number : null;
  const firstProject = course.projects[0];
  const projectNumber = firstProject ? moduleNumber(course, firstProject.after) : null;

  // «Основы» пройдены целиком (все уроки написаны и завершены): стадия не «текущая», а пройденная; пробы и проект
  // достигнуты. Пока часть уроков пишется, пройденные готовые уроки — ещё не конец «Основ».
  const allReady = basics.every((module) => module.lessons.every((lesson) => lesson.ready));
  const complete = allReady && lessonsTotal > 0 && lessonsDone >= lessonsTotal;
  const reached = (number: number | null) => complete || (number !== null && currentNumber !== null && currentNumber > number);

  const status: Record<StageKind, { text: string; sr: string }> = {
    basics: complete
      ? { text: `пройдены · ${lessonsDone}/${lessonsTotal}`, sr: `пройдены, ${lessonsDone} из ${lessonsTotal} уроков` }
      : { text: `идёт · ${lessonsDone}/${lessonsTotal}`, sr: `идёт, пройдено ${lessonsDone} из ${lessonsTotal} уроков` },
    labs: reached(firstUnlockNumber)
      ? { text: 'открыты', sr: 'открыты' }
      : { text: `после модуля ${firstUnlockNumber ?? ''}`.trim(), sr: `после модуля ${firstUnlockNumber ?? ''}`.trim() },
    choice: { text: 'после проб', sr: 'после проб' },
    projects: reached(projectNumber)
      ? { text: 'доступен', sr: 'доступен' }
      : { text: `после модуля ${projectNumber ?? ''}`.trim(), sr: `после модуля ${projectNumber ?? ''}`.trim() },
  };

  const kinds: StageKind[] = ['basics', 'labs', 'choice', 'projects'];
  // Проб на ветке — до шести кружков, равномерно.
  const labDots = Math.min(6, Math.max(0, course.labs.length - 1));

  return (
    <div className="route-graph">
      <ol className="route" aria-label="Маршрут курса">
        {course.stages.slice(0, 4).map((stage, index) => {
          const kind = kinds[index] ?? 'projects';
          const current = kind === 'basics' && !complete;
          const st = status[kind];
          return (
            <li
              key={stage.id}
              className={`rt rt-${kind}${current ? ' is-current' : ''}${kind === 'basics' && complete ? ' is-complete' : ''}`}
              aria-current={current ? 'step' : undefined}
              title={stage.description}
            >
              <span className="rt-art" aria-hidden="true" style={{ '--n': last } as CSSProperties}>
                {kind === 'basics' && (
                  <>
                    {basics.map((module, i) => {
                      const state = moduleStates.get(module.id);
                      // Пройден — по урокам (все завершены) или по навыкам; «пройден / освоен» различает «Прогресс».
                      const cls =
                        module.id === currentModuleId && !complete
                          ? ' is-current'
                          : complete || finishedModules?.has(module.id) || state === 'mastered' || state === 'practice'
                            ? ' is-done'
                            : '';
                      return <i key={module.id} className={`cm${cls}`} style={{ '--i': i } as CSSProperties} />;
                    })}
                    {unlocks.map((at, i) => (
                      <b key={at} className={i === 0 ? 'fork' : 'join'} style={{ '--i': at } as CSSProperties} />
                    ))}
                    <i
                      className="rt-done"
                      style={{ '--done': complete ? last : Math.max(0, basics.findIndex((module) => module.id === currentModuleId)) } as CSSProperties}
                    />
                  </>
                )}
                {kind === 'labs' && (
                  <>
                    <i className="node" />
                    {Array.from({ length: labDots }, (_, i) => (
                      <i key={i} className="pd" style={{ '--x': `${22 + (i * 60) / Math.max(1, labDots)}%` } as CSSProperties} />
                    ))}
                    <b className="merge" />
                  </>
                )}
                {kind !== 'basics' && kind !== 'labs' && <i className="node" />}
              </span>
              <span className="stage-name">
                <span>{stage.title}</span>
                <span className="stage-st" aria-hidden="true">
                  {st.text.split(/(\d+(?:\/\d+)?)/).map((part, i) => (/^\d/.test(part) ? <span key={i} className="n">{part}</span> : part))}
                </span>
                <span className="visually-hidden">: {st.sr}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
