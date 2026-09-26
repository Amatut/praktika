// Обратная связь режима «Подсказки курса» (офлайн, без ИИ).
// Превращает настоящие результаты запуска и проверки в короткий разбор
// «Где → Почему → Попробуй → Проверь». Ничего не выдумывает: строки, тесты и значения
// берутся только из результата harness.py.

import type { ContentTest, Exercise, Matcher, Mistake } from '../content/schema.ts';
import type { CheckOutcome, RunOutcome } from '../runner/runner.ts';
import type { CheckResult, OutputDiff, PyError, RuleResult, TestResult } from '../runner/types.ts';
import { closestName, explainError, plural, q, typeLabel } from './errors-ru.ts';
import type { Feedback, FeedbackSource } from './types.ts';

type Mode = 'run' | 'check';

const CHECK_BUTTON = '„Проверить“';
const RUN_BUTTON = '„Запустить“';

// ------------------------------------------------------------------ мелкие помощники

function clip(text: string, max = 60): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

const SHOWN_MAX = 40;
/** Сколько символов показать перед первым отличием, если строку приходится сокращать. */
const SHOWN_CONTEXT = 15;

/** Строка вывода для показа в кавычках; пустая строка подписывается словами. */
function shown(text: string | null | undefined): string {
  if (text === null || text === undefined || text === '') return '(пустая строка)';
  return clip(text, SHOWN_MAX);
}

/**
 * Ожидаемое и полученное для показа рядом. Длинные строки сокращаются вокруг первого отличия,
 * иначе при отличии после 40-го символа ученик увидел бы две одинаковые строки.
 */
function shownPair(expected: string, actual: string): [string, string] {
  if (expected.length <= SHOWN_MAX && actual.length <= SHOWN_MAX) return [shown(expected), shown(actual)];
  let index = 0;
  while (index < expected.length && index < actual.length && expected[index] === actual[index]) index++;
  let start = index > SHOWN_CONTEXT ? index - SHOWN_CONTEXT : 0;
  // Не режем слово пополам: если пробел рядом, начинаем с начала слова (до отличия строки совпадают).
  const space = start > 0 ? expected.lastIndexOf(' ', start) : -1;
  if (space >= 0 && start - space <= 10) start = space + 1;
  const window = (text: string): string => {
    if (text === '') return '(пустая строка)';
    return start > 0 ? clip(`…${text.slice(start)}`, SHOWN_MAX) : clip(text, SHOWN_MAX);
  };
  return [window(expected), window(actual)];
}

function formatSeconds(ms: number): string {
  const seconds = Math.round((ms / 1000) * 10) / 10;
  return `${String(seconds).replace('.', ',')} с`;
}

function inputLines(stdin: string | undefined): string[] {
  if (!stdin) return [];
  const text = stdin.replace(/\r\n?/g, '\n').replace(/\n$/, '');
  return text.split('\n');
}

function formatInput(stdin: string | undefined): string | null {
  const lines = inputLines(stdin);
  if (lines.length === 0) return null;
  return clip(lines.map((line) => (line === '' ? '(пусто)' : line)).join('; '), 40);
}

/** «Строка 2: print("Привет)». */
function codeWhere(error: PyError): string | null {
  if (!error.line) return null;
  const text = error.lineText?.trim();
  return text ? `Строка ${error.line}: ${clip(text)}` : `Строка ${error.line}`;
}

function verifyTest(label: string): string {
  return `Нажми ${CHECK_BUTTON}: тест ${q(label)} должен пройти.`;
}

function feedback(source: FeedbackSource, title: string, why: string, tryThis: string, extra: Partial<Feedback> = {}): Feedback {
  return {
    source,
    title,
    where: null,
    why,
    tryThis,
    verify: null,
    raw: null,
    line: null,
    testId: null,
    mistakeId: null,
    ...extra,
  };
}

/** Нормализация вывода: \r\n → \n, без пробелов в конце строк и без пустых строк в конце. */
export function normalizeOutput(text: string): string {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd());
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

function parseNumber(text: string): number | null {
  const value = Number(text.trim().replace(',', '.'));
  return text.trim() !== '' && Number.isFinite(value) ? value : null;
}

function isCheckPassed(result: CheckResult): boolean {
  return (
    !result.compileError && result.rules.every((rule) => rule.passed) && result.tests.every((test) => test.passed)
  );
}

function firstFailedTest(result: CheckResult): TestResult | null {
  return result.tests.find((test) => !test.passed && test.interrupted !== 'skipped') ?? null;
}

/** Первый тест, где программа (или проверка) остановилась с ошибкой. Тест с ошибкой всегда не пройден. */
function firstErrorTest(result: CheckResult): TestResult | null {
  return result.tests.find((test) => test.error) ?? null;
}

/** В разборе есть условие на ошибку (errorType или errorIncludes). */
function hasErrorCondition(when: Matcher): boolean {
  return when.errorType !== undefined || when.errorIncludes !== undefined;
}

/**
 * Тест, по которому проверяются условия разбора на ошибку и на вывод, — один на все условия.
 * С условием на ошибку — первый тест с ошибкой (так же выбирает ошибку и обычный разбор:
 * ошибка выполнения важнее расхождения вывода). Без него — первый непрошедший тест.
 */
function subjectTest(when: Matcher, result: CheckResult): TestResult | null {
  return hasErrorCondition(when) ? firstErrorTest(result) : firstFailedTest(result);
}

// ------------------------------------------------------------------ тесты

/** Название теста для ученика: title или «Пример N» / «Граничный случай N» / «Проверка N» (N — номер теста). */
export function testLabel(test: ContentTest, index: number): string {
  const title = test.title?.trim();
  if (title) return title;
  const number = index + 1;
  if (test.example) return `Пример ${number}`;
  if (test.edge) return `Граничный случай ${number}`;
  return `Проверка ${number}`;
}

interface TestInfo {
  result: TestResult | null;
  test: ContentTest | null;
  id: string | null;
  label: string;
  where: string;
}

