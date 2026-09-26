// Общие хуки: настройки, сеть, состояние Python, подписка на изменения данных.

import { useEffect, useState, useSyncExternalStore } from 'react';
import { pythonRunner, type RunnerState } from '../runner/runner.ts';
import { getSettings, mergeSettings, onChange, saveSettings, type SettingsPatch } from '../storage/repo.ts';
import { DEFAULT_SETTINGS, type Settings } from '../storage/types.ts';
import { isStorageError, reportSaveProblem } from './problems.ts';

// ------------------------------------------------------------ настройки

let settingsCache: Settings = DEFAULT_SETTINGS;
let settingsLoaded = false;
/** Сколько раз настройки перечитаны из хранилища (старт, сброс, импорт, восстановление копии). */
let settingsEpoch = 0;
const settingsListeners = new Set<() => void>();

function emitSettings() {
  for (const listener of settingsListeners) listener();
}

function subscribeSettings(listener: () => void) {
  settingsListeners.add(listener);
  return () => {
    settingsListeners.delete(listener);
  };
}

/**
 * Прочитать настройки из хранилища и применить тему и шрифты. Вызывается при старте и после того,
 * как данные заменены целиком (сброс, импорт, восстановление копии), — иначе в памяти остаются прежние.
 */
export async function initSettings(): Promise<Settings> {
  try {
    settingsCache = await getSettings();
  } catch (error) {
    settingsCache = DEFAULT_SETTINGS;
    if (isStorageError(error)) reportSaveProblem(error);
  }
  settingsLoaded = true;
  settingsEpoch += 1;
  applySettings(settingsCache);
  emitSettings();
  return settingsCache;
}

export function applySettings(settings: Settings) {
  const root = document.documentElement;
  if (settings.theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = settings.theme;
  try {
    localStorage.setItem('praktika-theme', settings.theme);
  } catch {
    // Недоступно (приватный режим) — тема всё равно применена.
  }
  root.style.setProperty('--lesson-size', `${settings.lessonFontSize}px`);
  root.style.setProperty('--code-size', `${settings.codeFontSize}px`);
}

/** Изменить настройки: coach и market можно передавать частично — остальные поля сохраняются. */
export async function updateSettings(patch: SettingsPatch): Promise<void> {
  const next = mergeSettings(settingsCache, patch);
  settingsCache = next;
  applySettings(next);
  emitSettings();
  await saveSettings(patch);
}

export function useSettings(): Settings {
  return useSyncExternalStore(subscribeSettings, () => settingsCache);
}

/** Меняется, только когда настройки перечитаны из хранилища: поля ввода с черновиком можно пересоздать. */
export function useSettingsEpoch(): number {
  return useSyncExternalStore(subscribeSettings, () => settingsEpoch);
}

export function settingsReady() {
  return settingsLoaded;
}

// ------------------------------------------------------------ сеть

function subscribeOnline(listener: () => void) {
  window.addEventListener('online', listener);
  window.addEventListener('offline', listener);
  return () => {
    window.removeEventListener('online', listener);
    window.removeEventListener('offline', listener);
  };
}

export function useOnline(): boolean {
  return useSyncExternalStore(subscribeOnline, () => navigator.onLine);
}

// ------------------------------------------------------------ Python

export function useRunnerState(): RunnerState {
  return useSyncExternalStore(pythonRunner.subscribe, pythonRunner.getState);
}

// ------------------------------------------------------------ данные ученика

/** Номер версии данных: увеличивается при изменении указанных хранилищ. */
export function useDataVersion(stores?: string[]): number {
  const [version, setVersion] = useState(0);
  const key = stores?.join(',') ?? '*';
  useEffect(() => {
    const watched = key === '*' ? null : new Set(key.split(','));
    return onChange((changed) => {
      if (!watched || changed.some((store) => watched.has(store))) setVersion((value) => value + 1);
    });
  }, [key]);
  return version;
}

/** Асинхронная загрузка с перезапуском при смене зависимостей. */
export function useAsync<T>(load: () => Promise<T>, deps: unknown[]): { value: T | undefined; error: Error | null; loading: boolean } {
  const [state, setState] = useState<{ value: T | undefined; error: Error | null; loading: boolean }>({
    value: undefined,
    error: null,
    loading: true,
  });
  useEffect(() => {
    let alive = true;
    setState((previous) => ({ ...previous, loading: true }));
    load().then(
      (value) => alive && setState({ value, error: null, loading: false }),
      (error: unknown) =>
        alive &&
        setState({ value: undefined, error: error instanceof Error ? error : new Error(String(error)), loading: false }),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

/** Медиазапрос для перестройки интерфейса (например, вкладки урока на телефоне). */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (listener) => {
      const media = window.matchMedia(query);
      media.addEventListener('change', listener);
      return () => media.removeEventListener('change', listener);
    },
    () => window.matchMedia(query).matches,
  );
}
