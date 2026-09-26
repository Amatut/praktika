// Регистрация service worker и понятный цикл обновления:
// новая версия скачивается в фоне, а применяется только по кнопке «Обновить».

import { useSyncExternalStore } from 'react';

export interface UpdateState {
  supported: boolean;
  /** Service worker управляет страницей — оболочка доступна без сети. */
  controlled: boolean;
  updateReady: boolean;
  /**
   * Новую версию применили в другой вкладке. Её service worker уже удалил файлы прежней оболочки,
   * и эта вкладка сломается при первом переходе на ещё не загруженный экран — её нужно перезагрузить.
   */
  reloadNeeded: boolean;
}

let state: UpdateState = { supported: false, controlled: false, updateReady: false, reloadNeeded: false };
const listeners = new Set<() => void>();
let waitingWorker: ServiceWorker | null = null;
let reloadRequested = false;

function set(patch: Partial<UpdateState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export function useUpdateState(): UpdateState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}

function track(worker: ServiceWorker | null) {
  if (!worker) return;
  const check = () => {
    if (worker.state === 'installed' && navigator.serviceWorker.controller) {
      waitingWorker = worker;
      set({ updateReady: true });
    }
  };
  worker.addEventListener('statechange', check);
  check();
}

export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  set({ supported: true, controlled: Boolean(navigator.serviceWorker.controller) });

  if (!import.meta.env.PROD) {
    // В режиме разработки офлайн-кеш мешает видеть изменения — снимаем старые регистрации.
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((registration) => registration.unregister()));
    return;
  }

  const base = import.meta.env.BASE_URL;
  try {
    const registration = await navigator.serviceWorker.register(`${base}sw.js`, { scope: base });
    if (registration.waiting && navigator.serviceWorker.controller) {
      waitingWorker = registration.waiting;
      set({ updateReady: true });
    }
    registration.addEventListener('updatefound', () => track(registration.installing));
    let hadController = Boolean(navigator.serviceWorker.controller);
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      const replaced = hadController;
      hadController = true;
      set({ controlled: true });
      // Перезагружаемся сами только после явного «Обновить» в этой вкладке.
      if (reloadRequested) {
        window.location.reload();
        return;
      }
      // Первая установка ничего не ломает. А смена управляющего service worker значит, что «Обновить»
      // нажали в другой вкладке: старые файлы этой оболочки уже удалены — просим перезагрузить страницу.
      if (replaced) {
        waitingWorker = null;
        set({ updateReady: false, reloadNeeded: true });
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void registration.update().catch(() => {});
    });
  } catch (error) {
    console.warn('Service worker не зарегистрирован', error);
  }
}

export function applyUpdate() {
  if (!waitingWorker) return;
  reloadRequested = true;
  waitingWorker.postMessage({ type: 'SKIP_WAITING' });
}

/** Перезагрузить вкладку, оболочку которой заменила новая версия (reloadNeeded). */
export function reloadPage() {
  window.location.reload();
}
