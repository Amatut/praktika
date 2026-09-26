import { CircleAlert, Download, RefreshCw } from 'lucide-react';
import { Suspense, lazy, useEffect, useState } from 'react';
import { EmptyState } from '../components/ui.tsx';
import { loadCourse } from '../content/loader.ts';
import type { Course } from '../content/schema.ts';
import { applyUpdate, reloadPage, useUpdateState } from '../pwa/register.ts';
import { setAppInfo } from '../storage/transfer.ts';
import { CourseScreen, ModuleScreen } from '../screens/CourseScreen.tsx';
import { useOfflineStatus } from '../screens/offline-controls.tsx';
import { TodayScreen } from '../screens/TodayScreen.tsx';
import { startActivityTracking } from './activity.ts';
import { AppShell } from './AppShell.tsx';
import { ScreenErrorBoundary } from './ErrorBoundary.tsx';
import { initSettings } from './hooks.ts';
import { dismissSaveProblem, useSaveProblem, watchStorageErrors } from './problems.ts';
import { href, parsePath, paths, sectionOf, usePath, type Route } from './router.ts';

// Тяжёлые экраны (редактор кода, настройки) загружаются отдельными частями —
// первый экран открывается быстрее. В офлайн-кеш попадают все части.
const LessonScreen = lazy(() => import('../screens/lesson/LessonScreen.tsx').then((m) => ({ default: m.LessonScreen })));
const SettingsScreen = lazy(() => import('../screens/SettingsScreen.tsx').then((m) => ({ default: m.SettingsScreen })));
const DirectionsScreen = lazy(() => import('../screens/DirectionsScreen.tsx').then((m) => ({ default: m.DirectionsScreen })));
const ProgressScreen = lazy(() => import('../screens/ProgressScreen.tsx').then((m) => ({ default: m.ProgressScreen })));
const ProjectsScreen = lazy(() => import('../screens/ProjectsScreen.tsx').then((m) => ({ default: m.ProjectsScreen })));

const TITLES: Partial<Record<Route['name'], string>> = {
  today: 'Сегодня',
  course: 'Курс',
  module: 'Модуль',
  projects: 'Проекты',
  directions: 'Направления',
  progress: 'Прогресс',
  settings: 'Настройки',
};

function Screen({ route, course }: { route: Route; course: Course }) {
  switch (route.name) {
    case 'today':
      return <TodayScreen course={course} />;
    case 'course':
      return <CourseScreen course={course} />;
    case 'module':
      return <ModuleScreen course={course} moduleId={route.moduleId} />;
    case 'projects':
      return <ProjectsScreen course={course} projectId={route.projectId} />;
    case 'lesson':
      return <LessonScreen course={course} lessonId={route.lessonId} step={route.step} />;
    case 'directions':
      return <DirectionsScreen course={course} labId={route.labId} />;
    case 'progress':
      return <ProgressScreen course={course} />;
    case 'settings':
      return <SettingsScreen course={course} section={route.section} />;
    default:
      return (
        <div className="page page-narrow">
          <EmptyState
            title="Такой страницы нет"
            action={
              <a className="btn" href={href(paths.today())}>
                На главную
              </a>
            }
          />
        </div>
      );
  }
}

function UpdateBanner() {
  const update = useUpdateState();
  const offline = useOfflineStatus();
  if (update.reloadNeeded) {
    // Новую версию применили в другой вкладке: файлы этой оболочки уже заменены.
    return (
      <div className="toast" role="status">
        <RefreshCw aria-hidden="true" width={18} height={18} />
        <span className="toast-text">«Практика» обновилась в другой вкладке. Перезагрузи страницу, чтобы всё работало. Прогресс сохранится.</span>
        <span className="toast-actions">
          <button type="button" className="btn btn-primary btn-sm" onClick={reloadPage}>
            Перезагрузить
          </button>
        </span>
      </div>
    );
  }
  if (!update.updateReady) return null;
  const hasDownloads = Object.values(offline.modules).some((module) => module.complete || module.stale);
  return (
    <div className="toast" role="status">
      <RefreshCw aria-hidden="true" width={18} height={18} />
      <span className="toast-text">
        Доступна новая версия «Практики». Прогресс сохранится.
        {hasDownloads && ' Скачанные для работы без сети уроки обновятся вместе с приложением; если какой-то модуль не скачается, приложение подскажет.'}
      </span>
      <span className="toast-actions">
        <button type="button" className="btn btn-primary btn-sm" onClick={applyUpdate}>
          Обновить
        </button>
      </span>
    </div>
  );
}

