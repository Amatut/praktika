// «Скачать модуль»: объём загрузки, прогресс и фактическая готовность к работе без сети.
// Состояние Python и модулей общее для всех строк: после любого скачивания или удаления обновляются все.

import { CircleCheck, Download, Trash2, TriangleAlert } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useOnline } from '../app/hooks.ts';
import { Meter, StatusBadge } from '../components/ui.tsx';
import {
  CONTENT_CACHE,
  bundleStatus,
  downloadBundle,
  formatBytes,
  loadOfflineManifest,
  offlineSupported,
  removeBundle,
  type BundleStatus,
  type OfflineFile,
  type OfflineManifest,
} from '../pwa/offline.ts';

export interface ModuleOffline extends BundleStatus {
  /** В хранилище лежит прежняя версия уроков модуля: после обновления приложения её нужно скачать заново. */
  stale: boolean;
}

export interface OfflineSnapshot {
  checked: boolean;
  manifest: OfflineManifest | null;
  python: BundleStatus | null;
  modules: Record<string, ModuleOffline>;
}

let snapshot: OfflineSnapshot = { checked: false, manifest: null, python: null, modules: {} };
const listeners = new Set<() => void>();
let running = false;
let queued = false;

function absoluteUrl(url: string): string {
  return new URL(`${import.meta.env.BASE_URL}${url}`, window.location.origin).href;
}

/** Файлы уроков модуля в кеше, кроме текущей версии (имя файла — id модуля и хеш содержимого). */
async function oldModuleFiles(moduleId: string, current: OfflineFile): Promise<string[]> {
  const cache = await caches.open(CONTENT_CACHE);
  const pattern = new RegExp(`/content/modules/${moduleId}\\.[^/]+\\.json$`);
  const target = absoluteUrl(current.url);
  return (await cache.keys()).map((request) => request.url).filter((url) => url !== target && pattern.test(new URL(url).pathname));
}

async function load(): Promise<OfflineSnapshot> {
  const manifest = await loadOfflineManifest();
  if (!manifest) return { checked: true, manifest: null, python: null, modules: {} };
  const python = await bundleStatus(manifest.python.cache, manifest.python.files);
  const modules: Record<string, ModuleOffline> = {};
  for (const [id, file] of Object.entries(manifest.modules)) {
    const status = await bundleStatus(CONTENT_CACHE, [file]);
    modules[id] = { ...status, stale: !status.complete && (await oldModuleFiles(id, file)).length > 0 };
  }
  return { checked: true, manifest, python, modules };
}

/** Перечитать, что лежит в хранилище. Вызовы во время проверки не теряются: проверка повторится. */
export async function refreshOffline(): Promise<void> {
  if (!offlineSupported()) {
    snapshot = { ...snapshot, checked: true };
    for (const listener of listeners) listener();
    return;
  }
  if (running) {
    queued = true;
    return;
  }
  running = true;
  try {
    do {
      queued = false;
      try {
        snapshot = await load();
      } catch {
        snapshot = { ...snapshot, checked: true };
      }
      for (const listener of listeners) listener();
    } while (queued);
  } finally {
    running = false;
  }
}

/** Общее состояние офлайн-файлов; при монтировании проверяется заново (Python мог докачаться при запуске кода). */
export function useOfflineStatus(): OfflineSnapshot {
  useEffect(() => {
    void refreshOffline();
  }, []);
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
  );
}

/** Удалить уроки модуля: текущую версию и оставшиеся прежние. */
async function removeModule(moduleId: string, file: OfflineFile): Promise<void> {
  const cache = await caches.open(CONTENT_CACHE);
  await Promise.all((await oldModuleFiles(moduleId, file)).map((url) => cache.delete(url)));
  await removeBundle(CONTENT_CACHE, [file]);
}

