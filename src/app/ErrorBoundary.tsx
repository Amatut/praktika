// Сбой одного экрана не должен оставлять пустую страницу. Частый случай — вкладка открыта давно,
// приложение обновилось, и ленивая часть экрана прежней версии уже удалена из кеша.

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { EmptyState } from '../components/ui.tsx';
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
    return (
      <div className="page">
        <div role="alert">
          <EmptyState
            title={chunk ? 'Не получилось открыть экран' : 'На этом экране что-то пошло не так'}
            action={
              <div className="row">
                <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
                  Обновить страницу
                </button>
                <a className="btn btn-ghost" href={href(paths.today())}>
                  На главную
                </a>
              </div>
            }
          >
            <p>
              {chunk
                ? 'Похоже, приложение обновилось, пока эта вкладка была открыта, или пропала сеть. Обнови страницу — сохранённый прогресс на месте.'
                : 'Сохранённый прогресс на месте. Обнови страницу; если ошибка повторится, открой другой раздел.'}
            </p>
            {!chunk && (
              <details className="disclosure" style={{ marginTop: 8 }}>
                <summary>Подробности для разработчика</summary>
                <div className="disclosure-body">
                  <pre className="card-code">{error.message}</pre>
                </div>
              </details>
            )}
          </EmptyState>
        </div>
      </div>
    );
  }
}
