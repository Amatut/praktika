// Схемы записей хранилища (zod) и понятные сообщения об ошибках проверки.
// Одни и те же правила проверяют запись в базу (repo.ts), файл экспорта и резервные копии (transfer.ts):
// всё, что прошло проверку при записи, примет и импорт на другом устройстве.

import { z } from 'zod';
import { EXPORT_FORMAT, SCHEMA_VERSION } from './types.ts';

const timestamp = z.number();
const count = z.number().int().nonnegative();
const id = z.string().min(1);

export const settingsSchema = z.object({
  theme: z.enum(['system', 'light', 'dark']),
  lessonFontSize: z.literal([16, 17, 18, 20]),
  codeFontSize: z.literal([14, 15, 16, 18]),
  coach: z.object({
    mode: z.enum(['course', 'ai']),
    endpoint: z.string(),
    accessToken: z.string(),
  }),
  market: z.object({
    region: z.string().nullable(),
    currency: z.string().nullable(),
  }),
});

export const metaSchema = z.object({
  currentLessonId: z.string().nullable(),
  lastOpenedAt: timestamp.nullable(),
  firstActivityAt: timestamp.nullable(),
});

const helpLevelSchema = z.literal([0, 1, 2, 3, 4]);

export const exerciseSchema = z
  .object({
    exerciseId: id,
    lessonId: z.string(),
    draft: z.string().nullable(),
    draftUpdatedAt: timestamp.nullable(),
    status: z.enum(['new', 'attempted', 'passed']),
    checks: count,
    runs: count,
    hintsShown: z.literal([0, 1, 2, 3]),
    solutionViewed: z.boolean(),
    firstPassedAt: timestamp.nullable(),
    firstPassHelp: helpLevelSchema.nullable(),
    lastCheckAt: timestamp.nullable(),
    updatedAt: timestamp,
  })
  // Пройденное задание всегда помнит, когда и с какой помощью решено впервые, а непройденное — нет.
  // Иначе после импорта задание навсегда осталось бы «пройденным без даты».
  .refine(
    (r) =>
      (r.status === 'passed') === (r.firstPassedAt !== null) && (r.firstPassedAt === null) === (r.firstPassHelp === null),
    {
      path: ['firstPassedAt'],
      message:
        'статус и первое прохождение не согласованы: у пройденного задания должны быть firstPassedAt и firstPassHelp, у непройденного — null',
    },
  );

export const lessonSchema = z.object({
  lessonId: id,
  stepIndex: count,
  completedSteps: z.array(z.string()),
  startedAt: timestamp,
  completedAt: timestamp.nullable(),
  predictions: z.record(z.string(), z.object({ answer: z.string(), matched: z.boolean().nullable() })),
  orders: z.record(z.string(), z.object({ attempts: count, solved: z.boolean() })),
  quizzes: z.record(z.string(), z.object({ choice: count, correct: z.boolean() })),
  checklists: z.record(z.string(), z.array(z.string())),
  recap: z
    .object({ answer: z.string(), selfCheck: z.enum(['understood', 'partly', 'not-yet']).nullable() })
    .nullable(),
  updatedAt: timestamp,
});

export const attemptSchema = z.object({
  key: id,
  exerciseId: z.string(),
  lessonId: z.string(),
  at: timestamp,
  kind: z.enum(['run', 'check']),
  passed: z.boolean(),
  errorType: z.string().nullable(),
  failed: count,
  total: count,
});

export const activitySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { error: 'нужна дата в виде ГГГГ-ММ-ДД' }),
  activeMs: z.number().nonnegative(),
});

export const interestSchema = z.object({
  labId: id,
  status: z.enum(['curious', 'tried']),
  liked: z.string(),
  tiring: z.string(),
  continue: z.enum(['yes', 'maybe', 'no']).nullable(),
  updatedAt: timestamp,
});

