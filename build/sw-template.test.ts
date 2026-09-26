// Тесты service worker (build/sw-template.js) без браузера: Cache Storage и сеть подменены,
// установка и активация вызываются так же, как это делает браузер.

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const ORIGIN = 'http://127.0.0.1:4173';
const SCOPE = `${ORIGIN}/`;
const PYTHON_FILES = ['pyodide/pyodide.mjs', 'pyodide/pyodide.asm.wasm'];

type Listener = (event: { waitUntil(promise: Promise<unknown>): void; data?: unknown }) => void;

function urlOf(request: RequestInfo | URL): string {
  if (typeof request === 'string') return new URL(request, SCOPE).href;
  if (request instanceof URL) return request.href;
  return request.url;
}

/** Cache Storage в памяти: имя кеша → адрес → тело ответа. */
class FakeCaches {
  stores = new Map<string, Map<string, string>>();

  constructor(initial: Record<string, string[]> = {}) {
    for (const [name, paths] of Object.entries(initial)) {
      this.stores.set(name, new Map(paths.map((path) => [new URL(path, SCOPE).href, `старое: ${path}`])));
    }
  }

  async open(name: string) {
    let store = this.stores.get(name);
    if (!store) {
      store = new Map();
      this.stores.set(name, store);
    }
    const entries = store;
    return {
      match: async (request: RequestInfo | URL) => {
        const body = entries.get(urlOf(request));
        return body === undefined ? undefined : new Response(body);
      },
      put: async (request: RequestInfo | URL, response: Response) => {
        entries.set(urlOf(request), await response.text());
      },
      addAll: async (requests: Request[]) => {
        for (const request of requests) {
          const response = await fakeFetchFor(this)(request);
          entries.set(request.url, await response.text());
        }
      },
      keys: async () => [...entries.keys()].map((url) => new Request(url)),
      delete: async (request: RequestInfo | URL) => entries.delete(urlOf(request)),
    };
  }

  async keys() {
    return [...this.stores.keys()];
  }

  async delete(name: string) {
    return this.stores.delete(name);
  }

  /** Пути в кеше относительно корня приложения. */
  paths(name: string): string[] {
    return [...(this.stores.get(name)?.keys() ?? [])].map((url) => url.slice(SCOPE.length)).sort();
  }

  /** Сеть: какие адреса отвечают ошибкой. */
  failing = new Set<string>();
  manifest: unknown = null;
  fetched: string[] = [];
}

function fakeFetchFor(caches: FakeCaches) {
  return async (input: RequestInfo | URL): Promise<Response> => {
    const url = urlOf(input);
    const path = url.slice(SCOPE.length);
    caches.fetched.push(path);
    if (caches.failing.has(path)) throw new TypeError('Failed to fetch');
    if (path === 'offline-manifest.json') return new Response(JSON.stringify(caches.manifest));
    return new Response(`новое: ${path}`);
  };
}

async function loadWorker(caches: FakeCaches, manifest: unknown) {
  caches.manifest = manifest;
  const template = await readFile(new URL('./sw-template.js', import.meta.url), 'utf8');
  const source = template
    .replace('__BUILD_ID__', 'new')
    .replace('__SHELL_FILES__', JSON.stringify(['./', 'offline-manifest.json', 'index.html']))
    .replace('__PYTHON_CACHE__', 'praktika-python-2.0');
  const listeners = new Map<string, Listener>();
  const self = {
    registration: { scope: SCOPE },
    clients: { claim: async () => {} },
    skipWaiting: () => {},
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
  };
  new Function('self', 'caches', 'fetch', source)(self, caches, fakeFetchFor(caches));
  const dispatch = async (type: 'install' | 'activate') => {
    const pending: Promise<unknown>[] = [];
    listeners.get(type)?.({ waitUntil: (promise) => pending.push(promise) });
    await Promise.all(pending);
  };
  return { dispatch };
}

const MANIFEST = {
  buildId: 'new',
  shell: { cache: 'praktika-shell-new', files: 3, bytes: 100 },
  python: { cache: 'praktika-python-2.0', version: '2.0', bytes: 10, files: PYTHON_FILES.map((url) => ({ url, bytes: 5 })) },
  modules: {
    m0: { url: 'content/modules/m0.1111111111.json', bytes: 10 },
    m1: { url: 'content/modules/m1.bbbbbbbbbb.json', bytes: 10 },
    m2: { url: 'content/modules/m2.2222222222.json', bytes: 10 },
  },
};

function previousVersion() {
  return new FakeCaches({
    'praktika-shell-old': ['./', 'index.html'],
    'praktika-python-1.0': PYTHON_FILES,
    'praktika-content': [
      'content/modules/m0.aaaaaaaaaa.json',
      'content/modules/m1.bbbbbbbbbb.json',
      'content/modules/gone.cccccccccc.json',
    ],
  });
}

describe('service worker: обновление офлайн-файлов', () => {
  it('при установке скачивает новые версии скачанных модулей и Python, при активации убирает старые', async () => {
    const caches = previousVersion();
    const worker = await loadWorker(caches, MANIFEST);

    await worker.dispatch('install');
    // Скачивается только то, что уже было в хранилище: m0 в новой версии и Python 2.0. m2 не качался и раньше.
    expect(caches.paths('praktika-content')).toEqual([
      'content/modules/gone.cccccccccc.json',
      'content/modules/m0.1111111111.json',
      'content/modules/m0.aaaaaaaaaa.json',
      'content/modules/m1.bbbbbbbbbb.json',
    ]);
    expect(caches.paths('praktika-python-2.0')).toEqual([...PYTHON_FILES].sort());
    expect(caches.fetched).not.toContain('content/modules/m2.2222222222.json');
    expect(caches.fetched).not.toContain('content/modules/m1.bbbbbbbbbb.json');

    await worker.dispatch('activate');
    expect((await caches.keys()).sort()).toEqual(['praktika-content', 'praktika-python-2.0', 'praktika-shell-new']);
    expect(caches.paths('praktika-content')).toEqual(['content/modules/m0.1111111111.json', 'content/modules/m1.bbbbbbbbbb.json']);
  });

  it('без сети установка не срывается, а прежняя версия модуля остаётся отметкой «была скачана»', async () => {
    const caches = previousVersion();
    caches.failing.add('content/modules/m0.1111111111.json');
    caches.failing.add('pyodide/pyodide.asm.wasm');
    const worker = await loadWorker(caches, MANIFEST);

    await worker.dispatch('install');
    await worker.dispatch('activate');
    expect(caches.paths('praktika-content')).toEqual(['content/modules/m0.aaaaaaaaaa.json', 'content/modules/m1.bbbbbbbbbb.json']);
    // Python 2.0 скачан не весь — настройки покажут, что его нужно докачать.
    expect(caches.paths('praktika-python-2.0')).toEqual(['pyodide/pyodide.mjs']);
  });

  it('Python, который не был скачан целиком, заранее не качается', async () => {
    const caches = new FakeCaches({ 'praktika-python-1.0': ['pyodide/pyodide.mjs'] });
    const worker = await loadWorker(caches, MANIFEST);
    await worker.dispatch('install');
    expect(caches.fetched.filter((path) => path.startsWith('pyodide/'))).toEqual([]);
  });
});
