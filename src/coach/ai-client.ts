// Клиент серверного адаптера наставника (режим «ИИ»).
// Ключа API здесь нет: приложение обращается только к своему адаптеру (server/coach-server.ts),
// а ключ провайдера хранится в переменных окружения на стороне адаптера.
// Запросы отправляются только по явному действию ученика — автоповторов здесь нет.

import type { CheckResult, OutputDiff, TestResult } from '../runner/types.ts';

// ------------------------------------------------------------------ формат

export type CoachAction = 'hint' | 'explain-error' | 'simpler' | 'detailed' | 'short' | 'question' | 'review';

export const COACH_ACTIONS: readonly CoachAction[] = [
  'hint',
  'explain-error',
  'simpler',
  'detailed',
  'short',
  'question',
  'review',
];

/** Названия действий для интерфейса. */
export const COACH_ACTION_LABELS: Record<CoachAction, string> = {
  hint: 'Подсказка',
  'explain-error': 'Разбери ошибку',
  simpler: 'Проще',
  detailed: 'Подробнее',
  short: 'Коротко',
  question: 'Вопрос',
  review: 'Проверь решение',
};

/** Лимиты запроса — те же, что проверяет адаптер (server/coach-server.ts, REQUEST_LIMITS). */
export const COACH_REQUEST_LIMITS = {
  bodyBytes: 24 * 1024,
  id: 100,
  title: 200,
  objective: 1000,
  kind: 40,
  statement: 4000,
  code: 8000,
  check: 4000,
  skills: 1500,
  question: 1000,
  historyItems: 8,
  historyText: 1500,
} as const;

/**
 * Сколько адаптер ждёт ответа ИИ: по умолчанию и максимум (COACH_TIMEOUT_MS на сервере, до 30 с).
 */
export const COACH_TIMEOUT_MS = 30_000;

/** Запас на сеть и ответ адаптера: приложение ждёт дольше адаптера, чтобы получить его понятный ответ 504. */
export const COACH_RESPONSE_MARGIN_MS = 5_000;

/** Сколько приложение ждёт ответа наставника по умолчанию. */
export const COACH_WAIT_MS = COACH_TIMEOUT_MS + COACH_RESPONSE_MARGIN_MS;

export interface CoachRequestOptions {
  /** Сколько ждать ответа адаптера, мс (1 000–180 000). По умолчанию COACH_WAIT_MS. */
  timeoutMs?: number;
}

export interface CoachHistoryItem {
  role: 'student' | 'coach';
  text: string;
}

/** Тело запроса POST /coach. */
export interface CoachRequest {
  action: CoachAction;
  lesson: { id: string; title: string; objective: string };
  exercise?: { id: string; title: string; kind: string; statement: string };
  code?: string;
  /** Краткая сводка реальных результатов тестов. */
  check?: string;
  hintsUsed: number;
  skills?: string;
  question?: string;
  history?: CoachHistoryItem[];
}

export interface CoachReply {
  text: string;
  model: string;
  usage: { input: number; output: number };
  /** Ответ обрезан по лимиту длины на сервере. */
  truncated: boolean;
}

export interface CoachLimits {
  perWindow: number;
  windowMinutes: number;
  daily: number;
  remainingWindow: number;
  remainingDaily: number;
  maxTokens: number;
  timeoutMs: number;
  maxBodyBytes: number;
}

export interface CoachHealth {
  ok: boolean;
  provider: string;
  model: string;
  /** false — адаптер запущен, но ключа API нет («ИИ не настроен»). */
  configured: boolean;
  mode: 'local' | 'remote';
  limits: CoachLimits | null;
}

// ------------------------------------------------------------------ ошибки

export type CoachErrorKind =
  | 'network' // нет сети
  | 'unavailable' // сервер наставника не запущен или недоступен
  | 'limit' // лимит запросов
  | 'server' // ошибка сервера наставника или провайдера
  | 'not-configured' // ИИ не настроен (нет ключа на сервере)
  | 'access' // неверный токен или адрес приложения не разрешён
  | 'timeout' // не ответил вовремя
  | 'aborted' // запрос отменён
  | 'endpoint'; // адрес адаптера указан неверно