export const reviewSchema = z.object({
  key: id,
  lessonId: z.string(),
  exerciseId: z.string().nullable(),
  stage: z.number().int().min(0).max(3),
  dueAt: timestamp,
  reason: z.string(),
  createdAt: timestamp,
  updatedAt: timestamp,
  doneAt: timestamp.nullable(),
});

export const projectSchema = z.object({
  projectId: id,
  stagesDone: z.array(z.string()),
  notes: z.string(),
  updatedAt: timestamp,
});

const marketEntrySchema = z.object({
  lab: z.string(),
  type: z.enum(['salary', 'hourly', 'project']),
  title: z.string(),
  amountMin: z.number().nullable(),
  amountMax: z.number().nullable(),
  currency: z.string(),
  period: z.enum(['month', 'year', 'hour', 'project']),
  region: z.string(),
  level: z.string(),
  publishedAt: z.string().nullable(),
  checkedAt: z.string(),
  url: z.string(),
  sourceType: z.enum(['vacancy', 'order', 'statistics', 'survey', 'platform']),
  isOffer: z.boolean(),
  note: z.string(),
});

export const marketDatasetSchema = z.object({
  id,
  title: z.string(),
  region: z.string(),
  currency: z.string(),
  importedAt: timestamp,
  checkedAt: z.string(),
  entries: z.array(marketEntrySchema),
});

export const coachDraftSchema = z.object({
  id,
  exerciseId: z.string().nullable(),
  lessonId: z.string().nullable(),
  text: z.string(),
  createdAt: timestamp,
});

/** Список записей без повторяющихся ключей: повтор в файле — признак повреждения, а не данные для слияния. */
function uniqueList<T>(item: z.ZodType<T>, keyField: string, keyOf: (value: T) => string) {
  return z.array(item).superRefine((list, ctx) => {
    const firstIndex = new Map<string, number>();
    list.forEach((value, index) => {
      const key = keyOf(value);
      const first = firstIndex.get(key);
      if (first === undefined) firstIndex.set(key, index);
      else ctx.addIssue({ code: 'custom', path: [index, keyField], message: `«${key}» повторяется — такая запись уже есть под номером ${first}` });
    });
  });
}

export const progressDataSchema = z.object({
  settings: settingsSchema,
  meta: metaSchema,
  exercises: uniqueList(exerciseSchema, 'exerciseId', (r) => r.exerciseId),
  lessons: uniqueList(lessonSchema, 'lessonId', (r) => r.lessonId),
  attempts: uniqueList(attemptSchema, 'key', (r) => r.key),
  activity: uniqueList(activitySchema, 'date', (r) => r.date),
  interests: uniqueList(interestSchema, 'labId', (r) => r.labId),
  reviews: uniqueList(reviewSchema, 'key', (r) => r.key),
  projects: uniqueList(projectSchema, 'projectId', (r) => r.projectId),
  market: uniqueList(marketDatasetSchema, 'id', (r) => r.id),
  coachDrafts: uniqueList(coachDraftSchema, 'id', (r) => r.id),
});

/** Схема файла экспорта текущей версии. Лишние поля отбрасываются, типы проверяются строго. */
export const exportFileSchema = z.object({
  format: z.literal(EXPORT_FORMAT),
  schemaVersion: z.literal(SCHEMA_VERSION),
  exportedAt: z.string(),
  app: z.object({ version: z.string(), contentVersion: z.string().nullable() }),
  data: progressDataSchema,
});

// ------------------------------------------------------------------ сообщения об ошибках

const EXPECTED: Record<string, string> = {
  string: 'нужна строка',
  number: 'нужно число',
  int: 'нужно целое число',
  boolean: 'нужно значение true или false',
  array: 'нужен список',
  object: 'нужен объект',
  null: 'нужно значение null',
};

function shortJson(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 40 ? `${text.slice(0, 37)}…` : text;
}

