// Скачивание Python и уроков для работы без сети (Cache Storage).
// Готовность проверяется по фактическому наличию файлов в кеше.
// Имена файлов уроков содержат хеш, кеш Python назван по версии: после обновления приложения
// service worker ещё при установке новой версии сам скачивает новые файлы для всего, что уже
// лежало в хранилище, и убирает прежние (build/sw-template.js). Если сети не было, прежний файл
// модуля остаётся отметкой «была скачана прежняя версия».

export interface OfflineFile {
  url: string;
  bytes: number;
}

export interface OfflineManifest {
  buildId: string;
  shell: { cache: string; files: number; bytes: number };
  python: { cache: string; version: string; bytes: number; files: OfflineFile[] };
  modules: Record<string, OfflineFile>;
}

export const CONTENT_CACHE = 'praktika-content';

export interface BundleStatus {
  bytesTotal: number;
  bytesCached: number;
  filesTotal: number;
  filesCached: number;
  complete: boolean;
}

const base = import.meta.env.BASE_URL;
let manifestPromise: Promise<OfflineManifest | null> | null = null;

/** Офлайн-режим есть только в собранной версии (npm run build / npm start). */
export function offlineSupported(): boolean {
  return import.meta.env.PROD && 'caches' in window && 'serviceWorker' in navigator;
}

export function loadOfflineManifest(): Promise<OfflineManifest | null> {
  if (!offlineSupported()) return Promise.resolve(null);
  if (!manifestPromise) {
    manifestPromise = fetch(`${base}offline-manifest.json`)
      .then((response) => (response.ok ? (response.json() as Promise<OfflineManifest>) : null))
      .catch(() => {
        manifestPromise = null;
        return null;
      });
  }
  return manifestPromise;
}

function absolute(url: string): string {
  return new URL(`${base}${url}`, window.location.origin).href;
}

export async function bundleStatus(cacheName: string, files: OfflineFile[]): Promise<BundleStatus> {
  const status: BundleStatus = {
    bytesTotal: files.reduce((sum, file) => sum + file.bytes, 0),
    bytesCached: 0,
    filesTotal: files.length,
    filesCached: 0,
    complete: false,
  };
  if (!offlineSupported()) return status;
  const cache = await caches.open(cacheName);
  for (const file of files) {
    if (await cache.match(absolute(file.url))) {
      status.filesCached += 1;
      status.bytesCached += file.bytes;
    }
  }
  status.complete = status.filesCached === status.filesTotal && status.filesTotal > 0;
  return status;
}

export type ProgressCallback = (done: number, total: number) => void;

/** Скачивает недостающие файлы в кеш. Уже сохранённые файлы пропускаются. */
export async function downloadBundle(
  cacheName: string,
  files: OfflineFile[],
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<void> {
  const cache = await caches.open(cacheName);
  const total = files.reduce((sum, file) => sum + file.bytes, 0);
  let done = 0;
  onProgress?.(done, total);
  for (const file of files) {
    const url = absolute(file.url);
    if (await cache.match(url)) {
      done += file.bytes;
      onProgress?.(done, total);
      continue;
    }
    const response = await fetch(url, { cache: 'no-cache', signal });
    if (!response.ok || !response.body) throw new Error(`Не удалось скачать ${file.url} (${response.status})`);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done: finished, value } = await reader.read();
      if (finished) break;
      chunks.push(value);
      received += value.byteLength;
      onProgress?.(done + Math.min(received, file.bytes), total);
    }
    const headers = new Headers();
    const type = response.headers.get('Content-Type');
    if (type) headers.set('Content-Type', type);
    await cache.put(url, new Response(new Blob(chunks as BlobPart[]), { status: 200, headers }));
    done += file.bytes;
    onProgress?.(done, total);
  }
}

export async function removeBundle(cacheName: string, files: OfflineFile[]): Promise<void> {
  const cache = await caches.open(cacheName);
  await Promise.all(files.map((file) => cache.delete(absolute(file.url))));
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} МБ`;
}