export function OfflineModuleControl({ moduleId, compact = false }: { moduleId: string; compact?: boolean }) {
  const online = useOnline();
  const { manifest, python, modules } = useOfflineStatus();
  const module = modules[moduleId];
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!offlineSupported()) {
    return compact ? null : <p className="small muted">Скачивание для работы без сети доступно в собранной версии приложения (npm start).</p>;
  }
  if (!manifest || !python || !module) return null;
  const moduleFile = manifest.modules[moduleId];
  if (!moduleFile) return null;

  const ready = python.complete && module.complete;
  const pythonLeft = python.bytesTotal - python.bytesCached;
  const remaining = pythonLeft + (module.bytesTotal - module.bytesCached);

  async function download() {
    if (!manifest) return;
    setError(null);
    const bundles = [
      { cache: manifest.python.cache, files: manifest.python.files, cached: python?.bytesCached ?? 0 },
      { cache: CONTENT_CACHE, files: [moduleFile], cached: module?.bytesCached ?? 0 },
    ];
    const total = remaining;
    let base = 0;
    setProgress({ done: 0, total });
    try {
      for (const bundle of bundles) {
        // Уже сохранённые файлы в прогресс не входят: считаем только то, что качается сейчас.
        let fetched = 0;
        await downloadBundle(bundle.cache, bundle.files, (done) => {
          fetched = Math.max(fetched, done - bundle.cached);
          setProgress({ done: Math.min(total, base + fetched), total });
        });
        base += fetched;
      }
      // Прежняя версия уроков больше не нужна.
      const cache = await caches.open(CONTENT_CACHE);
      await Promise.all((await oldModuleFiles(moduleId, moduleFile)).map((url) => cache.delete(url)));
    } catch (reason) {
      setError(`Не удалось скачать: ${(reason as Error).message}. Проверь сеть и попробуй снова.`);
    } finally {
      setProgress(null);
      await refreshOffline();
    }
  }

  if (ready) {
    return (
      <span className="row" style={{ gap: 6 }}>
        <StatusBadge tone="good">Доступен без сети</StatusBadge>
        {!compact && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={async () => {
              await removeModule(moduleId, moduleFile);
              await refreshOffline();
            }}
          >
            <Trash2 aria-hidden="true" />
            Удалить уроки
          </button>
        )}
      </span>
    );
  }

  if (progress) {
    return (
      <span className="stack-sm" style={{ minWidth: 200 }} role="status">
        <span className="small">
          Скачиваю: {formatBytes(progress.done)} из {formatBytes(progress.total)}
        </span>
        <Meter value={progress.done} max={progress.total} label="Скачивание модуля" />
      </span>
    );
  }

  const onlyPython = module.complete && !python.complete;
  return (
    <span className="stack-sm" style={{ alignItems: compact ? 'flex-end' : 'flex-start' }}>
      {module.stale && (
        <span className="tiny status-warn row" style={{ gap: 4 }}>
          <TriangleAlert aria-hidden="true" width={13} height={13} />
          Модуль обновился — скачай его заново для работы без сети
        </span>
      )}
      {onlyPython && <span className="tiny muted">Уроки скачаны, но без Python код без сети не запустится</span>}
      <button type="button" className="btn btn-sm" onClick={() => void download()} disabled={!online}>
        <Download aria-hidden="true" />
        {onlyPython ? 'Скачать Python' : module.stale ? 'Скачать заново' : 'Скачать модуль'} · {formatBytes(remaining)}
      </button>
      {!python.complete && !onlyPython && (
        <span className="tiny muted">Включая Python ({formatBytes(pythonLeft)}) — один раз для всех модулей</span>
      )}
      {!online && <span className="tiny muted">Нужна сеть</span>}
      {error && <span className="tiny status-error">{error}</span>}
    </span>
  );
}

/** Строка в настройках: Python или модуль с объёмом и состоянием. */
export function OfflineOverview({ modules }: { modules: { id: string; title: string; number: number }[] }) {
  const online = useOnline();
  const { checked, manifest, python } = useOfflineStatus();
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!offlineSupported()) {
    return (
      <p className="small muted">
        Сейчас открыта версия для разработки: офлайн-режим и скачивание работают в собранной версии (команда npm start).
      </p>
    );
  }
  if (!manifest || !python) {
    return <p className="small muted">{checked ? 'Не удалось проверить, что уже скачано. Обнови страницу.' : 'Проверяю, что уже скачано…'}</p>;
  }

  return (
    <div className="stack-sm">
      <div className="bundle-row">
        <div>
          <div className="list-row-title">Python {manifest.python.version.replace(/^3(\d\d)\./, '3.$1 · Pyodide 3$1.')}</div>
          <div className="list-row-sub">
            {formatBytes(python.bytesTotal)} · нужен для запуска кода во всех уроках
          </div>
          {progress && (
            <div className="stack-sm" style={{ marginTop: 8 }} role="status">
              <span className="small">
                {formatBytes(progress.done)} из {formatBytes(progress.total)}
              </span>
              <Meter value={progress.done} max={progress.total} label="Скачивание Python" />
            </div>
          )}
          {error && <div className="tiny status-error">{error}</div>}
        </div>
        {python.complete ? (
          <span className="row" style={{ gap: 6 }}>
            <StatusBadge tone="good">Скачан</StatusBadge>
            <button
              type="button"
              className="btn btn-ghost btn-sm btn-icon"
              aria-label="Удалить Python из офлайн-хранилища"
              title="Без Python уроки без сети не запустят код"
              onClick={async () => {
                await removeBundle(manifest.python.cache, manifest.python.files);
                await refreshOffline();
              }}
            >
              <Trash2 aria-hidden="true" />
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="btn btn-sm"
            disabled={!online || progress !== null}
            onClick={async () => {
              setError(null);
              try {
                await downloadBundle(manifest.python.cache, manifest.python.files, (done, total) => setProgress({ done, total }));
              } catch (reason) {
                setError(`Не удалось скачать: ${(reason as Error).message}`);
              } finally {
                setProgress(null);
                await refreshOffline();
              }
            }}
          >
            <Download aria-hidden="true" />
            Скачать · {formatBytes(python.bytesTotal - python.bytesCached)}
          </button>
        )}
      </div>
      {modules
        .filter((module) => manifest.modules[module.id])
        .map((module) => (
          <div key={module.id} className="bundle-row">
            <div>
              <div className="list-row-title">
                Модуль {module.number}. {module.title}
              </div>
              <div className="list-row-sub">Уроки: {formatBytes(manifest.modules[module.id].bytes)}</div>
            </div>
            <OfflineModuleControl moduleId={module.id} />
          </div>
        ))}
      <p className="tiny muted row" style={{ gap: 6 }}>
        <CircleCheck aria-hidden="true" width={13} height={13} />
        «Скачан» означает, что файлы лежат в хранилище браузера. «Доступен без сети» — скачаны и уроки модуля, и Python.
        Оболочка приложения сохраняется автоматически после первого открытия.
      </p>
    </div>
  );
}