/** Что оказалось на месте поля — для сообщения «нужно …, а …». */
function describeInput(input: unknown): string {
  if (input === undefined) return 'поля нет';
  if (input === null) return 'указано null';
  if (Array.isArray(input)) return 'указан список';
  switch (typeof input) {
    case 'string':
      return `указана строка ${shortJson(input)}`;
    case 'number':
      return `указано число ${String(input)}`;
    case 'boolean':
      return `указано ${String(input)}`;
    case 'object':
      return 'указан объект';
    default:
      return `указано значение типа ${typeof input}`;
  }
}

function sizeUnit(origin: string): string {
  if (origin === 'string') return ' символов';
  if (origin === 'array' || origin === 'set') return ' элементов';
  return '';
}

/**
 * Карта ошибок zod на русском: полные фразы без английских названий типов.
 * Подключается к одной проверке (safeParse(..., { error: russianIssue })), глобальные настройки zod не меняются.
 */
export const russianIssue: z.core.$ZodErrorMap = (issue) => {
  switch (issue.code) {
    case 'invalid_type': {
      const expected = EXPECTED[String(issue.expected)] ?? `нужно значение типа ${String(issue.expected)}`;
      return `${expected}, а ${describeInput(issue.input)}`;
    }
    case 'too_small': {
      const origin = String(issue.origin);
      if (origin === 'string' && Number(issue.minimum) === 1) return 'не может быть пустым';
      const bound = issue.inclusive ? 'не меньше' : 'больше';
      return `должно быть ${bound} ${String(issue.minimum)}${sizeUnit(origin)}`;
    }
    case 'too_big': {
      const bound = issue.inclusive ? 'не больше' : 'меньше';
      return `должно быть ${bound} ${String(issue.maximum)}${sizeUnit(String(issue.origin))}`;
    }
    case 'invalid_value':
      return `нужно одно из значений: ${issue.values.map((v) => shortJson(v)).join(', ')}, а ${describeInput(issue.input)}`;
    case 'invalid_format':
      return `значение в неверном формате: ${describeInput(issue.input)}`;
    case 'invalid_union':
      return 'значение не подходит ни под один из допустимых вариантов';
    case 'invalid_key':
      return 'неверный ключ';
    case 'invalid_element':
      return 'неверный элемент';
    case 'not_multiple_of':
      return `должно быть кратно ${String(issue.divisor)}`;
    case 'unrecognized_keys':
      return `лишние поля: ${issue.keys.join(', ')}`;
    default:
      return issue.message ?? 'неверное значение';
  }
};

/** Путь к полю в виде data.exercises[0].status. */
export function formatPath(path: readonly PropertyKey[], root = ''): string {
  let result = root;
  for (const part of path) {
    if (typeof part === 'number') result += `[${part}]`;
    else result += result ? `.${String(part)}` : String(part);
  }
  return result || '(весь файл)';
}

/** Первые limit проблем построчно: «путь: что не так». */
export function describeIssues(issues: readonly z.core.$ZodIssue[], limit = 5, root = ''): string {
  const lines = issues.slice(0, limit).map((issue) => `${formatPath(issue.path, root)}: ${issue.message}`);
  if (issues.length > limit) lines.push(`…и ещё ${issues.length - limit}`);
  return lines.join('\n');
}

// ------------------------------------------------------------------ проверка при записи

/** Запись не сохранена: данные не в том виде, который ожидает приложение. */
export class InvalidDataError extends Error {
  details: string;
  constructor(what: string, details: string) {
    super(`Не получилось сохранить ${what}: данные не в том виде, который ожидает приложение. Сохранённые данные не изменены.`);
    this.name = 'InvalidDataError';
    this.details = details;
  }
}

/**
 * Проверить запись перед сохранением в базу и вернуть её очищенной от лишних полей.
 * what — что сохраняем, в винительном падеже: «задание», «урок», «набор данных о рынке»…
 */
export function checkRecord<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value, { error: russianIssue });
  if (!result.success) throw new InvalidDataError(what, describeIssues(result.error.issues));
  return result.data;
}
