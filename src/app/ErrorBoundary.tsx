// Сбой одного экрана не должен оставлять пустую страницу. Частый случай — вкладка открыта давно,
// приложение обновилось, и ленивая часть экрана прежней версии уже удалена из кеша.

import { CircleAlert, House, RefreshCw } from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Disclosure } from '../components/ui.tsx';
import { href, paths } from './router.ts';

/** Не загрузилась ленивая часть приложения (import() экрана). */
export function isChunkLoadError(error: Error): boolean {
  return (
    error.name === 'ChunkLoadError' ||
    /dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS/i.test(
      error.message,
    )
  );
}

interface Props {
  /** При смене адреса ошибка сбрасывается — можно уйти на другой экран. */
  resetKey: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ScreenErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Экран не открылся', error, info.componentStack);
  }

  componentDidUpdate(previous: Props) {
    if (previous.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const chunk = isChunkLoadError(error);
    // Вид пустого состояния (.empty), но заголовок — h1: экран упал, и другого заголовка на нём нет.
    return (
      <div className="page screen-error">
        <div role="alert" className="empty">
          <CircleAlert aria-hidden="true" className="empty-icon" />
          <div className="empty-main">
            <h1 className="empty-title">{chunk ? 'Не получилось открыть экран' : 'На этом экране что-то пошло не так'}</h1>
            <p className="empty-text">Прогресс на месте.</p>
            <div className="empty-actions">
              <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
                <RefreshCw aria-hidden="true" />
                Обновить страницу
              </button>
              <a className="btn" href={href(paths.today())}>
                <House aria-hidden="true" />
                На главную
              </a>
            </div>
          </div>
        </div>
        {!chunk && (
          <Disclosure summary="Подробности для разработчика" className="screen-error-details">
            <pre className="screen-error-trace">{error.message}</pre>
          </Disclosure>
        )}
      </div>
    );
  }
}