interface CoachErrorOptions {
  status?: number | null;
  code?: string | null;
  retryAfterSec?: number | null;
}

export class CoachError extends Error {
  readonly kind: CoachErrorKind;
  /** HTTP-статус ответа адаптера, если ответ был. */
  readonly status: number | null;
  /** Код ошибки от адаптера: rate-limit, daily-limit, token, origin… */
  readonly code: string | null;
  /** Через сколько секунд можно попробовать снова. */
  readonly retryAfterSec: number | null;

  constructor(kind: CoachErrorKind, message: string, options: CoachErrorOptions = {}) {
    super(message);
    this.name = 'CoachError';
    this.kind = kind;
    this.status = options.status ?? null;
    this.code = options.code ?? null;
    this.retryAfterSec = options.retryAfterSec ?? null;
  }
}

export class CoachNetworkError extends CoachError {
  constructor(message = 'Нет подключения к интернету. Подсказки курса работают и без сети — вопрос можно отправить позже.') {
    super('network', message);
    this.name = 'CoachNetworkError';
  }
}

export class CoachUnavailableError extends CoachError {
  constructor(message = 'Сервер наставника не запущен или недоступен. Проверь адрес в настройках.') {
    super('unavailable', message);
    this.name = 'CoachUnavailableError';
  }
}

export class CoachLimitError extends CoachError {
  constructor(
    message = 'Лимит запросов к ИИ исчерпан. Подсказки курса работают без ограничений.',
    options: CoachErrorOptions = {},
  ) {
    super('limit', message, { status: 429, ...options });
    this.name = 'CoachLimitError';
  }
}

export class CoachServerError extends CoachError {
  constructor(message = 'Ошибка на сервере наставника. Попробуй позже.', options: CoachErrorOptions = {}) {
    super('server', message, options);
    this.name = 'CoachServerError';
  }
}

export class CoachNotConfiguredError extends CoachError {
  constructor(message = 'ИИ не настроен: на сервере наставника нет ключа API. Пока работают подсказки курса.') {
    super('not-configured', message, { status: 503, code: 'not-configured' });
    this.name = 'CoachNotConfiguredError';
  }
}

export class CoachAccessError extends CoachError {
  constructor(
    message = 'Сервер наставника отклонил запрос: проверь токен доступа в настройках.',
    options: CoachErrorOptions = {},
  ) {
    super('access', message, options);
    this.name = 'CoachAccessError';
  }
}

export class CoachTimeoutError extends CoachError {
  constructor(message = 'Наставник не ответил вовремя. Попробуй ещё раз чуть позже.', options: CoachErrorOptions = {}) {
    super('timeout', message, options);
    this.name = 'CoachTimeoutError';
  }
}

export class CoachAbortedError extends CoachError {
  constructor() {
    super('aborted', 'Запрос отменён.');
    this.name = 'CoachAbortedError';
  }
}

export class CoachEndpointError extends CoachError {
  constructor(message = 'Адрес сервера наставника указан неверно. Пример: http://127.0.0.1:8787') {
    super('endpoint', message);
    this.name = 'CoachEndpointError';
  }
}

/** Понятный текст для любой ошибки обращения к наставнику. */
export function describeCoachError(error: unknown): string {
  if (error instanceof CoachError) return error.message;
  return 'Не получилось обратиться к наставнику. Подсказки курса работают как обычно.';
}

// ------------------------------------------------------------------ обрезка текста

/**
 * Начало строки длиной не больше length (в единицах UTF-16) без разрезанной пополам
 * суррогатной пары: одиночную половинку эмодзи API провайдера не принимает (ошибка 400).
 */
function head(text: string, length: number): string {
  let cut = text.slice(0, Math.max(0, length));
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
}

function clip(text: string, max: number, marker = '…'): string {
  if (text.length <= max) return text;
  return head(text, max - marker.length) + marker;
}

