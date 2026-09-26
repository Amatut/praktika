import { BookOpen, ChartColumn, Compass, House, Settings } from 'lucide-react';
import type { ReactNode } from 'react';
import { connectionLabel, useCoachConnection } from '../coach/connection.ts';
import { useOnline, useRunnerState, useSettings } from './hooks.ts';
import { href, paths, type NavSection } from './router.ts';

const NAV: { id: NavSection; label: string; path: string; icon: typeof House }[] = [
  { id: 'today', label: 'Сегодня', path: paths.today(), icon: House },
  { id: 'course', label: 'Курс', path: paths.course(), icon: BookOpen },
  { id: 'directions', label: 'Направления', path: paths.directions(), icon: Compass },
  { id: 'progress', label: 'Прогресс', path: paths.progress(), icon: ChartColumn },
];

function Brand() {
  return (
    <a className="brand" href={href(paths.today())} aria-label="Практика — на главную">
      <span className="brand-mark" aria-hidden="true">
        &gt;_
      </span>
      <span className="brand-name">Практика</span>
    </a>
  );
}

/** Короткое честное состояние: Python, сеть, режим наставника. */
export function SystemStatus() {
  const runner = useRunnerState();
  const online = useOnline();
  const settings = useSettings();

  const python =
    runner.phase === 'ready' || runner.phase === 'busy'
      ? { tone: 'tone-good', text: `Python ${runner.pythonVersion ?? ''} готов` }
      : runner.phase === 'loading' || runner.phase === 'restarting'
        ? { tone: 'tone-accent', text: runner.phase === 'loading' ? 'Python загружается…' : 'Python перезапускается…' }
        : runner.phase === 'failed'
          ? { tone: 'tone-error', text: 'Python не запустился' }
          : { tone: 'tone-muted', text: 'Python запустится с уроком' };

  // В режиме ИИ видно состояние связи с адаптером (проверка /health бесплатная), а не только выбранный режим.
  const connection = useCoachConnection(settings.coach, online);
  const status = connectionLabel(connection, online);
  const problem = connection.state === 'unavailable' || connection.state === 'not-configured' ? connection.message : null;
  const coach =
    settings.coach.mode === 'ai'
      ? { tone: `tone-${status.tone}`, text: `ИИ: ${status.text}`, title: problem ?? `ИИ-наставник: ${status.text}` }
      : { tone: 'tone-muted', text: 'Наставник: подсказки курса', title: 'Наставник: подсказки курса' };

  return (
    <div className="sys-status" aria-label="Состояние">
      <div className={`sys-status-row ${python.tone}`} title={python.text}>
        <span className="dot" aria-hidden="true" />
        <span className="sys-status-text">{python.text}</span>
      </div>
      <div className={`sys-status-row ${online ? 'tone-good' : 'tone-warn'}`} title={online ? 'Сеть есть' : 'Нет сети'}>
        <span className="dot" aria-hidden="true" />
        <span className="sys-status-text">{online ? 'Сеть есть' : 'Нет сети — работают сохранённые уроки'}</span>
      </div>
      <div className={`sys-status-row ${coach.tone}`} title={coach.title}>
        <span className="dot" aria-hidden="true" />
        <span className="sys-status-text">{coach.text}</span>
      </div>
    </div>
  );
}

export function AppShell({ section, children }: { section: NavSection | null; children: ReactNode }) {
  const online = useOnline();
  return (
    <div className="app">
      <a className="skip-link" href="#main" onClick={(event) => {
        event.preventDefault();
        document.getElementById('main')?.focus();
      }}>
        Перейти к содержимому
      </a>

      <aside className="sidebar">
        <Brand />
        <nav className="nav" aria-label="Разделы">
          {NAV.map((item) => (
            <a
              key={item.id}
              className="nav-item"
              href={href(item.path)}
              aria-current={section === item.id ? 'page' : undefined}
            >
              <item.icon aria-hidden="true" />
              <span>{item.label}</span>
            </a>
          ))}
        </nav>
        <div className="sidebar-foot">
          <SystemStatus />
          {!online && (
            <div className="rail-offline">
              <span className="badge badge-warn" title="Нет сети — работают сохранённые уроки">
                Без сети
              </span>
            </div>
          )}
          <div className="pace">
            <strong>20–30 минут в день</strong>
            История, небольшая задача, новый навык. Пропуск дня ничего не обнуляет.
          </div>
          <nav className="nav" aria-label="Служебное">
            <a className="nav-item" href={href(paths.settings())} aria-current={section === 'settings' ? 'page' : undefined}>
              <Settings aria-hidden="true" />
              <span>Настройки</span>
            </a>
          </nav>
        </div>
      </aside>

      <header className="topbar">
        <Brand />
        <span className="spacer" />
        {!online && <span className="badge badge-warn">Без сети</span>}
        <a
          className="btn btn-ghost btn-icon"
          href={href(paths.settings())}
          aria-label="Настройки"
          aria-current={section === 'settings' ? 'page' : undefined}
        >
          <Settings aria-hidden="true" />
        </a>
      </header>

      <main id="main" className="main" tabIndex={-1}>
        {children}
      </main>

      <nav className="bottombar" aria-label="Разделы">
        {NAV.map((item) => (
          <a key={item.id} href={href(item.path)} aria-current={section === item.id ? 'page' : undefined}>
            <item.icon aria-hidden="true" />
            <span>{item.label}</span>
          </a>
        ))}
      </nav>
    </div>
  );
}
