// Процесс с Python для проверки учебных материалов (node scripts/verify-content.ts).
// Делает то же, что src/runner/python.worker.ts в браузере, но в Node.js:
// Pyodide берётся из node_modules, а обвязка — тот же файл src/runner/harness.py.
//
// Основной процесс запускает этот файл отдельным процессом Node с включёнными разрешениями
// (--permission): читать можно только Pyodide, harness.py и сам этот файл; писать файлы,
// запускать процессы и потоки нельзя. Код из материалов может добраться до JavaScript
// (запрет импорта «js» в harness.py — учебный, а не защитный), поэтому ограничения
// ставит сам Node. Это «ремень безопасности», а не полная песочница: сеть Node 24 не ограничивает.
//
// Зависшую программу изнутри не остановить, поэтому основной процесс при тайм-ауте
// завершает этот процесс и при следующем запросе запускает новый.
//
// Аргументы: <папка pyodide> <путь к harness.py>. Сообщения — через IPC (process.send).

import { constants as fsConstants, readFileSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PyodideAPI } from 'pyodide';
import type { WorkerMessage, WorkerRequest } from '../src/runner/types.ts';

interface PyCallable {
  (...args: unknown[]): unknown;
  destroy(): void;
}

const send = process.send?.bind(process);
if (!send) throw new Error('verify-worker.ts запускается только из scripts/verify-content.ts (нужен канал IPC).');

function post(message: WorkerMessage) {
  send?.(message);
}

// Основной процесс завершился или закрыл канал — работать больше не для кого.
process.on('disconnect', () => process.exit(0));

/**
 * Pyodide при загрузке берёт константы файловой системы через устаревший process.binding('constants'),
 * а при включённых разрешениях Node этот вызов запрещён. Те же константы есть в публичных модулях.
 */
function allowConstantsBinding() {
  const legacy = process as NodeJS.Process & { binding(name: string): unknown };
  const original = legacy.binding.bind(process);
  legacy.binding = (name: string) => (name === 'constants' ? { fs: fsConstants, os: osConstants } : original(name));
}

async function boot(): Promise<PyodideAPI> {
  post({ type: 'status', phase: 'loading' });
  const [pyodideDir, harnessPath] = process.argv.slice(2);
  if (!pyodideDir || !harnessPath) throw new Error('не указаны папка Pyodide и путь к harness.py');
  allowConstantsBinding();
  const harness = readFileSync(harnessPath, 'utf8');
  const { loadPyodide } = (await import(pathToFileURL(path.join(pyodideDir, 'pyodide.mjs')).href)) as typeof import('pyodide');
  const pyodide = await loadPyodide({
    // Вывод программ перехватывает harness.py; сюда попадают только служебные сообщения Pyodide.
    stdout: () => {},
    stderr: () => {},
  });
  pyodide.runPython(harness);
  const pythonVersion = String(pyodide.runPython('import sys; sys.version.split()[0]'));
  post({ type: 'ready', pyodideVersion: pyodide.version, pythonVersion });
  return pyodide;
}

const ready = boot();
ready.catch((error: unknown) => {
  post({ type: 'init-error', message: error instanceof Error ? error.message : String(error) });
});

process.on('message', async (request: WorkerRequest) => {
  let pyodide: PyodideAPI;
  try {
    pyodide = await ready;
  } catch {
    return;
  }

  const name = request.type === 'run' ? 'run_program' : 'check_program';
  const fn = pyodide.globals.get(name) as PyCallable;
  try {
    if (request.type === 'run') {
      // Окружение (учебные файлы, базы, seed, ответы сети) — строкой JSON, как в python.worker.ts.
      const environment = request.environment ? JSON.stringify(request.environment) : null;
      const json = fn(request.code, request.stdin, request.limit, environment) as string;
      post({ type: 'run-result', id: request.id, result: JSON.parse(json) });
    } else {
      const json = fn(request.payload) as string;
      post({ type: 'check-result', id: request.id, result: JSON.parse(json) });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // После «фатальной» ошибки Pyodide дальше работать нельзя — основной процесс перезапустит этот.
    // Pyodide помечает такие ошибки полем pyodide_fatal_error (например, переполнение стека JS
    // при очень глубокой рекурсии): текст у них обычный, без слова fatal.
    const marked = typeof error === 'object' && error !== null && 'pyodide_fatal_error' in error;
    const fatal = marked || /fatal|Pyodide already fatally failed|RuntimeError: memory access/i.test(message);
    post({ type: 'failure', id: request.id, message, fatal });
  } finally {
    fn.destroy();
  }
});
