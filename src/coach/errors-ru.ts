// Понятные объяснения ошибок Python 3.14 на русском для режима «Подсказки курса».
// Работает офлайн: разбирает настоящие сообщения Python (поля message и summary из harness.py)
// и превращает их в короткое «почему» и одно действие «попробуй».

import type { PyError } from '../runner/types.ts';
import type { ErrorCategory } from './types.ts';

export interface ErrorExplanation {
  /** Короткий заголовок: «Незакрытая строка». */
  title: string;
  /** Причина простыми словами. */
  why: string;
  /** Одно действие или наводящий вопрос. */
  tryThis: string;
  /** true — ограничение браузерной среды, а не ошибка ученика. */
  environment: boolean;
}

interface Context {
  error: PyError;
  message: string;
  summary: string;
  /** Подсказка Python «Did you mean: 'print'?», если есть. */
  hint: string | null;
  lineText: string;
  code: string | null;
}

// ------------------------------------------------------------------ общие помощники

/** Текст в кавычках-лапках: „print“. */
export function q(text: string): string {
  return `„${text}“`;
}

export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/**
 * Значение из таблицы только по собственному ключу: имя класса ученика вроде «constructor»
 * или «__proto__» не должно доставать свойства Object.prototype.
 */
function own(table: Record<string, string>, key: string): string | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/** Первая буква — заглавная (для начала предложения). */
function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const TYPE_NAMES: Record<string, string> = {
  int: 'целое число (int)',
  float: 'дробное число (float)',
  complex: 'комплексное число (complex)',
  str: 'строка (str)',
  bool: 'логическое значение (bool)',
  list: 'список (list)',
  tuple: 'кортеж (tuple)',
  dict: 'словарь (dict)',
  set: 'множество (set)',
  NoneType: 'None',
  function: 'функция',
  builtin_function_or_method: 'встроенная функция',
  method: 'метод',
  range: 'range',
  module: 'модуль',
  type: 'тип',
};

/** Те же названия в родительном падеже: «у строки (str)», «после целого числа (int)». */
const TYPE_NAMES_GENITIVE: Record<string, string> = {
  int: 'целого числа (int)',
  float: 'дробного числа (float)',
  complex: 'комплексного числа (complex)',
  str: 'строки (str)',
  bool: 'логического значения (bool)',
  list: 'списка (list)',
  tuple: 'кортежа (tuple)',
  dict: 'словаря (dict)',
  set: 'множества (set)',
  NoneType: 'None',
  function: 'функции',
  builtin_function_or_method: 'встроенной функции',
  method: 'метода',
  range: 'range',
  module: 'модуля',
  type: 'типа (type)',
};

/**
 * Название типа Python для ученика в именительном падеже: «строка (str)».
 * Ставь его после тире или двоеточия («а здесь — строка (str)»), чтобы не зависеть от падежа.
 */
export function typeLabel(type: string): string {
  return own(TYPE_NAMES, type) ?? type;
}

/** Название типа в родительном падеже: «строки (str)»; незнакомый тип — «значения типа Dog». */
export function typeLabelGenitive(type: string): string {
  return own(TYPE_NAMES_GENITIVE, type) ?? `значения типа ${type}`;
}

function isNumberType(type: string): boolean {
  return type === 'int' || type === 'float';
}

/** Расстояние Левенштейна — для подсказок «похоже на опечатку». */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return prev[b.length];
}

/** Самое похожее имя из списка (не дальше двух правок), кроме точного совпадения. */
export function closestName(name: string, candidates: Iterable<string>): string | null {
  let best: string | null = null;
  let bestDistance = Infinity;
  const limit = name.length <= 3 ? 1 : 2;
  for (const candidate of candidates) {
    if (candidate === name) continue;
    const distance =
      candidate.toLowerCase() === name.toLowerCase() ? 0.5 : editDistance(name.toLowerCase(), candidate.toLowerCase());
    if (distance <= limit && distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Подсказка Python: «Did you mean: 'print'?» или «Did you mean 'for'?». */
function didYouMean(error: PyError): string | null {
  for (const text of [error.summary, error.message, error.raw]) {
    const match = /Did you mean:? '([^']+)'\?/.exec(text ?? '');
    if (match) return match[1];
  }
  return null;
}

function explanation(title: string, why: string, tryThis: string, environment = false): ErrorExplanation {
  return { title, why, tryThis, environment };
}

// ------------------------------------------------------------------ синтаксис и отступы

const TYPOGRAPHIC_QUOTES = new Set(['«', '»', '“', '”', '„', '‟', '‘', '’', '‚', '‛', '″', '′', '＂', '＇']);
const DASHES = new Set(['—', '–', '−', '‐', '‑', '‒']);
const KEYWORDS = [
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del',
  'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal',
  'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
];
const BRACKET_PAIRS: Record<string, string> = { '(': ')', '[': ']', '{': '}', ')': '(', ']': '[', '}': '{' };

function blockKeyword(lineText: string): string | null {
  const match = /^\s*(if|elif|else|for|while|def|class|try|except|finally|with|match|case)\b/.exec(lineText);
  return match ? match[1] : null;
}

/** Строка кода без строковых литералов и комментария — чтобы искать то, что стоит вне кавычек. */
function outsideQuotes(lineText: string): string {
  return lineText
    .replace(/"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?/g, ' ')
    .replace(/#.*$/, '');
}

/**
 * Русские слова вне кавычек: print(Привет мир) — текст забыли взять в кавычки.
 * Слова, которым в коде присваивается значение (русские имена переменных допустимы), не считаются.
 */
function hasBareCyrillic(lineText: string, code: string | null): boolean {
  const words = outsideQuotes(lineText).match(/[А-Яа-яЁё][А-Яа-яЁё\w]*/g) ?? [];
  // \b в JS знает только латиницу, поэтому границу слова задаём явно.
  const end = '(?![А-Яа-яЁё\\w])';
  return words.some(
    (word) => !code || !new RegExp(`^\\s*(?:${word}\\s*=(?!=)|for\\s+${word}${end}|def\\s+${word}${end})`, 'm').test(code),
  );
}

function bareText(): ErrorExplanation {
  return explanation(
    'Текст без кавычек?',
    'Русские слова стоят в коде без кавычек, поэтому Python принимает их за имена переменных и не может разобрать строку.',
    'Возьми текст в прямые кавычки: print("Привет, мир!").',
  );
}

/**
 * Незакрытая строка: какой кавычкой она открыта и не закрыта ли кавычкой другого вида.
 * col из SyntaxError указывает на начало строки (для f"…" — на букву f).
 */
function mixedQuotes(lineText: string, col: number | null): boolean {
  let start = col && col > 0 ? col - 1 : -1;
  while (start >= 0 && start < lineText.length && /[rRbBfFuUtT]/.test(lineText[start])) start++;
  if (start < 0 || start >= lineText.length) return false;
  const opener = lineText[start];
  if (opener !== '"' && opener !== "'") return false;
  const other = opener === '"' ? "'" : '"';
  // Конец текста: без закрывающих скобок, двоеточия, запятых и пробелов в конце строки кода.
  const rest = lineText.slice(start + 1).replace(/[\s)\]}:,;]+$/, '');
  return rest.length > 0 && rest.endsWith(other);
}

