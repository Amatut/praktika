// Автоматическая проверка учебных материалов запуском настоящего Python:
//   npm run verify:content -- [id урока или модуля ...] [--root <папка>] [--json] [--timeout <мс>]
//
// Python — тот же Pyodide и тот же src/runner/harness.py, что и в приложении, только в Node.js
// (отдельный процесс, файл scripts/verify-worker.ts). Для каждого задания проверяется:
//   * тесты сами по себе: у call-тестов expected — литерал Python, а call — выражение;
//     у assert-тестов код проверки без синтаксических ошибок;
//   * эталонное решение проходит все тесты и правила и укладывается в лимит времени приложения;
//   * стартовый код их НЕ проходит (иначе заданию нечего делать);
//   * каждое другое верное решение (altSolutions) проходит всё, как эталон, — правила не отклоняют
//     верный код, написанный иначе;
//   * каждое типичное неверное решение проваливает хотя бы один тест или правило, и срабатывает
//     именно разбор из expectMistake (matchMistake из src/coach/feedback.ts), а при expectMistake: null —
//     ни один. Если у задания есть разборы, expectMistake указывается у каждого неверного решения;
// для шагов predict — ответ совпадает с настоящим выводом программы, для example — код работает без ошибок.
// Всё запускается с окружением из материалов (учебные файлы, базы SQLite, seed, ответы сети), как в приложении.
// Код выхода: 0 — ошибок нет, 1 — найдены ошибки, 2 — неверные аргументы.
//
// Безопасность: код из материалов выполняется на этом компьютере. Процесс с Python запускается
// с разрешениями Node (--permission): без записи файлов, без запуска программ и потоков, читать
// можно только Pyodide и harness.py. Это не полная песочница (например, сеть Node 24 не ограничивает),
// поэтому проверяй только материалы, которым доверяешь.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ContentError, loadContent, type LoadedContent } from '../build/content-lib.ts';
import { matchMistake, normalizeOutput, testLabel } from '../src/coach/feedback.ts';
import type { ContentTest, ExampleStep, Exercise, Lesson, PredictStep } from '../src/content/schema.ts';
import { exerciseEnvironment, stepEnvironment } from '../src/runner/environment.ts';
import { DEFAULT_OUTPUT_LIMIT, DEFAULT_TEST_LIMIT_MS } from '../src/runner/runner.ts';
import type {
  CheckPayload,
  CheckResult,
  PyError,
  RunEnvironment,
  RunResult,
  TestResult,
  WorkerMessage,
  WorkerRequest,
} from '../src/runner/types.ts';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER_PATH = fileURLToPath(new URL('./verify-worker.ts', import.meta.url));
const HARNESS_PATH = fileURLToPath(new URL('../src/runner/harness.py', import.meta.url));

/** Лимит на один тест (и на запуск примера) по умолчанию. */
export const DEFAULT_TIMEOUT_MS = 5000;
/** Эталон, которому нужно больше этой доли лимита приложения, может не уложиться на слабом устройстве. */
const SLOW_SHARE = 0.5;
const LOAD_TIMEOUT_MS = 120_000;
const MAX_VALUE_LINES = 12;
const MAX_LINE_LENGTH = 160;
const STDERR_TAIL = 4000;

// ------------------------------------------------------------------ Python в отдельном процессе

export type CallOutcome<T> =
  | { status: 'done'; result: T }
  | { status: 'timeout'; limitMs: number }
  | { status: 'failed'; message: string };

/** Всё, что проверке нужно от Python. В тестах можно подставить свою реализацию. */
export interface PythonExecutor {
  /** environment — учебные файлы, базы, seed и ответы сети шага (необязательно). */
  run(code: string, stdin: string, limitMs: number, environment?: RunEnvironment): Promise<CallOutcome<RunResult>>;
  check(payload: CheckPayload, limitMs: number): Promise<CallOutcome<CheckResult>>;
  /** Загрузить Python заранее (необязательно). */
  start?(): Promise<PythonInfo>;
  /** Python больше не запускается — дальше проверять нечем. */
  readonly failure?: string | null;
  /** Сколько раз Python пришлось перезапускать. */
  readonly restarts?: number;
}

export interface PythonInfo {
  pythonVersion: string;
  pyodideVersion: string;
}

export interface NodePythonOptions {
  /** Папка пакета pyodide. По умолчанию — из node_modules. */
  pyodideDir?: string;
  /** Сколько ждать загрузки Python, мс. */
  loadTimeoutMs?: number;
}

type RequestBody =
  | { type: 'run'; code: string; stdin: string; limit: number; environment?: RunEnvironment }
  | { type: 'check'; payload: string };

interface Pending {
  id: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (outcome: CallOutcome<RunResult | CheckResult>) => void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultPyodideDir(): string {
  try {
    return path.dirname(createRequire(import.meta.url).resolve('pyodide/package.json'));
  } catch {
    throw new Error('Pyodide не найден в node_modules — выполни npm install.');
  }
}

function isWorkerMessage(value: unknown): value is WorkerMessage {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
}

/** Первая строка из stderr процесса, похожая на сообщение об ошибке. */
function stderrHint(stderr: string): string {
  const line = stderr.split(/\r?\n/).find((item) => /error/i.test(item) && item.trim().length > 0);
  return line ? `: ${clipLine(line.trim())}` : '';
}

/**
 * Pyodide в отдельном процессе Node с ограниченными правами. Запросы выполняются строго по одному.
 * Если программа не уложилась в лимит, процесс завершается, а следующий запрос
 * запускает новый — так же приложение поступает с бесконечным циклом.
 */
export class NodePython implements PythonExecutor {
  #child: ChildProcess | null = null;
  #ready: Promise<ChildProcess> | null = null;
  #stopping: Promise<unknown> = Promise.resolve();
  #queue: Promise<unknown> = Promise.resolve();
  #pending: Pending | null = null;
  #broken: string | null = null;
  #nextId = 1;
  #spawned = 0;
  #pyodideDir: string | undefined;
  #loadTimeoutMs: number;
  info: PythonInfo | null = null;
  /** Сколько раз процесс с Python пришлось перезапустить (после зависаний и сбоев). */
  restarts = 0;

  constructor(options: NodePythonOptions = {}) {
    this.#pyodideDir = options.pyodideDir;
    this.#loadTimeoutMs = options.loadTimeoutMs ?? LOAD_TIMEOUT_MS;
  }

  /** Python больше не запускается (например, не загрузился после перезапуска) — дальше проверять нечем. */
  get failure(): string | null {
    return this.#broken;
  }

  /** Загружает Python заранее; без этого он загрузится при первом запросе. */
  async start(): Promise<PythonInfo> {
    await this.#ensure();
    if (!this.info) throw new Error('Python загрузился, но не сообщил версию.');
    return this.info;
  }

  run(code: string, stdin: string, limitMs: number, environment?: RunEnvironment): Promise<CallOutcome<RunResult>> {
    const body: RequestBody = { type: 'run', code, stdin, limit: DEFAULT_OUTPUT_LIMIT, ...(environment ? { environment } : {}) };
    return this.#request(body, limitMs) as Promise<CallOutcome<RunResult>>;
  }

  check(payload: CheckPayload, limitMs: number): Promise<CallOutcome<CheckResult>> {
    const body = JSON.stringify({ ...payload, limit: payload.limit ?? DEFAULT_OUTPUT_LIMIT });
    return this.#request({ type: 'check', payload: body }, limitMs) as Promise<CallOutcome<CheckResult>>;
  }

  async close(): Promise<void> {
    await this.#queue;
    const child = this.#child;
    if (child) this.#kill(child);
    await this.#stopping;
  }

  #request(body: RequestBody, limitMs: number): Promise<CallOutcome<RunResult | CheckResult>> {
    const task = this.#queue.then(() => this.#send(body, limitMs));
    this.#queue = task.catch(() => undefined);
    return task;
  }