function clipCode(code: string, max: number): string {
  if (code.length <= max) return code;
  const total = code.length;
  const marker = `\n# … код обрезан: показано начало, всего ${total} ${plural(total, 'символ', 'символа', 'символов')}`;
  return head(code, max - marker.length) + marker;
}

/** Склонение по числу: 1 символ, 2 символа, 5 символов. */
function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/** Родительный падеж после «из», «за»: из 1 теста, из 3 тестов, из 21 теста. */
function genitive(n: number, singular: string, pluralForm: string): string {
  return n % 10 === 1 && n % 100 !== 11 ? singular : pluralForm;
}

/** Показывает значение в кавычках, с видимыми \n и пробелами по краям. */
function shown(value: string, max = 300): string {
  return JSON.stringify(clip(value, max));
}

// ------------------------------------------------------------------ сводка результатов проверки

/**
 * Что приложение знает о тесте из материалов урока. Совместимо с тестами задания
 * (Exercise['tests'] из src/content/schema.ts) — их можно передать как есть.
 */
export interface CoachTestInfo {
  id: string;
  /** Название, которое видит ученик: «Пример 1», «Граничный случай: ноль». */
  title?: string;
  /** Для проверок по шаблону: как описать ожидаемое человеку. */
  expectedLabel?: string;
  compare?: {
    mode?: 'lines' | 'regex' | 'contains';
    ignoreCase?: boolean;
    ignoreSpaces?: boolean;
    ignoreBlankLines?: boolean;
  };
}

export interface SummarizeOptions {
  /** Тесты задания: названия для ученика и режим сравнения вывода. */
  tests?: readonly CoachTestInfo[] | null;
  /** Предел длины сводки. По умолчанию — лимит адаптера (4000 символов). */
  maxLength?: number;
}

type CompareMode = 'lines' | 'regex' | 'contains';

const DIFF_HINTS: Record<NonNullable<OutputDiff['hint']>, string> = {
  case: 'отличается регистр букв',
  spaces: 'отличаются пробелы',
  quotes: 'отличаются кавычки',
  'number-format': 'отличается запись числа',
  number: 'другое число',
  cut: 'строка оборвана',
  'extra-text': 'лишний текст в строке',
};

/**
 * Режим сравнения вывода. Если данных теста нет, его видно по отличию из harness.py:
 * pattern — шаблон, missing без номера строки — проверка «вывод содержит».
 */
function compareModeOf(test: TestResult, info: CoachTestInfo | undefined): CompareMode {
  if (info) return info.compare?.mode ?? 'lines';
  if (test.diff?.kind === 'pattern') return 'regex';
  if (test.diff?.kind === 'missing' && test.diff.line === null) return 'contains';
  return 'lines';
}

function describeDiff(diff: OutputDiff, mode: CompareMode): string | null {
  switch (diff.kind) {
    case 'empty':
      return 'программа ничего не вывела';
    case 'missing':
      if (mode === 'contains' || diff.line === null) {
        return diff.expectedLine !== null
          ? `в выводе нет нужного фрагмента: ${shown(diff.expectedLine, 150)}`
          : 'в выводе нет нужного фрагмента';
      }
      return (
        `не хватает строк вывода${diff.count ? `: ${diff.count}` : ''}` +
        (diff.expectedLine !== null ? `, первая недостающая: ${shown(diff.expectedLine, 150)}` : '')
      );
    case 'extra':
      return (
        `лишние строки вывода${diff.count ? `: ${diff.count}` : ''}` +
        (diff.actualLine !== null ? `, первая лишняя: ${shown(diff.actualLine, 150)}` : '')
      );
    case 'pattern':
      return 'вывод не подходит под шаблон';
    case 'mismatch': {
      const parts: string[] = [];
      parts.push(diff.line !== null ? `первое отличие в строке вывода ${diff.line}` : 'первое отличие');
      if (diff.expectedLine !== null) parts.push(`ожидалось ${shown(diff.expectedLine, 150)}`);
      if (diff.actualLine !== null) parts.push(`получилось ${shown(diff.actualLine, 150)}`);
      if (diff.hint) parts.push(DIFF_HINTS[diff.hint]);
      return parts.join(', ');
    }
    default:
      return null;
  }
}

