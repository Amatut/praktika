/* Практика — service worker. Файл создаётся при сборке (build/service-worker-plugin.ts). */
/* global self, caches */

const BUILD_ID = '__BUILD_ID__';
/** Оболочка приложения: страница, скрипты, стили, шрифты, иконки, карта курса. */
const SHELL = __SHELL_FILES__;
const SHELL_CACHE = 'praktika-shell-' + BUILD_ID;
/** Python (Pyodide) — скачивается отдельно, по кнопке или при первом запуске кода. */
const PYTHON_CACHE = '__PYTHON_CACHE__';
/** Уроки модулей — файлы с хешем в имени, поэтому их можно хранить без проверки. */
const CONTENT_CACHE = 'praktika-content';
const KEEP = new Set([SHELL_CACHE, PYTHON_CACHE, CONTENT_CACHE]);

const PYTHON_PREFIX = 'praktika-python-';
/** Файл уроков модуля: content/modules/<id модуля>.<хеш содержимого>.json. */
const MODULE_FILE = /^content\/modules\/([a-z0-9-]+)\.[0-9a-f]+\.json$/;

const scopeUrl = new URL(self.registration.scope);

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      await cache.addAll(SHELL.map((file) => new Request(new URL(file, scopeUrl), { cache: 'reload' })));
      await refreshOfflineFiles();
    })(),
  );
  // Новая версия ждёт: страница предложит обновиться и пришлёт SKIP_WAITING.
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => name.startsWith('praktika-') && !KEEP.has(name)).map((name) => caches.delete(name)),
      );
      await removeOldModules().catch(() => {});
      await self.clients.claim();
    })(),
  );
});

function relativePath(url) {
  return url.pathname.startsWith(scopeUrl.pathname) ? url.pathname.slice(scopeUrl.pathname.length) : null;
}

// ignoreVary: сервер может отвечать с «Vary: Origin», а модульные скрипты и стили
// запрашиваются с заголовком Origin — без этого флага кеш не находит их без сети.
const MATCH = { ignoreVary: true };

// ---------------------------------------------------------------- обновление офлайн-файлов
//
// Имена файлов уроков содержат хеш, а кеш Python назван по его версии. Поэтому новая версия
// приложения ищет уроки и Python по новым адресам, и то, что ученик скачал для работы без сети,
// без этого шага перестало бы открываться без сети. Ещё при установке — пока работает прежняя
// версия и есть сеть — новая скачивает свежие файлы для всего, что уже лежало в хранилище.
// Ошибки сети установку не срывают: такой модуль просто покажется в настройках нескачанным.

/** offline-manifest.json этой версии — он уже лежит в кеше оболочки. */
async function readManifest() {
  const cache = await caches.open(SHELL_CACHE);
  const response = await cache.match(new URL('offline-manifest.json', scopeUrl), MATCH);
  return response ? response.json() : null;
}

/** Скачивает файл в кеш, если его там ещё нет. */
async function store(cacheName, file) {
  const url = new URL(file, scopeUrl);
  const cache = await caches.open(cacheName);
  if (await cache.match(url, MATCH)) return;
  const response = await fetch(new Request(url, { cache: 'no-cache' }));
  if (!response.ok || response.status !== 200) throw new Error(`${file}: ${response.status}`);
  await cache.put(url, response);
}

/** id модулей, файлы которых (любой версии) лежат в кеше уроков. */
async function cachedModuleIds() {
  const cache = await caches.open(CONTENT_CACHE);
  const ids = new Set();
  for (const request of await cache.keys()) {
    const path = relativePath(new URL(request.url));
    const match = path && MODULE_FILE.exec(path);
    if (match) ids.add(match[1]);
  }
  return ids;
}

/** Прежний Python был скачан целиком: в его кеше есть все файлы, которые нужны новой версии. */
async function hadFullPython(files) {
  for (const name of await caches.keys()) {
    if (!name.startsWith(PYTHON_PREFIX) || name === PYTHON_CACHE) continue;
    const cache = await caches.open(name);
    let complete = true;
    for (const file of files) {
      if (!(await cache.match(new URL(file.url, scopeUrl), MATCH))) {
        complete = false;
        break;
      }
    }
    if (complete) return true;
  }
  return false;
}

async function refreshOfflineFiles() {
  try {
    const manifest = await readManifest();
    if (!manifest) return;
    const downloads = [];
    for (const id of await cachedModuleIds()) {
      const file = manifest.modules[id];
      if (file) downloads.push(store(CONTENT_CACHE, file.url));
    }
    if (await hadFullPython(manifest.python.files)) {
      for (const file of manifest.python.files) downloads.push(store(PYTHON_CACHE, file.url));
    }
    await Promise.allSettled(downloads);
  } catch {
    // Не удалось — не страшно: всё, чего нет в кеше, можно скачать в настройках.
  }
}

/**
 * После активации: прежние версии уроков удаляются, если текущая уже скачана или модуля больше нет.
 * Если скачать текущую не удалось, прежняя остаётся как отметка «была скачана» — настройки
 * предложат скачать модуль заново и после этого уберут её сами.
 */
async function removeOldModules() {
  const manifest = await readManifest();
  if (!manifest) return;
  const cache = await caches.open(CONTENT_CACHE);
  const requests = await cache.keys();
  const current = new Map(Object.entries(manifest.modules).map(([id, file]) => [id, new URL(file.url, scopeUrl).href]));
  const cached = new Set(requests.map((request) => request.url));
  await Promise.all(
    requests.map((request) => {
      const path = relativePath(new URL(request.url));
      const match = path && MODULE_FILE.exec(path);
      if (!match) return null;
      const target = current.get(match[1]);
      if (target === request.url) return null;
      if (target && !cached.has(target)) return null;
      return cache.delete(request);
    }),
  );
}

async function fromCacheOrNetwork(request, storeIn) {
  const cached = await caches.match(request, MATCH);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (storeIn && response.ok && response.status === 200) {
      const cache = await caches.open(storeIn);
      await cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Нет сети, и этот файл ещё не сохранён для офлайн-работы.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

async function navigation(request) {
  const cache = await caches.open(SHELL_CACHE);
  const page = await cache.match(new URL('index.html', scopeUrl), MATCH);
  if (page) return page;
  return fetch(request);
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // Чужие адреса (например, сервер наставника) не трогаем.
  if (url.origin !== scopeUrl.origin) return;
  const path = relativePath(url);
  if (path === null || path === 'sw.js') return;

  if (request.mode === 'navigate') {
    event.respondWith(navigation(request));
    return;
  }
  if (path.startsWith('pyodide/')) {
    event.respondWith(fromCacheOrNetwork(request, PYTHON_CACHE));
    return;
  }
  if (path.startsWith('content/modules/')) {
    event.respondWith(fromCacheOrNetwork(request, CONTENT_CACHE));
    return;
  }
  event.respondWith(fromCacheOrNetwork(request, null));
});