function explainSyntax(ctx: Context): ErrorExplanation {
  const { message, lineText } = ctx;
  let m: RegExpExecArray | null;

  // --- отступы
  if (ctx.error.type === 'TabError' || /inconsistent use of tabs and spaces/.test(message)) {
    return explanation(
      'Табуляция и пробелы вперемешку',
      'В отступах смешаны табуляция и пробелы, и Python не может понять уровень вложенности.',
      'Перепиши отступы этого блока только пробелами — по 4 на уровень.',
    );
  }
  if ((m = /expected an indented block after (?:'(\w+)' statement|(function) definition|(class) definition) on line (\d+)/.exec(message))) {
    const keyword = m[1] ?? (m[2] ? 'def' : 'class');
    return explanation(
      'Нет отступа',
      `После строки ${m[4]} с ${q(keyword)} должен идти блок с отступом, а его нет.`,
      'Сдвинь строки, которые относятся к этому блоку, на 4 пробела вправо; если блок пока пустой — напиши в нём pass.',
    );
  }
  if (/expected an indented block/.test(message)) {
    return explanation(
      'Нет отступа',
      'После строки с двоеточием должен идти блок с отступом, а его нет.',
      'Сдвинь строки, которые относятся к этому блоку, на 4 пробела вправо.',
    );
  }
  if (/unexpected indent/.test(message)) {
    return explanation(
      'Лишний отступ',
      'Строка сдвинута вправо, хотя новый блок здесь не начинается.',
      'Убери пробелы в начале строки, чтобы она стояла вровень с соседними.',
    );
  }
  if (/unindent does not match any outer indentation level/.test(message)) {
    return explanation(
      'Отступ не совпадает',
      'Отступ этой строки не совпадает ни с одним уровнем выше — например, 3 пробела вместо 4.',
      'Выровняй строку по началу блока, к которому она относится; отступы делай по 4 пробела.',
    );
  }

  // --- строки и кавычки
  if (/unterminated triple-quoted string literal/.test(message)) {
    return explanation(
      'Незакрытая многострочная строка',
      'Текст в тройных кавычках открыт, но до конца программы так и не закрыт.',
      'Поставь в конце текста такие же три кавычки.',
    );
  }
  if (/unterminated (?:[a-z]+-)?string literal/.test(message)) {
    // «Разные кавычки» — только если текст открыт одной кавычкой и в конце стоит другая: print("Привет').
    // Апостроф внутри текста (print("It's)) — это просто незакрытая строка.
    if (mixedQuotes(lineText, ctx.error.col)) {
      return explanation(
        'Разные кавычки у строки',
        'Текст открыт одной кавычкой, а закрыт другой, поэтому Python не видит конца строки.',
        'Сделай кавычки в начале и в конце одинаковыми: "Привет" или \'Привет\'.',
      );
    }
    return explanation(
      'Незакрытая строка',
      'Текст начинается с кавычки, но в этой строке кода нет закрывающей кавычки.',
      'Поставь в конце текста такую же кавычку, как в начале: print("Привет").',
    );
  }
  if (message.startsWith('f-string: ')) {
    return explanation(
      'Ошибка в f-строке',
      'Внутри f-строки выражение пишут в фигурных скобках, и здесь они не сходятся.',
      'Проверь, что каждая „{“ закрыта „}“, например f"Привет, {name}!".',
    );
  }

  // --- скобки
  if ((m = /closing parenthesis '(.)' does not match opening parenthesis '(.)'/.exec(message))) {
    return explanation(
      'Скобки не совпадают',
      `Скобка ${q(m[2])} закрыта скобкой ${q(m[1])}, а пары должны совпадать: () [] {}.`,
      `Замени ${q(m[1])} на ${q(BRACKET_PAIRS[m[2]] ?? ')')} или проверь, где закрывается каждая скобка.`,
    );
  }
  if ((m = /'(.)' was never closed/.exec(message))) {
    const close = BRACKET_PAIRS[m[1]] ?? ')';
    return explanation(
      'Незакрытая скобка',
      `Скобка ${q(m[1])} открыта, но так и не закрыта.`,
      `Добавь ${q(close)} там, где заканчивается выражение: сколько скобок открыто, столько и закрыто.`,
    );
  }
  if ((m = /unmatched '(.)'/.exec(message))) {
    return explanation(
      'Лишняя скобка',
      `У закрывающей скобки ${q(m[1])} нет открывающей пары.`,
      `Убери лишнюю ${q(m[1])} или добавь пропущенную ${q(BRACKET_PAIRS[m[1]] ?? '(')} перед ней.`,
    );
  }

  // --- двоеточие и скобки после def
  if (/expected ':'/.test(message)) {
    const keyword = blockKeyword(lineText);
    return explanation(
      'Не хватает двоеточия',
      keyword
        ? `Строка с ${q(keyword)} должна заканчиваться двоеточием — так начинается вложенный блок.`
        : 'После if, for, while, def и else нужно двоеточие — так начинается вложенный блок.',
      'Поставь „:“ в конце этой строки.',
    );
  }
  if (/expected '\('/.test(message)) {
    if (/^\s*def\b/.test(lineText)) {
      return explanation(
        'Не хватает скобок после имени функции',
        'После имени функции в def нужны круглые скобки, даже если параметров нет.',
        'Запиши так: def имя(): или def имя(параметр):.',
      );
    }
    return explanation('Не хватает скобки', 'Python ждал в этом месте открывающую скобку „(“.', 'Добавь „(“ в отмеченном месте.');
  }

  // --- символы, которых нет в Python
  if (/invalid non-printable character/.test(message)) {
    return explanation(
      'Невидимый символ',
      'В строке есть невидимый символ — он часто попадает в код при копировании из документа или сайта.',
      'Сотри пробелы вокруг отмеченного места и набери их заново.',
    );
  }
  if ((m = /invalid character '(.)'/u.exec(message))) {
    const char = m[1];
    if (TYPOGRAPHIC_QUOTES.has(char)) {
      return explanation(
        'Неподходящие кавычки',
        'Ёлочки и типографские кавычки не подходят: Python понимает только прямые " или \'.',
        'Замени обе кавычки на прямые из английской раскладки: print("Привет").',
      );
    }
    if (DASHES.has(char)) {
      return explanation(
        'Тире вместо минуса',
        `Символ ${q(char)} похож на минус, но это тире, и Python его не понимает.`,
        'Замени его на обычный минус „-“ с клавиатуры.',
      );
    }
    if (char === '×' || char === '·' || char === '✕') {
      return explanation('Неверный знак умножения', `Символ ${q(char)} Python не понимает.`, 'Для умножения используй „*“: 2 * x.');
    }
    if (char === '÷') {
      return explanation('Неверный знак деления', `Символ ${q(char)} Python не понимает.`, 'Для деления используй „/“, а для целого деления — „//“.');
    }
    return explanation(
      'Недопустимый символ',
      `Символ ${q(char)} нельзя использовать в коде вне кавычек.`,
      'Удали его или замени обычным символом с клавиатуры; если это часть текста — возьми текст в кавычки.',
    );
  }

  // --- print без скобок, пропущенная запятая, числа
  if ((m = /Missing parentheses in call to '(\w+)'/.exec(message))) {
    return explanation(
      `Нужны скобки после ${m[1]}`,
      `В Python 3 ${m[1]} — функция, и то, что ей передают, пишут в круглых скобках.`,
      `Запиши так: ${m[1]}("Привет").`,
    );
  }
  if (/Perhaps you forgot a comma/.test(message)) {
    // print(Привет мир): запятая здесь не поможет — дальше будет NameError. Нужны кавычки.
    if (hasBareCyrillic(lineText, ctx.code)) return bareText();
    return explanation(
      'Пропущена запятая?',
      'Два значения стоят рядом без знака между ними, и Python не понимает, как их связать.',
      'Поставь между значениями запятую, например print("Итог:", total), или нужный знак операции.',
    );
  }
  if (/leading zeros in decimal integer literals/.test(message)) {
    return explanation(
      'Число с ведущим нулём',
      'Целые числа в Python не пишут с нулём в начале: 05 — ошибка.',
      'Убери ноль в начале числа; если нужен именно текст «05» — возьми его в кавычки.',
    );
  }
  if (/invalid (?:decimal|hexadecimal|octal|binary) literal|invalid digit '.' in/.test(message)) {
    return explanation(
      'Цифры и буквы слитно',
      'Сразу после цифры идут буквы — так нельзя записать ни число, ни имя переменной.',
      'Имя переменной начинай с буквы (x1, а не 1x), умножение пиши через * (2 * x), а текст бери в кавычки.',
    );
  }

  // --- = и ==
  if (/Maybe you meant '==' |perhaps you meant "=="|Maybe you meant '==' or ':='/.test(message)) {
    return explanation(
      'Перепутаны = и ==',
      'Одно „=“ сохраняет значение в переменную, а для сравнения нужно два: „==“.',
      'Если здесь сравнение — замени = на ==, например if x == 5:.',
    );
  }
  if (/cannot assign to /.test(message)) {
    return explanation(
      'Слева от = должно быть имя',
      'Присвоить значение можно только переменной, а слева от „=“ стоит выражение или готовое значение.',
      'Запиши имя переменной слева, а вычисление справа: total = a + b.',
    );
  }

  // --- слова не на своём месте
  if ((m = /'(return|yield)' outside function/.exec(message))) {
    return explanation(
      `${m[1]} вне функции`,
      `${m[1]} возвращает результат из функции, а эта строка находится не внутри def.`,
      'Проверь отступ: строка должна быть сдвинута внутрь функции. Чтобы показать результат вне функции, используй print.',
    );
  }
  if ((m = /'(break|continue)' (?:outside loop|not properly in loop)/.exec(message))) {
    return explanation(
      `${m[1]} вне цикла`,
      `${m[1]} работает только внутри цикла for или while, а эта строка не внутри цикла.`,
      'Проверь отступ: строка должна быть сдвинута внутрь цикла.',
    );
  }
  if (/expected 'except' or 'finally' block/.test(message)) {
    return explanation(
      'После try нужен except',
      'За блоком try должен идти блок except (или finally) на том же уровне отступа.',
      'Добавь except после блока try или проверь отступы строк внутри try.',
    );
  }
  if (/unexpected character after line continuation character/.test(message)) {
    return explanation(
      'Лишний символ после \\',
      'Обратная косая черта \\ вне кавычек означает перенос строки, и после неё ничего не должно быть.',
      'Для деления используй /, а \\ оставь только внутри текста в кавычках.',
    );
  }

  // --- invalid syntax: уточняем по строке кода
  if (/invalid syntax/.test(message) || message === '') {
    if (ctx.hint && KEYWORDS.includes(ctx.hint)) {
      return explanation(
        'Опечатка в ключевом слове?',
        'Python не узнал слово в этой строке — похоже на опечатку в ключевом слове.',
        `Возможно, здесь должно быть ${q(ctx.hint)}.`,
      );
    }
    const keywordAssign = new RegExp(`^\\s*(${KEYWORDS.join('|')})\\s*=(?!=)`).exec(lineText);
    if (keywordAssign) {
      return explanation(
        'Служебное слово вместо имени',
        `${q(keywordAssign[1])} — служебное слово Python, его нельзя использовать как имя переменной.`,
        `Выбери другое имя, например my_${keywordAssign[1].toLowerCase()}.`,
      );
    }
    const orphan = /^\s*(else|elif)\b/.exec(lineText);
    if (orphan) {
      return explanation(
        `${orphan[1]} без if`,
        `${q(orphan[1])} должен идти сразу после блока if и стоять с тем же отступом, что и if.`,
        'Выровняй его по строке с if и проверь, что между ними нет строк без отступа.',
      );
    }
    if (/=>|=</.test(outsideQuotes(lineText))) {
      return explanation(
        'Неверный знак сравнения',
        'В Python пишут „>=“ и „<=“: сначала знак сравнения, потом равно.',
        'Замени „=>“ на „>=“ (или „=<“ на „<=“).',
      );
    }
    if (hasBareCyrillic(lineText, ctx.code)) return bareText();
    return explanation(
      'Python не понял строку',
      'В строке нарушен порядок слов или знаков, и Python остановился в отмеченном месте.',
      'Посмотри на отмеченное место и на конец предыдущей строки: часто там не хватает скобки, кавычки или знака.',
    );
  }

  return explanation(
    'Синтаксическая ошибка',
    'Python не смог разобрать программу, поэтому она не запустилась.',
    'Посмотри на отмеченное место в строке и сравни запись с примером из урока.',
  );
}