/** Строки «ожидалось» для теста на вывод с учётом режима сравнения. */
function describeExpectedOutput(expected: string, mode: CompareMode, info: CoachTestInfo | undefined): string[] {
  const lines: string[] = [];
  if (mode === 'regex') {
    const label = info?.expectedLabel?.trim();
    lines.push(
      label
        ? `  ожидалось: ${clip(label, 300)} (вывод проверяется по шаблону, а не буква в букву)`
        : `  ожидалось: вывод под шаблон (регулярное выражение Python, а не сам текст): ${shown(expected)}`,
    );
  } else if (mode === 'contains') {
    const needles = expected
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    const listed = needles.slice(0, 5).map((line) => shown(line, 100));
    if (needles.length > 5) listed.push(`и ещё ${needles.length - 5}`);
    lines.push(`  вывод должен содержать (остальной текст не важен): ${listed.join(', ')}`);
  } else {
    lines.push(`  ожидалось: ${shown(expected)}`);
  }
  const relaxed: string[] = [];
  if (info?.compare?.ignoreCase) relaxed.push('регистр букв');
  if (info?.compare?.ignoreSpaces) relaxed.push('лишние пробелы');
  if (info?.compare?.ignoreBlankLines) relaxed.push('пустые строки');
  if (relaxed.length > 0) lines.push(`  при сравнении не важны: ${relaxed.join(', ')}`);
  return lines;
}

function describeFailedTest(test: TestResult, info: CoachTestInfo | undefined): string {
  const name = info?.title?.trim() || test.id;
  const lines: string[] = [`Тест «${clip(name, 100)}» — не пройден`];
  if (test.interrupted === 'timeout') {
    lines.push('  программа не завершилась вовремя — возможно, бесконечный цикл или лишний input()');
  } else if (test.interrupted === 'stopped') {
    lines.push('  проверку остановил ученик');
  }
  if (test.stdin) lines.push(`  вход: ${shown(test.stdin)}`);

  if (test.kind === 'call') {
    if (test.call) lines.push(`  вызов: ${clip(test.call, 200)}`);
    if (test.expected !== undefined) lines.push(`  ожидалось: ${clip(test.expected, 300)}`);
    if (test.actual !== undefined) {
      const types =
        test.actualType && test.expectedType && test.actualType !== test.expectedType
          ? ` (тип ${test.actualType}, ожидался ${test.expectedType})`
          : '';
      lines.push(`  получилось: ${clip(test.actual, 300)}${types}`);
    }
  } else if (test.kind === 'assert') {
    if (test.message) lines.push(`  проверка: ${clip(test.message, 300)}`);
  } else {
    const mode = compareModeOf(test, info);
    if (test.expected !== undefined) lines.push(...describeExpectedOutput(test.expected, mode, info));
    if (!test.interrupted) lines.push(`  получилось: ${test.output ? shown(test.output) : '(пусто)'}`);
    const diff = test.diff ? describeDiff(test.diff, mode) : null;
    if (diff && !test.error) lines.push(`  ${diff}`);
  }

  if (test.error) {
    const where = test.error.line !== null ? ` (строка ${test.error.line})` : '';
    const inCheck =
      test.error.origin === 'check' ? ' — ошибка в самой проверке, например нет функции с нужным именем' : '';
    lines.push(`  ошибка: ${clip(test.error.summary, 300)}${where}${inCheck}`);
  }
  if (test.limit) lines.push('  программа вывела слишком много текста и была остановлена');
  return lines.join('\n');
}

/**
 * Сводит реальные результаты проверки в короткий текст для наставника:
 * вход, ожидалось, получилось, ошибка. Показывает не больше трёх непройденных тестов.
 * С данными тестов задания (options.tests) тесты называются так, как их видит ученик,
 * а шаблон или список фрагментов не выдаётся за точный ожидаемый вывод.
 */