  async #send(body: RequestBody, limitMs: number): Promise<CallOutcome<RunResult | CheckResult>> {
    let child: ChildProcess;
    try {
      child = await this.#ensure();
    } catch (error) {
      return { status: 'failed', message: messageOf(error) };
    }
    const id = this.#nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.#pending?.id !== id) return;
        this.#pending = null;
        resolve({ status: 'timeout', limitMs });
        // Бесконечный цикл изнутри не прервать — завершаем процесс целиком.
        this.#kill(child);
      }, limitMs);
      this.#pending = { id, timer, resolve };
      const request: WorkerRequest = { ...body, id };
      child.send(request, (error) => {
        if (error) this.#abandon(child, `Не удалось передать программу процессу с Python: ${error.message}`);
      });
    });
  }

  #ensure(): Promise<ChildProcess> {
    if (this.#broken) return Promise.reject(new Error(this.#broken));
    this.#ready ??= this.#spawn();
    return this.#ready;
  }

  async #spawn(): Promise<ChildProcess> {
    // Старый процесс должен завершиться: два Python одновременно — лишняя нагрузка на память.
    await this.#stopping;
    if (this.#spawned++ > 0) this.restarts++;
    let pyodideDir: string;
    try {
      pyodideDir = path.resolve(this.#pyodideDir ?? defaultPyodideDir());
    } catch (error) {
      this.#broken = messageOf(error);
      this.#ready = null;
      throw error;
    }

    // Разрешения Node: читать только то, что нужно для запуска Python; писать файлы,
    // запускать процессы и потоки нельзя. Переменные окружения не передаются (в них бывают ключи).
    const child = spawn(
      process.execPath,
      [
        '--permission',
        `--allow-fs-read=${WORKER_PATH}`,
        `--allow-fs-read=${HARNESS_PATH}`,
        `--allow-fs-read=${pyodideDir}`,
        WORKER_PATH,
        pyodideDir,
        HARNESS_PATH,
      ],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: {}, windowsHide: true },
    );
    this.#child = child;
    let stderr = '';
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL);
    });

    return new Promise<ChildProcess>((resolve, reject) => {
      let loaded = false;
      let settled = false;
      const fail = (message: string) => {
        clearTimeout(loadTimer);
        if (settled) return;
        settled = true;
        if (this.#child === child) {
          this.#broken = message;
          this.#kill(child);
        }
        reject(new Error(message));
      };
      const loadTimer = setTimeout(
        () => fail(`Python не загрузился за ${Math.round(this.#loadTimeoutMs / 1000)} с.`),
        this.#loadTimeoutMs,
      );

      child.on('message', (message: unknown) => {
        if (!isWorkerMessage(message)) return;
        if (message.type === 'ready') {
          if (settled) return;
          loaded = true;
          settled = true;
          clearTimeout(loadTimer);
          this.info = { pythonVersion: String(message.pythonVersion), pyodideVersion: String(message.pyodideVersion) };
          resolve(child);
          return;
        }
        if (message.type === 'init-error') {
          fail(`Python не запустился: ${message.message}`);
          return;
        }
        this.#handle(child, message);
      });
      child.on('error', (error: Error) => {
        if (!loaded) fail(`Процесс с Python не запустился: ${error.message}`);
        else this.#abandon(child, `Процесс с Python завершился с ошибкой: ${error.message}`);
      });
      child.on('exit', (code, signal) => {
        const how = signal ? `сигнал ${signal}` : `код ${code}`;
        if (!loaded) fail(`Процесс с Python завершился, не успев загрузиться (${how})${stderrHint(stderr)}`);
        else this.#abandon(child, `Процесс с Python неожиданно завершился (${how})${stderrHint(stderr)}`);
      });
    });
  }

  #handle(child: ChildProcess, message: WorkerMessage) {
    const pending = this.#pending;
    if (!pending || this.#child !== child) return;
    if (message.type !== 'run-result' && message.type !== 'check-result' && message.type !== 'failure') return;
    if (message.id !== pending.id) return;
    clearTimeout(pending.timer);
    this.#pending = null;
    if (message.type === 'failure') {
      pending.resolve({ status: 'failed', message: String(message.message) });
      if (message.fatal) this.#kill(child);
    } else if (typeof message.result !== 'object' || message.result === null) {
      pending.resolve({ status: 'failed', message: 'Python вернул результат в неожиданном виде' });
    } else {
      pending.resolve({ status: 'done', result: message.result });
    }
  }

  /** Процесс завершился сам: текущий запрос считается сбоем, следующий запустит новый процесс. */
  #abandon(child: ChildProcess, message: string) {
    if (this.#child !== child) return;
    const pending = this.#pending;
    if (pending) {
      clearTimeout(pending.timer);
      this.#pending = null;
      pending.resolve({ status: 'failed', message });
    }
    this.#kill(child);
  }

  #kill(child: ChildProcess) {
    if (this.#child !== child) return;
    this.#child = null;
    this.#ready = null;
    this.#stopping = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
        resolve();
        return;
      }
      // Страховка: если событие exit так и не придёт, не ждём вечно.
      const fallback = setTimeout(resolve, 5000);
      fallback.unref();
      child.once('exit', () => {
        clearTimeout(fallback);
        resolve();
      });
      if (!child.kill()) {
        clearTimeout(fallback);
        resolve();
      }
    });
  }
}

// ------------------------------------------------------------------ отчёт

export type Severity = 'error' | 'warning';
/**
 * Что именно проверялось. content — само описание задания (тесты, разборы, пояснения к строкам),
 * alt — другое верное решение (altSolutions).
 */
export type Subject = 'solution' | 'starter' | 'alt' | 'wrong' | 'predict' | 'example' | 'content';

export interface Problem {
  severity: Severity;
  subject: Subject;
  lessonId: string;
  stepId: string | null;
  exerciseId: string | null;
  /** Номер неверного решения, с 1. */
  wrongIndex?: number;
  /** Номер другого верного решения, с 1. */
  altIndex?: number;
  /** Тест, о котором идёт речь, если он один. */
  testId?: string;
  /** Непройденные тесты и правила — для проблем «не проходит проверку» и «не тот разбор». */
  failedTests?: string[];
  failedRules?: string[];
  message: string;
  /** Подробности: какой тест, ввод, ожидалось/получилось. */
  details: string[];
}

/** Итог проверки одного варианта кода задания (эталон, стартовый код, неверное решение). */
export interface CodeSummary {
  /** Прошёл бы проверку в приложении: все тесты и правила, без зависаний и без выхода за лимит приложения. */
  passed: boolean;
  compileError: string | null;
  failedTests: string[];
  failedRules: string[];
  /** Тест, на котором код не завершился за лимит проверки. */
  timedOutTest: string | null;
  /** Тесты, на которые ушло не меньше лимита приложения: там проверка остановится по тайм-ауту. */
  overAppLimitTests: string[];
  /** Сбои самой проверки: Python не смог её выполнить (ученик увидит сообщение о сбое, а не тест). */
  checkFailures: string[];
}

export interface WrongReport extends CodeSummary {
  index: number;
  note: string;
  /** true — решение не прошло проверку, как и должно быть (сбой проверки не считается). */
  rejected: boolean;
  /** Ожидаемый разбор; null — не должен сработать ни один (или в материалах не указан). */
  expectMistake: string | null;
  /** Разбор, который увидит ученик с этим решением. */
  matchedMistake: string | null;
}

export interface AltReport extends CodeSummary {
  index: number;
  note: string;
}

export interface ExerciseReport {
  id: string;
  stepId: string;
  /** Задание не на Python — автоматически не проверялось. */
  skipped: boolean;
  /** Тесты с ошибками в самих тестах; пока они есть, код задания не запускается. */
  invalidTests: string[];
  solutionPassed: boolean;
  starterPassed: boolean;
  /** null — код не запускался (задание не на Python или тесты с ошибками). */
  solution: CodeSummary | null;
  starter: CodeSummary | null;
  altSolutions: AltReport[];
  wrongSolutions: WrongReport[];
}

