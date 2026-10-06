import { ArrowUp, Check, FolderCode, FolderKanban, Hourglass, ListChecks } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAsync, useDataVersion } from '../app/hooks.ts';
import { reportSaveProblem } from '../app/problems.ts';
import { href, navigate, paths } from '../app/router.ts';
import { StatusBadge, Tag } from '../components/ui.tsx';
import type { Course, Project } from '../content/schema.ts';
import { getAllProjects, getProject, saveProject } from '../storage/repo.ts';
import type { ProjectRecord } from '../storage/types.ts';

// «Проекты» — как «Направления»: слева лестница из четырёх проектов (список), справа документ выбранного.
// Отметки этапов и «Мои решения» — записи ученика; пояснений «как это работает» нет.

const ENV = { browser: 'в браузере', local: 'на компьютере', mixed: 'браузер + компьютер' } as const;

function afterNumber(course: Course, project: Project): number | null {
  return course.modules.find((module) => module.id === project.after)?.number ?? null;
}

export function ProjectsScreen({ course, projectId }: { course: Course; projectId: string | null }) {
  const selected = course.projects.find((project) => project.id === projectId) ?? course.projects[0];
  const version = useDataVersion(['projects']);
  // Отметки этапов для счётчиков в лестнице; хранилище недоступно — лестница без счётчиков (о сбое говорит баннер).
  const records = useAsync(() => getAllProjects(), [version]);
  const byId = new Map((records.value ?? []).map((record) => [record.projectId, record]));

  return (
    <div className="page-split projects-split">
      <div className="projects-list">
        {/* Шапка списка — как у «Направлений»: метка панели. На телефоне название экрана уже в верхней строке —
            метка остаётся только для скринридера. Готовность материалов — бейджем у каждого проекта. */}
        <div className="pane-head projects-head">
          <h1 className="plabel">
            <FolderCode aria-hidden="true" />
            Проекты
          </h1>
        </div>
        <ol className="rows projects-ladder" aria-label="Лестница проектов">
          {course.projects.map((project, index) => {
            const done = byId.get(project.id)?.stagesDone.length ?? 0;
            const total = project.stages.length;
            const finished = done > 0 && done >= total;
            return (
              <li key={project.id}>
                <a
                  className="row lesson-row project-row"
                  href={href(paths.projects(project.id))}
                  aria-current={project.id === selected.id ? 'true' : undefined}
                  onClick={(event) => {
                    event.preventDefault();
                    navigate(paths.projects(project.id), { replace: true });
                    // Узкий экран: документ ниже списка — показываем его и переносим туда фокус.
                    if (window.matchMedia('(max-width: 899px)').matches) {
                      const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
                      requestAnimationFrame(() => {
                        document.getElementById('project-title')?.focus({ preventScroll: true });
                        document.getElementById('project-detail')?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
                      });
                    }
                  }}
                >
                  <span className={`row-ic n project-num${finished ? ' is-done' : ''}`} aria-hidden="true">
                    {finished ? <Check /> : index + 1}
                  </span>
                  <span className="row-main">
                    <span className="row-title">{project.title}</span>
                    <span className="row-sub">
                      <span className="nowrap">после модуля {afterNumber(course, project) ?? '—'}</span>
                      &nbsp;·{' '}
                      <span className="nowrap">{ENV[project.environment]}</span>
                    </span>
                    <span className="project-row-tags">
                      {project.ready ? (
                        <StatusBadge tone="ok">Готов</StatusBadge>
                      ) : (
                        <StatusBadge tone="muted" icon={Hourglass}>
                          Материалы пишутся
                        </StatusBadge>
                      )}
                      {done > 0 && (
                        <span className="project-row-progress">
                          <ListChecks aria-hidden="true" />
                          <span>
                            этапы <span className="n">{done}</span> из <span className="n">{total}</span>
                          </span>
                        </span>
                      )}
                    </span>
                  </span>
                </a>
              </li>
            );
          })}
        </ol>
      </div>
      <ProjectDetail key={selected.id} course={course} project={selected} index={course.projects.indexOf(selected)} />
    </div>
  );
}