export function summarizeCheck(result: CheckResult, options: SummarizeOptions = {}): string {
  const maxLength = options.maxLength ?? COACH_REQUEST_LIMITS.check;
  const infoById = new Map<string, CoachTestInfo>();
  for (const info of options.tests ?? []) infoById.set(info.id, info);

  const lines: string[] = [];
  const counted = result.tests.filter((test) => test.interrupted !== 'skipped');
  const skipped = result.tests.length - counted.length;
  const passed = counted.filter((test) => test.passed).length;

  if (result.tests.length > 0) {
    const total = result.tests.length;
    let summary = `Итог: пройдено ${passed} из ${total} ${genitive(total, 'теста', 'тестов')}.`;
    if (skipped > 0) summary += ` Не запускались: ${skipped}.`;
    lines.push(summary);
  }

  if (result.compileError) {
    const error = result.compileError;
    const where = error.line !== null ? `, строка ${error.line}` : '';
    lines.push(`Синтаксическая ошибка${where}: ${clip(error.summary, 300)}`);
    if (error.lineText) lines.push(`  код в строке: ${clip(error.lineText.trim(), 200)}`);
    if (result.tests.length === 0) lines.push('Тесты не запускались: программа не начала выполняться.');
  }

  for (const rule of result.rules) {
    if (!rule.passed) lines.push(`Требование к коду не выполнено: ${clip(rule.message, 300)}`);
  }

  const failed = counted.filter((test) => !test.passed);
  for (const test of failed.slice(0, 3)) lines.push(describeFailedTest(test, infoById.get(test.id)));
  if (failed.length > 3) lines.push(`Ещё не пройдено тестов: ${failed.length - 3} (подробности опущены).`);

  if (!result.compileError && failed.length === 0 && result.rules.every((rule) => rule.passed) && counted.length > 0) {
    lines.push('Все запущенные тесты и требования к коду пройдены.');
  }

  return clip(lines.join('\n'), maxLength, '\n…(сводка сокращена)');
}

// ------------------------------------------------------------------ сборка запроса

export interface CoachContextInput {
  action: CoachAction;
  lesson: { id: string; title: string; objective: string };
  exercise?: { id: string; title: string; kind: string; statement: string } | null;
  /** Текущий код ученика. */
  code?: string | null;
  /** Результат последней проверки. */
  checkResult?: CheckResult | null;
  /**
   * Код, который был проверен (снимок на момент проверки). Если он не совпадает с code,
   * результаты относятся к старой версии и наставнику не передаются: иначе он принял бы их
   * за запуск текущего кода. Без снимка результаты передаются как есть.
   */
  checkedCode?: string | null;
  /** Тесты задания (exercise.tests): названия для ученика и режим сравнения вывода. */
  tests?: readonly CoachTestInfo[] | null;
  hintsUsed?: number;
  /** Краткая карточка навыков: строка или список пунктов. */
  skillCard?: string | readonly string[] | null;
  question?: string | null;
  history?: readonly CoachHistoryItem[] | null;
}

const encoder = new TextEncoder();

function byteSize(request: CoachRequest): number {
  return encoder.encode(JSON.stringify(request)).length;
}

/** Запас под заголовки JSON и неточности подсчёта. */
const BODY_BUDGET = COACH_REQUEST_LIMITS.bodyBytes - 512;

/**
 * Приводит запрос к лимитам адаптера: обрезает поля и, если тело всё ещё больше 24 КБ,
 * по очереди убирает старую историю, карточку навыков и сокращает длинные тексты.
 */