// ------------------------------------------------------------------ ошибки выполнения

const SHADOWABLE = [
  'print', 'input', 'len', 'sum', 'max', 'min', 'str', 'int', 'float', 'list', 'dict', 'set', 'tuple', 'range',
  'type', 'round', 'abs', 'sorted', 'bool', 'open', 'map', 'filter', 'zip', 'enumerate',
];

/** Номера строк кода, где имени присваивается значение (x = …, x += …, for x in, def x(, import x, x, y = …). */
function findAssignments(lines: string[], name: string): number[] {
  const n = escapeRegExp(name);
  const pattern = new RegExp(
    `^\\s*(?:${n}\\s*(?:[-+*/%]|//|\\*\\*)?=(?!=)|for\\s+${n}\\s+in(?![\\wА-Яа-яЁё])|def\\s+${n}\\s*\\(|import\\s+${n}(?![\\wА-Яа-яЁё.])|${n}\\s*,[^=]*=(?!=))`,
  );
  const found: number[] = [];
  lines.forEach((line, index) => {
    if (pattern.test(line)) found.push(index + 1);
  });
  return found;
}

/** Имена, которые получают значение где-нибудь в коде: переменные, функции, параметры. */
function knownNames(lines: string[]): Set<string> {
  const identifier = /[A-Za-z_А-Яа-яЁё][\wА-Яа-яЁё]*/g;
  const names = new Set<string>();
  for (const line of lines) {
    const assigned = /^\s*([A-Za-z_А-Яа-яЁё][\wА-Яа-яЁё]*(?:\s*,\s*[A-Za-z_А-Яа-яЁё][\wА-Яа-яЁё]*)*)\s*(?:[-+*/%]|\/\/|\*\*)?=(?!=)/.exec(line);
    if (assigned) for (const name of assigned[1].match(identifier) ?? []) names.add(name);
    const loop = /^\s*for\s+(.+?)\s+in\s/.exec(line);
    if (loop) for (const name of loop[1].match(identifier) ?? []) names.add(name);
    const def = /^\s*(?:async\s+)?def\s+([A-Za-z_А-Яа-яЁё][\wА-Яа-яЁё]*)\s*\(([^)]*)\)/.exec(line);
    if (def) {
      names.add(def[1]);
      for (const param of def[2].split(',')) {
        const paramName = /^\s*\**([A-Za-z_А-Яа-яЁё][\wА-Яа-яЁё]*)/.exec(param)?.[1];
        if (paramName) names.add(paramName);
      }
    }
  }
  return names;
}

function indentWidth(line: string): number {
  return (/^[ \t]*/.exec(line)?.[0] ?? '').replace(/\t/g, '    ').length;
}

interface CodeScope {
  kind: 'def' | 'class';
  name: string;
  /** Номер строки с def/class. */
  line: number;
  hasParams: boolean;
}

