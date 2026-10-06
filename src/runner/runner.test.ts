// Тесты управления запуском (runner.ts) без настоящего Python: поток подменён заглушкой,
// которая сама решает, когда «загрузился» Python и что вернуть на запрос.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PythonRunner } from './runner.ts';
import type { CheckResult, WorkerMessage, WorkerRequest } from './types.ts';

class FakeWorker {
  static all: FakeWorker[] = [];
  onmessage: ((event: { data: WorkerMessage }) => void) | null = null;
  onerror: ((event: { message: string; preventDefault(): void }) => void) | null = null;
  posted: WorkerRequest[] = [];
  terminated = false;

  constructor() {
    FakeWorker.all.push(this);
  }

  postMessage(request: WorkerRequest) {
    this.posted.push(request);
  }

  terminate() {
    this.terminated = true;
  }

  send(message: WorkerMessage) {
    this.onmessage?.({ data: message });
  }

  ready() {
    this.send({ type: 'ready', pyodideVersion: '314.0.7', pythonVersion: '3.14.2' });
  }
}

const EMPTY_CHECK: CheckResult = { compileError: null, rules: [], tests: [] };

function lastWorker(): FakeWorker {
  const worker = FakeWorker.all[FakeWorker.all.length - 1];
  if (!worker) throw new Error('поток с Python не создан');
  return worker;
}

beforeEach(() => {
  FakeWorker.all = [];
  vi.useFakeTimers();
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('Worker', FakeWorker);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('PythonRunner', () => {
  it('«Остановить», пока Python загружается, отменяет запуск: программа в поток не уходит, загрузка не прерывается', async () => {
    const runner = new PythonRunner();
    const outcome = runner.run('print(1)', '');
    const worker = lastWorker();
    expect(runner.busy).toBe(true);

    runner.stop();
    await expect(outcome).resolves.toEqual({ status: 'stopped' });
    expect(runner.busy).toBe(false);
    expect(worker.terminated).toBe(false);

    worker.ready();
    await vi.runAllTimersAsync();
    expect(worker.posted).toEqual([]);
    expect(runner.getState().phase).toBe('ready');
    expect(FakeWorker.all).toHaveLength(1);
  });

  it('остановленная во время загрузки проверка не превращается в попытку: ни запроса, ни результата', async () => {
    const runner = new PythonRunner();
    const outcome = runner.check({ code: 'print(1)', tests: [], rules: [] });
    runner.stop();
    await expect(outcome).resolves.toEqual({ status: 'stopped', testIndex: 0 });
    lastWorker().ready();
    await vi.runAllTimersAsync();
    expect(lastWorker().posted).toEqual([]);
  });

  it('новый запуск, пока прежний ждёт Python, заменяет его: прежний остановлен, в поток уходит только новый', async () => {
    // Ученик нажал «Запустить» на одном шаге, пока грузится Python, и перешёл на другой.
    const runner = new PythonRunner();
    const first = runner.check({ code: 'print(1)', tests: [], rules: [] });
    const second = runner.run('print(2)', '');
    await expect(first).resolves.toEqual({ status: 'stopped', testIndex: 0 });
    expect(runner.busy).toBe(true);

    const worker = lastWorker();
    worker.ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(worker.posted).toHaveLength(1);
    const request = worker.posted[0];
    expect(request?.type).toBe('run');
    worker.send({ type: 'run-result', id: request?.id ?? -1, result: { stdout: '2\n' } });
    await expect(second).resolves.toEqual({ status: 'done', result: { stdout: '2\n' } });
    expect(runner.busy).toBe(false);
    expect(FakeWorker.all).toHaveLength(1);
  });

  it('второй запуск, пока программа выполняется в потоке, отклоняется, а первый доходит до результата', async () => {
    const runner = new PythonRunner();
    const first = runner.check({ code: 'print(1)', tests: [], rules: [] });
    const worker = lastWorker();
    worker.ready();
    await vi.advanceTimersByTimeAsync(0);
    await expect(runner.check({ code: 'print(2)', tests: [], rules: [] })).rejects.toThrow('Программа уже выполняется');
    await expect(runner.run('print(3)', '')).rejects.toThrow('Программа уже выполняется');

    expect(worker.posted).toHaveLength(1);
    const request = worker.posted[0];
    expect(request?.type).toBe('check');
    worker.send({ type: 'check-result', id: request?.id ?? -1, result: EMPTY_CHECK });
    await expect(first).resolves.toEqual({ status: 'done', result: EMPTY_CHECK });
    expect(runner.busy).toBe(false);
  });

  it('лимит времени отсчитывается с отправки программы, а не с начала загрузки Python', async () => {
    const runner = new PythonRunner();
    let settled = false;
    const outcome = runner.run('while True: pass', '', { timeLimitMs: 100 });
    void outcome.then(() => (settled = true));
    const worker = lastWorker();

    await vi.advanceTimersByTimeAsync(5000);
    expect(settled).toBe(false);

    worker.ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(worker.posted).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);
    await expect(outcome).resolves.toEqual({ status: 'timeout', limitMs: 100 });
    // Зависшую программу изнутри не прервать: поток завершается и запускается заново.
    expect(worker.terminated).toBe(true);
    expect(FakeWorker.all).toHaveLength(2);
  });

  it('«Остановить» во время выполнения перезапускает поток, и следующий запуск работает', async () => {
    const runner = new PythonRunner();
    const first = runner.run('while True: pass', '');
    const worker = lastWorker();
    worker.ready();
    await vi.advanceTimersByTimeAsync(0);
    runner.stop();
    await expect(first).resolves.toEqual({ status: 'stopped' });
    expect(worker.terminated).toBe(true);

    const second = runner.run('print(1)', '');
    const fresh = lastWorker();
    expect(fresh).not.toBe(worker);
    fresh.ready();
    await vi.advanceTimersByTimeAsync(0);
    const request = fresh.posted[0];
    fresh.send({ type: 'run-result', id: request?.id ?? -1, result: { stdout: '1\n' } });
    await expect(second).resolves.toEqual({ status: 'done', result: { stdout: '1\n' } });
  });

  it('окружение запуска (файлы, базы, seed, сеть) уходит в поток вместе с программой, без окружения — не уходит', async () => {
    const runner = new PythonRunner();
    const environment = { filename: 'calc.py', files: { 'data.txt': '1' }, seed: 7, http: [{ url: 'https://api.example.com/x' }] };
    const first = runner.run('print(1)', '', { environment });
    const worker = lastWorker();
    worker.ready();
    await vi.advanceTimersByTimeAsync(0);
    const request = worker.posted[0];
    expect(request).toMatchObject({ type: 'run', code: 'print(1)', environment });
    worker.send({ type: 'run-result', id: request?.id ?? -1, result: { stdout: '1\n', files: [] } });
    await first;

    const second = runner.run('print(2)', '');
    await vi.advanceTimersByTimeAsync(0);
    const plain = worker.posted[1];
    expect(plain && 'environment' in plain).toBe(false);
    worker.send({ type: 'run-result', id: plain?.id ?? -1, result: { stdout: '2\n' } });
    await second;
  });

  it('Python не загрузился — запуск завершается сбоем, слот освобождается', async () => {
    const runner = new PythonRunner();
    const outcome = runner.run('print(1)', '');
    lastWorker().send({ type: 'init-error', message: 'Failed to fetch' });
    const result = await outcome;
    expect(result.status).toBe('failed');
    expect(runner.busy).toBe(false);
  });
});