export function fitCoachRequest(request: CoachRequest): CoachRequest {
  const L = COACH_REQUEST_LIMITS;
  const fitted: CoachRequest = {
    action: request.action,
    lesson: {
      id: clip(request.lesson.id, L.id, ''),
      title: clip(request.lesson.title, L.title),
      objective: clip(request.lesson.objective, L.objective),
    },
    hintsUsed: Math.min(3, Math.max(0, Math.trunc(Number.isFinite(request.hintsUsed) ? request.hintsUsed : 0))),
  };
  if (request.exercise) {
    fitted.exercise = {
      id: clip(request.exercise.id, L.id, ''),
      title: clip(request.exercise.title, L.title),
      kind: clip(request.exercise.kind, L.kind, ''),
      statement: clip(request.exercise.statement, L.statement),
    };
  }
  if (request.code !== undefined) fitted.code = clipCode(request.code, L.code);
  if (request.check?.trim()) fitted.check = clip(request.check, L.check, '\n…(сводка сокращена)');
  if (request.skills?.trim()) fitted.skills = clip(request.skills.trim(), L.skills);
  if (request.question?.trim()) fitted.question = clip(request.question.trim(), L.question);
  if (request.history && request.history.length > 0) {
    const history = request.history
      .filter((item) => (item.role === 'student' || item.role === 'coach') && item.text.trim() !== '')
      .map((item) => ({ role: item.role, text: clip(item.text.trim(), L.historyText) }))
      .slice(-L.historyItems);
    if (history.length > 0) fitted.history = history;
  }

  const reducers: Array<() => boolean> = [
    // 1. Самая старая история.
    () => {
      if (!fitted.history || fitted.history.length === 0) return false;
      fitted.history = fitted.history.slice(1);
      if (fitted.history.length === 0) delete fitted.history;
      return true;
    },
    // 2. Карточка навыков.
    () => {
      if (fitted.skills === undefined) return false;
      delete fitted.skills;
      return true;
    },
    // 3. Длинное условие.
    () => {
      if (!fitted.exercise || fitted.exercise.statement.length <= 1500) return false;
      fitted.exercise.statement = clip(fitted.exercise.statement, 1500);
      return true;
    },
    // 4. Длинная сводка проверки.
    () => {
      if (!fitted.check || fitted.check.length <= 1500) return false;
      fitted.check = clip(fitted.check, 1500, '\n…(сводка сокращена)');
      return true;
    },
    // 5. Код — постепенно, пока не поместится.
    () => {
      if (fitted.code === undefined || fitted.code.length <= 1000) return false;
      fitted.code = clipCode(fitted.code, Math.floor(fitted.code.length * 0.75));
      return true;
    },
  ];

  for (const reduce of reducers) {
    while (byteSize(fitted) > BODY_BUDGET) {
      if (!reduce()) break;
    }
  }
  return fitted;
}

function sameCode(a: string, b: string): boolean {
  return a.replace(/\r\n?/g, '\n') === b.replace(/\r\n?/g, '\n');
}

/** Проверка была для другой версии кода: после неё ученик менял программу. */
function isStaleCheck(code: string | null | undefined, checkedCode: string | null | undefined): boolean {
  return typeof code === 'string' && typeof checkedCode === 'string' && !sameCode(code, checkedCode);
}

/**
 * Собирает запрос к наставнику: только нужный контекст (цель урока, условие, попытка,
 * реальные результаты тестов, использованные подсказки, карточка навыков), с учётом лимитов.
 * Результаты проверки передаются, только если они относятся к текущему коду (см. checkedCode);
 * иначе адаптер попросит наставника честно сказать, что это разбор по чтению кода.
 */
export function buildCoachRequest(input: CoachContextInput): CoachRequest {
  const request: CoachRequest = {
    action: input.action,
    lesson: { id: input.lesson.id, title: input.lesson.title, objective: input.lesson.objective },
    hintsUsed: input.hintsUsed ?? 0,
  };
  if (input.exercise) {
    request.exercise = {
      id: input.exercise.id,
      title: input.exercise.title,
      kind: input.exercise.kind,
      statement: input.exercise.statement,
    };
  }
  if (typeof input.code === 'string') request.code = input.code;
  if (input.checkResult && !isStaleCheck(input.code, input.checkedCode)) {
    request.check = summarizeCheck(input.checkResult, { tests: input.tests });
  }
  if (input.skillCard) {
    const skills = typeof input.skillCard === 'string' ? input.skillCard : input.skillCard.join('; ');
    if (skills.trim()) request.skills = skills;
  }
  if (input.question?.trim()) request.question = input.question;
  if (input.history && input.history.length > 0) request.history = [...input.history];
  return fitCoachRequest(request);
}

// ------------------------------------------------------------------ сеть

function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