export interface LessonReport {
  id: string;
  module: string;
  title: string;
  checks: number;
  errors: number;
  warnings: number;
  exercises: ExerciseReport[];
  problems: Problem[];
  /** Замечания к оформлению от загрузчика материалов (не влияют на результат). */
  contentWarnings: string[];
  durationMs: number;
}

export interface VerifyReport {
  ok: boolean;
  root: string;
  only: string[];
  /** Запрошенные уроки и модули, которых нет среди готовых материалов. */
  missing: string[];
  timeoutMs: number;
  python: PythonInfo | null;
  lessons: LessonReport[];
  totals: {
    lessons: number;
    failedLessons: number;
    exercises: number;
    checks: number;
    errors: number;
    warnings: number;
    pythonRestarts: number;
  };
  /** Причина, по которой проверка не состоялась: формат материалов, Python не запустился, нечего проверять. */
  fatal: string | null;
  durationMs: number;
}

// ------------------------------------------------------------------ запуск кода задания

export interface CodeCheck {
  /** Результат в том виде, в каком его получает приложение после полной проверки. */
  result: CheckResult;
  /** Тест, на котором программа не завершилась вовремя; следующие тесты не запускались. */
  timedOut: { testId: string; limitMs: number } | null;
  /** Сбои самой проверки (Python не смог выполнить проверку). */
  failures: { testId: string | null; message: string }[];
  passed: boolean;
}

function placeholderTest(test: ContentTest, interrupted?: TestResult['interrupted']): TestResult {
  return {
    id: test.id,
    kind: test.kind,
    passed: false,
    stdin: test.stdin ?? '',
    expected: test.kind === 'assert' ? undefined : test.expected,
    call: test.kind === 'call' ? test.call : undefined,
    message: test.kind === 'assert' ? test.message : undefined,
    output: '',
    transcript: [],
    error: null,
    limit: false,
    truncated: false,
    exitCode: null,
    durationMs: 0,
    interrupted,
  };
}

/**
 * Проверяет код так же, как кнопка «Проверить»: те же тесты, правила и harness.py.
 * Тесты запускаются по одному, чтобы у каждого был свой лимит времени: после зависания
 * Python перезапускается, а оставшиеся тесты помечаются как незапущенные —
 * приложение в этом случае тоже прекращает проверку.
 */
export async function checkCode(py: PythonExecutor, exercise: Exercise, code: string, limitMs: number): Promise<CodeCheck> {
  const failures: CodeCheck['failures'] = [];
  const result: CheckResult = { compileError: null, rules: [], tests: [] };
  const done = (timedOut: CodeCheck['timedOut'] = null): CodeCheck => ({
    result,
    timedOut,
    failures,
    passed:
      !result.compileError &&
      timedOut === null &&
      failures.length === 0 &&
      result.rules.every((rule) => rule.passed) &&
      result.tests.length === exercise.tests.length &&
      result.tests.every((test) => test.passed),
  });

  // Окружение задания: файл кода, учебные файлы, базы, seed, ответы сети. Тест дополняет его своими полями.
  const environment = exerciseEnvironment(exercise);
  // Сначала разбор кода и правила (без тестов).
  const first = await py.check({ code, tests: [], rules: exercise.rules, ...environment }, limitMs);
  if (first.status !== 'done') {
    failures.push({
      testId: null,
      message: first.status === 'timeout' ? `разбор кода не уложился в ${formatSeconds(limitMs)}` : first.message,
    });
    return done();
  }
  if (first.result.compileError) {
    result.compileError = first.result.compileError;
    return done();
  }
  result.rules = first.result.rules;

  for (const [index, test] of exercise.tests.entries()) {
    const outcome = await py.check({ code, tests: [test], rules: [], ...environment }, limitMs);
    if (outcome.status === 'timeout') {
      result.tests.push(placeholderTest(test, 'timeout'));
      for (const rest of exercise.tests.slice(index + 1)) result.tests.push(placeholderTest(rest, 'skipped'));
      return done({ testId: test.id, limitMs: outcome.limitMs });
    }
    if (outcome.status === 'failed') {
      failures.push({ testId: test.id, message: outcome.message });
      result.tests.push(placeholderTest(test));
      continue;
    }
    const tested = outcome.result.tests[0];
    if (outcome.result.compileError || !tested) {
      failures.push({ testId: test.id, message: 'Python не вернул результат теста' });
      result.tests.push(placeholderTest(test));
      continue;
    }
    result.tests.push(tested);
  }
  return done();
}

function failedTests(check: CodeCheck): string[] {
  return check.result.tests.filter((test) => !test.passed && test.interrupted !== 'skipped').map((test) => test.id);
}

/** Итог проверки кода с учётом лимита приложения на один тест. */
export function summarizeCheck(check: CodeCheck, appLimitMs: number): CodeSummary {
  const overAppLimitTests = check.result.tests
    .filter((test) => !test.interrupted && test.durationMs >= appLimitMs)
    .map((test) => test.id);
  return {
    passed: check.passed && overAppLimitTests.length === 0,
    compileError: check.result.compileError?.summary ?? null,
    failedTests: failedTests(check),
    failedRules: check.result.rules.filter((rule) => !rule.passed).map((rule) => rule.id),
    timedOutTest: check.timedOut?.testId ?? null,
    overAppLimitTests,
    checkFailures: check.failures.map((failure) =>
      failure.testId ? `${failure.testId}: ${lastLine(failure.message)}` : lastLine(failure.message),
    ),
  };
}

// ------------------------------------------------------------------ проверка самих тестов

/** Ошибка в самом тесте: call — не выражение, expected — не литерал, код assert не компилируется. */
export interface TestIssue {
  id: string;
  field: 'call' | 'expected' | 'code';
  error: string;
  line?: number | null;
}

// Выполняется как обычная программа через run_program; тесты приходят через stdin.
const TEST_VALIDATOR = `import ast, json, sys

found = []
for test in json.loads(sys.stdin.read()):
    kind = test.get("kind")
    if kind == "call":
        try:
            compile(test["call"], "<проверка>", "eval", dont_inherit=True)
        except SyntaxError as e:
            found.append({"id": test["id"], "field": "call", "error": f"{type(e).__name__}: {e.msg}"})
        try:
            ast.literal_eval(test["expected"])
        except SyntaxError as e:
            found.append({"id": test["id"], "field": "expected", "error": f"{type(e).__name__}: {e.msg}"})
        except Exception as e:
            found.append({"id": test["id"], "field": "expected", "error": f"{type(e).__name__}: {e}"})
    elif kind == "assert":
        try:
            compile(test["code"], "<проверка>", "exec", dont_inherit=True)
        except SyntaxError as e:
            found.append({"id": test["id"], "field": "code", "error": f"{type(e).__name__}: {e.msg}", "line": e.lineno})
print(json.dumps(found, ensure_ascii=False))
`;

/**
 * Проверяет call- и assert-тесты задания тем же Python (ast.literal_eval, compile).
 * null — проверять нечего или Python не смог выполнить проверку (тогда ошибки всплывут при запуске кода).
 */
export async function validateTests(py: PythonExecutor, exercise: Exercise, limitMs: number): Promise<TestIssue[] | null> {
  const tests = exercise.tests.filter((test) => test.kind === 'call' || test.kind === 'assert');
  if (tests.length === 0) return null;
  const outcome = await py.run(TEST_VALIDATOR, JSON.stringify(tests), limitMs);
  if (outcome.status !== 'done' || outcome.result.compileError || outcome.result.error) return null;
  try {
    const parsed: unknown = JSON.parse(outcome.result.stdout ?? '');
    return Array.isArray(parsed) ? (parsed as TestIssue[]) : null;
  } catch {
    return null;
  }
}

