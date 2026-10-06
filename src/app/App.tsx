import { CircleAlert, Download, FileQuestion, RefreshCw, WifiOff } from 'lucide-react';
import { Suspense, lazy, useEffect, useState, type ReactNode } from 'react';
import { EmptyState, Spinner } from '../components/ui.tsx';
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
            as="h1"
            title="Такой страницы нет"
            icon={FileQuestion}
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

/** Баннер оболочки: строка сетки над содержимым (не поверх него), значок + короткий текст + действия. */
function Banner({
  tone,
  icon: Icon,
  role = 'status',
  children,
  actions,
}: {
  tone: 'warn' | 'err' | 'muted';
  icon: typeof RefreshCw;
  role?: 'status' | 'alert';
  children: ReactNode;
  actions: ReactNode;
}) {
  return (
    <div className={`banner banner-${tone}`} role={role}>
      <Icon aria-hidden="true" />
      <div className="banner-text">{children}</div>
      <div className="banner-actions">{actions}</div>
    </div>
  );
}

function UpdateBanner() {
  const update = useUpdateState();
  if (update.reloadNeeded) {
    // Новую версию применили в другой вкладке: файлы этой оболочки уже заменены.
    return (
      <Banner
        tone="muted"
        icon={RefreshCw}
        actions={
          <button type="button" className="btn btn-primary btn-sm" onClick={reloadPage}>
            Перезагрузить
          </button>
        }
      >
        Приложение обновилось в другой вкладке
      </Banner>
    );
  }
  if (!update.updateReady) return null;
  return (
    <Banner
      tone="muted"
      icon={RefreshCw}
      actions={
        <button type="button" className="btn btn-primary btn-sm" onClick={applyUpdate}>
          Обновить
        </button>
      }
    >
      Новая версия «Практики»
    </Banner>
  );
}

/**
 * После обновления прежняя версия скачанного модуля не подходит: без сети его уроки не откроются.
 * В «Настройках» (hidden) баннера нет: там модуль виден в «Работе без сети» со своей кнопкой — вторая главная кнопка
 * на экране не нужна. Компонент остаётся смонтированным, чтобы «Позже» не забывалось.
 */
function StaleModulesBanner({ course, hidden = false }: { course: Course | null; hidden?: boolean }) {
  const offline = useOfflineStatus();
  const stale = (course?.modules ?? []).filter((module) => offline.modules[module.id]?.stale);
  const key = stale.map((module) => module.id).join(',');
  const [dismissed, setDismissed] = useState('');
  if (hidden || stale.length === 0 || dismissed === key) return null;
  const numbers = stale.map((module) => module.number).join(', ');
  return (
    <Banner
      tone="warn"
      icon={Download}
      actions={
        <>
          <a className="btn btn-primary btn-sm" href={href(paths.settings('offline'))} onClick={() => setDismissed(key)}>
            Скачать
          </a>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDismissed(key)}>
            Позже
          </button>
        </>
      }
    >
      {stale.length === 1 ? `Модуль ${numbers} обновился — скачай заново` : `Модули ${numbers} обновились — скачай заново`}
    </Banner>
  );
}

/** Сбой сохранения: хранилище недоступно, не хватило места, черновик не записался. */
function SaveProblemBanner() {
  const problem = useSaveProblem();
  if (!problem) return null;
  return (
    <Banner
      tone="err"
      icon={CircleAlert}
      role="alert"
      actions={
        <>
          {problem.reload && (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => window.location.reload()}>
              Перезагрузить
            </button>
          )}
          <button type="button" className="btn btn-ghost btn-sm" onClick={dismissSaveProblem}>
            Понятно
          </button>
        </>
      }
    >
      <strong className="banner-title">{problem.title}</strong>
      <span>{problem.message}</span>
    </Banner>
  );
}

/** Строка ожидания: слева сверху, не по центру экрана. */
function Loading({ children }: { children: ReactNode }) {
  return (
    <div className="page">
      <p className="loading-line" role="status">
        <Spinner />
        {children}
      </p>
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
      setError(navigator.onLine ? 'Не удалось загрузить курс' : 'Нет сети, приложение ещё не сохранено'),
    );
  }, []);

  useEffect(() => {
    const title = route.name === 'lesson' ? 'Урок' : TITLES[route.name];
    document.title = title ? `${title} — Практика` : 'Практика';
  }, [route.name]);

  // Новый экран открывается с начала: прокручивается <main>, а не окно (окно всегда ровно в экран).
  useEffect(() => {
    document.getElementById('main')?.scrollTo({ top: 0 });
    if (document.documentElement.dataset.scroll === 'page') window.scrollTo({ top: 0 });
  }, [route.name]);

  return (
    <AppShell
      section={sectionOf(route)}
      route={route}
      course={course}
      banners={
        <>
          <SaveProblemBanner />
          <StaleModulesBanner course={course} hidden={route.name === 'settings'} />
          <UpdateBanner />
        </>
      }
    >
      {course ? (
        <ScreenErrorBoundary resetKey={path}>
          <Suspense fallback={<Loading>Открываю…</Loading>}>
            <Screen route={route} course={course} />
          </Suspense>
        </ScreenErrorBoundary>
      ) : error ? (
        <div className="page page-narrow">
          <EmptyState
            as="h1"
            title="Курс не загрузился"
            icon={navigator.onLine ? CircleAlert : WifiOff}
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
        <Loading>Загружаю курс…</Loading>
      )}
    </AppShell>
  );
}
