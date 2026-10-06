// «Скачать модуль»: объём загрузки, прогресс и фактическая готовность к работе без сети.
// Состояние Python и модулей общее для всех строк: после любого скачивания или удаления обновляются все.

import { CloudOff, Download, Trash2, WifiOff } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useOnline } from '../app/hooks.ts';
import { Meter, Spinner, StatusBadge, StatusLine } from '../components/ui.tsx';
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
    // Рендер без браузера (тесты разметки) видит то же состояние.
    () => snapshot,
  );
}

/** Удалить уроки модуля: текущую версию и оставшиеся прежние. */
async function removeModule(moduleId: string, file: OfflineFile): Promise<void> {
  const cache = await caches.open(CONTENT_CACHE);
  await Promise.all((await oldModuleFiles(moduleId, file)).map((url) => cache.delete(url)));
  await removeBundle(CONTENT_CACHE, [file]);
}

/** Идёт скачивание: объём числом рядом с полосой, не внутри неё. */
function DownloadProgress({ done, total, label }: { done: number; total: number; label: string }) {
  return (
    <div className="offline-progress" role="status">
      <span className="offline-progress-text tnum">
        {formatBytes(done)} из {formatBytes(total)}
      </span>
      <Meter value={done} max={total} label={label} />
    </div>
  );
}

/**
 * Скачивание модуля. compact — в шапке списка уроков модуля: только статус или кнопка, без «Удалить».
 * number — номер модуля для имён кнопок у скринридера («Скачать модуль 1 вместе с Python, всего 12,6 МБ»).
 */
export function OfflineModuleControl({ moduleId, compact = false, number }: { moduleId: string; compact?: boolean; number?: number }) {
  const online = useOnline();
  const { manifest, python, modules } = useOfflineStatus();
  const module = modules[moduleId];
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!offlineSupported()) {
    return compact ? null : (
      <StatusLine tone="muted" icon={CloudOff}>
        Офлайн — только в собранной версии
      </StatusLine>
    );
  }
  if (!manifest || !python || !module) return null;
  const moduleFile = manifest.modules[moduleId];
  if (!moduleFile) return null;

  const ready = python.complete && module.complete;
  const pythonLeft = python.bytesTotal - python.bytesCached;
  const moduleLeft = module.bytesTotal - module.bytesCached;
  const remaining = pythonLeft + moduleLeft;
  const className = `offline-ctl${compact ? ' is-compact' : ''}`;
  const which = number === undefined ? 'модуль' : `модуль ${number}`;

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
      setError(`Не удалось скачать: ${(reason as Error).message}`);
    } finally {
      setProgress(null);
      await refreshOffline();
    }
  }

  if (ready) {
    return (
      <div className={className}>
        <div className="offline-ctl-line">
          <StatusBadge tone="good">Доступен без сети</StatusBadge>
          {!compact && (
            <button
              type="button"
              className="btn btn-ghost"
              aria-label={`Удалить уроки: ${which}`}
              onClick={async () => {
                await removeModule(moduleId, moduleFile);
                await refreshOffline();
              }}
            >
              <Trash2 aria-hidden="true" />
              Удалить
            </button>
          )}
        </div>
      </div>
    );
  }

  if (progress) {
    return (
      <div className={className}>
        <DownloadProgress done={progress.done} total={progress.total} label="Скачивание модуля" />
      </div>
    );
  }

  const onlyPython = module.complete && !python.complete;
  const verb = onlyPython ? 'Скачать Python' : module.stale ? 'Скачать заново' : 'Скачать модуль';
  const withPython = !python.complete && !onlyPython;
  // На кнопке — объём самого модуля и «+ Python», если его ещё нет (Python общий, его объём — в ряду Python);
  // скринридер слышит итог целиком.
  const label = onlyPython
    ? `Скачать Python, ${formatBytes(remaining)}`
    : `${module.stale ? `Скачать заново ${which}` : number === undefined ? verb : `${verb} ${number}`}${withPython ? ' вместе с Python, всего' : ','} ${formatBytes(remaining)}`;
  return (
    <div className={className}>
      {module.stale && <StatusLine tone="warn">Модуль обновился</StatusLine>}
      {onlyPython && <StatusLine tone="warn">Без Python код офлайн не запустится</StatusLine>}
      <div className="offline-ctl-line">
        <button type="button" className={`btn${compact ? ' btn-sm' : ''}`} aria-label={label} onClick={() => void download()} disabled={!online}>
          <Download aria-hidden="true" />
          {verb} · {formatBytes(onlyPython ? pythonLeft : moduleLeft)}
          {withPython && ' + Python'}
        </button>
      </div>
      {!online && (
        <StatusLine tone="muted" icon={WifiOff}>
          Нужна сеть
        </StatusLine>
      )}
      {error && <StatusLine tone="err">{error}</StatusLine>}
    </div>
  );
}