/** Ближайшая функция или класс, внутри которых стоит строка lineNo; null — верхний уровень программы. */
function enclosingScope(lines: string[], lineNo: number): CodeScope | null {
  let indent = indentWidth(lines[lineNo - 1] ?? '');
  for (let i = lineNo - 2; i >= 0 && indent > 0; i--) {
    const line = lines[i];
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    const width = indentWidth(line);
    if (width >= indent) continue;
    const def = /^\s*(?:async\s+)?def\s+([A-Za-z_А-Яа-яЁё][\wА-Яа-яЁё]*)\s*\(([^)]*)/.exec(line);
    if (def) return { kind: 'def', name: def[1], line: i + 1, hasParams: def[2].trim() !== '' };
    const cls = /^\s*class\s+([A-Za-z_А-Яа-яЁё][\wА-Яа-яЁё]*)/.exec(line);
    if (cls) return { kind: 'class', name: cls[1], line: i + 1, hasParams: false };
    indent = width;
  }
  return null;
}

/** Строки def/class, внутри которых стоит строка lineNo (от ближайшей к внешней). */
function scopeChain(lines: string[], lineNo: number): number[] {
  const chain: number[] = [];
  for (let scope = enclosingScope(lines, lineNo); scope; scope = enclosingScope(lines, scope.line)) chain.push(scope.line);
  return chain;
}