function testInfo(exercise: Exercise, result: TestResult | null, fallbackIndex: number, test?: ContentTest): TestInfo {
  const index = result ? exercise.tests.findIndex((item) => item.id === result.id) : -1;
  const content = test ?? (index >= 0 ? exercise.tests[index] : null);
  const position = test ? fallbackIndex : index >= 0 ? index : fallbackIndex;
  const label = content ? testLabel(content, position) : `Проверка ${position + 1}`;
  let where = `Тест ${q(label)}`;
  const call = result?.call ?? (content?.kind === 'call' ? content.call : undefined);
  if (call) where += `: ${clip(call)}`;
  const input = formatInput(result?.stdin ?? content?.stdin);
  if (input) where += ` (ввод: ${input})`;
  return { result, test: content, id: result?.id ?? content?.id ?? null, label, where };
}

// ------------------------------------------------------------------ сбой среды, время, лимит

/**
 * Сообщения раннера (runner.ts), когда Python не загрузился или не запущен. Всё остальное со статусом
 * failed — сбой Python уже во время работы программы (например, переполнение стека при глубокой рекурсии).
 */
const LOAD_FAILURE = /^(?:Не удалось загрузить Python|Python не запустился|Python не успел загрузиться|Python не запущен)/;

function environmentFailure(message: string, mode: Mode): Feedback {
  const button = mode === 'check' ? CHECK_BUTTON : RUN_BUTTON;
  if (!LOAD_FAILURE.test(message)) {
    // Сбой во время выполнения может вызвать и сам код, поэтому «не твоя ошибка» здесь не утверждаем.
    return feedback(
      'environment',
      'Python аварийно остановился',
      mode === 'check'
        ? 'Python в браузере аварийно остановился во время проверки, поэтому результатов тестов нет.'
        : 'Python в браузере аварийно остановился во время работы программы.',
      `Нажми ${button} ещё раз. Если сбой повторяется только с этим кодом, проверь рекурсию и объём данных.`,
      {
        raw: message,
        verify: mode === 'check' ? 'Проверка должна дойти до результатов тестов.' : 'Программа должна дойти до конца и показать вывод.',
      },
    );
  }
  const loading = /интернет|загруз|офлайн|fetch|network/i.test(message);
  return feedback(
    'environment',
    'Python не запустился',
    mode === 'check'
      ? 'Проверка не состоялась из-за сбоя Python в браузере — это не ошибка в твоём коде.'
      : 'Запуск не состоялся из-за сбоя Python в браузере — это не ошибка в твоём коде.',
    loading
      ? 'Для первой загрузки Python нужен интернет; чтобы заниматься без сети, скачай его заранее в настройках.'
      : `Нажми ${button} ещё раз — Python перезапустится. Если сбой повторится, перезагрузи страницу.`,
    {
      raw: message,
      verify: mode === 'check' ? 'Проверка должна дойти до результатов тестов.' : 'Программа должна запуститься и показать вывод.',
    },
  );
}

function loopAdvice(code: string): string {
  if (/\bwhile\b/.test(code)) {
    return 'Проверь условие цикла while: меняется ли переменная цикла на каждом шаге и может ли условие стать ложным?';
  }
  if (/\bfor\b/.test(code)) {
    return 'Проверь цикл for: не слишком ли большой диапазон он перебирает и не растёт ли список, который он обходит?';
  }
  return 'Найди место, где программа может повторять действие без конца, и проверь условие остановки.';
}

function timeoutFeedback(code: string, limitMs: number | null, info: TestInfo | null, mode: Mode): Feedback {
  const during = limitMs ? `за ${formatSeconds(limitMs)}` : 'за отведённое время';
  const title = 'Программа работает слишком долго';
  if (mode === 'run') {
    return feedback('timeout', title, `Программа не завершилась ${during} — похоже, цикл не останавливается.`, loopAdvice(code), {
      verify: `Нажми ${RUN_BUTTON} снова: программа должна завершиться сама за доли секунды.`,
    });
  }
  return feedback(
    'timeout',
    title,
    `${info ? 'Тест не завершился' : 'Проверка не завершилась'} ${during} — похоже, цикл не останавливается.`,
    loopAdvice(code),
    {
      where: info?.where ?? null,
      testId: info?.id ?? null,
      verify: info
        ? `Нажми ${CHECK_BUTTON} снова: тест ${q(info.label)} должен завершиться за доли секунды.`
        : `Нажми ${CHECK_BUTTON} снова: проверка должна завершиться за доли секунды.`,
    },
  );
}

function limitFeedback(info: TestInfo | null): Feedback {
  return feedback(
    'limit',
    'Слишком много вывода',
    'Программа напечатала слишком много текста, и её остановили — обычно print стоит внутри цикла, который не заканчивается.',
    'Проверь условие цикла и то, сколько раз выполняется print.',
    {
      where: info?.where ?? null,
      testId: info?.id ?? null,
      verify: info
        ? verifyTest(info.label)
        : `Нажми ${RUN_BUTTON} снова: программа должна завершиться сама, а вывод — уместиться на экране.`,
    },
  );
}

// ------------------------------------------------------------------ ошибки Python

/**
 * «Проверь» после синтаксической ошибки: тесты ещё не запускались, поэтому называем первый
 * тест-пример (или первый тест, если примеров нет).
 */
function firstTestVerify(exercise: Exercise): string {
  const index = Math.max(
    0,
    exercise.tests.findIndex((test) => test.example),
  );
  const test = exercise.tests[index];
  return test
    ? verifyTest(testLabel(test, index))
    : `Нажми ${CHECK_BUTTON}: сообщение об ошибке должно исчезнуть, и запустятся тесты.`;
}

function compileFeedback(error: PyError, code: string, verify: string): Feedback {
  const explained = explainError(error, code);
  return feedback(explained.environment ? 'environment' : 'compile', explained.title, explained.why, explained.tryThis, {
    where: codeWhere(error),
    raw: error.raw,
    line: error.line,
    verify,
  });
}

