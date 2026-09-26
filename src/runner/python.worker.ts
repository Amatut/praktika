/// <reference lib="webworker" />
// Отдельный поток с Python (Pyodide). Интерфейс остаётся отзывчивым, а зависшую
// программу можно остановить, просто завершив этот поток.
// Важно: worker не является песочницей безопасности. Код ученика может добраться до JavaScript
// этого потока (запрет импорта js в harness.py обходится через importlib), а поток открыт с того же
// адреса, что и приложение, — значит, мог бы читать его хранилища: прогресс, настройки и токен
// удалённого наставника в IndexedDB. Поэтому до первого запуска кода ученика lockDown() отнимает
// у потока хранилища, сеть и способы открыть новый поток. Полная изоляция — запуск на отдельном
// адресе (origin); её пока нет.

import harnessSource from './harness.py?raw';
import type { WorkerMessage, WorkerRequest } from './types.ts';

interface PyCallable {
  (...args: unknown[]): unknown;
  destroy(): void;
}

interface PyodideApi {
  version: string;
  runPython(code: string): unknown;
  globals: { get(name: string): PyCallable };
}

const scope = self as unknown as DedicatedWorkerGlobalScope;

function post(message: WorkerMessage) {
  scope.postMessage(message);
}

async function boot(): Promise<PyodideApi> {
  post({ type: 'status', phase: 'loading' });
  const indexURL = new URL(`${import.meta.env.BASE_URL}pyodide/`, scope.location.origin).href;
  const module = (await import(/* @vite-ignore */ `${indexURL}pyodide.mjs`)) as {
    loadPyodide(options: Record<string, unknown>): Promise<PyodideApi>;
  };
  const pyodide = await module.loadPyodide({
    indexURL,
    // Вывод ученика перехватывает harness.py; сюда попадают только служебные сообщения.
    stdout: () => {},
    stderr: (text: string) => console.warn('[python]', text),
  });
  pyodide.runPython(harnessSource);
  const pythonVersion = String(pyodide.runPython('import sys; sys.version.split()[0]'));
  // Python и обвязка загружены — сеть и хранилища потоку больше не нужны.
  lockDown();
  post({ type: 'ready', pyodideVersion: pyodide.version, pythonVersion });
  return pyodide;
}

/**
 * Что убирается из потока: хранилища приложения (IndexedDB, Cache Storage), сеть и способы
 * запустить новый поток или service worker, где всё это было бы снова доступно.
 * postMessage, таймеры и WebAssembly остаются — без них Python не работает.
 */
const LOCKED_GLOBALS = [
  'indexedDB',
  'caches',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'WebTransport',
  'EventSource',
  'Worker',
  'SharedWorker',
  'BroadcastChannel',
  'importScripts',
] as const;
const LOCKED_NAVIGATOR = ['serviceWorker', 'storage'] as const;

/** Удаляет свойство так, чтобы его нельзя было достать ни с объекта, ни с прототипа. */
function remove(target: object, name: string) {
  for (let owner: object | null = target; owner !== null; owner = Object.getPrototypeOf(owner)) {
    if (!Object.prototype.hasOwnProperty.call(owner, name)) continue;
    // Свойства глобального объекта потока — собственные и настраиваемые, их можно удалить.
    Reflect.deleteProperty(owner, name);
  }
  if (!(name in target)) return;
  try {
    // Не удалилось — закрываем значением undefined без права изменить.
    Object.defineProperty(target, name, { value: undefined, writable: false, configurable: false });
  } catch {
    console.warn(`[python] не удалось закрыть ${name} от кода ученика`);
  }
}

function lockDown() {
  for (const name of LOCKED_GLOBALS) remove(scope, name);
  for (const name of LOCKED_NAVIGATOR) remove(scope.navigator, name);
}

const ready = boot();
ready.catch((error: unknown) => {
  post({ type: 'init-error', message: error instanceof Error ? error.message : String(error) });
});

scope.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  let pyodide: PyodideApi;
  try {
    pyodide = await ready;
  } catch {
    return;
  }

  if (request.type === 'run') {
    const runProgram = pyodide.globals.get('run_program');
    try {
      const json = runProgram(request.code, request.stdin, request.limit) as string;
      post({ type: 'run-result', id: request.id, result: JSON.parse(json) });
    } catch (error) {
      post(failure(request.id, error));
    } finally {
      runProgram.destroy();
    }
    return;
  }

  if (request.type === 'check') {
    const checkProgram = pyodide.globals.get('check_program');
    const notify = (index: number) => post({ type: 'test-start', id: request.id, index });
    try {
      const json = checkProgram(request.payload, notify) as string;
      post({ type: 'check-result', id: request.id, result: JSON.parse(json) });
    } catch (error) {
      post(failure(request.id, error));
    } finally {
      checkProgram.destroy();
    }
  }
};

function failure(id: number, error: unknown): WorkerMessage {
  const message = error instanceof Error ? error.message : String(error);
  // После «фатальной» ошибки Pyodide дальше работать нельзя — интерфейс перезапустит поток.
  // Pyodide помечает такие ошибки флагом pyodide_fatal_error (например, переполнение стека).
  const flagged = typeof error === 'object' && error !== null && (error as { pyodide_fatal_error?: boolean }).pyodide_fatal_error === true;
  const fatal =
    flagged || /fatal|Pyodide already fatally failed|RuntimeError: memory access|Maximum call stack size exceeded/i.test(message);
  return { type: 'failure', id, message, fatal };
}
