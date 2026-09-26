// Сбои сохранения, о которых ученик должен узнать сразу: хранилище браузера недоступно, не хватает места,
// черновик не записался. Сообщение показывает баннер в App.tsx — прогресс не должен теряться молча.

import { useEffect, useSyncExternalStore } from 'react';

export interface SaveProblem {
  title: string;
  message: string;
  /** Помогает только перезагрузка страницы (например, приложение обновилось в другой вкладке). */
  reload: boolean;
}

let current: SaveProblem | null = null;
/** Причина, которую экран уже показывает крупно (например, «Прогресс не загрузился»): баннер её не повторяет. */
let inlineMessage: string | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function errorName(error: unknown): string {
  return typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : '';
}

/** Ошибка хранилища, которую нужно показать ученику (а не только записать в консоль). */
export function isStorageError(error: unknown): boolean {
  const name = errorName(error);
  return name === 'StorageUnavailableError' || name === 'InvalidDataError' || name === 'QuotaExceededError';
}

function describe(error: unknown): { message: string; reload: boolean } {
  const name = errorName(error);
  if (name === 'QuotaExceededError') {
    return { message: 'На устройстве не хватает места, поэтому последние изменения не сохранились. Освободи немного места.', reload: false };
  }
  const message = error instanceof Error && error.message ? error.message : 'Браузер не дал сохранить данные.';
  const reason = typeof error === 'object' && error !== null && 'reason' in error ? String(error.reason) : '';
  return { message, reload: name === 'StorageUnavailableError' && reason !== 'unsupported' };
}

/** Сообщить о сбое сохранения. title — что именно не сохранилось. */
export function reportSaveProblem(error: unknown, title = 'Прогресс не сохраняется'): void {
  current = { title, ...describe(error) };
  emit();
}

export function dismissSaveProblem(): void {
  current = null;
  emit();
}

export function useSaveProblem(): SaveProblem | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => (current && current.message === inlineMessage ? null : current),
  );
}

/** Экран показывает причину сам — пока он открыт, баннер с тем же текстом не нужен. */
export function useInlineProblem(message: string | null): void {
  useEffect(() => {
    if (!message) return;
    inlineMessage = message;
    emit();
    return () => {
      if (inlineMessage !== message) return;
      inlineMessage = null;
      emit();
    };
  }, [message]);
}

/**
 * Необработанные отказы хранилища (запись из обработчика кнопки, сохранение шага урока) тоже попадают в баннер:
 * иначе ученик продолжает заниматься, а прогресс не записывается.
 */
export function watchStorageErrors(): () => void {
  const onRejection = (event: PromiseRejectionEvent) => {
    if (!isStorageError(event.reason)) return;
    event.preventDefault();
    reportSaveProblem(event.reason);
  };
  window.addEventListener('unhandledrejection', onRejection);
  return () => window.removeEventListener('unhandledrejection', onRejection);
}