const RUN_COMPILE_VERIFY = `Нажми ${RUN_BUTTON} ещё раз: сообщение об ошибке должно исчезнуть.`;

function runErrorFeedback(error: PyError, code: string): Feedback {
  const explained = explainError(error, code);
  let { why, tryThis } = explained;
  if (error.type === 'EOFError') {
    why = 'Программа попросила больше строк ввода, чем ей дали перед запуском.';
    tryThis = 'Добавь недостающие строки во ввод или проверь, сколько раз вызывается input().';
  }
  return feedback(explained.environment ? 'environment' : 'runtime', explained.title, why, tryThis, {
    where: codeWhere(error),
    raw: error.raw,
    line: error.line,
    verify: `Нажми ${RUN_BUTTON} ещё раз: программа должна дойти до конца без ошибки.`,
  });
}

/** Имена функций из строк def: top — без отступа, nested — с отступом (внутри другого блока), all — любые. */
function definedFunctions(code: string, scope: 'top' | 'nested' | 'all'): string[] {
  const indent = scope === 'top' ? '' : scope === 'nested' ? '[ \\t]+' : '[ \\t]*';
  const pattern = new RegExp(`^${indent}(?:async\\s+)?def\\s+([A-Za-z_]\\w*)\\s*\\(`, 'gm');
  return [...code.matchAll(pattern)].map((match) => match[1]);
}

/** Ошибка в самой проверке: например, функции с нужным именем нет. */
function checkOriginFeedback(error: PyError, code: string, info: TestInfo): Feedback {
  const call = info.result?.call ?? (info.test?.kind === 'call' ? info.test.call : null);
  const called = call ? (/^\s*([A-Za-z_]\w*)\s*\(/.exec(call)?.[1] ?? null) : null;
  const extra: Partial<Feedback> = { where: info.where, raw: error.raw, testId: info.id, verify: verifyTest(info.label) };

  if (error.type === 'NameError') {
    const name = /name '([^']+)' is not defined/.exec(error.message)?.[1] ?? called;
    if (name) {
      const isFunction = name === called;
      const topDefs = definedFunctions(code, 'top');
      if (topDefs.includes(name)) {
        // def на верхнем уровне есть, а имени нет: программа завершилась раньше, чем дошла до этой строки.
        return feedback(
          'check',
          `Проверка не видит ${q(name)}`,
          `Функция ${q(name)} объявлена, но программа завершилась раньше, чем дошла до строки с def.`,
          'Проверь, нет ли выше exit() или quit(), — или перенеси объявление функции в начало программы.',
          extra,
        );
      }
      if (definedFunctions(code, 'nested').includes(name)) {
        return feedback(
          'check',
          `Проверка не видит ${q(name)}`,
          `Функция ${q(name)} объявлена внутри другого блока, поэтому проверка до неё не добирается.`,
          'Объяви её на верхнем уровне программы — строка def без отступа.',
          extra,
        );
      }
      const similar = closestName(name, definedFunctions(code, 'all'));
      return feedback(
        'check',
        isFunction ? `Нет функции ${q(name)}` : `Нет имени ${q(name)}`,
        isFunction && call
          ? `Проверка вызывает ${clip(call)}, но функции ${q(name)} в программе нет.`
          : `Проверка обращается к ${q(name)}, но такого имени в программе нет.`,
        similar
          ? `У тебя есть функция ${q(similar)} — назови её ${q(name)}, как в условии.`
          : isFunction
            ? `Объяви функцию: def ${name}(...): — имя должно совпадать с условием, включая регистр.`
            : `Проверь, что в программе есть ${q(name)} и имя написано как в условии.`,
        extra,
      );
    }
  }
  if (error.type === 'TypeError' && /positional argument|required (?:positional|keyword-only) argument|unexpected keyword argument/.test(error.message)) {
    return feedback(
      'check',
      'Другое число параметров',
      call
        ? `Проверка вызывает ${clip(call)}, а функция объявлена с другими параметрами.`
        : 'Проверка вызывает функцию с другим числом значений, чем объявлено в def.',
      'Сравни параметры в def с условием: их должно быть столько же, сколько значений в вызове.',
      extra,
    );
  }
  const notCallable = /'(\w+)' object is not callable/.exec(error.message);
  if (error.type === 'TypeError' && notCallable && called) {
    return feedback(
      'check',
      `${q(called)} — не функция`,
      `Проверка вызывает ${clip(call ?? called)}, но ${q(called)} в программе — ${typeLabel(notCallable[1])}, а не функция.`,
      `Объяви функцию через def ${called}(...): и не занимай её имя переменной.`,
      extra,
    );
  }
  return feedback(
    'check',
    'Проверка не смогла обратиться к коду',
    'Ошибка возникла в самой проверке, когда она обращалась к твоему коду: чаще всего функция называется иначе или принимает другие параметры.',
    'Сравни имя и параметры функции с условием задания.',
    extra,
  );
}

function testErrorFeedback(error: PyError, code: string, info: TestInfo): Feedback {
  if (error.origin === 'check') return checkOriginFeedback(error, code, info);
  const explained = explainError(error, code);
  let { title, why, tryThis } = explained;
  if (error.type === 'EOFError') {
    const kind = info.result?.kind ?? info.test?.kind;
    if (kind === 'call' || kind === 'assert') {
      title = 'input() в задании с функцией';
      why = 'В этом задании данные приходят в функцию через параметры, а для input() в тесте нет ввода.';
      tryThis = 'Убери input() и используй параметры функции.';
    } else {
      const count = inputLines(info.result?.stdin ?? info.test?.stdin).length;
      why =
        count === 0
          ? 'В этом тесте нет ввода, а программа вызывает input().'
          : `Программа попросила больше строк ввода, чем есть в тесте: в нём ${count} ${plural(count, 'строка', 'строки', 'строк')}.`;
    }
  }
  const lineWhere = codeWhere(error);
  return feedback(explained.environment ? 'environment' : 'runtime', title, why, tryThis, {
    where: lineWhere ? `${lineWhere} — ${info.where.replace(/^Тест/, 'тест')}` : info.where,
    raw: error.raw,
    line: error.line,
    testId: info.id,
    verify: verifyTest(info.label),
  });
}

