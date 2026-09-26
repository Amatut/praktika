// Управление потоком с Python: подготовка, запуск, проверка, тайм-аут и остановка.
// Одновременно выполняется только одна программа.

import type { CheckPayload, CheckResult, RunResult, WorkerMessage, WorkerRequest } from './types.ts';

export type RunnerPhase = 'idle' | 'loading' | 'ready' | 'busy' | 'restarting' | 'failed';

export interface RunnerState {
  phase: RunnerPhase;
  pythonVersion?: string;
  pyodideVersion?: string;
  error?: string;
}

export type RunOutcome =
  | { status: 'done'; result: RunResult }
  | { status: 'timeout'; limitMs: number }
  | { status: 'stopped' }
  | { status: 'failed'; message: string };

export type CheckOutcome =
  | { status: 'done'; result: CheckResult }
  | { status: 'timeout'; limitMs: number; testIndex: number }
  | { status: 'stopped'; testIndex: number }
  | { status: 'failed'; message: string };

export interface RunOptions {
  timeLimitMs?: number;
  outputLimit?: number;
}

export interface CheckOptions {
  perTestMs?: number;
  outputLimit?: number;
  /** Вызывается перед каждым тестом — для строки «Проверяю тест 2 из 4». */
  onTestStart?: (index: number) => void;
}

export const DEFAULT_RUN_LIMIT_MS = 5000;
export const DEFAULT_TEST_LIMIT_MS = 3000;
export const DEFAULT_OUTPUT_LIMIT = 20_000;
const LOAD_TIMEOUT_MS = 180_000;

/**
 * Текущий запуск. Слот занимается сразу при вызове run/check — ещё до загрузки Python, —
 * поэтому промис не теряется, а «Остановить» отменяет ожидающий запуск.
 * sent — программа уже передана в поток; до этого таймера нет, а останавливать поток незачем.
 */
type Pending =
  | { kind: 'run'; id: number; limitMs: number; timer: number | null; sent: boolean; resolve: (o: RunOutcome) => void }
  | {
      kind: 'check';
      id: number;
      limitMs: number;
      timer: number | null;
      sent: boolean;
      testIndex: number;
      onTestStart?: (index: number) => void;
      resolve: (o: CheckOutcome) => void;
    };

export class PythonRunner {
  #worker: Worker | null = null;
  #ready: Promise<void> | null = null;
  #state: RunnerState = { phase: 'idle' };
  #listeners = new Set<(state: RunnerState) => void>();
  #pending: Pending | null = null;
  #nextId = 1;

  getState = (): RunnerState => this.#state;

  subscribe = (listener: (state: RunnerState) => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #setState(patch: Partial<RunnerState>) {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener(this.#state);
  }

  /** Запускает Python (если ещё не запущен) и ждёт готовности. */
  prepare(): Promise<void> {
    if (this.#ready && this.#state.phase !== 'failed') return this.#ready;
    this.#ready = this.#spawn(false);
    return this.#ready;
  }

  #spawn(restarting: boolean): Promise<void> {
    this.#setState({ phase: restarting ? 'restarting' : 'loading', error: undefined });
    const worker = new Worker(new URL('./python.worker.ts', import.meta.url), {
      type: 'module',
      name: 'python',
    });
    this.#worker = worker;

    return new Promise<void>((resolve, reject) => {
      const loadTimer = window.setTimeout(() => {
        fail('Python не успел загрузиться. Проверь подключение или скачай Python для офлайн-работы в настройках.');
      }, LOAD_TIMEOUT_MS);

      const fail = (message: string) => {
        window.clearTimeout(loadTimer);
        if (this.#worker === worker) {
          worker.terminate();
          this.#worker = null;
          this.#setState({ phase: 'failed', error: message });
        }
        reject(new Error(message));
      };

      worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
        const message = event.data;
        if (message.type === 'ready') {
          window.clearTimeout(loadTimer);
          this.#setState({
            phase: this.#pending ? 'busy' : 'ready',
            pythonVersion: message.pythonVersion,
            pyodideVersion: message.pyodideVersion,
          });
          resolve();
          return;
        }
        if (message.type === 'init-error') {
          fail(describeLoadError(message.message));
          return;
        }
        this.#handleMessage(message);
      };