function describeTestIssue(exercise: Exercise, issue: TestIssue): { message: string; details: string[] } {
  const test = exercise.tests.find((item) => item.id === issue.id);
  const label = test ? `тест «${testLabel(test, exercise.tests.indexOf(test))}» (${issue.id})` : `тест ${issue.id}`;
  const skipped = 'код задания не запускался — сначала исправь тесты';
  if (issue.field === 'expected' && test?.kind === 'call') {
    const value = test.expected.trim();
    const details: string[] = [];
    if (/^[\p{L}_][\p{L}\p{N}_ ]*$/u.test(value)) {
      details.push(`если это строка, нужны кавычки: '${value}'`);
    } else {
      details.push('нужен литерал Python: число, строка в кавычках, список, кортеж, словарь, True, False или None');
      if (issue.error.startsWith('SyntaxError')) details.push(`Python: ${clipLine(issue.error)}`);
    }
    return { message: `${label}: expected «${clipLine(value)}» — не литерал Python`, details: [...details, skipped] };
  }
  if (issue.field === 'call' && test?.kind === 'call') {
    return {
      message: `${label}: call «${clipLine(test.call)}» — не выражение Python`,
      details: [`Python: ${clipLine(issue.error)}`, skipped],
    };
  }
  const where = issue.line ? `строка ${issue.line}: ` : '';
  return {
    message: `${label}: в коде проверки синтаксическая ошибка`,
    details: [`${where}${clipLine(issue.error)}`, skipped],
  };
}

// ------------------------------------------------------------------ описание результатов

