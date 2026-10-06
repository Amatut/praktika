// Оболочка «Мастерской»: заголовок окна со знаком «П_» и вкладками документов, полоса разделов слева,
// строка состояния снизу. На телефоне — верхняя строка и нижняя навигация. Все панели — строки и колонки
// сетки окна, поэтому ничего не закрывает содержимое; прокручивается только <main>.
import {
  BookMarked,
  BookOpen,
  ChartColumn,
  Check,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleX,
  Clock,
  Compass,
  FileQuestion,
  FolderCode,
  House,
  LoaderCircle,
  Settings,
  Wifi,
  WifiOff,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { connectionLabel, useCoachConnection } from '../coach/connection.ts';
import { findLessonSummary } from '../content/loader.ts';
import type { Course } from '../content/schema.ts';
import { getMeta } from '../storage/repo.ts';
import { useAsync, useDataVersion, useOnline, useRunnerState, useSettings } from './hooks.ts';
import { href, paths, type NavSection, type Route } from './router.ts';
import { useShellStatusValue } from './shell-status.ts';

interface NavItem {
  id: NavSection;
  label: string;
  path: string;
  icon: LucideIcon;
}

const NAV: NavItem[] = [
  { id: 'today', label: 'Сегодня', path: paths.today(), icon: House },
  { id: 'course', label: 'Курс', path: paths.course(), icon: BookOpen },
  { id: 'directions', label: 'Направления', path: paths.directions(), icon: Compass },
  { id: 'projects', label: 'Проекты', path: paths.projects(), icon: FolderCode },
  { id: 'progress', label: 'Прогресс', path: paths.progress(), icon: ChartColumn },
];

/** На телефоне четыре раздела: «Проекты» открываются из «Курса» и подсвечивают его. */
const PHONE_NAV = NAV.filter((item) => item.id !== 'projects');

function Brand() {
  return (
    <a className="brand" href={href(paths.today())} aria-label="Практика — на главную">
      <span className="brand-mark" aria-hidden="true">
        П
      </span>
    </a>
  );
}

// ------------------------------------------------------------ состояние: Python, сеть, наставник

interface StatusItem {
  key: string;
  icon: LucideIcon;
  text: string;
  tone?: 'ok' | 'err' | 'warn';
  title?: string;
  spin?: boolean;
}

function useSystemItems(): StatusItem[] {
  const runner = useRunnerState();
  const online = useOnline();
  const settings = useSettings();
  // В режиме ИИ видно состояние связи с адаптером (проверка /health бесплатная), а не только выбранный режим.
  const connection = useCoachConnection(settings.coach, online);

  const version = runner.pythonVersion?.split('.').slice(0, 2).join('.') ?? '';
  const python: StatusItem =
    runner.phase === 'ready' || runner.phase === 'busy'
      ? { key: 'python', icon: CircleCheck, text: version ? `Python ${version} готов` : 'Python готов', tone: 'ok' }
      : runner.phase === 'loading' || runner.phase === 'restarting'
        ? {
            key: 'python',
            icon: LoaderCircle,
            spin: true,
            text: runner.phase === 'loading' ? 'Python загружается…' : 'Python перезапускается…',
          }
        : runner.phase === 'failed'
          ? { key: 'python', icon: CircleAlert, text: 'Python не запустился', tone: 'err', title: runner.error }
          : { key: 'python', icon: Circle, text: 'Python запустится с уроком' };

  const network: StatusItem = online
    ? { key: 'network', icon: Wifi, text: 'В сети' }
    : { key: 'network', icon: WifiOff, text: 'Без сети', tone: 'warn', title: 'Работают скачанные уроки' };

  let coach: StatusItem;
  if (settings.coach.mode === 'ai') {
    const status = connectionLabel(connection, online);
    const problem = connection.state === 'unavailable' || connection.state === 'not-configured' ? connection.message : null;
    coach = {
      key: 'coach',
      icon: BookMarked,
      text: `ИИ: ${status.text}`,
      tone: status.tone === 'warn' ? 'warn' : undefined,
      title: problem ?? `ИИ-наставник: ${status.text}`,
    };
  } else {
    coach = { key: 'coach', icon: BookMarked, text: 'Наставник: подсказки курса', title: 'Подсказки курса · не ИИ' };
  }
  return [python, network, coach];
}

/**
 * «Перейти к содержимому»: фокус в первую прокручиваемую область экрана. У настроек (уже 1200) и урока
 * прокручивается не main, а своя область — без этого PgDn и пробел не листали бы содержимое.
 */
function focusContent() {
  const main = document.getElementById('main');
  if (!main) return;
  const scrolls = (element: Element) =>
    /(auto|scroll)/.test(getComputedStyle(element).overflowY) && element.scrollHeight > element.clientHeight + 1;
  const target = scrolls(main) ? main : ([...main.querySelectorAll<HTMLElement>('*')].find(scrolls) ?? main);
  if (target !== main && !target.hasAttribute('tabindex')) {
    target.tabIndex = -1;
    target.dataset.skipTarget = '';
  }
  target.focus();
}

function StatusEntry({ item, className = '' }: { item: StatusItem; className?: string }) {
  const Icon = item.icon;
  return (
    <span
      className={`sb sb-${item.key}${item.tone ? ` tone-${item.tone}` : ''}${className ? ` ${className}` : ''}`}
      title={item.title}
    >
      <Icon aria-hidden="true" className={item.spin ? 'spin' : undefined} />
      <span>{item.text}</span>
    </span>
  );
}

/**
 * Состояние Python, сети и наставника: значок + слово (тон — не единственный сигнал).
 * variant 'inline' — строкой внутри экрана (телефон: низ «Сегодня»), 'bar' — в строке состояния.
 */
export function SystemStatus({ variant = 'inline' }: { variant?: 'bar' | 'inline' }) {
  const items = useSystemItems();
  if (variant === 'bar') return items.map((item) => <StatusEntry key={item.key} item={item} />);
  return (
    <div className="status-inline" aria-label="Состояние">
      {items.map((item) => (
        <StatusEntry key={item.key} item={item} />
      ))}
    </div>
  );
}

function StatusBar({ lesson }: { lesson: boolean }) {
  const status = useShellStatusValue();
  const tests = lesson ? status.tests : null;
  return (
    <footer className="statusbar" aria-label="Состояние">
      {tests && (
        <button
          type="button"
          className="sb sb-tests"
          onClick={tests.open}
          aria-label={`Проверка: ${tests.failed} не ${tests.failed === 1 ? 'прошёл' : 'прошли'}, ${tests.passed} ${
            tests.passed === 1 ? 'прошёл' : 'прошли'
          }. Открыть «Проверку»`}
        >
          <span className="sb-count tone-err">
            <CircleX aria-hidden="true" />
            <span className="n">{tests.failed}</span>
          </span>
          <span className="sb-count tone-ok">
            <CircleCheck aria-hidden="true" />
            <span className="n">{tests.passed}</span>
          </span>
        </button>
      )}
      <SystemStatus variant="bar" />
      {lesson && (status.minutes || status.cursor) && (
        <span className="sb-end">
          {status.minutes && (
            <span className="sb sb-minutes">
              <Clock aria-hidden="true" />
              <span>
                <span className="n">
                  {status.minutes[0] === status.minutes[1] ? status.minutes[0] : `${status.minutes[0]}–${status.minutes[1]}`}
                </span>{' '}
                мин
              </span>
            </span>
          )}
          {status.cursor && (
            <span className="sb sb-cursor">
              <span>курсор</span>
              <span className="sb-addr">
                {status.cursor.file}:{status.cursor.line}
              </span>
            </span>
          )}
        </span>
      )}
    </footer>
  );
}

// ------------------------------------------------------------ вкладки документов

interface DocTab {
  key: string;
  label: ReactNode;
  title: string;
  icon: LucideIcon;
  path: string;
  current: boolean;
  /** Временная вкладка раздела: сокращается с многоточием, если не хватает места. */
  shrink?: boolean;
}

/** Вкладка текущего раздела, если это не «Сегодня» и не урок. */
function sectionTab(route: Route, course: Course | null): { label: string; icon: LucideIcon; path: string } | null {
  switch (route.name) {
    case 'course':
      return { label: 'Курс', icon: BookOpen, path: paths.course() };
    case 'module': {
      const module = course?.modules.find((item) => item.id === route.moduleId);
      return { label: module ? `Модуль ${module.number}` : 'Модуль', icon: BookOpen, path: paths.module(route.moduleId) };
    }
    case 'directions':
      return { label: 'Направления', icon: Compass, path: paths.directions(route.labId ?? undefined) };
    case 'projects':
      return { label: 'Проекты', icon: FolderCode, path: paths.projects(route.projectId ?? undefined) };
    case 'progress':
      return { label: 'Прогресс', icon: ChartColumn, path: paths.progress() };
    case 'settings':
      return { label: 'Настройки', icon: Settings, path: paths.settings(route.section ?? undefined) };
    case 'not-found':
      return { label: 'Не найдено', icon: FileQuestion, path: route.path };
    default:
      return null;
  }
}

/** Последний открытый урок: из адреса, если открыт урок, иначе из служебных данных (meta.currentLessonId). */
function useLessonTab(route: Route, course: Course | null): { id: string; number: string } | null {
  const version = useDataVersion(['kv']);
  const meta = useAsync(() => getMeta(), [version]);
  const lessonId = route.name === 'lesson' ? route.lessonId : (meta.value?.currentLessonId ?? null);
  if (!lessonId || !course) return null;
  const found = findLessonSummary(course, lessonId);
  if (!found) return null;
  return { id: lessonId, number: found.lesson.number ?? `${found.module.number}.${found.index + 1}` };
}

function DocTabs({ route, course }: { route: Route; course: Course | null }) {
  const lesson = useLessonTab(route, course);
  const section = sectionTab(route, course);
  const tabs: DocTab[] = [
    { key: 'today', label: 'Сегодня', title: 'Сегодня', icon: House, path: paths.today(), current: route.name === 'today' },
  ];
  if (lesson) {
    tabs.push({
      key: 'lesson',
      label: (
        <>
          Урок <span className="n">{lesson.number}</span>
        </>
      ),
      title: `Урок ${lesson.number}`,
      icon: BookOpen,
      path: paths.lesson(lesson.id),
      current: route.name === 'lesson',
    });
  }
  if (section) {
    tabs.push({ key: 'section', label: section.label, title: section.label, icon: section.icon, path: section.path, current: true, shrink: true });
  }
  return (
    <nav className="doc-tabs" aria-label="Открытые вкладки">
      {tabs.map((tab) => (
        <a
          key={tab.key}
          className={`dtab${tab.shrink ? ' dtab-shrink' : ''}`}
          href={href(tab.path)}
          aria-current={tab.current ? 'page' : undefined}
          title={tab.shrink ? tab.title : undefined}
        >
          <tab.icon aria-hidden="true" />
          <span className="dtab-text">{tab.label}</span>
        </a>
      ))}
    </nav>
  );
}

/** Название экрана в верхней строке телефона. */
function phoneTitle(route: Route, course: Course | null): string {
  if (route.name === 'today') return 'Сегодня';
  if (route.name === 'lesson') return 'Урок';
  return sectionTab(route, course)?.label ?? 'Практика';
}

function TitlebarEnd({ lesson }: { lesson: boolean }) {
  const status = useShellStatusValue();
  if (lesson && status.save) {
    return (
      <div className="titlebar-end">
        {status.save === 'saving' ? (
          <span className="save">
            <LoaderCircle aria-hidden="true" className="spin" />
            Сохраняю…
          </span>
        ) : status.save === 'saved' ? (
          <span className="save tone-ok-icon">
            <Check aria-hidden="true" />
            Черновик сохранён
          </span>
        ) : (
          <span className="save tone-err">
            <CircleX aria-hidden="true" />
            Не сохранено
          </span>
        )}
      </div>
    );
  }
  if (lesson) return <div className="titlebar-end" />;
  const today = new Date().toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
  return (
    <div className="titlebar-end">
      <span className="today-date">{today}</span>
    </div>
  );
}

export function AppShell({
  section,
  route,
  course,
  banners,
  children,
}: {
  section: NavSection | null;
  route: Route;
  course: Course | null;
  /** Баннеры (обновление, сбой сохранения): строка сетки над содержимым, никогда не поверх него. */
  banners?: ReactNode;
  children: ReactNode;
}) {
  const online = useOnline();
  const lesson = route.name === 'lesson';
  const phoneSection = section === 'projects' ? 'course' : section;
  return (
    <div className="app" data-screen={route.name}>
      <a
        className="skip-link"
        href="#main"
        onClick={(event) => {
          event.preventDefault();
          focusContent();
        }}
      >
        Перейти к содержимому
      </a>

      <header className="titlebar">
        <Brand />
        <DocTabs route={route} course={course} />
        <TitlebarEnd lesson={lesson} />
      </header>

      <header className="topbar">
        <Brand />
        <span className="topbar-title">{phoneTitle(route, course)}</span>
        {!online && (
          <span className="topbar-offline tone-warn" title="Работают скачанные уроки">
            <WifiOff aria-hidden="true" />
            Без сети
          </span>
        )}
        <a
          className="btn btn-ghost btn-icon topbar-settings"
          href={href(paths.settings())}
          aria-label="Настройки"
          title="Настройки"
          aria-current={section === 'settings' ? 'page' : undefined}
        >
          <Settings aria-hidden="true" />
        </a>
      </header>

      <nav className="activity sidebar" aria-label="Разделы">
        {NAV.map((item) => (
          <a key={item.id} className="act" href={href(item.path)} aria-current={section === item.id ? 'page' : undefined}>
            <item.icon aria-hidden="true" />
            <span>{item.label}</span>
          </a>
        ))}
        <span className="act-spacer" />
        <a className="act" href={href(paths.settings())} aria-current={section === 'settings' ? 'page' : undefined}>
          <Settings aria-hidden="true" />
          <span>Настройки</span>
        </a>
      </nav>

      <div className="banners">{banners}</div>

      <main id="main" className="main" tabIndex={-1}>
        {children}
      </main>

      <StatusBar lesson={lesson} />

      <nav className="bottombar" aria-label="Разделы">
        {PHONE_NAV.map((item) => (
          <a key={item.id} href={href(item.path)} aria-current={phoneSection === item.id ? 'page' : undefined}>
            <item.icon aria-hidden="true" />
            <span>{item.label}</span>
          </a>
        ))}
      </nav>
    </div>
  );
}