      worker.onerror = (event) => {
        event.preventDefault();
        fail(describeLoadError(event.message || 'Не удалось запустить поток с Python.'));
      };
    });
  }

  #handleMessage(message: WorkerMessage) {
    const pending = this.#pending;
    if (!pending) return;

    if (message.type === 'test-start' && pending.kind === 'check' && message.id === pending.id) {
      pending.testIndex = message.index;
      pending.onTestStart?.(message.index);
      if (pending.timer !== null) window.clearTimeout(pending.timer);
      pending.timer = window.setTimeout(() => this.#interrupt('timeout'), pending.limitMs);
      return;
    }

    if (message.type === 'run-result' && pending.kind === 'run' && message.id === pending.id) {
      this.#finish();
      pending.resolve({ status: 'done', result: message.result });
      return;
    }

    if (message.type === 'check-result' && pending.kind === 'check' && message.id === pending.id) {
      this.#finish();
      pending.resolve({ status: 'done', result: message.result });
      return;
    }

    if (message.type === 'failure' && message.id === pending.id) {
      this.#finish();
      pending.resolve({ status: 'failed', message: message.message });
      if (message.fatal) void this.#restart();
    }
  }

  #finish() {
    const timer = this.#pending?.timer;
    if (timer !== null && timer !== undefined) window.clearTimeout(timer);
    this.#pending = null;
    this.#setState({ phase: 'ready' });
  }

  async #restart() {
    this.#worker?.terminate();
    this.#worker = null;
    this.#ready = this.#spawn(true);
    try {
      await this.#ready;
    } catch {
      // Состояние failed уже выставлено — интерфейс покажет сообщение.
    }
  }

  #interrupt(reason: 'timeout' | 'stopped') {
    const pending = this.#pending;
    if (!pending) return;
    if (pending.timer !== null) window.clearTimeout(pending.timer);
    this.#pending = null;
    if (pending.kind === 'run') {
      pending.resolve(reason === 'timeout' ? { status: 'timeout', limitMs: pending.limitMs } : { status: 'stopped' });
    } else {
      pending.resolve(
        reason === 'timeout'
          ? { status: 'timeout', limitMs: pending.limitMs, testIndex: pending.testIndex }
          : { status: 'stopped', testIndex: pending.testIndex },
      );
    }
    // Программа ещё ждала загрузки Python: в поток она не попала, загрузку не прерываем.
    if (!pending.sent) return;
    // Бесконечный цикл нельзя прервать изнутри — перезапускаем поток с Python.
    void this.#restart();
  }

  /** Остановить текущую программу — или отменить запуск, который ждёт загрузки Python. */
  stop() {
    this.#interrupt('stopped');
  }

  /** Идёт запуск: программа выполняется или ждёт загрузки Python. */
  get busy() {
    return this.#pending !== null;
  }

  /**
   * Занимает слот синхронно, до первого await. Запуск, который ещё ждёт загрузки Python, новый вызов
   * заменяет: прежний завершается как остановленный. Так запуск на другом шаге урока не зависает из-за
   * того, что на прежнем шаге успели нажать «Запустить». Пока программа уже выполняется в потоке,
   * второй вызов отклоняется ошибкой «Программа уже выполняется» — интерфейс в это время запуск не даёт.
   */
  run(code: string, stdin: string, options: RunOptions = {}): Promise<RunOutcome> {
    if (!this.#claim()) return Promise.reject(new Error('Программа уже выполняется'));
    const limitMs = options.timeLimitMs ?? DEFAULT_RUN_LIMIT_MS;
    const limit = options.outputLimit ?? DEFAULT_OUTPUT_LIMIT;
    return new Promise<RunOutcome>((resolve) => {
      const pending: Pending = { kind: 'run', id: this.#nextId++, limitMs, timer: null, sent: false, resolve };
      this.#pending = pending;
      void this.#dispatch(pending, { type: 'run', id: pending.id, code, stdin, limit });
    });
  }

  check(payload: CheckPayload, options: CheckOptions = {}): Promise<CheckOutcome> {
    if (!this.#claim()) return Promise.reject(new Error('Программа уже выполняется'));
    const limitMs = options.perTestMs ?? DEFAULT_TEST_LIMIT_MS;
    const body = JSON.stringify({ ...payload, limit: payload.limit ?? options.outputLimit ?? DEFAULT_OUTPUT_LIMIT });
    return new Promise<CheckOutcome>((resolve) => {
      const pending: Pending = {
        kind: 'check',
        id: this.#nextId++,
        limitMs,
        timer: null,
        sent: false,
        testIndex: 0,
        onTestStart: options.onTestStart,
        resolve,
      };
      this.#pending = pending;
      void this.#dispatch(pending, { type: 'check', id: pending.id, payload: body });
    });
  }

  /** Освобождает слот для нового запуска: ожидающий загрузки Python отменяется. false — программа уже в потоке. */
  #claim(): boolean {
    if (this.#pending?.sent) return false;
    this.#interrupt('stopped');
    return true;
  }

  /** Дожидается Python и передаёт программу в поток, если запуск за это время не отменили. */
  async #dispatch(pending: Pending, request: WorkerRequest) {
    try {
      await this.prepare();
    } catch (error) {
      if (this.#pending !== pending) return;
      this.#pending = null;
      pending.resolve({ status: 'failed', message: (error as Error).message });
      return;
    }
    // Пока Python загружался, запуск остановили — в поток ничего не отправляем.
    if (this.#pending !== pending) return;
    const worker = this.#worker;
    if (!worker) {
      this.#pending = null;
      pending.resolve({ status: 'failed', message: 'Python не запущен' });
      return;
    }
    pending.sent = true;
    // Для проверки это ещё и лимит на разбор кода до первого теста.
    pending.timer = window.setTimeout(() => this.#interrupt('timeout'), pending.limitMs);
    this.#setState({ phase: 'busy' });
    worker.postMessage(request);
  }
}

function describeLoadError(message: string): string {
  if (/fetch|network|Failed to load|NetworkError|import/i.test(message)) {
    return 'Не удалось загрузить Python. Нужен интернет для первой загрузки или заранее скачанный Python (Настройки → Офлайн).';
  }
  return `Python не запустился: ${message}`;
}

export const pythonRunner = new PythonRunner();
