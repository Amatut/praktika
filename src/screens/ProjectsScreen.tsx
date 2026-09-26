import { FolderKanban } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAsync, useDataVersion } from '../app/hooks.ts';
import { reportSaveProblem } from '../app/problems.ts';
import { href, navigate, paths } from '../app/router.ts';
import { StatusBadge } from '../components/ui.tsx';
import type { Course, Project } from '../content/schema.ts';
import { getProject, saveProject } from '../storage/repo.ts';
import type { ProjectRecord } from '../storage/types.ts';

const ENV = { browser: 'в браузере', local: 'на компьютере', mixed: 'браузер + компьютер' } as const;

export function ProjectsScreen({ course, projectId }: { course: Course; projectId: string | null }) {
  const selected = course.projects.find((project) => project.id === projectId) ?? course.projects[0];
  return (
    <div className="page">
      <header className="page-head">
        <a className="eyebrow" href={href(paths.course())} style={{ textDecoration: 'none' }}>
          ← Курс · проекты
        </a>
        <h1>Проекты</h1>
        <p className="page-lead">
          Лестница от небольшой консольной программы до итогового проекта. Сначала ты пишешь план и делаешь реализацию сам,
          наставник помогает точечно. В конце одно требование меняется — это проверка понимания.
        </p>
      </header>
      <div className="labs-layout">
        <ol className="lesson-rows" aria-label="Лестница проектов">
          {course.projects.map((project, index) => {
            const after = course.modules.find((module) => module.id === project.after);
            return (
              <li key={project.id}>
                <a
                  className="lesson-row"
                  href={href(paths.projects(project.id))}
                  aria-current={project.id === selected.id ? 'true' : undefined}
                  onClick={(event) => {
                    event.preventDefault();
                    navigate(paths.projects(project.id), { replace: true });
                    // На узком экране описание ниже списка: показываем его и переносим туда фокус.
                    if (window.matchMedia('(max-width: 1199px)').matches) {
                      requestAnimationFrame(() => {
                        document.getElementById('project-title')?.focus({ preventScroll: true });
                        document.getElementById('project-detail')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                      });
                    }
                  }}
                >
                  <span className="lesson-row-num">{index + 1}</span>
                  <span>
                    <span className="list-row-title">{project.title}</span>
                    <span className="list-row-sub" style={{ display: 'block' }}>
                      после модуля {after?.number ?? '—'} · {ENV[project.environment]}
                    </span>
                  </span>
                  <StatusBadge tone={project.ready ? 'good' : 'muted'}>{project.ready ? 'Готов' : 'Материалы пишутся'}</StatusBadge>
                </a>
              </li>
            );
          })}
        </ol>
        <ProjectDetail key={selected.id} course={course} project={selected} />
      </div>
    </div>
  );
}

function ProjectDetail({ course, project }: { course: Course; project: Project }) {
  const version = useDataVersion(['projects']);
  const stored = useAsync(() => getProject(project.id), [project.id, version]);
  const record: ProjectRecord = stored.value ?? { projectId: project.id, stagesDone: [], notes: '', updatedAt: 0 };
  const [notes, setNotes] = useState('');
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
  const after = course.modules.find((module) => module.id === project.after);

  const flushNotes = useCallback(() => {
    window.clearTimeout(saveTimer.current);
    const value = pendingNotes.current;
    if (value === null) return;
    pendingNotes.current = null;
    saveProject({ projectId: project.id, notes: value }).catch((error: unknown) => reportSaveProblem(error, 'Записи проекта не сохранены'));
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
    const done = new Set(record.stagesDone);
    if (done.has(stageId)) done.delete(stageId);
    else done.add(stageId);
    await saveProject({ projectId: project.id, stagesDone: project.stages.map((stage) => stage.id).filter((id) => done.has(id)) });
  }

  return (
    <section id="project-detail" className="lab-detail" aria-labelledby="project-title">
      <div className="card stack">
        <div className="stack-sm">
          <span className="eyebrow row" style={{ gap: 6 }}>
            <FolderKanban aria-hidden="true" width={14} height={14} />
            Проект · после модуля {after?.number ?? '—'}
          </span>
          <h2 id="project-title" tabIndex={-1}>
            {project.title}
          </h2>
          <p className="muted">{project.story}</p>
          {!project.ready && (
            <StatusBadge tone="muted">Пошаговые материалы проекта ещё пишутся — требования уже можно прочитать</StatusBadge>
          )}
        </div>
        <div className="stack-sm">
          <span className="label">Минимальные требования</span>
          <ul className="bullets small">
            {project.minimum.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
        <div className="stack-sm">
          <span className="label">Дополнительно (по желанию)</span>
          <ul className="bullets small">
            {project.extras.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
        <div className="stack-sm">
          <span className="label">Проект готов, когда</span>
          <ul className="bullets small">
            {project.criteria.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
        <div className="prose-note small">
          <strong>Изменение требования в конце: </strong>
          {project.changeRequest}
        </div>
      </div>

      <div className="card stack">
        <div>
          <h3 className="card-title">Этапы</h3>
          <p className="card-sub">Отметки ставишь ты — это твой план, а не автоматическая проверка.</p>
        </div>
        <ul className="checklist">
          {project.stages.map((stage) => (
            <li key={stage.id} data-done={record.stagesDone.includes(stage.id)}>
              <label className="check">
                <input type="checkbox" checked={record.stagesDone.includes(stage.id)} onChange={() => void toggleStage(stage.id)} />
                <span>
                  <strong className="small">{stage.title}</strong>
                  <span className="small muted" style={{ display: 'block' }}>
                    {stage.description}
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>
        <label className="field">
          <span className="field-label">Мои решения</span>
          <span className="field-hint">План, выбранные структуры данных, что пришлось поменять. Сохраняется автоматически.</span>
          <textarea
            className="textarea"
            rows={5}
            value={notes}
            onChange={(event) => {
              setNotes(event.target.value);
              pendingNotes.current = event.target.value;
              window.clearTimeout(saveTimer.current);
              saveTimer.current = window.setTimeout(flushNotes, 500);
            }}
            onBlur={flushNotes}
          />
        </label>
      </div>
    </section>
  );
}
