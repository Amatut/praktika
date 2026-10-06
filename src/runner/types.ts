// Типы данных, которыми обмениваются интерфейс, Web Worker и Python-обвязка (harness.py).

export type TranscriptKind = 'out' | 'err' | 'prompt' | 'input';
export type TranscriptPart = [TranscriptKind, string];

export interface PyError {
  phase: 'compile' | 'runtime';
  /** program — ошибка в коде ученика; check — в выражении проверки (например, нет нужной функции). */
  origin?: 'program' | 'check';
  type: string;
  message: string;
  line: number | null;
  col: number | null;
  endCol: number | null;
  lineText: string | null;
  /** Последняя строка сообщения Python, например «NameError: name 'x' is not defined». */
  summary: string;
  /** Исходное сообщение Python целиком. */
  raw: string;
}

export interface OutputDiff {
  kind: 'empty' | 'mismatch' | 'missing' | 'extra' | 'pattern';
  line: number | null;
  expectedLine: string | null;
  actualLine: string | null;
  count?: number;
  hint?: 'case' | 'spaces' | 'quotes' | 'number-format' | 'number' | 'cut' | 'extra-text' | null;
  /**
   * Для подсказок number и number-format: различающиеся числа. Если строка — число с подписью
   * («Итого: 269.7»), здесь только сами числа («269.7» и «269»).
   */
  expectedNumber?: string;
  actualNumber?: string;
}

/** Ответ учебной симуляции сети (поле http в материалах, см. src/content/schema.ts). */
export interface HttpMock {
  url: string;
  method?: 'GET' | 'POST';
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
  error?: 'timeout' | 'connection';
}

/**
 * Окружение запуска: каждый запуск идёт в новой пустой рабочей папке, куда записываются учебные
 * файлы и базы SQLite, а код ученика сохраняется под именем filename (по умолчанию main.py).
 */
export interface RunEnvironment {
  filename?: string;
  files?: Record<string, string>;
  databases?: Record<string, string>;
  seed?: number;
  http?: HttpMock[];
}

/** Файл рабочей папки, который программа создала или изменила («Файлы после запуска»). */
export interface RunFile {
  /** Путь относительно рабочей папки, через «/». */
  path: string;
  status: 'created' | 'modified';
  /** Размер в байтах. */
  size: number;
  /** Начало текста (до 4000 символов); null — двоичный файл (например, база SQLite). */
  text: string | null;
  /** Текст показан не целиком. */
  truncated: boolean;
}

export interface ExecutionOutcome {
  error: PyError | null;
  /** Вывод превысил лимит — программа остановлена. */
  limit: boolean;
  exitCode: number | string | null;
  durationMs: number;
  transcript: TranscriptPart[];
  stdout: string;
  truncated: boolean;
  /** Созданные и изменённые программой файлы (не больше 20). */
  files: RunFile[];
}

export interface RunResult extends Partial<ExecutionOutcome> {
  compileError?: PyError;
}

export interface TestResult {
  id: string;
  kind: 'io' | 'call' | 'assert';
  passed: boolean;
  stdin: string;
  expected?: string;
  call?: string;
  actual?: string;
  actualType?: string;
  expectedType?: string;
  message?: string;
  diff?: OutputDiff | null;
  output: string;
  transcript: TranscriptPart[];
  error: PyError | null;
  limit: boolean;
  truncated: boolean;
  exitCode: number | string | null;
  durationMs: number;
  /** Созданные и изменённые программой файлы; у прерванного теста их нет. */
  files?: RunFile[];
  /** Заполняется на стороне интерфейса: тест не завершился вовремя или был остановлен. */
  interrupted?: 'timeout' | 'stopped' | 'skipped';
}

export interface RuleResult {
  id: string;
  passed: boolean;
  message: string;
}

export interface CheckResult {
  compileError: PyError | null;
  rules: RuleResult[];
  tests: TestResult[];
}

/**
 * Проверка: код, тесты, правила и окружение задания. У тестов могут быть свои files, databases,
 * seed и http — harness.py дополняет ими окружение задания.
 */
export interface CheckPayload extends RunEnvironment {
  code: string;
  tests: unknown[];
  rules: unknown[];
  limit?: number;
}

/** Сообщения от worker к интерфейсу. */
export type WorkerMessage =
  | { type: 'status'; phase: 'loading' }
  | { type: 'ready'; pyodideVersion: string; pythonVersion: string }
  | { type: 'init-error'; message: string }
  | { type: 'test-start'; id: number; index: number }
  | { type: 'run-result'; id: number; result: RunResult }
  | { type: 'check-result'; id: number; result: CheckResult }
  | { type: 'failure'; id: number; message: string; fatal: boolean };

/** Сообщения от интерфейса к worker. */
export type WorkerRequest =
  | { type: 'run'; id: number; code: string; stdin: string; limit: number; environment?: RunEnvironment }
  | { type: 'check'; id: number; payload: string };