function explainNameError(ctx: Context): ErrorExplanation {
  const { error, message, summary, hint, code } = ctx;
  const nameMatch = /name '([^']+)' is not defined/.exec(message) ?? /variable '([^']+)'/.exec(message);
  const name = nameMatch?.[1] ?? null;

  const forgotImport = /Did you forget to import '([\w.]+)'/.exec(summary) ?? /Did you forget to import '([\w.]+)'/.exec(error.raw);
  if (forgotImport) {
    return explanation(
      'Модуль не подключён',
      `Ты используешь ${q(forgotImport[1])}, но модуль не подключён.`,
      `Добавь в начало программы строку import ${forgotImport[1]}.`,
    );
  }
  if (!name) {
    return explanation(
      'Неизвестное имя',
      'Python встретил имя, которому ещё не присвоено значение.',
      'Проверь написание имени (регистр тоже важен) и что значение присваивается выше этой строки.',
    );
  }
  if (hint && hint.toLowerCase() === name.toLowerCase()) {
    return explanation(
      'Большая или маленькая буква',
      `Python различает регистр: ${q(name)} и ${q(hint)} — разные имена.`,
      `Напиши ${q(hint)}.`,
    );
  }
  if (hint) {
    return explanation(
      `Неизвестное имя ${q(name)}`,
      `Python не знает имени ${q(name)} — похоже на опечатку.`,
      `Возможно, здесь должно быть ${q(hint)}.`,
    );
  }
  const lines = code ? code.split(/\r?\n/) : null;
  if (lines && error.line) {
    const errorLine = error.line;
    const chain = scopeChain(lines, errorLine);
    const visible: number[] = [];
    const hidden: { line: number; scope: CodeScope }[] = [];
    for (const line of findAssignments(lines, name)) {
      const scope = enclosingScope(lines, line);
      // Отсюда видно то, что создано на верхнем уровне или в той же (или внешней) функции.
      if (!scope || chain.includes(scope.line)) visible.push(line);
      else hidden.push({ line, scope });
    }
    const earlier = visible.filter((line) => line < errorLine);
    const later = visible.filter((line) => line > errorLine);

    if (visible.length === 0 && hidden.length > 0) {
      const { line, scope } = hidden[0];
      if (scope.kind === 'class') {
        return explanation(
          `${q(name)} видна только внутри класса`,
          `${q(name)} создаётся внутри класса ${q(scope.name)} (строка ${line}), и просто по имени снаружи её не видно.`,
          `Обращайся к ней через класс или объект: ${scope.name}.${name}.`,
        );
      }
      return explanation(
        `${q(name)} видна только внутри функции`,
        `${q(name)} создаётся внутри функции ${q(scope.name)} (строка ${line}), а переменные функции снаружи не видны.`,
        `Верни значение из функции через return и сохрани результат при вызове: ${name} = ${scope.name}(${scope.hasParams ? '...' : ''}).`,
      );
    }
    if (later.length > 0 && earlier.length === 0) {
      return explanation(
        `${q(name)} используется до создания`,
        `Python выполняет код сверху вниз, а ${q(name)} получает значение только в строке ${later[0]}.`,
        `Перенеси присваивание из строки ${later[0]} выше строки ${errorLine}.`,
      );
    }
    if (earlier.length > 0) {
      return explanation(
        `${q(name)} ещё без значения`,
        `${q(name)} получает значение только в строке ${earlier[0]}, а эта строка при запуске не выполнилась — например, она внутри if или цикла, который не сработал.`,
        `Присвой ${q(name)} начальное значение до условия или цикла — или проверь, почему строка ${earlier[0]} не выполняется.`,
      );
    }
    const similar = closestName(name, knownNames(lines));
    if (similar) {
      return explanation(
        `Неизвестное имя ${q(name)}`,
        `Имени ${q(name)} в программе нет, зато есть похожее — ${q(similar)}.`,
        `Если это опечатка — напиши ${q(similar)}, в точности как при создании.`,
      );
    }
  }
  const cyrillic = /[А-Яа-яЁё]/.test(name);
  const capitalizedWord = /^[A-Z][a-z]{2,}$/.test(name);
  if (cyrillic || capitalizedWord) {
    return explanation(
      'Текст без кавычек?',
      `Слово ${q(name)} стоит без кавычек, поэтому Python ищет переменную с таким именем и не находит её.`,
      `Если это текст — возьми его в кавычки: "${name}". Если это переменная — сначала присвой ей значение.`,
    );
  }
  return explanation(
    `Неизвестное имя ${q(name)}`,
    `Python не знает имени ${q(name)}: к моменту выполнения этой строки ему не присвоено значение.`,
    `Проверь написание (регистр тоже важен) и что ${q(name)} получает значение до этой строки.`,
  );
}

function explainTypeError(ctx: Context): ErrorExplanation {
  const { message, lineText, code, hint } = ctx;
  let m: RegExpExecArray | null;

  if ((m = /can only concatenate (\w+) \(not "(\w+)"\) to \w+/.exec(message))) {
    if (m[1] === 'str') {
      return explanation(
        'Текст и число через +',
        `Знак „+“ склеивает строку только со строкой, а здесь к строке прибавляется ${typeLabel(m[2])}.`,
        'Передай значения через запятую: print("Итог:", x) — или преврати число в строку: str(x).',
      );
    }
    if (m[1] === 'list') {
      return explanation(
        'К списку прибавляется не список',
        `Через „+“ к списку можно прибавить только другой список, а здесь — ${typeLabel(m[2])}.`,
        'Чтобы добавить один элемент, используй items.append(x).',
      );
    }
  }
  if ((m = /unsupported operand type\(s\) for ([^:]+): '(\w+)' and '(\w+)'/.exec(message))) {
    const [, op, left, right] = m;
    if (left === 'NoneType' || right === 'NoneType') {
      return explanation(
        'None в вычислении',
        'Одно из значений — None. Обычно так бывает, когда функция ничего не возвращает (в ней нет return).',
        'Проверь, что функция возвращает результат через return, а не печатает его.',
      );
    }
    const mixed = (left === 'str' && isNumberType(right)) || (right === 'str' && isNumberType(left));
    if (mixed && op.trim() === '+') {
      return explanation(
        'Число и строка через +',
        'С одной стороны от „+“ число, с другой — строка, и Python не угадывает, сложить их как числа или склеить как текст.',
        'Для сложения чисел преврати строку в число: int(...); для склейки текста — число в строку: str(...).',
      );
    }
    if (mixed) {
      return explanation(
        'Число и строка в одном вычислении',
        `Для ${q(op.trim())} нужны два числа, а здесь ${typeLabel(left)} и ${typeLabel(right)}. Часто это значение из input(), которое осталось строкой.`,
        'Преврати строку в число: int(input()) или float(...).',
      );
    }
    return explanation(
      'Несовместимые типы',
      `Операция ${q(op.trim())} не работает, когда значения — ${typeLabel(left)} и ${typeLabel(right)}.`,
      'Проверь, что лежит в переменных этой строки: выведи их через print(type(x)).',
    );
  }
  if ((m = /can't multiply sequence by non-int of type '(\w+)'/.exec(message))) {
    return explanation(
      'Строку умножают не на целое число',
      `Строку или список можно повторить только целое число раз, а множитель здесь — ${typeLabel(m[1])}.`,
      m[1] === 'float'
        ? 'Преврати множитель в целое число: int(...).'
        : 'Похоже, число осталось строкой после input(): преврати его через int(...).',
    );
  }
  if ((m = /'(\w+)' object cannot be interpreted as an integer/.exec(message))) {
    return explanation(
      'Нужно целое число',
      `Здесь нужно целое число (например, в range()), а передано другое значение — ${typeLabel(m[1])}.`,
      m[1] === 'float'
        ? 'Используй целое деление // или int(...), чтобы получить целое число.'
        : 'Если значение пришло из input(), преврати его: int(input()).',
    );
  }
  if ((m = /(\S+?)\(\) takes (?:from (\d+) to (\d+)|(\d+)) positional arguments? but (\d+) (?:was|were) given/.exec(message))) {
    const [, fn, from, to, exact, given] = m;
    const expected = exact ?? `от ${from} до ${to}`;
    const isMethod = fn.includes('.');
    return explanation(
      'Лишние аргументы',
      `${fn}() принимает ${expected} ${exact ? plural(Number(exact), 'аргумент', 'аргумента', 'аргументов') : 'аргументов'}, а при вызове передано ${given}.${isMethod ? ' У метода self тоже считается.' : ''}`,
      `Сравни вызов с объявлением def ${fn.split('.').pop()}(...): значений в скобках должно быть столько же, сколько параметров.`,
    );
  }
  if ((m = /(\S+?)\(\) missing (\d+) required (?:positional|keyword-only) arguments?: (.+)$/.exec(message))) {
    const names = m[3].replace(/'([^']+)'/g, '„$1“').replace(/ and /g, ' и ');
    return explanation(
      'Не хватает аргументов',
      `Функции ${m[1]}() не передано значение для ${names}.`,
      'Передай при вызове столько значений, сколько параметров в def.',
    );
  }
  if ((m = /(\S+?)\(\) got an unexpected keyword argument '(\w+)'/.exec(message))) {
    return explanation(
      'Неизвестный параметр',
      `У ${m[1]}() нет параметра ${q(m[2])}.`,
      hint ? `Возможно, здесь должно быть ${q(hint)}.` : 'Проверь название параметра в объявлении функции.',
    );
  }
  if ((m = /'(\w+)' object is not callable/.exec(message))) {
    if (code) {
      const lines = code.split(/\r?\n/);
      for (const name of SHADOWABLE) {
        if (!new RegExp(`\\b${name}\\s*\\(`).test(lineText)) continue;
        const assigned = lines.findIndex((line) => new RegExp(`^\\s*${name}\\s*=(?!=)`).test(line));
        if (assigned >= 0) {
          return explanation(
            'Имя функции занято переменной',
            `В строке ${assigned + 1} имени ${q(name)} присвоено значение, и теперь это не функция.`,
            `Переименуй переменную, например в total или value, — тогда ${name}() снова заработает.`,
          );
        }
      }
    }
    if (/(?:^|[^\w.])\d+(?:\.\d+)?\s*\(/.test(lineText) || /\)\s*\(/.test(lineText)) {
      return explanation(
        'Пропущен знак умножения?',
        'Перед скобкой нет знака операции, и Python пытается «вызвать» значение как функцию.',
        'Поставь * перед скобкой: 2 * (x + 1).',
      );
    }
    return explanation(
      'Значение вызвано как функция',
      `После ${typeLabelGenitive(m[1])} стоят скобки (), как будто это функция.`,
      'Проверь, не занято ли имя функции переменной и не пропущен ли знак операции перед скобкой.',
    );
  }
  if ((m = /object of type '(\w+)' has no len\(\)/.exec(message))) {
    return explanation(
      'У значения нет длины',
      `len() считает символы в строке или элементы в списке, а здесь — ${typeLabel(m[1])}.`,
      isNumberType(m[1])
        ? 'Если нужна длина числа в цифрах — сначала преврати его в строку: len(str(n)).'
        : 'Проверь, что в len() передаётся строка или список.',
    );
  }
  if ((m = /'(\w+)' object is not subscriptable/.exec(message))) {
    if (['function', 'builtin_function_or_method', 'method', 'type'].includes(m[1])) {
      return explanation(
        'Квадратные скобки вместо круглых',
        'Функцию вызывают круглыми скобками, а квадратные нужны для индексов.',
        'Замени [ ] на ( ): len(x), а не len[x].',
      );
    }
    if (m[1] === 'NoneType') {
      return explanation(
        'Индекс у None',
        'Значение — None: обычно так бывает, когда функция ничего не возвращает.',
        'Проверь, что функция возвращает результат через return.',
      );
    }
    return explanation(
      'Индекс у значения, где его нет',
      `Квадратные скобки [ ] работают со строками, списками и словарями, а здесь — ${typeLabel(m[1])}.`,
      isNumberType(m[1])
        ? 'Если нужна цифра числа — сначала преврати его в строку: str(n)[0].'
        : 'Проверь, что лежит в переменной: возможно, нужна другая переменная.',
    );
  }
  if ((m = /'(\w+)' object is not iterable/.exec(message))) {
    return explanation(
      'Значение нельзя перебрать',
      `for перебирает строки, списки и range(...), а здесь — ${typeLabel(m[1])}.`,
      m[1] === 'int' ? 'Чтобы повторить действие n раз, используй for i in range(n).' : 'Проверь, что после in стоит строка, список или range(...).',
    );
  }
  if ((m = /'(\w+)' object does not support item assignment/.exec(message))) {
    if (m[1] === 'str') {
      return explanation(
        'Строку нельзя изменить по индексу',
        'Строки в Python неизменяемы: s[0] = "x" не сработает.',
        'Собери новую строку, например s = "x" + s[1:], или используй s.replace(...).',
      );
    }
    return explanation(
      'Значение нельзя изменить по индексу',
      `${capitalize(typeLabel(m[1]))} нельзя менять по индексу.`,
      'Если нужно менять элементы — используй список: list(...).',
    );
  }
  if ((m = /(list|string|tuple) indices must be integers(?: or slices)?, not '?(\w+)'?/.exec(message))) {
    return explanation(
      'Индекс должен быть целым числом',
      `Номер элемента в [ ] должен быть целым числом, а здесь — ${typeLabel(m[2])}.`,
      m[2] === 'float'
        ? 'Используй целое деление // вместо / или int(...).'
        : m[2] === 'str'
          ? 'Если индекс пришёл из input(), преврати его: int(...).'
          : 'Проверь, что в квадратных скобках стоит целое число.',
    );
  }
  if ((m = /'([<>=!]+)' not supported between instances of '(\w+)' and '(\w+)'/.exec(message))) {
    return explanation(
      'Сравнение разных типов',
      `Сравнение ${q(m[1])} не работает, когда значения — ${typeLabel(m[2])} и ${typeLabel(m[3])}. Часто одно из них — строка из input().`,
      'Преврати строку в число перед сравнением: int(input()).',
    );
  }
  if ((m = /sequence item \d+: expected str instance, (\w+) found/.exec(message))) {
    return explanation(
      'join соединяет только строки',
      `Среди элементов есть ${typeLabel(m[1])}, а join умеет склеивать только строки.`,
      'Преврати элементы в строки: ", ".join(map(str, items)).',
    );
  }
  if (/not 'NoneType'|'NoneType'/.test(message)) {
    return explanation(
      'Значение None',
      'Вместо значения пришло None — обычно так бывает, когда функция ничего не возвращает.',
      'Проверь, что функция возвращает результат через return.',
    );
  }
  return explanation(
    'Неподходящий тип значения',
    'Операция или функция получила значение не того типа, которого ждёт.',
    'Проверь типы значений в этой строке — например, выведи их через print(type(x)).',
  );
}

function explainValueError(ctx: Context): ErrorExplanation {
  const { message } = ctx;
  let m: RegExpExecArray | null;
  // Python показывает значение как repr: 'abc', а если внутри апостроф — "it's".
  if ((m = /invalid literal for int\(\) with base \d+: (['"])(.*)\1$/s.exec(message))) {
    const value = m[2];
    if (value.trim() === '') {
      return explanation(
        'Пустая строка вместо числа',
        'int() получил пустую строку: во вводе пустая строка или программа читает лишнюю строку.',
        'Проверь, сколько строк во вводе и сколько раз вызывается input().',
      );
    }
    // float("3,5") тоже упадёт, поэтому совет — сначала заменить запятую на точку.
    if (/^\s*[-+]?\d+,\d+\s*$/.test(value)) {
      return explanation(
        'Дробное число с запятой',
        `int() не понимает запись ${q(value)}: это дробное число, а в Python дробную часть отделяют точкой.`,
        'Замени запятую на точку и преврати в дробное число: float(s.replace(",", ".")).',
      );
    }
    if (/^\s*[-+]?\d+\.\d*\s*$/.test(value)) {
      return explanation(
        'Дробное число в int()',
        `int() не понимает дробную запись ${q(value)}.`,
        'Для дробных чисел используй float(...); если нужно целое — int(float(...)).',
      );
    }
    if (/\S\s+\S/.test(value.trim())) {
      return explanation(
        'Несколько значений в одной строке',
        `В строке ${q(value)} несколько значений, а int() ждёт одно число.`,
        'Раздели строку через split() и преврати в число каждую часть отдельно.',
      );
    }
    return explanation(
      'Текст вместо числа',
      `int() превращает в число только запись из цифр, а получил ${q(value)}.`,
      'Проверь, что именно попадает в int(): возможно, это не та строка ввода или в ней лишние символы.',
    );
  }
  if ((m = /could not convert string to float: (['"])(.*)\1$/s.exec(message))) {
    const value = m[2];
    if (/^\s*[-+]?\d+,\d+\s*$/.test(value)) {
      return explanation(
        'Запятая вместо точки',
        'В Python дробные числа пишут через точку: 3.5, а не 3,5.',
        'Замени запятую на точку, например float(s.replace(",", ".")).',
      );
    }
    if (value.trim() === '') {
      return explanation(
        'Пустая строка вместо числа',
        'float() получил пустую строку: во вводе пустая строка или программа читает лишнюю строку.',
        'Проверь, сколько строк во вводе и сколько раз вызывается input().',
      );
    }
    return explanation(
      'Текст вместо числа',
      `float() превращает в число только запись числа, а получил ${q(value)}.`,
      'Проверь, что именно попадает в float(): возможно, это не та строка ввода.',
    );
  }
  if ((m = /not enough values to unpack \(expected (\d+), got (\d+)\)/.exec(message))) {
    const expected = Number(m[1]);
    const got = Number(m[2]);
    return explanation(
      'Не хватает значений',
      `Слева ${expected} ${plural(expected, 'переменная', 'переменные', 'переменных')}, а значений справа только ${got}.`,
      'Проверь, сколько значений в строке ввода и как она делится через split().',
    );
  }
  if ((m = /too many values to unpack \(expected (\d+)(?:, got (\d+))?\)/.exec(message))) {
    const expected = Number(m[1]);
    return explanation(
      'Лишние значения',
      `Слева ${expected} ${plural(expected, 'переменная', 'переменные', 'переменных')}, а значений справа больше${m[2] ? `: ${m[2]}` : ''}.`,
      'Проверь, сколько значений в строке ввода и как она делится через split().',
    );
  }
  // Python 3.14: sqrt(-1) — «expected a nonnegative input», log(0) — «expected a positive input».
  if (/expected a positive input/.test(message)) {
    return explanation(
      'Недопустимое значение для math',
      'Математическая функция получила значение, для которого результат не определён, — например, логарифм нуля или отрицательного числа.',
      'Проверь значение перед вызовом: здесь нужно число больше нуля, например if x > 0.',
    );
  }
  if (/expected a nonnegative input/.test(message)) {
    return explanation(
      'Недопустимое значение для math',
      'Математическая функция получила значение, для которого результат не определён, — например, корень из отрицательного числа.',
      'Проверь значение перед вызовом: здесь нужно число не меньше нуля, например if x >= 0.',
    );
  }
  if (/math domain error/.test(message)) {
    return explanation(
      'Недопустимое значение для math',
      'Математическая функция получила значение, для которого результат не определён.',
      'Выведи значение через print перед вызовом и проверь, подходит ли оно для этой функции.',
    );
  }
  if (/x not in list|is not in list/.test(message)) {
    return explanation(
      'Такого элемента нет в списке',
      'remove() и index() ищут элемент, а его в списке нет.',
      'Перед вызовом проверь: if x in items.',
    );
  }
  if (/substring not found/.test(message)) {
    return explanation(
      'Фрагмент не найден',
      'index() не нашёл такой фрагмент в строке.',
      'Используй find(): он вернёт -1 вместо ошибки. Или проверь заранее: if part in text.',
    );
  }
  if (/Exceeds the limit \(\d+ digits\)/.test(message)) {
    return explanation(
      'Слишком длинное число',
      'Число получилось таким длинным, что Python не превращает его в текст, — обычно это знак ошибки в вычислении.',
      'Проверь формулу: возможно, степень или умножение повторяются лишний раз.',
    );
  }
  return explanation(
    'Неподходящее значение',
    'Функция получила значение нужного типа, но оно не подходит — например, текст, в котором нет числа.',
    'Выведи значение через print перед этой строкой и проверь, какое оно на самом деле.',
  );
}

function explainIndexError(ctx: Context): ErrorExplanation {
  const { message } = ctx;
  if (/list index out of range/.test(message)) {
    return explanation(
      'Индекс за пределами списка',
      'Элемента с таким номером в списке нет. Нумерация идёт с 0, поэтому у списка из 3 элементов последний индекс — 2.',
      'Проверь индекс и границы цикла: для обхода удобнее for item in items.',
    );
  }
  if (/string index out of range/.test(message)) {
    return explanation(
      'Индекс за пределами строки',
      'Символа с таким номером в строке нет. Нумерация идёт с 0, поэтому последний символ — s[len(s) - 1] или s[-1].',
      'Проверь индекс и границы цикла; помни, что строка может оказаться короче, чем ожидалось.',
    );
  }
  if (/tuple index out of range/.test(message)) {
    return explanation(
      'Индекс за пределами кортежа',
      'Элемента с таким номером в кортеже нет. Нумерация идёт с 0.',
      'Проверь индекс и количество элементов.',
    );
  }
  if (/pop from empty/.test(message)) {
    return explanation('Список пуст', 'pop() пытается взять элемент из пустого списка.', 'Перед pop() проверь, что список не пуст: if items:.');
  }
  return explanation(
    'Индекс вне границ',
    'Элемента с таким номером нет. Нумерация идёт с 0.',
    'Проверь индекс и границы цикла.',
  );
}

function explainAttributeError(ctx: Context): ErrorExplanation {
  const { message, hint } = ctx;
  let m: RegExpExecArray | null;
  if ((m = /module '([\w.]+)' has no attribute '(\w+)'/.exec(message))) {
    return explanation(
      `В модуле ${m[1]} нет ${q(m[2])}`,
      `В модуле ${m[1]} нет функции или значения ${q(m[2])}.`,
      hint ? `Возможно, здесь должно быть ${q(hint)}.` : 'Проверь название по примеру из урока.',
    );
  }
  if ((m = /'(\w+)' object has no attribute '(\w+)'/.exec(message))) {
    const [, type, attribute] = m;
    if (type === 'NoneType') {
      return explanation(
        'Метод у None',
        'Значение — None. Так бывает, если сохранить результат метода, который меняет список на месте (sort, append) и ничего не возвращает.',
        'Вызывай такой метод отдельной строкой, без присваивания: items.sort().',
      );
    }
    if (hint) {
      return explanation(
        'Нет такого метода',
        `У ${typeLabelGenitive(type)} нет ${q(attribute)} — похоже на опечатку.`,
        `Возможно, здесь должно быть ${q(hint)}.`,
      );
    }
    return explanation(
      'Нет такого метода',
      `У ${typeLabelGenitive(type)} нет метода или свойства ${q(attribute)}.`,
      'Проверь тип значения и название метода: например, append есть у списков, но не у строк и чисел.',
    );
  }
  return explanation(
    'Нет такого метода или свойства',
    'У значения нет метода или свойства с таким именем.',
    hint ? `Возможно, здесь должно быть ${q(hint)}.` : 'Проверь тип значения и название метода.',
  );
}

/**
 * Модули, которых нет в учебной среде браузера (Pyodide 314): убранные из стандартной библиотеки
 * (dbm, test, curses…), только для Windows или Unix, сторонние библиотеки, в том числе из курса
 * (pytest, yaml…). Список нужен только после ModuleNotFoundError: модули, которые импортируются
 * (sqlite3, ssl, socket, subprocess…), сюда не входят — их ограничения видны уже при работе.
 * Примечание Pyodide «removed … due to browser limitations» до harness.py не доходит, поэтому
 * одного его недостаточно.
 */
const BROWSER_UNAVAILABLE = new Set([
  // стандартная библиотека, которой нет в Pyodide или в браузере
  'tkinter', '_tkinter', 'turtle', 'turtledemo', 'idlelib', 'curses', 'readline', 'dbm', 'test',
  'resource', 'grp', 'pwd', 'msvcrt', 'winsound', 'winreg', 'venv', 'ensurepip', 'pip',
  // учебная среда: модули самого браузерного Python закрыты для программ
  'micropip', 'js', 'pyodide', 'pyodide_js', '_pyodide',
  // сторонние библиотеки
  'pytest', 'yaml', 'dateutil', 'pytz', 'dotenv', 'colorama', 'rich', 'click', 'typer', 'tqdm',
  'pygame', 'pyglet', 'arcade', 'kivy', 'requests', 'httpx', 'aiohttp', 'urllib3', 'selenium', 'bs4',
  'lxml', 'flask', 'django', 'fastapi', 'numpy', 'pandas', 'matplotlib', 'scipy', 'sklearn', 'PIL',
  'cv2', 'telebot', 'aiogram', 'telegram', 'discord', 'vk_api', 'pyautogui', 'keyboard', 'mouse', 'pynput',
]);

const KNOWN_MODULES = [
  'math', 'random', 'datetime', 'time', 'string', 'statistics', 'collections', 'itertools', 'functools', 'json',
  're', 'os', 'sys', 'fractions', 'decimal', 'calendar', 'operator', 'copy', 'textwrap', 'unittest', 'csv',
  'pathlib', 'typing', 'dataclasses', 'enum', 'heapq', 'bisect', 'array', 'pprint', 'doctest',
];

function explainImport(ctx: Context): ErrorExplanation {
  const { message, error, hint } = ctx;
  let m: RegExpExecArray | null;
  if ((m = /cannot import name '(\w+)' from '([\w.]+)'/.exec(message))) {
    return explanation(
      `В модуле ${m[2]} нет ${q(m[1])}`,
      `В модуле ${m[2]} нет функции или значения ${q(m[1])}.`,
      hint ? `Возможно, здесь должно быть ${q(hint)}.` : 'Проверь название по примеру из урока.',
    );
  }
  const nameMatch = /No module named '([\w.]+)'/.exec(message) ?? /Модуль «([\w.]+)»/.exec(message);
  const module = nameMatch?.[1] ?? '';
  const top = module.split('.')[0];
  const text = `${message}\n${error.summary}\n${error.raw}`;
  const environment =
    /недоступен в учебной среде/.test(text) ||
    /Pyodide|browser limitations|not installed/.test(text) ||
    BROWSER_UNAVAILABLE.has(top);
  if (environment) {
    return explanation(
      'Модуль недоступен в браузере',
      `Модуль ${q(top || 'этот')} не работает в учебной среде браузера — это ограничение среды, а не ошибка в твоём коде.`,
      'Реши задание без этого модуля; программы с ним запускают в редакторе на компьютере.',
      true,
    );
  }
  if (error.type === 'ImportError' && !module) {
    return explanation(
      'Не удалось подключить модуль',
      'Python не смог подключить модуль или имя из него.',
      'Проверь написание в строке import.',
    );
  }
  const suggestion = hint ?? closestName(top, KNOWN_MODULES);
  if (suggestion) {
    return explanation(
      `Нет модуля ${q(module || top)}`,
      'Python не нашёл модуль с таким именем — похоже на опечатку.',
      `Возможно, здесь должно быть ${q(suggestion)}: import ${suggestion}.`,
    );
  }
  // Похожего имени нет: это может быть и опечатка, и библиотека, которой нет в браузере.
  return explanation(
    `Нет модуля ${q(module || top)}`,
    'Python не нашёл модуль с таким именем: либо в названии опечатка, либо это библиотека, которой нет в учебной среде браузера.',
    'Проверь написание имени; если это сторонняя библиотека, такую программу запускай в редакторе на компьютере.',
  );
}

const NETWORK_ERRORS = new Set([
  'ConnectionError', 'ConnectionRefusedError', 'ConnectionResetError', 'ConnectionAbortedError', 'BrokenPipeError',
  'URLError', 'HTTPError', 'gaierror', 'herror', 'SSLError', 'SSLCertVerificationError', 'RemoteDisconnected',
  'TimeoutError', 'socket.timeout', 'InvalidURL',
]);
const FILE_ERRORS = new Set([
  'OSError', 'IOError', 'EnvironmentError', 'FileNotFoundError', 'PermissionError', 'IsADirectoryError',
  'NotADirectoryError', 'FileExistsError', 'BlockingIOError', 'InterruptedError', 'ProcessLookupError',
  'ChildProcessError', 'UnsupportedOperation',
]);

function explainEnvironment(ctx: Context): ErrorExplanation | null {
  const { error, message } = ctx;
  const network =
    NETWORK_ERRORS.has(error.type) ||
    (FILE_ERRORS.has(error.type) && /network|socket|connect|host|Name or service/i.test(message));
  if (network) {
    return explanation(
      'Сеть недоступна',
      'Из учебной среды в браузере программа не может обращаться к сети — это ограничение среды, а не ошибка в коде.',
      'Программы с запросами к сети запускай в редакторе на компьютере.',
      true,
    );
  }
  if (!FILE_ERRORS.has(error.type)) return null;
  if (error.type === 'FileNotFoundError') {
    const file = /No such file or directory: '(.+)'/.exec(message)?.[1];
    return explanation(
      'Файл не найден',
      `${file ? `Файла ${q(file)} здесь нет` : 'Такого файла здесь нет'}: в браузере программа видит только файлы, которые создала сама, а не файлы с компьютера.`,
      'Проверь имя файла; если задание рассчитано на файлы с компьютера, выполни его в редакторе на ПК.',
      true,
    );
  }
  return explanation(
    'Ограничение среды',
    'В браузерной учебной среде работа с файлами и системой ограничена — это ограничение среды, а не ошибка в коде.',
    'Такие программы запускай в редакторе на компьютере.',
    true,
  );
}

function explainRuntime(ctx: Context): ErrorExplanation {
  const { error, message } = ctx;
  switch (error.type) {
    case 'NameError':
      return explainNameError(ctx);
    case 'TypeError':
      return explainTypeError(ctx);
    case 'ValueError':
      return explainValueError(ctx);
    case 'ZeroDivisionError':
      return explanation(
        'Деление на ноль',
        /modulo/.test(message)
          ? 'Делитель в операции % оказался равен нулю, а остаток от деления на ноль не определён.'
          : 'Делитель в этой строке оказался равен нулю, а на ноль делить нельзя.',
        'Найди, откуда берётся ноль; если такой ввод возможен — обработай его заранее через if.',
      );
    case 'IndexError':
      return explainIndexError(ctx);
    case 'KeyError': {
      const key = message.trim();
      // KeyError бывает и у множеств: set.remove(x) без такого элемента и pop() из пустого множества.
      if (/^'pop from an empty set'$/.test(key)) {
        return explanation(
          'Множество пустое',
          'pop() пытается взять элемент из пустого множества.',
          'Перед pop() проверь, что множество не пустое: if items:.',
        );
      }
      const setRemove = /([A-Za-z_А-Яа-яЁё][\wА-Яа-яЁё]*)\s*\.\s*remove\s*\(/.exec(ctx.lineText);
      if (setRemove && key) {
        return explanation(
          'Такого элемента нет в множестве',
          `remove() не нашёл в множестве элемент ${key}.`,
          `Если элемента может не быть, используй ${setRemove[1]}.discard(${key}) — он не вызывает ошибку.`,
        );
      }
      return explanation(
        'Нет такого ключа',
        key ? `В словаре нет ключа ${key}.` : 'В словаре нет такого ключа.',
        key
          ? `Проверь написание ключа (регистр, пробелы) или получай значение через get(): d.get(${key}).`
          : 'Проверь написание ключа или получай значение через get().',
      );
    }
    case 'AttributeError':
      return explainAttributeError(ctx);
    case 'UnboundLocalError': {
      const name = /local variable '([^']+)'/.exec(message)?.[1];
      const label = name ? q(name) : 'переменная';
      return explanation(
        'Переменная функции ещё без значения',
        `Внутри функции ${label} меняется, поэтому Python считает её локальной, но внутри функции ей ещё не присвоено значение.`,
        `Передай значение в функцию параметром и верни результат через return — или присвой ${name ? q(name) : 'ей'} значение в начале функции.`,
      );
    }
    case 'RecursionError':
      return explanation(
        'Бесконечная рекурсия',
        'Функция снова и снова вызывает саму себя и не доходит до остановки.',
        'Проверь базовый случай: при каком значении функция возвращает результат без нового вызова и приближается ли к нему аргумент.',
      );
    case 'EOFError':
      return explanation(
        'Не хватило строк ввода',
        'Программа попросила больше строк ввода, чем есть в тесте.',
        'Проверь, сколько раз вызывается input(): столько же строк должно быть во вводе.',
      );
    case 'ModuleNotFoundError':
    case 'ImportError':
      return explainImport(ctx);
    case 'KeyboardInterrupt':
      return explanation('Выполнение прервано', 'Программу остановили до того, как она закончила работу.', 'Запусти её снова.');
    case 'AssertionError':
      return explanation(
        'Не выполнилось условие assert',
        message ? `Условие в assert оказалось ложным: ${message}` : 'Условие в assert оказалось ложным.',
        'Выведи значения из условия через print перед этой строкой и сравни с ожидаемыми.',
      );
    case 'OverflowError':
      return explanation(
        'Слишком большое число',
        'Результат вычисления вышел за пределы, которые может хранить дробное число.',
        'Проверь формулу: возможно, степень или умножение повторяются слишком много раз.',
      );
    case 'MemoryError':
      return explanation(
        'Не хватило памяти',
        'Программа заняла слишком много памяти — обычно список или строка растут без остановки.',
        'Проверь цикл, который добавляет элементы: когда он должен закончиться?',
      );
    default: {
      const environment = explainEnvironment(ctx);
      if (environment) return environment;
      return explanation(
        `Ошибка ${error.type}`,
        `Python остановил программу с ошибкой ${error.type}.`,
        'Посмотри на отмеченную строку и проверь значения переменных: выведи их через print перед этой строкой.',
      );
    }
  }
}

// ------------------------------------------------------------------ публичные функции

const COMPILE_TYPES = new Set(['SyntaxError', 'IndentationError', 'TabError']);

/**
 * Объясняет ошибку Python по-русски. code — весь код ученика (необязательно):
 * с ним объяснение точнее, например «имя создаётся ниже, в строке 5».
 */
export function explainError(error: PyError, code?: string): ErrorExplanation {
  const ctx: Context = {
    error,
    message: error.message ?? '',
    summary: error.summary ?? '',
    hint: didYouMean(error),
    lineText: error.lineText ?? '',
    code: code ?? null,
  };
  if (error.phase === 'compile' || COMPILE_TYPES.has(error.type)) return explainSyntax(ctx);
  return explainRuntime(ctx);
}

const CATEGORY_LABELS: Record<string, string> = {
  none: 'Без ошибки',
  timeout: 'Слишком долгая работа',
  limit: 'Слишком много вывода',
  output: 'Неверный вывод',
  rule: 'Не выполнено требование к коду',
  environment: 'Ограничение среды',
  stopped: 'Остановлено вручную',
  SyntaxError: 'Синтаксис (SyntaxError)',
  IndentationError: 'Отступы (IndentationError)',
  TabError: 'Табуляция в отступах (TabError)',
  NameError: 'Неизвестное имя (NameError)',
  TypeError: 'Несовместимые типы (TypeError)',
  ValueError: 'Неподходящее значение (ValueError)',
  ZeroDivisionError: 'Деление на ноль (ZeroDivisionError)',
  IndexError: 'Индекс вне границ (IndexError)',
  KeyError: 'Нет такого ключа (KeyError)',
  AttributeError: 'Нет такого метода (AttributeError)',
  UnboundLocalError: 'Переменная функции без значения (UnboundLocalError)',
  RecursionError: 'Бесконечная рекурсия (RecursionError)',
  EOFError: 'Не хватило ввода (EOFError)',
  ModuleNotFoundError: 'Модуль не найден (ModuleNotFoundError)',
  ImportError: 'Ошибка импорта (ImportError)',
  FileNotFoundError: 'Файл не найден (FileNotFoundError)',
  OSError: 'Ограничение среды (OSError)',
  AssertionError: 'Не выполнено условие (AssertionError)',
  KeyboardInterrupt: 'Выполнение прервано (KeyboardInterrupt)',
  OverflowError: 'Слишком большое число (OverflowError)',
  MemoryError: 'Не хватило памяти (MemoryError)',
};

/** Метка для экрана «Прогресс» → «Повторяющиеся ошибки». */
export function errorCategory(errorType: string | null): ErrorCategory {
  const key = errorType ?? 'none';
  return { key, label: own(CATEGORY_LABELS, key) ?? `Ошибка ${key}` };
}