/**
 * «Работа без сети» в настройках: Python и модули строками настроек (класс bundle-row, первая строка —
 * Python: на порядок опирается e2e), слева название и объём, справа статус и действие.
 */
export function OfflineOverview({ modules }: { modules: { id: string; title: string; number: number }[] }) {
  const online = useOnline();
  const { checked, manifest, python, modules: saved } = useOfflineStatus();
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!offlineSupported()) {
    return (
      <div className="setting-row">
        <div className="setting-label">
          <span className="setting-name">Python и уроки</span>
        </div>
        <div className="setting-control">
          <StatusLine tone="muted" icon={CloudOff}>
            Офлайн — только в собранной версии
          </StatusLine>
        </div>
      </div>
    );
  }
  if (!manifest || !python) {
    return (
      <div className="setting-row">
        <div className="setting-label">
          <span className="setting-name">Python и уроки</span>
        </div>
        <div className="setting-control">
          {checked ? (
            <StatusLine tone="err">Не удалось проверить, что скачано. Обнови страницу.</StatusLine>
          ) : (
            <p className="loading-line" role="status">
              <Spinner />
              Проверяю, что скачано…
            </p>
          )}
        </div>
      </div>
    );
  }

  // «314.0.7» → «3.14» и «Pyodide 314.0.7».
  const pyodide = manifest.python.version;
  const pythonVersion = pyodide.replace(/^3(\d\d)\..*$/, '3.$1');

  return (
    <>
      <div className="setting-row bundle-row">
        <div className="setting-label">
          <span className="setting-name">Python {pythonVersion !== pyodide ? pythonVersion : ''}</span>
          <span className="setting-hint">
            Pyodide {pyodide} · {formatBytes(python.bytesTotal)}
          </span>
        </div>
        <div className="setting-control">
          {python.complete ? (
            <div className="offline-ctl-line">
              <StatusBadge tone="good">Скачан</StatusBadge>
              <button
                type="button"
                className="btn btn-ghost"
                aria-label="Удалить Python из офлайн-хранилища"
                onClick={async () => {
                  await removeBundle(manifest.python.cache, manifest.python.files);
                  await refreshOffline();
                }}
              >
                <Trash2 aria-hidden="true" />
                Удалить
              </button>
            </div>
          ) : progress ? (
            <DownloadProgress done={progress.done} total={progress.total} label="Скачивание Python" />
          ) : (
            <div className="offline-ctl">
              {/* Python — общая зависимость всех модулей: его логично скачать первым, поэтому кнопка главная. */}
              <button
                type="button"
                className="btn btn-primary"
                aria-label={`Скачать Python, ${formatBytes(python.bytesTotal - python.bytesCached)}`}
                disabled={!online}
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
              {!online && (
                <StatusLine tone="muted" icon={WifiOff}>
                  Нужна сеть
                </StatusLine>
              )}
              {error && <StatusLine tone="err">{error}</StatusLine>}
            </div>
          )}
        </div>
      </div>
      {modules
        .filter((module) => manifest.modules[module.id])
        .map((module) => (
          <div key={module.id} className="setting-row bundle-row">
            <div className="setting-label">
              <span className="setting-name">
                Модуль {module.number} · {module.title}
              </span>
              {/* Пока уроки не скачаны, тот же объём — на кнопке: на телефоне эту строку прячет settings.css. */}
              <span className={`setting-hint${saved[module.id]?.complete ? '' : ' offline-size'}`}>
                Уроки · {formatBytes(manifest.modules[module.id].bytes)}
              </span>
            </div>
            <div className="setting-control">
              <OfflineModuleControl moduleId={module.id} number={module.number} />
            </div>
          </div>
        ))}
    </>
  );
}