// ------------------------------------------------------------------ неверный результат

/** Кавычки в строке вывода — те же, что учитывает подсказка quotes в harness.py (и „). */
function quoteMarks(text: string): string[] {
  return text.match(/["'«»“”„]/g) ?? [];
}

/** Виды кавычек для показа: „"“ или „«»“. */
function quoteKinds(marks: string[]): string {
  return q([...new Set(marks)].join(''));
}

/** В коде есть то, где легко ошибиться на единицу: range, сравнения, while. */
function hasBoundaries(code: string): boolean {
  return /\brange\s*\(|[<>]|\bwhile\b/.test(code);
}

/**
 * «33» при вводе «3» или «34» при вводе «3» и «4»: значение из input() осталось строкой.
 * Смотрит только числовые строки ввода: в тесте может быть и название («Кофе», 3, 3).
 */
function textInputHint(actual: string, stdin: string | undefined): string | null {
  const lines = inputLines(stdin)
    .map((line) => line.trim())
    .filter((line) => /^-?\d+(?:[.,]\d+)?$/.test(line));
  if (lines.length === 0) return null;
  if (lines.length >= 2 && actual === lines.join('')) {
    return `${q(actual)} — это склеенные строки ввода: значения из input() остались текстом, и + их соединил.`;
  }
  const first = lines[0];
  if (actual.length > first.length && actual.length % first.length === 0 && actual === first.repeat(actual.length / first.length)) {
    const times = actual.length / first.length;
    return `${q(actual)} — это строка ${q(first)}, повторённая ${times} ${plural(times, 'раз', 'раза', 'раз')}: значение из input() осталось текстом.`;
  }
  return null;
}

function mismatchFeedback(diff: OutputDiff, code: string, info: TestInfo): Feedback {
  const expected = diff.expectedLine ?? '';
  const actual = diff.actualLine ?? '';
  const [shownExpected, shownActual] = shownPair(expected, actual);
  const base = `В строке ${diff.line ?? 1} ожидалось ${q(shownExpected)}, получилось ${q(shownActual)}.`;
  const extra: Partial<Feedback> = { where: info.where, testId: info.id, verify: verifyTest(info.label) };
  const stdin = info.result?.stdin ?? info.test?.stdin;

  switch (diff.hint) {
    case 'case':
      return feedback('output', 'Отличие в регистре букв', `${base} Отличие только в регистре букв.`, 'Сравни большие и маленькие буквы с ожидаемым выводом.', extra);
    case 'spaces':
      return feedback(
        'output',
        'Отличие в пробелах',
        `${base} Отличие только в пробелах.`,
        actual.length > expected.length
          ? 'Убери лишний пробел: print(a, b) сам ставит пробел между значениями.'
          : 'Добавь пробел: при склейке через + его нужно дописать в строку, а print(a, b) ставит его сам.',
        extra,
      );
    case 'quotes': {
      const actualMarks = quoteMarks(actual);
      const expectedMarks = quoteMarks(expected);
      if (actualMarks.length > expectedMarks.length) {
        return feedback(
          'output',
          'Лишние кавычки',
          `${base} В выводе лишние кавычки.`,
          'Кавычки в коде только обозначают текст — убери их из самой выводимой строки.',
          extra,
        );
      }
      if (actualMarks.length < expectedMarks.length) {
        return feedback(
          'output',
          'Не хватает кавычек',
          `${base} В выводе не хватает кавычек.`,
          'Чтобы напечатать кавычки, возьми текст в кавычки другого вида: print(\'Он сказал "да"\').',
          extra,
        );
      }
      if (actualMarks.join('') === expectedMarks.join('')) {
        // Кавычки те же и в том же порядке, но вокруг другого текста: "Он сказал да" вместо Он сказал "да".
        return feedback(
          'output',
          'Кавычки не на своём месте',
          `${base} Кавычки те же, но стоят вокруг другого текста.`,
          'Сравни с ожидаемым выводом, какие именно слова должны быть в кавычках, и перенеси кавычки к ним.',
          extra,
        );
      }
      return feedback(
        'output',
        'Кавычки другого вида',
        `${base} Нужны кавычки ${quoteKinds(expectedMarks)}, а в выводе — ${quoteKinds(actualMarks)}.`,
        'Поставь внутри текста такие же кавычки, как в ожидаемом выводе, а сам текст возьми в кавычки другого вида: print(\'Он сказал "да"\').',
        extra,
      );
    }
    case 'number-format': {
      // В строке с подписью («Итого: 269.70») сравниваются только сами числа.
      const a = (diff.actualNumber ?? actual).trim();
      const e = (diff.expectedNumber ?? expected).trim();
      // «00» при вводе «0»: то же число, но это строка из input(), повторённая дважды.
      const textHint = textInputHint(a, stdin);
      if (textHint) {
        return feedback('output', 'Число осталось строкой', `${base} ${textHint}`, 'Преврати ввод в число: int(input()) или float(input()).', extra);
      }
      const actualFraction = /[.,]/.test(a);
      const expectedFraction = /[.,]/.test(e);
      if (!actualFraction && !expectedFraction) {
        return feedback(
          'output',
          'Число в другом виде',
          `${q(a)} и ${q(e)} — одно и то же число, но записанное по-другому.`,
          /^[-+]?0\d/.test(a)
            ? 'Убери нули в начале числа: выводи само число, без дополнения нулями.'
            : a.startsWith('+')
              ? 'Убери знак „+“ перед числом: выводи само число.'
              : 'Сравни запись числа с ожидаемой посимвольно и выведи его в том же виде.',
          extra,
        );
      }
      if (actualFraction && !expectedFraction) {
        const division = /[^/]\/[^/]/.test(code);
        return feedback(
          'output',
          'Число в другом виде',
          division
            ? `${q(a)} и ${q(e)} — одно число, но в разном виде: деление / всегда даёт дробное.`
            : `${q(a)} и ${q(e)} — одно число, но в разном виде: у тебя дробное, а нужно целое.`,
          division ? 'Если нужно целое, используй целочисленное деление // или int(...).' : 'Преврати результат в целое число: int(...).',
          extra,
        );
      }
      if (expectedFraction && !actualFraction) {
        return feedback(
          'output',
          'Число в другом виде',
          `Ожидалось дробное ${q(e)}, а получилось целое ${q(a)}.`,
          'Сделай результат дробным: деление / или float(...).',
          extra,
        );
      }
      if (a.includes(',') !== e.includes(',')) {
        return feedback(
          'output',
          'Другой разделитель дробной части',
          `${q(a)} и ${q(e)} — одно число, но с разным разделителем дробной части.`,
          a.includes(',') ? 'Выводи дробную часть через точку, как это делает Python.' : 'Замени точку на запятую при выводе: str(x).replace(".", ",").',
          extra,
        );
      }
      // Точка или запятая есть в обоих числах, и разделитель один и тот же.
      const comma = e.includes(',');
      const digits = e.length - Math.max(e.indexOf('.'), e.indexOf(',')) - 1;
      const format = `f"{x:.${digits}f}"${comma ? '.replace(".", ",")' : ''}`;
      const actualDigits = a.length - Math.max(a.indexOf('.'), a.indexOf(',')) - 1;
      // «269.70» вместо «269.7»: образец похож на обычный вывод дробного числа (без нулей в конце),
      // а нули дописал формат. Совет «ровно 1 знак» тут может увести в сторону: если в условии
      // round(…, 2), то при другом вводе нужно два знака (199.98).
      if (!comma && actualDigits > digits && /[1-9]$/.test(e)) {
        return feedback(
          'output',
          'Лишние нули после точки',
          `${q(a)} и ${q(e)} — одно число, но у тебя в конце дробной части лишние нули.`,
          `Нули в конце дописывает формат вроде f"{x:.${actualDigits}f}", а само дробное число Python печатает без них. Если в условии сказано округлить — выведи результат round(...) без формата, а если нужен именно формат — поставь столько знаков, сколько в образце: ${format}.`,
          extra,
        );
      }
      return feedback(
        'output',
        `Другое число знаков после ${comma ? 'запятой' : 'точки'}`,
        `${q(a)} и ${q(e)} — одно число, но с разным числом знаков после ${comma ? 'запятой' : 'точки'}.`,
        digits > 0
          ? `Выведи ровно ${digits} ${plural(digits, 'знак', 'знака', 'знаков')} после ${comma ? 'запятой' : 'точки'}, например ${format}.`
          : 'Сравни запись числа с ожидаемой посимвольно и выведи его в том же виде.',
        extra,
      );
    }
    case 'number': {
      const actualNumber = diff.actualNumber ?? actual;
      const textHint = textInputHint(actualNumber.trim(), stdin);
      if (textHint) {
        return feedback('output', 'Число осталось строкой', `${base} ${textHint}`, 'Преврати ввод в число: int(input()) или float(input()).', extra);
      }
      const a = parseNumber(actualNumber);
      const e = parseNumber(diff.expectedNumber ?? expected);
      const offByOne = a !== null && e !== null && Math.abs(a - e) === 1 && hasBoundaries(code);
      // Число с подписью («Итого: 269»): остальная строка совпала — дело в вычислении, а не в тексте.
      const labelled = diff.expectedNumber !== undefined && diff.expectedNumber.trim() !== expected.trim();
      const detail = labelled
        ? offByOne
          ? ' Текст совпал, а число отличается ровно на 1.'
          : ' Текст совпал, отличается только число.'
        : offByOne
          ? ' Разница ровно на 1.'
          : '';
      return feedback(
        'output',
        'Другое число',
        `${base}${detail}`,
        offByOne
          ? 'Проверь границы: range(a, b) не включает b, а < и <= дают разный результат.'
          : inputLines(stdin).length > 0
            ? 'Посчитай вручную для ввода из теста и найди шаг, где вычисление расходится.'
            : 'Посчитай вручную, что должно получиться, и найди шаг, где вычисление расходится, — число должна посчитать программа.',
        extra,
      );
    }
    case 'cut': {
      const missing = expected.slice(actual.length);
      return feedback(
        'output',
        'Строка короче ожидаемой',
        `${base} Не хватает окончания ${q(shown(missing))}.`,
        // Недостающие цифры — это значение, которое должна вывести программа, а не текст для print.
        /\d/.test(missing)
          ? 'Похоже, в строку не попало посчитанное значение. Передай в print переменную или выражение, которое его считает, — само число вручную не пиши.'
          : 'Допиши недостающую часть в то, что печатает print.',
        extra,
      );
    }
    case 'extra-text':
      return feedback(
        'output',
        'Лишний текст в строке',
        `${base} Лишнее — ${q(shown(actual.slice(expected.length)))}.`,
        'Убери лишнее из того, что печатает print.',
        extra,
      );
    default:
      return feedback('output', 'Вывод отличается', base, 'Сравни строку с ожидаемой посимвольно: слова, знаки препинания, пробелы.', extra);
  }
}

function countCalls(code: string, name: string): number {
  return [...code.matchAll(new RegExp(`\\b${name}\\s*\\(`, 'g'))].length;
}

function outputFeedback(result: TestResult, code: string, info: TestInfo): Feedback {
  const diff = result.diff;
  const extra: Partial<Feedback> = { where: info.where, testId: info.id, verify: verifyTest(info.label) };
  if (!diff) {
    return feedback('output', 'Вывод не совпал', 'Вывод программы отличается от ожидаемого в этом тесте.', 'Сравни свой вывод с ожидаемым построчно.', extra);
  }
  switch (diff.kind) {
    case 'empty': {
      if (!/\bprint\s*\(/.test(code)) {
        return feedback(
          'output',
          'Программа ничего не вывела',
          'Тест ждал вывод, но в программе нет print — без него на экране ничего не появится.',
          'Выведи результат через print(...).',
          extra,
        );
      }
      const uncalled = definedFunctions(code, 'top').find((name) => countCalls(code, name) <= 1);
      if (uncalled) {
        return feedback(
          'output',
          'Программа ничего не вывела',
          `Функция ${q(uncalled)} объявлена, но нигде не вызывается, поэтому её код не выполняется.`,
          `Вызови её после объявления: ${uncalled}(...).`,
          extra,
        );
      }
      return feedback(
        'output',
        'Программа ничего не вывела',
        `Тест ждал ${q(shown(diff.expectedLine))}, а программа ничего не напечатала.`,
        'Проверь, что print выполняется: не стоит ли он внутри условия, которое не срабатывает?',
        extra,
      );
    }
    case 'missing': {
      if (diff.line === null) {
        return feedback(
          'output',
          'Нет нужного фрагмента',
          `В выводе должен быть фрагмент ${q(shown(diff.expectedLine))}, а его нет.`,
          'Сравни свой вывод с ожидаемым и допиши недостающее.',
          extra,
        );
      }
      const printed = diff.line - 1;
      const count = diff.count ?? 1;
      const needed = printed + count;
      const lacking =
        count === 1
          ? `не хватает строки ${q(shown(diff.expectedLine))}`
          : `не хватает ${count} ${plural(count, 'строки', 'строк', 'строк')}, первая из них — ${q(shown(diff.expectedLine))}`;
      return feedback(
        'output',
        'Не хватает строк',
        `Программа вывела ${printed} ${plural(printed, 'строку', 'строки', 'строк')}, а нужно ${needed}: ${lacking}.`,
        count === 1 && /\brange\s*\(/.test(code)
          ? 'Не заканчивается ли цикл на шаг раньше? Правая граница range(a, b) в результат не входит.'
          : 'Проверь, все ли значения выводятся: может быть, цикл заканчивается раньше или одного print не хватает.',
        extra,
      );
    }
    case 'extra': {
      const count = diff.count ?? 1;
      return feedback(
        'output',
        'Лишние строки',
        count === 1
          ? `После ожидаемого вывода программа напечатала ещё одну строку: ${q(shown(diff.actualLine))}.`
          : `После ожидаемого вывода программа напечатала ещё ${count} ${plural(count, 'строку', 'строки', 'строк')}, первая из них — ${q(shown(diff.actualLine))}.`,
        count === 1 && /\brange\s*\(/.test(code)
          ? 'Не делает ли цикл лишний шаг? Правая граница range(a, b) в результат не входит.'
          : 'Найди print, который выводит лишнее: возможно, он стоит внутри цикла или остался после отладки.',
        extra,
      );
    }
    case 'pattern': {
      const label = info.test?.kind === 'io' ? info.test.expectedLabel : undefined;
      const first = diff.actualLine ? `Первая строка вывода: ${q(shown(diff.actualLine))}.` : 'Вывод пустой.';
      return feedback(
        'output',
        'Вывод не подходит под формат',
        label
          ? `Ожидался вывод в виде: ${/[.!?…]$/.test(label) ? label : `${label}.`} ${first}`
          : `Вывод не подходит под ожидаемый формат. ${first}`,
        'Сравни свой вывод с примером в условии: порядок, слова и знаки.',
        extra,
      );
    }
    case 'mismatch':
      return mismatchFeedback(diff, code, info);
    default:
      return feedback('output', 'Вывод не совпал', 'Вывод программы отличается от ожидаемого в этом тесте.', 'Сравни свой вывод с ожидаемым построчно.', extra);
  }
}

function callFeedback(result: TestResult, code: string, info: TestInfo): Feedback {
  const call = clip(result.call ?? (info.test?.kind === 'call' ? info.test.call : 'функция'));
  const actualFull = result.actual ?? '?';
  const expectedFull = result.expected ?? (info.test?.kind === 'call' ? info.test.expected : '?');
  const [expected, actual] = shownPair(expectedFull, actualFull);
  const actualType = result.actualType;
  const expectedType = result.expectedType;
  const extra: Partial<Feedback> = { where: info.where, testId: info.id, verify: verifyTest(info.label) };
  const numeric = (type: string | undefined) => type === 'int' || type === 'float';

  if (actualType === 'NoneType' && expectedType && expectedType !== 'NoneType') {
    const printed = (result.output ?? '').trim() !== '';
    return feedback(
      'output',
      'Функция ничего не вернула',
      printed
        ? `Вызов ${call} вернул None: результат печатается через print, но не возвращается.`
        : `Вызов ${call} вернул None — в функции нет return или он не выполняется.`,
      printed
        ? 'Замени print(...) внутри функции на return: проверка получает именно возвращённое значение.'
        : 'Добавь return с результатом и проверь, что он выполняется при любом условии.',
      extra,
    );
  }
  if (actualType && expectedType && actualType !== expectedType && !(numeric(actualType) && numeric(expectedType))) {
    let tryThis = `Проверь, что функция возвращает значение нужного типа — ${typeLabel(expectedType)}.`;
    if (actualType === 'str' && numeric(expectedType)) tryThis = 'Преврати результат в число: int(...) или float(...).';
    else if (numeric(actualType) && expectedType === 'str') tryThis = 'Преврати результат в строку: str(...).';
    else if (expectedType === 'bool') tryThis = 'Верни результат сравнения: например, return a > b даёт True или False.';
    return feedback(
      'output',
      'Значение другого типа',
      `Вызов ${call} вернул ${actual} — это ${typeLabel(actualType)}, а ожидалось ${expected} — ${typeLabel(expectedType)}.`,
      tryThis,
      extra,
    );
  }
  const bothBool = /^(True|False)$/.test(actualFull) && /^(True|False)$/.test(expectedFull);
  const a = parseNumber(actualFull);
  const e = parseNumber(expectedFull);
  const offByOne = a !== null && e !== null && Math.abs(a - e) === 1 && hasBoundaries(code);
  return feedback(
    'output',
    'Функция вернула другое значение',
    `Вызов ${call} вернул ${actual}, а ожидалось ${expected}.`,
    bothBool
      ? 'Результат противоположный: проверь условие — не перепутаны ли < и > или == и !=?'
      : offByOne
        ? 'Разница ровно на 1: проверь границы — range(a, b) не включает b, а < и <= дают разный результат.'
        : 'Посчитай вручную, что функция должна вернуть для этих аргументов, и найди шаг, где код расходится с расчётом.',
    extra,
  );
}

function assertFeedback(result: TestResult, info: TestInfo): Feedback {
  const message = result.message ?? (info.test?.kind === 'assert' ? info.test.message : undefined);
  return feedback(
    'output',
    'Проверка не прошла',
    message || 'Условие проверки не выполнилось.',
    'Проверь, что делает код в этом случае: выведи промежуточные значения через print.',
    { where: info.where, testId: info.id, verify: verifyTest(info.label) },
  );
}

/** Разбор одного непрошедшего теста. */
function testFeedback(exercise: Exercise, code: string, result: TestResult, index: number): Feedback {
  const info = testInfo(exercise, result, index);
  if (result.interrupted === 'timeout') return timeoutFeedback(code, null, info, 'check');
  if (result.error) return testErrorFeedback(result.error, code, info);
  if (result.limit) return limitFeedback(info);
  if (result.kind === 'call') return callFeedback(result, code, info);
  if (result.kind === 'assert') return assertFeedback(result, info);
  return outputFeedback(result, code, info);
}

function ruleFeedback(rule: RuleResult, testsPassed: boolean): Feedback {
  return feedback(
    'rule',
    'Не выполнено требование к коду',
    testsPassed
      ? 'Вывод верный, но в задании есть требование к устройству программы, и оно пока не выполнено.'
      : 'В задании есть требование к устройству программы, и оно пока не выполнено.',
    rule.message,
    {
      verify: testsPassed
        ? `Нажми ${CHECK_BUTTON}: требование должно выполниться, а тесты — остаться зелёными.`
        : `Нажми ${CHECK_BUTTON}: требование должно отметиться как выполненное.`,
    },
  );
}

// ------------------------------------------------------------------ разборы из материалов

function matches(when: Matcher, code: string, result: CheckResult): boolean {
  const subject = subjectTest(when, result);
  const error = result.compileError ?? subject?.error ?? null;
  // Вывод сравниваем, только если программа дошла до конца. После ошибки или остановки по лимиту
  // вывод оборван: «Меню дня, Капучино» перед NameError совпадёт с разбором «не хватает строки»,
  // хотя дело в ошибке. Исключение — разбор с условием на ошибку: там вывод — часть его условия.
  const outputComplete =
    subject !== null && (hasErrorCondition(when) || (!subject.error && !subject.limit && !subject.interrupted));
  const rawOutput = outputComplete ? (subject.output ?? '') : null;
  const output = rawOutput === null ? null : normalizeOutput(rawOutput);
  let checked = 0;
  const check = (value: string | undefined, test: (value: string) => boolean): boolean => {
    if (value === undefined) return true;
    checked++;
    return test(value);
  };
  const ok =
    check(when.errorType, (value) => error?.type === value) &&
    check(when.errorIncludes, (value) => !!error && (error.summary.includes(value) || error.message.includes(value))) &&
    check(when.outputEquals, (value) => output !== null && output === normalizeOutput(value)) &&
    check(when.outputIncludes, (value) => output !== null && (output.includes(value) || (rawOutput ?? '').includes(value))) &&
    check(when.codeIncludes, (value) => code.includes(value)) &&
    check(when.codeRegex, (value) => {
      try {
        return new RegExp(value, 'm').test(code);
      } catch {
        return false;
      }
    }) &&
    check(when.failedTest, (value) =>
      result.tests.some((test) => test.id === value && !test.passed && test.interrupted !== 'skipped'),
    ) &&
    check(when.failedRule, (value) => result.rules.some((rule) => rule.id === value && !rule.passed));
  return ok && checked > 0;
}

/**
 * Первый разбор из exercise.mistakes, у которого выполнены все условия when.
 * Если проверка полностью прошла — null.
 *
 * Условия на ошибку и на вывод проверяются по одному тесту (см. subjectTest):
 * - errorType / errorIncludes — ошибка компиляции или ошибка первого теста с ошибкой;
 *   outputEquals / outputIncludes в том же разборе смотрят вывод этого же теста;
 * - без условия на ошибку outputEquals / outputIncludes смотрят вывод первого непрошедшего теста
 *   и не срабатывают, если в нём программа упала с ошибкой, превысила лимит вывода или была прервана;
 * - failedTest, failedRule, codeIncludes, codeRegex от выбора теста не зависят.
 */
export function matchMistake(exercise: Exercise, code: string, result: CheckResult): Mistake | null {
  if (isCheckPassed(result)) return null;
  for (const mistake of exercise.mistakes ?? []) {
    if (matches(mistake.when, code, result)) return mistake;
  }
  return null;
}

/** Строка кода, на которую указывает условие разбора (codeRegex / codeIncludes). */
function mistakeCodeLine(when: Matcher, code: string): number | null {
  let index = -1;
  if (when.codeRegex) {
    try {
      const match = new RegExp(when.codeRegex, 'm').exec(code);
      if (match) index = match.index;
    } catch {
      index = -1;
    }
  }
  if (index < 0 && when.codeIncludes) index = code.indexOf(when.codeIncludes);
  if (index < 0) return null;
  return code.slice(0, index).split('\n').length;
}

/**
 * Заголовок разбора из материалов. Своего заголовка у Mistake нет, поэтому он строится по смыслу
 * сработавшего условия. Заголовок ошибки берётся только для разбора с условием на ошибку — раз условие
 * выполнено, это та самая ошибка. Заголовок посторонней ошибки к разбору не подставляется.
 */
function mistakeTitle(exercise: Exercise, code: string, result: CheckResult, when: Matcher, target: TestResult | null): string {
  if (hasErrorCondition(when)) {
    if (result.compileError) return explainError(result.compileError, code).title;
    const errorTest = firstErrorTest(result);
    if (errorTest) return testFeedback(exercise, code, errorTest, result.tests.indexOf(errorTest)).title;
  }
  if (when.failedRule !== undefined) return 'Не выполнено требование к коду';
  if (when.outputEquals !== undefined || when.outputIncludes !== undefined) return 'Вывод не совпал';
  if (when.failedTest !== undefined && target) {
    if (target.error || target.limit || target.interrupted) {
      return `Не прошёл тест ${q(testInfo(exercise, target, result.tests.indexOf(target)).label)}`;
    }
    if (target.kind === 'call') return 'Функция вернула другое значение';
    if (target.kind === 'assert') return 'Проверка не прошла';
    return 'Вывод не совпал';
  }
  return 'Разбор типичной ошибки';
}

function mistakeFeedback(exercise: Exercise, code: string, result: CheckResult, mistake: Mistake): Feedback {
  const when = mistake.when;
  let base: Feedback | null = null;
  let target: TestResult | null = null;

  if (result.compileError) {
    base = compileFeedback(result.compileError, code, firstTestVerify(exercise));
  } else {
    const rule = when.failedRule ? result.rules.find((item) => item.id === when.failedRule && !item.passed) : undefined;
    if (rule) {
      base = ruleFeedback(rule, result.tests.every((test) => test.passed));
    } else {
      // Тот же тест, по которому сработали условия разбора (или тест из failedTest).
      target =
        (when.failedTest ? result.tests.find((test) => test.id === when.failedTest && !test.passed) : undefined) ??
        subjectTest(when, result);
      if (target) {
        base = testFeedback(exercise, code, target, result.tests.indexOf(target));
      } else {
        const failedRule = result.rules.find((item) => !item.passed);
        if (failedRule) base = ruleFeedback(failedRule, true);
      }
    }
  }

  // «Проверь» по умолчанию — конкретный тест, который должен стать зелёным.
  let verify = base?.verify ?? null;
  if (target) verify = verifyTest(testInfo(exercise, target, result.tests.indexOf(target)).label);

  const codeLine = mistakeCodeLine(when, code);
  const line = base?.line ?? codeLine;
  let where = mistake.where ?? base?.where ?? null;
  if (!where && codeLine) {
    const text = code.split(/\r?\n/)[codeLine - 1]?.trim();
    where = text ? `Строка ${codeLine}: ${clip(text)}` : `Строка ${codeLine}`;
  }

  return {
    source: 'mistake',
    title: mistakeTitle(exercise, code, result, when, target),
    where,
    why: mistake.why,
    tryThis: mistake.try,
    verify: mistake.verify ?? verify,
    raw: base?.raw ?? null,
    line,
    testId: base?.testId ?? target?.id ?? null,
    mistakeId: mistake.id,
  };
}

// ------------------------------------------------------------------ публичные функции

/**
 * Разбор результата «Проверить». Порядок: сбой среды → тайм-аут → (остановлено: null) →
 * синтаксическая ошибка → разбор из материалов → ошибка выполнения → лимит вывода →
 * первый непрошедший тест → требование к коду. Всё прошло — null.
 * Требование к коду разбирается последним: пока вывод неверный, главное — он, а совет
 * про устройство программы у незаконченного кода часто не о том.
 */
export function buildCheckFeedback(exercise: Exercise, code: string, outcome: CheckOutcome): Feedback | null {
  if (outcome.status === 'failed') return environmentFailure(outcome.message, 'check');
  if (outcome.status === 'timeout') {
    const test = exercise.tests[outcome.testIndex];
    const info = test ? testInfo(exercise, null, outcome.testIndex, test) : null;
    return timeoutFeedback(code, outcome.limitMs, info, 'check');
  }
  if (outcome.status === 'stopped') return null;

  const result = outcome.result;
  if (result.compileError) {
    const mistake = matchMistake(exercise, code, result);
    return mistake
      ? mistakeFeedback(exercise, code, result, mistake)
      : compileFeedback(result.compileError, code, firstTestVerify(exercise));
  }
  if (isCheckPassed(result)) return null;

  const mistake = matchMistake(exercise, code, result);
  if (mistake) return mistakeFeedback(exercise, code, result, mistake);

  const withError = result.tests.find((test) => test.error);
  if (withError) return testFeedback(exercise, code, withError, result.tests.indexOf(withError));

  const timedOut = result.tests.find((test) => test.interrupted === 'timeout');
  if (timedOut) return testFeedback(exercise, code, timedOut, result.tests.indexOf(timedOut));

  const limited = result.tests.find((test) => test.limit);
  if (limited) return testFeedback(exercise, code, limited, result.tests.indexOf(limited));

  const failed = firstFailedTest(result);
  if (failed) return testFeedback(exercise, code, failed, result.tests.indexOf(failed));

  const rule = result.rules.find((item) => !item.passed);
  if (rule) return ruleFeedback(rule, result.tests.every((test) => test.passed));
  return null;
}

/** Разбор обычного запуска («Запустить»): ошибки, тайм-аут, лимит вывода, сбой среды. Иначе null. */
export function buildRunFeedback(code: string, outcome: RunOutcome): Feedback | null {
  if (outcome.status === 'failed') return environmentFailure(outcome.message, 'run');
  if (outcome.status === 'timeout') return timeoutFeedback(code, outcome.limitMs, null, 'run');
  if (outcome.status === 'stopped') return null;
  const result = outcome.result;
  if (result.compileError) return compileFeedback(result.compileError, code, RUN_COMPILE_VERIFY);
  if (result.error) return runErrorFeedback(result.error, code);
  if (result.limit) return limitFeedback(null);
  return null;
}