function ProjectDetail({ course, project, index }: { course: Course; project: Project; index: number }) {
  const version = useDataVersion(['projects']);
  const stored = useAsync(() => getProject(project.id), [project.id, version]);
  const record: ProjectRecord = stored.value ?? { projectId: project.id, stagesDone: [], notes: '', updatedAt: 0 };
  const [notes, setNotes] = useState('');
  const [saved, setSaved] = useState(false);
  // Отметка этапа видна сразу, не дожидаясь записи в хранилище; свежая запись из хранилища её сменяет.
  const [localStages, setLocalStages] = useState<string[] | null>(null);
  useEffect(() => setLocalStages(null), [stored.value]);
  const stagesDoneIds = localStages ?? record.stagesDone;
  const loaded = useRef(false);
  // Записи сохраняются с небольшой задержкой при наборе, при уходе из поля и при закрытии вкладки.
  const pendingNotes = useRef<string | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!stored.loading && !loaded.current) {
      if (pendingNotes.current === null) setNotes(stored.value?.notes ?? '');
      loaded.current = true;
    }
  }, [stored.loading, stored.value]);
  const after = afterNumber(course, project);

  const flushNotes = useCallback(() => {
    window.clearTimeout(saveTimer.current);
    const value = pendingNotes.current;
    if (value === null) return;
    pendingNotes.current = null;
    saveProject({ projectId: project.id, notes: value })
      .then(() => {
        if (pendingNotes.current === null) setSaved(true);
      })
      .catch((error: unknown) => reportSaveProblem(error, 'Записи проекта не сохранены'));
  }, [project.id]);

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') flushNotes();
    };
    window.addEventListener('pagehide', flushNotes);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('pagehide', flushNotes);
      document.removeEventListener('visibilitychange', onHide);
      flushNotes();
    };
  }, [flushNotes]);

  async function toggleStage(stageId: string) {
    const done = new Set(stagesDoneIds);
    if (done.has(stageId)) done.delete(stageId);
    else done.add(stageId);
    const next = project.stages.map((stage) => stage.id).filter((id) => done.has(id));
    setLocalStages(next);
    try {
      await saveProject({ projectId: project.id, stagesDone: next });
    } catch (error) {
      setLocalStages(null);
      reportSaveProblem(error, 'Этапы проекта не сохранены');
    }
  }

  const stagesDone = project.stages.filter((stage) => stagesDoneIds.includes(stage.id)).length;

  // Узкий экран: список выше документа — возвращаемся к выбранному проекту в лестнице (как «К списку» в «Направлениях»).
  function backToList() {
    const row = document.querySelector<HTMLElement>('.project-row[aria-current="true"]');
    const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    row?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'center' });
    row?.focus({ preventScroll: true });
  }

  return (
    <section id="project-detail" className="project-doc" aria-labelledby="project-title">
      <div className="project-doc-body">
        <button type="button" className="btn btn-sm btn-ghost project-back" onClick={backToList}>
          <ArrowUp aria-hidden="true" />
          К списку
        </button>
        <p className="project-kicker">
          <FolderKanban aria-hidden="true" />
          <span>
            <span className="nowrap">Проект {index + 1}</span>
            &nbsp;·{' '}
            <span className="nowrap">после модуля {after ?? '—'}</span>
            &nbsp;·{' '}
            <span className="nowrap">{ENV[project.environment]}</span>
          </span>
        </p>
        <h2 id="project-title" tabIndex={-1}>
          {project.title}
        </h2>
        {!project.ready && (
          <div className="project-badges">
            <StatusBadge tone="muted" icon={Hourglass}>
              Материалы пишутся
            </StatusBadge>
          </div>
        )}
        <p className="prose project-story">{project.story}</p>

        <section className="project-sec" aria-labelledby="project-minimum">
          <h3 id="project-minimum">Минимальные требования</h3>
          <ul className="bullets">
            {project.minimum.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>

        <section className="project-sec" aria-labelledby="project-extras">
          <div className="project-sec-head">
            <h3 id="project-extras">Дополнительно</h3>
            <Tag>по желанию</Tag>
          </div>
          <ul className="bullets">
            {project.extras.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>

        <section className="project-sec" aria-labelledby="project-criteria">
          <h3 id="project-criteria">Проект готов, когда</h3>
          <ul className="bullets">
            {project.criteria.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <div className="prose-note project-change">
            <strong>Изменение требования в конце</strong>
            <p>{project.changeRequest}</p>
          </div>
        </section>

        <section className="project-sec" aria-labelledby="project-stages">
          <div className="project-sec-head">
            <h3 id="project-stages">Этапы</h3>
            <Tag>Отмечаешь сам</Tag>
            <span className="project-sec-aside">
              <span className="n">{stagesDone}</span> из <span className="n">{project.stages.length}</span>
            </span>
          </div>
          <ul className="checklist project-stages">
            {project.stages.map((stage) => (
              <li key={stage.id}>
                <label className="check">
                  <input type="checkbox" checked={stagesDoneIds.includes(stage.id)} onChange={() => void toggleStage(stage.id)} />
                  <span className="project-stage">
                    <span className="project-stage-title">{stage.title}</span>
                    <span className="project-stage-text">{stage.description}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </section>

        <section className="project-sec project-notes" aria-labelledby="project-notes-label">
          <div className="project-sec-head">
            <label id="project-notes-label" htmlFor="project-notes" className="project-notes-label">
              Мои решения
            </label>
            <span className="project-saved" aria-live="polite">
              {saved && (
                <>
                  <Check aria-hidden="true" />
                  Сохранено
                </>
              )}
            </span>
          </div>
          <textarea
            id="project-notes"
            className="textarea"
            rows={5}
            value={notes}
            placeholder="План, структуры данных, что пришлось поменять"
            onChange={(event) => {
              setNotes(event.target.value);
              setSaved(false);
              pendingNotes.current = event.target.value;
              window.clearTimeout(saveTimer.current);
              saveTimer.current = window.setTimeout(flushNotes, 500);
            }}
            onBlur={flushNotes}
          />
        </section>
      </div>
    </section>
  );
}