function formatSeconds(ms: number): string {
  const seconds = Math.round(ms / 100) / 10;
  return `${String(seconds).replace('.', ',')} с`;
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} мс` : formatSeconds(ms);
}

function clipLine(text: string): string {
  return text.length <= MAX_LINE_LENGTH ? text : `${text.slice(0, MAX_LINE_LENGTH - 1)}…`;
}

/** Последняя непустая строка — обычно это суть сообщения Python. */
function lastLine(text: string): string {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  return clipLine(lines[lines.length - 1]?.trim() ?? text);
}

/** Ввод в одну строку: «2 ⏎ 3». */
function inlineInput(stdin: string): string {
  return clipLine(
    stdin
      .replace(/\r\n?/g, '\n')
      .replace(/\n$/, '')
      .split('\n')
      .map((line) => (line === '' ? '(пусто)' : line))
      .join(' ⏎ '),
  );
}

/** «ожидалось: 5» или многострочный блок с «| » перед каждой строкой. */
function valueLines(label: string, text: string, indent: string): string[] {
  const normalized = normalizeOutput(text);
  if (normalized === '') return [`${indent}${label}: (пусто)`];
  const lines = normalized.split('\n');
  if (lines.length === 1) return [`${indent}${label}: ${clipLine(lines[0] ?? '')}`];
  const shown = lines.slice(0, MAX_VALUE_LINES).map((line) => `${indent}  | ${clipLine(line)}`);
  if (lines.length > MAX_VALUE_LINES) shown.push(`${indent}  | … ещё строк: ${lines.length - MAX_VALUE_LINES}`);
  return [`${indent}${label}:`, ...shown];
}

function describeError(error: PyError): string {
  const where = error.line ? ` (строка ${error.line})` : '';
  const origin = error.origin === 'check' ? 'ошибка в выражении проверки' : 'ошибка';
  return `${origin}: ${clipLine(error.summary)}${where}`;
}

function labelOf(exercise: Exercise, testId: string): string {
  const test = exercise.tests.find((item) => item.id === testId);
  return test ? testLabel(test, exercise.tests.indexOf(test)) : testId;
}

function describeTest(exercise: Exercise, check: CodeCheck, test: TestResult, index: number): string[] {
  const content = exercise.tests.find((item) => item.id === test.id);
  const position = content ? exercise.tests.indexOf(content) : index;
  const label = content ? testLabel(content, position) : test.id;
  const stdin = content?.stdin ?? test.stdin;
  const lines = [`тест «${label}» (${test.id})${stdin ? `, ввод: ${inlineInput(stdin)}` : ''}`];
  const indent = '  ';

  const failure = check.failures.find((item) => item.testId === test.id);
  if (failure) {
    lines.push(`${indent}сбой проверки: ${lastLine(failure.message)}`);
    return lines;
  }
  if (test.interrupted === 'timeout') {
    const limit = check.timedOut ? formatSeconds(check.timedOut.limitMs) : 'лимит';
    lines.push(`${indent}не завершился за ${limit} — похоже на бесконечный цикл`);
    return lines;
  }
  if (test.error) lines.push(`${indent}${describeError(test.error)}`);
  if (test.limit) lines.push(`${indent}вывод превысил ${DEFAULT_OUTPUT_LIMIT} символов — программа остановлена`);

  if (content?.kind === 'io') {
    const mode = content.compare?.mode ?? 'lines';
    const expectedLabel = mode === 'regex' ? 'шаблон' : mode === 'contains' ? 'должно встречаться' : 'ожидалось';
    lines.push(...valueLines(expectedLabel, content.expected, indent));
    if (!test.error && !test.limit) {
      lines.push(...valueLines('получилось', test.output, indent));
      const diff = test.diff;
      if (diff?.line && diff.kind === 'mismatch') {
        lines.push(
          `${indent}первое расхождение — строка ${diff.line}: ожидалось «${diff.expectedLine ?? ''}», получилось «${diff.actualLine ?? ''}»`,
        );
      }
    }
  } else if (content?.kind === 'call') {
    lines.push(`${indent}вызов: ${content.call}`);
    lines.push(`${indent}ожидалось: ${clipLine(content.expected)}`);
    if (test.actual !== undefined) {
      lines.push(`${indent}получилось: ${clipLine(test.actual)}${test.actualType ? ` (${test.actualType})` : ''}`);
    }
  } else if (content?.kind === 'assert') {
    if (!test.error && !test.limit) lines.push(`${indent}не выполнено: ${clipLine(content.message)}`);
  }
  return lines;
}

/** Почему код не прошёл проверку: синтаксис, правила, тесты. */
export function describeCheck(exercise: Exercise, check: CodeCheck): string[] {
  const { result } = check;
  if (result.compileError) return [`синтаксическая ошибка: ${describeError(result.compileError).replace(/^ошибка: /, '')}`];
  const lines: string[] = [];
  for (const failure of check.failures) {
    if (failure.testId === null) lines.push(`сбой проверки: ${lastLine(failure.message)}`);
  }
  for (const rule of result.rules) {
    if (!rule.passed) lines.push(`правило «${rule.id}» не выполнено: ${clipLine(rule.message)}`);
  }
  let skipped = 0;
  for (const [index, test] of result.tests.entries()) {
    if (test.passed) continue;
    if (test.interrupted === 'skipped') {
      skipped++;
      continue;
    }
    lines.push(...describeTest(exercise, check, test, index));
  }
  if (skipped > 0) lines.push(`после зависания не запускались тесты: ${skipped}`);
  return lines;
}

/** failedTests/failedRules для проблемы, а testId — если непройденный тест один. */
function failedFields(summary: CodeSummary): Pick<Problem, 'testId' | 'failedTests' | 'failedRules'> {
  return {
    ...(summary.failedTests.length === 1 && summary.failedTests[0] ? { testId: summary.failedTests[0] } : {}),
    failedTests: summary.failedTests,
    failedRules: summary.failedRules,
  };
}

// ------------------------------------------------------------------ проверки шагов

interface StepContext {
  py: PythonExecutor;
  lesson: Lesson;
  stepId: string;
  timeoutMs: number;
  problems: Problem[];
}

function report(ctx: StepContext, problem: Omit<Problem, 'lessonId' | 'stepId' | 'exerciseId'> & { exerciseId?: string | null }) {
  ctx.problems.push({ lessonId: ctx.lesson.id, stepId: ctx.stepId, exerciseId: null, ...problem });
}

export async function verifyExercise(ctx: StepContext, exercise: Exercise): Promise<{ report: ExerciseReport; checks: number }> {
  const exerciseReport: ExerciseReport = {
    id: exercise.id,
    stepId: ctx.stepId,
    skipped: false,
    invalidTests: [],
    solutionPassed: false,
    starterPassed: false,
    solution: null,
    starter: null,
    altSolutions: [],
    wrongSolutions: [],
  };
  const base = { exerciseId: exercise.id };

  if (!/\.py$/i.test(exercise.filename)) {
    exerciseReport.skipped = true;
    report(ctx, {
      ...base,
      severity: 'warning',
      subject: 'content',
      message: `файл ${exercise.filename} — не Python, задание не проверялось автоматически`,
      details: [],
    });
    return { report: exerciseReport, checks: 0 };
  }

  // Приложение даёт на тест exercise.timeLimitMs или 3 с; проверка — не меньше своего лимита,
  // чтобы отличить «медленно» от «зависло». Выход за лимит приложения — отдельная ошибка.
  const limitMs = Math.max(ctx.timeoutMs, exercise.timeLimitMs ?? 0);
  const appLimitMs = exercise.timeLimitMs ?? DEFAULT_TEST_LIMIT_MS;
  let checks = 0;

  // 0. Сами тесты: expected — литерал, call — выражение, код assert компилируется.
  const issues = await validateTests(ctx.py, exercise, limitMs);
  if (issues !== null) checks++;
  if (issues && issues.length > 0) {
    for (const issue of issues) {
      const { message, details } = describeTestIssue(exercise, issue);
      report(ctx, { ...base, severity: 'error', subject: 'content', testId: issue.id, message, details });
    }
    exerciseReport.invalidTests = [...new Set(issues.map((issue) => issue.id))];
    return { report: exerciseReport, checks };
  }

  // 1. Эталон проходит всё и укладывается в лимит приложения.
  const solutionCheck = await checkCode(ctx.py, exercise, exercise.solution.code, limitMs);
  checks++;
  const solution = summarizeCheck(solutionCheck, appLimitMs);
  exerciseReport.solution = solution;
  exerciseReport.solutionPassed = solution.passed;
  if (!solutionCheck.passed) {
    report(ctx, {
      ...base,
      ...failedFields(solution),
      severity: 'error',
      subject: 'solution',
      message: 'не проходит проверку',
      details: describeCheck(exercise, solutionCheck),
    });
  }
  for (const test of solutionCheck.result.tests) {
    if (test.interrupted) continue;
    const label = labelOf(exercise, test.id);
    if (test.durationMs >= appLimitMs) {
      report(ctx, {
        ...base,
        severity: 'error',
        subject: 'solution',
        testId: test.id,
        message: `не укладывается в лимит приложения: тест «${label}» занимает ${formatDuration(test.durationMs)}, а лимит — ${formatDuration(appLimitMs)}; у ученика проверка остановится по тайм-ауту`,
        details: ['ускорь эталон или задай заданию timeLimitMs побольше'],
      });
    } else if (solutionCheck.passed && test.durationMs > appLimitMs * SLOW_SHARE) {
      report(ctx, {
        ...base,
        severity: 'warning',
        subject: 'solution',
        testId: test.id,
        message: `эталон проходит тест «${label}» за ${formatDuration(test.durationMs)} — больше половины лимита приложения (${formatDuration(appLimitMs)}): на медленном устройстве может не уложиться`,
        details: [],
      });
    }
  }

  // 2. Стартовый код не проходит — и не ломает саму проверку.
  const starterCheck = await checkCode(ctx.py, exercise, exercise.starterCode, limitMs);
  checks++;
  const starter = summarizeCheck(starterCheck, appLimitMs);
  exerciseReport.starter = starter;
  exerciseReport.starterPassed = starter.passed;
  if (starterCheck.failures.length > 0) {
    report(ctx, {
      ...base,
      ...failedFields(starter),
      severity: 'error',
      subject: 'starter',
      message: 'проверка завершилась сбоем — ученик увидит «Python не смог выполнить проверку», а не проваленный тест',
      details: describeCheck(exercise, starterCheck),
    });
  } else if (starter.passed) {
    report(ctx, {
      ...base,
      severity: 'error',
      subject: 'starter',
      message: 'уже проходит все тесты и правила — ученику нечего делать в этом задании',
      details: ['добавь тест или правило, которое стартовый код не выполняет, или измени стартовый код'],
    });
  }

  // 3. Другие верные решения проходят всё, как эталон: тесты и правила принимают верный код, написанный иначе.
  for (const [index, alt] of (exercise.altSolutions ?? []).entries()) {
    const number = index + 1;
    const check = await checkCode(ctx.py, exercise, alt.code, limitMs);
    checks++;
    const summary = summarizeCheck(check, appLimitMs);
    exerciseReport.altSolutions.push({ ...summary, index: number, note: alt.note });
    if (summary.passed) continue;
    report(ctx, {
      ...base,
      ...failedFields(summary),
      severity: 'error',
      subject: 'alt',
      altIndex: number,
      message: 'верное решение не проходит проверку — ученик с таким кодом получит ложный отказ',
      details: [`чем оно отличается: ${alt.note}`, ...describeCheck(exercise, check)],
    });
  }

  // 4. Каждое неверное решение ловится тестом или правилом, и срабатывает ожидаемый разбор.
  const matched = new Set<string>();
  for (const [index, wrong] of exercise.wrongSolutions.entries()) {
    const number = index + 1;
    const check = await checkCode(ctx.py, exercise, wrong.code, limitMs);
    checks++;
    const summary = summarizeCheck(check, appLimitMs);
    const firstOverLimit = summary.overAppLimitTests[0] ?? null;
    // Как в приложении: при зависании, выходе за лимит или сбое Python разборы из материалов не показываются.
    const mistake =
      summary.passed || check.timedOut || firstOverLimit !== null || check.failures.length > 0
        ? null
        : matchMistake(exercise, wrong.code, check.result);
    if (mistake) matched.add(mistake.id);
    exerciseReport.wrongSolutions.push({
      ...summary,
      index: number,
      note: wrong.note,
      rejected: !summary.passed && check.failures.length === 0,
      expectMistake: wrong.expectMistake ?? null,
      matchedMistake: mistake?.id ?? null,
    });
    const wrongBase = { ...base, subject: 'wrong' as const, wrongIndex: number };
    const expected = wrong.expectMistake;
    const shownMistake = mistake ? `сработал разбор «${mistake.id}»` : 'не сработал ни один разбор из материалов';

    if (summary.passed) {
      report(ctx, {
        ...wrongBase,
        severity: 'error',
        message: 'проходит все тесты и правила — тесты не отличают его от верного',
        details: [`что в нём не так: ${wrong.note}`, 'добавь тест или правило, на котором это решение ошибётся'],
      });
      continue;
    }
    if (check.failures.length > 0) {
      report(ctx, {
        ...wrongBase,
        ...failedFields(summary),
        severity: 'error',
        message: `проверка завершилась сбоем — ученик увидит «Python не смог выполнить проверку», а не ${expected ? `разбор «${expected}»` : 'проваленный тест'}`,
        details: [`что в нём не так: ${wrong.note}`, ...describeCheck(exercise, check)],
      });
      continue;
    }
    if (expected === undefined && exercise.mistakes.length > 0) {
      // Без expectMistake не видно, какой разбор здесь правильный: ложный разбор прошёл бы незамеченным.
      report(ctx, {
        ...wrongBase,
        ...failedFields(summary),
        severity: 'error',
        message: `не указан expectMistake — ${shownMistake}`,
        details: [
          `что в нём не так: ${wrong.note}`,
          mistake
            ? `если этот разбор верен, укажи expectMistake: ${mistake.id}; если нет — поправь его условие when`
            : 'если общий разбор проверки здесь уместен, укажи expectMistake: null',
        ],
      });
      continue;
    }
    if (!expected) {
      if (!mistake) continue;
      checks++;
      report(ctx, {
        ...wrongBase,
        ...failedFields(summary),
        severity: 'error',
        message: `ожидался общий разбор проверки (expectMistake: null), а ${shownMistake}`,
        details: [`что в нём не так: ${wrong.note}`, ...describeCheck(exercise, check)],
      });
      continue;
    }
    checks++;
    if (check.timedOut) {
      const testId = check.timedOut.testId;
      report(ctx, {
        ...wrongBase,
        severity: 'error',
        testId,
        message: `зависает на тесте «${labelOf(exercise, testId)}»: ученик увидит сообщение о слишком долгой работе, а не разбор «${expected}»`,
        details: [`что в нём не так: ${wrong.note}`],
      });
      continue;
    }
    if (firstOverLimit !== null) {
      const duration = check.result.tests.find((test) => test.id === firstOverLimit)?.durationMs ?? appLimitMs;
      report(ctx, {
        ...wrongBase,
        severity: 'error',
        testId: firstOverLimit,
        message: `не укладывается в лимит приложения на тесте «${labelOf(exercise, firstOverLimit)}» (${formatDuration(duration)} при лимите ${formatDuration(appLimitMs)}): ученик увидит сообщение о слишком долгой работе, а не разбор «${expected}»`,
        details: [`что в нём не так: ${wrong.note}`],
      });
      continue;
    }
    if (mistake?.id !== expected) {
      report(ctx, {
        ...wrongBase,
        ...failedFields(summary),
        severity: 'error',
        message: mistake
          ? `ожидался разбор «${expected}», а сработал «${mistake.id}»`
          : `ожидался разбор «${expected}», а не сработал ни один разбор`,
        details: [`что в нём не так: ${wrong.note}`, ...describeCheck(exercise, check)],
      });
    }
  }

  // 5. Разбор, который не сработал ни на одном неверном решении, ничем не подтверждён.
  for (const mistake of exercise.mistakes) {
    if (matched.has(mistake.id)) continue;
    report(ctx, {
      ...base,
      severity: 'warning',
      subject: 'content',
      message: `разбор «${mistake.id}» не сработал ни на одном неверном решении — добавь пример в wrongSolutions`,
      details: [],
    });
  }

  return { report: exerciseReport, checks };
}

/** Типы ошибок, упомянутые в ответе: «Ошибка TypeError» → TypeError. */
function errorTypesIn(text: string): string[] {
  return [...text.matchAll(/\b([A-Z][A-Za-z]*(?:Error|Exception))\b/g)].map((match) => match[1] ?? '');
}

/** В ответе сказано, что программа не остановится: «бесконечный цикл», «зависнет». */
function mentionsEndlessRun(text: string): boolean {
  return /бесконечн|завис|не останов|не заверш|не законч/i.test(text) && !/не\s+завис/i.test(text);
}

/** То, что ученик видит в консоли: вывод вместе с приглашениями input() и введёнными строками. */
function consoleText(result: RunResult): string {
  return (result.transcript ?? [])
    .filter(([kind]) => kind !== 'err')
    .map(([, text]) => text)
    .join('');
}

export async function verifyPredict(ctx: StepContext, step: PredictStep): Promise<number> {
  const stdin = step.stdin ?? '';
  const inputLine = stdin ? [`ввод: ${inlineInput(stdin)}`] : [];
  const outcome = await ctx.py.run(step.code, stdin, ctx.timeoutMs, stepEnvironment(step));
  const fail = (message: string, details: string[] = [], severity: Severity = 'error') =>
    report(ctx, { severity, subject: 'predict', message, details: [...inputLine, ...details] });

  if (outcome.status === 'timeout') {
    if (!step.answerIsNotOutput) {
      fail(`программа не завершилась за ${formatSeconds(outcome.limitMs)}`, [
        'если ответ и есть «программа не остановится», отметь answerIsNotOutput: true',
      ]);
    } else if (!mentionsEndlessRun(step.answer)) {
      // Намеренный бесконечный цикл — законный вопрос; предупреждаем, только если ответ о другом.
      fail(
        `программа не завершилась за ${formatSeconds(outcome.limitMs)}, а в ответе об этом не сказано`,
        valueLines('ответ', step.answer, ''),
        'warning',
      );
    }
    return 1;
  }
  if (outcome.status === 'failed') {
    fail('Python не смог выполнить код', [lastLine(outcome.message)]);
    return 1;
  }
  const result = outcome.result;
  const error = result.compileError ?? result.error ?? null;
  const stdout = normalizeOutput(result.stdout ?? '');

  if (step.answerIsNotOutput) {
    // Ответ — не вывод; проверить можно только упомянутый в нём тип ошибки.
    const expectedTypes = errorTypesIn(step.answer);
    if (expectedTypes.length > 0 && (!error || !expectedTypes.includes(error.type))) {
      fail(
        `в ответе упомянута ошибка ${expectedTypes.join(' / ')}, а программа ${error ? `завершается ошибкой ${error.type}` : 'работает без ошибок'}`,
        [...valueLines('ответ', step.answer, ''), ...valueLines('вывод программы', stdout, '')],
        'warning',
      );
    }
    return 1;
  }

  const expected = normalizeOutput(step.answer);
  const matches = expected === stdout || expected === normalizeOutput(consoleText(result));
  if (result.compileError) {
    fail(`в коде синтаксическая ошибка — ${describeError(result.compileError).replace(/^ошибка: /, '')}`, [
      'если ответ и есть «ошибка», отметь answerIsNotOutput: true',
    ]);
  } else if (result.error) {
    // Совпавший вывод до ошибки — обычный учебный приём («что успеет появиться до ошибки?»).
    if (!matches) {
      fail(`программа завершается ошибкой, а ответ записан как её вывод`, [
        describeError(result.error),
        ...valueLines('ответ', step.answer, ''),
        ...valueLines('вывод до ошибки', stdout, ''),
        'если ответ и есть «ошибка», отметь answerIsNotOutput: true',
      ]);
    }
  } else if (result.limit) {
    fail(`вывод превысил ${DEFAULT_OUTPUT_LIMIT} символов — программа остановлена`);
  } else if (!matches) {
    fail('ответ не совпадает с тем, что выводит программа', [
      ...valueLines('ответ', step.answer, ''),
      ...valueLines('вывод программы', stdout, ''),
    ]);
  }
  return 1;
}

function codeLineCount(code: string): number {
  return code.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n').length;
}

export async function verifyExample(ctx: StepContext, step: ExampleStep): Promise<number> {
  const lineCount = codeLineCount(step.code);
  for (const note of step.notes) {
    if (note.line > lineCount) {
      report(ctx, {
        severity: 'error',
        subject: 'content',
        message: `пояснение к строке ${note.line}, а в коде примера строк: ${lineCount}`,
        details: [clipLine(note.text)],
      });
    }
  }

  const stdin = step.stdin ?? '';
  const outcome = await ctx.py.run(step.code, stdin, ctx.timeoutMs, stepEnvironment(step));
  const fail = (message: string, details: string[] = []) =>
    report(ctx, {
      severity: 'error',
      subject: 'example',
      message,
      details: [...(stdin ? [`ввод: ${inlineInput(stdin)}`] : []), ...details],
    });

  if (outcome.status === 'timeout') fail(`код примера не завершился за ${formatSeconds(outcome.limitMs)}`);
  else if (outcome.status === 'failed') fail('Python не смог выполнить код примера', [lastLine(outcome.message)]);
  else if (outcome.result.compileError) fail('в коде примера синтаксическая ошибка', [describeError(outcome.result.compileError)]);
  else if (outcome.result.error) {
    const hint = outcome.result.error.type === 'EOFError' ? ['программа ждёт ввод — добавь в шаг stdin'] : [];
    fail('код примера завершается ошибкой', [describeError(outcome.result.error), ...hint]);
  } else if (outcome.result.limit) fail(`вывод примера превысил ${DEFAULT_OUTPUT_LIMIT} символов`);
  return 1;
}

export async function verifyLesson(py: PythonExecutor, lesson: Lesson, timeoutMs: number): Promise<LessonReport> {
  const started = performance.now();
  const problems: Problem[] = [];
  const exercises: ExerciseReport[] = [];
  let checks = 0;
  for (const step of lesson.steps) {
    const ctx: StepContext = { py, lesson, stepId: step.id, timeoutMs, problems };
    if (step.type === 'exercise') {
      const result = await verifyExercise(ctx, step.exercise);
      exercises.push(result.report);
      checks += result.checks;
    } else if (step.type === 'predict') {
      checks += await verifyPredict(ctx, step);
    } else if (step.type === 'example') {
      checks += await verifyExample(ctx, step);
    }
  }
  return {
    id: lesson.id,
    module: lesson.module,
    title: lesson.title,
    checks,
    errors: problems.filter((problem) => problem.severity === 'error').length,
    warnings: problems.filter((problem) => problem.severity === 'warning').length,
    exercises,
    problems,
    contentWarnings: [],
    durationMs: Math.round(performance.now() - started),
  };
}

// ------------------------------------------------------------------ весь курс

/** Уроки в порядке плана курса; ids — уроки или модули. */
export function selectLessons(content: LoadedContent, ids: string[]): { lessons: Lesson[]; missing: string[] } {
  const order = new Map<string, number>();
  for (const module of content.source.modules) {
    for (const planned of module.lessons) order.set(planned.id, order.size);
  }
  const sorted = [...content.lessons].sort(
    (a, b) => (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER),
  );
  if (ids.length === 0) return { lessons: sorted, missing: [] };

  const wanted = new Set(ids);
  const lessons = sorted.filter((lesson) => wanted.has(lesson.id) || wanted.has(lesson.module));
  const missing: string[] = [];
  const moduleIds = new Set(content.source.modules.map((module) => module.id));
  for (const id of ids) {
    if (content.lessons.some((lesson) => lesson.id === id || lesson.module === id)) continue;
    if (order.has(id)) missing.push(`урок ${id} есть в плане, но файла с ним пока нет`);
    else if (moduleIds.has(id)) missing.push(`в модуле ${id} пока нет готовых уроков`);
    else missing.push(`не найден урок или модуль «${id}»`);
  }
  return { lessons, missing };
}

export interface VerifyOptions {
  root: string;
  /** id уроков или модулей; пусто — все готовые уроки. */
  only?: string[];
  timeoutMs?: number;
  /** Своя реализация Python (для тестов); закрывает её тот, кто создал. По умолчанию — Pyodide в отдельном процессе. */
  python?: PythonExecutor;
  onStart?: (info: { python: PythonInfo | null; lessons: Lesson[] }) => void;
  onLesson?: (lesson: LessonReport) => void;
}

/** Понятная причина, если в папке нет материалов; null — всё на месте. */
function missingRoot(root: string): string | null {
  if (!existsSync(root) || !statSync(root).isDirectory()) return `Папка ${root} не найдена — проверь --root.`;
  if (!existsSync(path.join(root, 'content', 'course.yaml'))) {
    return `В папке ${root} нет content/course.yaml — проверь --root (нужна папка, внутри которой лежит content/).`;
  }
  return null;
}

export async function verifyContent(options: VerifyOptions): Promise<VerifyReport> {
  const started = performance.now();
  const only = options.only ?? [];
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const result: VerifyReport = {
    ok: false,
    root: options.root,
    only,
    missing: [],
    timeoutMs,
    python: null,
    lessons: [],
    totals: { lessons: 0, failedLessons: 0, exercises: 0, checks: 0, errors: 0, warnings: 0, pythonRestarts: 0 },
    fatal: null,
    durationMs: 0,
  };
  const finish = (): VerifyReport => {
    const lessons = result.lessons;
    result.totals = {
      ...result.totals,
      lessons: lessons.length,
      failedLessons: lessons.filter((lesson) => lesson.errors > 0).length,
      exercises: lessons.reduce((sum, lesson) => sum + lesson.exercises.length, 0),
      checks: lessons.reduce((sum, lesson) => sum + lesson.checks, 0),
      errors: lessons.reduce((sum, lesson) => sum + lesson.errors, 0),
      warnings: lessons.reduce((sum, lesson) => sum + lesson.warnings, 0),
    };
    result.ok = result.fatal === null && result.missing.length === 0 && result.totals.errors === 0;
    result.durationMs = Math.round(performance.now() - started);
    return result;
  };

  result.fatal = missingRoot(options.root);
  if (result.fatal) return finish();

  let content: LoadedContent;
  try {
    content = await loadContent(options.root);
  } catch (error) {
    result.fatal =
      error instanceof ContentError ? error.message : `Не удалось прочитать материалы из ${options.root}: ${messageOf(error)}`;
    return finish();
  }

  const { lessons, missing } = selectLessons(content, only);
  result.missing = missing;
  if (lessons.length === 0 && missing.length > 0) {
    result.fatal = `Нечего проверять: ${missing.join('; ')}.`;
    return finish();
  }

  const own = options.python ? null : new NodePython();
  const py: PythonExecutor = options.python ?? (own as NodePython);
  try {
    if (py.start && lessons.length > 0) {
      try {
        result.python = await py.start();
      } catch (error) {
        result.fatal = messageOf(error);
        return finish();
      }
    }
    options.onStart?.({ python: result.python, lessons });
    for (const lesson of lessons) {
      const lessonReport = await verifyLesson(py, lesson, timeoutMs);
      lessonReport.contentWarnings = content.warnings.filter(
        (warning) => warning.startsWith(`Урок ${lesson.id}:`) || warning.startsWith(`Урок ${lesson.id},`),
      );
      result.lessons.push(lessonReport);
      options.onLesson?.(lessonReport);
      if (py.failure) {
        result.fatal = `Проверка прервана: ${py.failure}`;
        break;
      }
    }
  } finally {
    result.totals.pythonRestarts = py.restarts ?? 0;
    if (own) await own.close();
  }
  return finish();
}

// ------------------------------------------------------------------ текстовый отчёт

function problemPlace(problem: Problem): string {
  switch (problem.subject) {
    case 'solution':
      return `задание ${problem.exerciseId}, эталонное решение`;
    case 'starter':
      return `задание ${problem.exerciseId}, стартовый код`;
    case 'alt':
      return `задание ${problem.exerciseId}, другое верное решение №${problem.altIndex}`;
    case 'wrong':
      return `задание ${problem.exerciseId}, неверное решение №${problem.wrongIndex}`;
    case 'predict':
      return `шаг ${problem.stepId} (predict)`;
    case 'example':
      return `шаг ${problem.stepId} (example)`;
    case 'content':
      return problem.exerciseId ? `задание ${problem.exerciseId}` : `шаг ${problem.stepId}`;
  }
}

export function formatHeader(report: Pick<VerifyReport, 'root' | 'timeoutMs'>, python: PythonInfo | null, lessonCount: number): string[] {
  const lines = [`Проверка материалов: ${report.root}`];
  if (python) {
    lines.push(
      `Python ${python.pythonVersion} (Pyodide ${python.pyodideVersion}), уроков: ${lessonCount}, лимит на тест: ${formatSeconds(report.timeoutMs)}`,
    );
  }
  lines.push('');
  return lines;
}

/** Какой разбор увидит ученик с каждым неверным решением задания: «№1 short-receipt, №2 общий разбор». */
function mistakesLine(exercise: ExerciseReport): string | null {
  if (exercise.wrongSolutions.length === 0) return null;
  const shown = exercise.wrongSolutions.map((wrong) => {
    const what = wrong.passed
      ? 'проходит проверку'
      : wrong.checkFailures.length > 0
        ? 'сбой проверки'
        : wrong.timedOutTest || wrong.overAppLimitTests.length > 0
          ? 'слишком долго'
          : (wrong.matchedMistake ?? 'общий разбор');
    return `№${wrong.index} ${what}`;
  });
  return `  · ${exercise.id}, разборы неверных решений: ${shown.join(', ')}`;
}

export function formatLesson(lesson: LessonReport): string[] {
  const summary = `заданий: ${lesson.exercises.length}, проверок: ${lesson.checks}, время: ${formatDuration(lesson.durationMs)}`;
  const counts = [
    lesson.errors > 0 ? `ошибок: ${lesson.errors}` : null,
    lesson.warnings > 0 ? `предупреждений: ${lesson.warnings}` : null,
  ].filter(Boolean);
  const mark = lesson.errors > 0 ? '✗' : lesson.warnings > 0 ? '!' : '✓';
  const lines = [`${mark} ${lesson.id} «${lesson.title}» — ${counts.length > 0 ? `${counts.join(', ')}; ` : ''}${summary}`];
  const ordered = [...lesson.problems].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
  for (const problem of ordered) {
    lines.push(`  ${problem.severity === 'error' ? '✗' : '!'} ${problemPlace(problem)}: ${problem.message}`);
    for (const detail of problem.details) lines.push(`      ${detail}`);
  }
  for (const warning of lesson.contentWarnings) lines.push(`  · оформление: ${warning}`);
  for (const exercise of lesson.exercises) {
    const line = mistakesLine(exercise);
    if (line) lines.push(line);
  }
  return lines;
}

export function formatSummary(report: VerifyReport): string[] {
  const lines: string[] = [];
  if (report.fatal) {
    lines.push(report.fatal);
    return lines;
  }
  if (report.lessons.length === 0) {
    lines.push('Готовых уроков пока нет — проверять нечего.');
    return lines;
  }
  const t = report.totals;
  lines.push('');
  lines.push(
    `Итог: уроков ${t.lessons} (с ошибками: ${t.failedLessons}), заданий ${t.exercises}, проверок ${t.checks}. Ошибок: ${t.errors}, предупреждений: ${t.warnings}.`,
  );
  if (report.missing.length > 0) lines.push(`Не найдено: ${report.missing.join('; ')}.`);
  lines.push(`Время: ${formatDuration(report.durationMs)}. Перезапусков Python (после зависаний и сбоев): ${t.pythonRestarts}.`);
  if (report.ok) lines.push('Материалы прошли проверку.');
  else if (t.errors > 0) lines.push('Есть ошибки — исправь материалы и запусти проверку снова.');
  else lines.push('Найденные уроки в порядке, но проверены не все запрошенные — проверь id.');
  return lines;
}

export function formatReport(report: VerifyReport): string {
  const lines = report.fatal && report.lessons.length === 0 ? [] : formatHeader(report, report.python, report.lessons.length);
  for (const lesson of report.lessons) lines.push(...formatLesson(lesson));
  lines.push(...formatSummary(report));
  return lines.join('\n');
}

// ------------------------------------------------------------------ командная строка

export const USAGE = `Проверка учебных материалов запуском настоящего Python.