/** После обновления прежняя версия скачанного модуля не подходит: без сети его уроки не откроются. */
function StaleModulesBanner({ course }: { course: Course | null }) {
  const offline = useOfflineStatus();
  const stale = (course?.modules ?? []).filter((module) => offline.modules[module.id]?.stale);
  const key = stale.map((module) => module.id).join(',');
  const [dismissed, setDismissed] = useState('');
  if (stale.length === 0 || dismissed === key) return null;
  const numbers = stale.map((module) => module.number).join(', ');
  return (
    <div className="toast" role="status">
      <Download aria-hidden="true" width={18} height={18} />
      <span className="toast-text">
        {stale.length === 1 ? `Модуль ${numbers} обновился — скачай его` : `Модули ${numbers} обновились — скачай их`} заново для
        работы без сети.
      </span>
      <span className="toast-actions">
        <a className="btn btn-primary btn-sm" href={href(paths.settings('offline'))} onClick={() => setDismissed(key)}>
          Скачать
        </a>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDismissed(key)}>
          Позже
        </button>
      </span>
    </div>
  );
}

/** Сбой сохранения: хранилище недоступно, не хватило места, черновик не записался. */
function SaveProblemBanner() {
  const problem = useSaveProblem();
  if (!problem) return null;
  return (
    <div className="toast toast-error" role="alert">
      <CircleAlert aria-hidden="true" width={18} height={18} />
      <span className="toast-text stack-sm" style={{ gap: 2 }}>
        <strong>{problem.title}</strong>
        <span>{problem.message}</span>
      </span>
      <span className="toast-actions">
        {problem.reload && (
          <button type="button" className="btn btn-primary btn-sm" onClick={() => window.location.reload()}>
            Перезагрузить
          </button>
        )}
        <button type="button" className="btn btn-ghost btn-sm" onClick={dismissSaveProblem}>
          Понятно
        </button>
      </span>
    </div>
  );
}

export function App() {
  const path = usePath();
  const route = parsePath(path);
  const [course, setCourse] = useState<Course | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const stopWatching = watchStorageErrors();
    void initSettings();
    const stopTracking = startActivityTracking();
    return () => {
      stopWatching();
      stopTracking();
    };
  }, []);

  useEffect(() => {
    loadCourse().then((value) => {
      setAppInfo({ version: __APP_VERSION__, contentVersion: value.contentVersion });
      setCourse(value);
    }, () =>
      setError(
        navigator.onLine
          ? 'Не удалось загрузить карту курса. Попробуй обновить страницу.'
          : 'Нет сети, а приложение ещё не сохранено для работы без интернета. Открой его один раз с сетью.',
      ),
    );
  }, []);

  useEffect(() => {
    const title = route.name === 'lesson' ? 'Урок' : TITLES[route.name];
    document.title = title ? `${title} — Практика` : 'Практика';
  }, [route.name]);

  // Фокус на основной области после перехода — для чтения с клавиатуры и скринридера.
  useEffect(() => {
    if (route.name !== 'lesson') window.scrollTo({ top: 0 });
  }, [route.name]);

  return (
    <AppShell section={sectionOf(route)}>
      {course ? (
        <ScreenErrorBoundary resetKey={path}>
          <Suspense
            fallback={
              <div className="page">
                <p className="muted" role="status">
                  Открываю…
                </p>
              </div>
            }
          >
            <Screen route={route} course={course} />
          </Suspense>
        </ScreenErrorBoundary>
      ) : error ? (
        <div className="page page-narrow">
          <EmptyState
            title="Курс не загрузился"
            action={
              <button type="button" className="btn" onClick={() => window.location.reload()}>
                Обновить страницу
              </button>
            }
          >
            {error}
          </EmptyState>
        </div>
      ) : (
        <div className="page">
          <p className="muted" role="status">
            Загружаю курс…
          </p>
        </div>
      )}
      <div className="toast-region">
        <SaveProblemBanner />
        <StaleModulesBanner course={course} />
        <UpdateBanner />
      </div>
    </AppShell>
  );
}