function endpointUrl(endpoint: string, path: '/health' | '/coach'): URL {
  let base: URL;
  try {
    base = new URL(endpoint.trim());
  } catch {
    throw new CoachEndpointError();
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') throw new CoachEndpointError();
  if (base.username || base.password) {
    throw new CoachEndpointError('В адресе сервера наставника не должно быть логина и пароля. Для доступа используй токен.');
  }
  const pageProtocol = typeof location !== 'undefined' ? location.protocol : null;
  if (pageProtocol === 'https:' && base.protocol === 'http:' && !isLoopbackHostname(base.hostname)) {
    throw new CoachEndpointError(
      'Приложение открыто по HTTPS, а адрес наставника — по HTTP. Браузер заблокирует такой запрос: нужен HTTPS-адрес адаптера.',
    );
  }
  const prefix = base.pathname.replace(/\/+$/, '');
  return new URL(`${base.origin}${prefix}${path}`);
}

/** Адрес, с которого открыто приложение (его адаптер сверяет с COACH_ALLOWED_ORIGINS). */
function appOrigin(): string | null {
  if (typeof location === 'undefined') return null;
  const origin = location.origin;
  return typeof origin === 'string' && /^https?:\/\//.test(origin) ? origin : null;
}

/**
 * Запрос не дошёл или браузер не отдал ответ. Так выглядит и выключенный адаптер, и отказ
 * адаптера для неразрешённого адреса приложения (CORS): браузер не показывает причину.
 */
function connectionError(url: URL): CoachError {
  const loopback = isLoopbackHostname(url.hostname);
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  if (offline && !loopback) return new CoachNetworkError();
  const origin = appOrigin();
  // Коротко: что случилось и одно действие; вторая строка — на случай, когда адаптер запущен, но отказал (CORS).
  if (loopback) {
    return new CoachUnavailableError(
      `Нет связи с сервером наставника (${url.origin}). Запусти его: «npm run coach».` +
        (origin ? ` Уже запущен — добавь ${origin} в COACH_ALLOWED_ORIGINS (.env).` : ''),
    );
  }
  return new CoachUnavailableError(
    `Нет связи с сервером наставника (${url.origin}). Проверь адрес и интернет.` +
      (origin ? ` Сервер работает — добавь ${origin} в COACH_ALLOWED_ORIGINS.` : ''),
  );
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds) : null;
}

function errorFromResponse(response: Response, data: unknown): CoachError {
  const status = response.status;
  const error = (data as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  const code = typeof error?.code === 'string' ? error.code : null;
  const message = typeof error?.message === 'string' && error.message.trim() ? clip(error.message, 500) : null;
  const retryAfterSec = parseRetryAfter(response.headers.get('Retry-After'));

  if (status === 429) return new CoachLimitError(message ?? undefined, { status, code, retryAfterSec });
  if (status === 503 && code === 'not-configured') return new CoachNotConfiguredError(message ?? undefined);
  if (status === 401 || status === 403) return new CoachAccessError(message ?? undefined, { status, code });
  if (status === 504) {
    return new CoachTimeoutError(message ?? 'ИИ не ответил вовремя. Попробуй ещё раз чуть позже.', { status, code });
  }
  if (!message) {
    return new CoachServerError(
      status === 404
        ? 'По этому адресу нет сервера наставника. Проверь адрес в настройках.'
        : `Ошибка сервера наставника (${status}). Попробуй позже.`,
      { status, code, retryAfterSec },
    );
  }
  return new CoachServerError(message, { status, code, retryAfterSec });
}

async function requestJson(
  url: URL,
  init: { method: 'GET' | 'POST'; body?: string },
  token: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<unknown> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  const cleanToken = token.trim();
  if (cleanToken) {
    if (!/^[\x21-\x7e]+$/.test(cleanToken)) {
      throw new CoachAccessError('Токен доступа содержит недопустимые символы. Скопируй его заново без пробелов.');
    }
    headers.Authorization = `Bearer ${cleanToken}`;
  }

  if (signal?.aborted) throw new CoachAbortedError();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });

  const failure = (): CoachError => {
    if (timedOut) {
      const seconds = Math.round(timeoutMs / 1000);
      return new CoachTimeoutError(
        `Наставник не ответил за ${seconds} ${plural(seconds, 'секунду', 'секунды', 'секунд')}. Попробуй ещё раз чуть позже.`,
      );
    }
    if (signal?.aborted) return new CoachAbortedError();
    return connectionError(url);
  };

  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: init.method,
        headers,
        body: init.body,
        signal: controller.signal,
        mode: 'cors',
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
      });
    } catch {
      throw failure();
    }

    let data: unknown = null;
    let parsed = true;
    try {
      data = await response.json();
    } catch {
      if (timedOut || signal?.aborted) throw failure();
      parsed = false;
    }

    if (!response.ok) throw errorFromResponse(response, data);
    if (!parsed) {
      throw new CoachServerError('По этому адресу отвечает не сервер наставника. Проверь адрес в настройках.', {
        status: response.status,
      });
    }
    return data;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readLimits(value: unknown): CoachLimits | null {
  if (!isRecord(value)) return null;
  const keys = [
    'perWindow',
    'windowMinutes',
    'daily',
    'remainingWindow',
    'remainingDaily',
    'maxTokens',
    'timeoutMs',
    'maxBodyBytes',
  ] as const;
  const limits = {} as CoachLimits;
  for (const key of keys) {
    const item = value[key];
    if (typeof item !== 'number' || !Number.isFinite(item)) return null;
    limits[key] = item;
  }
  return limits;
}