Запуск:
  npm run verify:content -- [id урока или модуля ...] [--root <папка>] [--json] [--timeout <мс>]
  node scripts/verify-content.ts [id ...] [параметры]

  id ...          проверить только эти уроки или модули (по умолчанию — все готовые уроки)
  --root <папка>  папка, в которой лежит content/ (по умолчанию — корень проекта)
  --json          результат в формате JSON
  --timeout <мс>  лимит на один тест и на запуск примера, по умолчанию ${DEFAULT_TIMEOUT_MS}
  -h, --help      эта справка

Через npm параметры пишут после «--», иначе npm заберёт их себе.

Код из материалов выполняется на этом компьютере. Python работает в отдельном процессе Node
с ограниченными правами (без записи файлов и запуска программ), но это не полная песочница:
проверяй только материалы, которым доверяешь.

Код выхода: 0 — ошибок нет, 1 — найдены ошибки, 2 — неверные аргументы.`;

export class UsageError extends Error {}

export interface CliOptions {
  only: string[];
  root: string;
  json: boolean;
  timeoutMs: number;
  help: boolean;
}

type Env = Record<string, string | undefined>;

function placeholderOf(flag: string): string {
  if (flag === '--root') return '--root <папка>';
  if (flag === '--timeout') return '--timeout <мс>';
  return flag;
}

/**
 * Разбирает аргументы. env нужен для запуска через npm: без «--» npm забирает --root, --json
 * и --timeout себе и оставляет от них только переменные npm_config_*.
 */
export function parseCli(argv: string[], cwd = process.cwd(), defaultRoot = PROJECT_ROOT, env: Env = {}): CliOptions {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        root: { type: 'string' },
        json: { type: 'boolean' },
        timeout: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    throw new UsageError(messageOf(error));
  }
  const { values, positionals } = parsed;
  let root = values.root;
  let timeout = values.timeout;
  let base = cwd;

  if (env.npm_lifecycle_event === 'verify:content') {
    // npm запускает скрипт из корня пакета; пути пользователь пишет относительно своей папки.
    if (env.INIT_CWD) base = env.INIT_CWD;
    const eaten: string[] = [];
    // «--root=папка» npm тоже забирает, но значение сохраняется; «--root папка» — только true.
    const npmRoot = env.npm_config_root;
    if (root === undefined && npmRoot !== undefined) {
      if (npmRoot === 'true' || npmRoot === '') eaten.push('--root');
      else root = npmRoot;
    }
    const npmTimeout = env.npm_config_timeout;
    if (timeout === undefined && npmTimeout !== undefined) {
      if (/^\d+$/.test(npmTimeout)) timeout = npmTimeout;
      else eaten.push('--timeout');
    }
    // Свой --json npm при ошибке допечатает в stdout свой JSON — такой вывод не разобрать.
    if (!values.json && env.npm_config_json === 'true') eaten.push('--json');
    if (eaten.length > 0) {
      throw new UsageError(
        `npm забрал себе ${eaten.join(', ')} — до проверки ${eaten.length > 1 ? 'они не дошли' : 'он не дошёл'}. ` +
          `Параметры для проверки пишут после «--»: npm run verify:content -- ${eaten.map(placeholderOf).join(' ')}`,
      );
    }
  }

  for (const id of positionals) {
    if (/[\\/]/.test(id)) {
      throw new UsageError(
        `«${id}» похоже на путь к папке, а не на id урока или модуля. Папку с материалами указывают через --root: ` +
          `node scripts/verify-content.ts --root ${id} (через npm: npm run verify:content -- --root ${id})`,
      );
    }
  }

  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (timeout !== undefined) {
    timeoutMs = Number(timeout);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100) {
      throw new UsageError(`--timeout: нужно целое число миллисекунд не меньше 100, а получено «${timeout}»`);
    }
  }
  return {
    only: positionals,
    root: root ? path.resolve(base, root) : defaultRoot,
    json: values.json ?? false,
    timeoutMs,
    help: values.help ?? false,
  };
}

export async function main(argv: string[], env: Env = process.env): Promise<number> {
  let cli: CliOptions;
  try {
    cli = parseCli(argv, process.cwd(), PROJECT_ROOT, env);
  } catch (error) {
    console.error(messageOf(error));
    console.error('');
    console.error(USAGE);
    return 2;
  }
  if (cli.help) {
    console.log(USAGE);
    return 0;
  }

  const text = !cli.json;
  const verifyReport = await verifyContent({
    root: cli.root,
    only: cli.only,
    timeoutMs: cli.timeoutMs,
    onStart: text
      ? ({ python, lessons }) => {
          for (const line of formatHeader({ root: cli.root, timeoutMs: cli.timeoutMs }, python, lessons.length)) console.log(line);
        }
      : undefined,
    onLesson: text
      ? (lesson) => {
          for (const line of formatLesson(lesson)) console.log(line);
        }
      : undefined,
  });

  if (cli.json) {
    process.stdout.write(`${JSON.stringify(verifyReport, null, 2)}\n`);
  } else {
    const summary = formatSummary(verifyReport);
    if (verifyReport.fatal) console.error(summary.join('\n'));
    else console.log(summary.join('\n'));
  }
  return verifyReport.ok ? 0 : 1;
}

function samePath(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

// Запуск из командной строки; при импорте (например, в тестах) ничего не выполняется.
const invokedDirectly = process.argv[1] !== undefined && samePath(process.argv[1], fileURLToPath(import.meta.url));
if (invokedDirectly) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(`Проверка остановилась из-за внутренней ошибки: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    process.exitCode = 1;
  }
}