function waitMs(options: CoachRequestOptions, fallback: number): number {
  const value = options.timeoutMs;
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(180_000, Math.max(1_000, Math.round(value)));
}

/** Проверяет, запущен ли адаптер и настроен ли ИИ. Это бесплатный запрос. */
export async function checkHealth(
  endpoint: string,
  token: string,
  signal?: AbortSignal,
  options: CoachRequestOptions = {},
): Promise<CoachHealth> {
  const url = endpointUrl(endpoint, '/health');
  const data = await requestJson(url, { method: 'GET' }, token, signal, waitMs(options, COACH_TIMEOUT_MS));
  if (
    !isRecord(data) ||
    typeof data.ok !== 'boolean' ||
    typeof data.provider !== 'string' ||
    typeof data.model !== 'string' ||
    typeof data.configured !== 'boolean'
  ) {
    throw new CoachServerError('По этому адресу отвечает не сервер наставника. Проверь адрес в настройках.');
  }
  return {
    ok: data.ok,
    provider: data.provider,
    model: data.model,
    configured: data.configured,
    mode: data.mode === 'remote' ? 'remote' : 'local',
    limits: readLimits(data.limits),
  };
}

/**
 * Отправляет один запрос наставнику. Вызывай только по явному действию ученика:
 * каждый запрос к ИИ платный. Повторов при ошибке здесь нет.
 * Ждёт ответа COACH_WAIT_MS (35 с): на 5 с дольше, чем адаптер ждёт ИИ, — поэтому при
 * медленном ИИ приходит понятный ответ адаптера (504), а не обрыв на стороне приложения.
 */
export async function askCoach(
  endpoint: string,
  token: string,
  request: CoachRequest,
  signal?: AbortSignal,
  options: CoachRequestOptions = {},
): Promise<CoachReply> {
  const url = endpointUrl(endpoint, '/coach');
  const body = JSON.stringify(fitCoachRequest(request));
  const data = await requestJson(url, { method: 'POST', body }, token, signal, waitMs(options, COACH_WAIT_MS));
  if (!isRecord(data) || typeof data.text !== 'string' || !data.text.trim()) {
    throw new CoachServerError('Сервер наставника вернул пустой ответ. Попробуй ещё раз.');
  }
  const usage = isRecord(data.usage) ? data.usage : {};
  return {
    text: data.text,
    model: typeof data.model === 'string' ? data.model : '',
    usage: {
      input: typeof usage.input === 'number' ? usage.input : 0,
      output: typeof usage.output === 'number' ? usage.output : 0,
    },
    truncated: data.truncated === true,
  };
}
