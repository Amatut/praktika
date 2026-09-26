// Формат учебных материалов «Практики».
// Материалы пишутся в YAML (папка content/), проверяются этой схемой при сборке
// и превращаются в JSON. Интерфейс использует только типы отсюда.

import { z } from 'zod';

const id = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'id: латиница, цифры и дефис');
/** Текст с простой разметкой: абзацы, списки, **жирный**, *курсив*, `код`, ```блоки```, [ссылки](https://…). */
const markdown = z.string().min(1);

// ------------------------------------------------------------------ тесты

export const compareOptionsSchema = z
  .object({
    /** lines — построчно (по умолчанию); regex — весь вывод по шаблону; contains — вывод содержит строки. */
    mode: z.enum(['lines', 'regex', 'contains']).optional(),
    ignoreCase: z.boolean().optional(),
    ignoreSpaces: z.boolean().optional(),
    ignoreBlankLines: z.boolean().optional(),
  })
  .strict();

const testBase = {
  id,
  /** Название для ученика: «Пример 1», «Граничный случай: ноль». */
  title: z.string().optional(),
  /** Показывать в условии как пример. */
  example: z.boolean().optional(),
  /** Граничный случай. */
  edge: z.boolean().optional(),
  stdin: z.string().optional(),
};

export const ioTestSchema = z
  .object({
    ...testBase,
    kind: z.literal('io'),
    expected: z.string(),
    /** Для regex-проверок: как описать ожидаемое человеку. */
    expectedLabel: z.string().optional(),
    compare: compareOptionsSchema.optional(),
  })
  .strict();

export const callTestSchema = z
  .object({
    ...testBase,
    kind: z.literal('call'),
    /** Выражение Python, например «is_even(4)». */
    call: z.string(),
    /** Ожидаемое значение как литерал Python: «True», «[1, 2]», «'текст'». */
    expected: z.string(),
    floatTolerance: z.number().positive().optional(),
  })
  .strict();

export const assertTestSchema = z
  .object({
    ...testBase,
    kind: z.literal('assert'),
    /** Код с assert, выполняется после программы ученика в том же пространстве имён. */
    code: z.string(),
    /** Что сказать, если проверка не прошла. */
    message: z.string(),
  })
  .strict();

export const testSchema = z.discriminatedUnion('kind', [ioTestSchema, callTestSchema, assertTestSchema]);

const pythonName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'имя переменной Python');

/**
 * Проверка по устройству кода (через ast).
 * use / avoid / min / max — узлы и вызовы: For, While, If, FunctionDef, call:print, call:input…
 * Число узлов плохо передаёт смысл (разные верные решения дают разное число имён и присваиваний),
 * поэтому «посчитано из переменных» проверяют dependsOn и fromNumbers — по тому, откуда берётся значение.
 */
export const ruleSchema = z
  .object({
    id,
    use: z.array(z.string()).optional(),
    avoid: z.array(z.string()).optional(),
    min: z.record(z.string(), z.number().int().nonnegative()).optional(),
    max: z.record(z.string(), z.number().int().nonnegative()).optional(),
    /**
     * Значение переменной посчитано из этих переменных — прямо или через другие:
     * { greeting: [name] }. Вместо переменной можно указать print — то, что печатает программа.
     */
    dependsOn: z.record(pythonName, z.array(pythonName).min(1)).optional(),
    /**
     * Значение переменной посчитано формулой без готовых чисел, а исходные числа лежат
     * в переменных: { total: [540, 3, 330] } — среди них есть переменные с 540, 3 и 330.
     */
    fromNumbers: z.record(pythonName, z.array(z.number()).min(1)).optional(),
    message: z.string(),
  })
  .strict();

/** Когда показывать заранее написанный разбор типичной ошибки. */
export const matcherSchema = z
  .object({
    errorType: z.string().optional(),
    errorIncludes: z.string().optional(),
    /**
     * Весь вывод (без пробелов в конце строк) в первом непрошедшем тесте.
     * Условия по выводу не срабатывают, если программа в этом тесте упала, упёрлась в лимит
     * или была прервана; если в разборе есть условие на ошибку — вывод берётся из теста с ошибкой.
     */
    outputEquals: z.string().optional(),
    outputIncludes: z.string().optional(),
    codeIncludes: z.string().optional(),
    codeRegex: z.string().optional(),
    failedTest: z.string().optional(),
    failedRule: z.string().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Пустое условие');

export const mistakeSchema = z
  .object({
    id,
    when: matcherSchema,
    /** Где искать (необязательно — по умолчанию берётся из результата проверки). */
    where: z.string().optional(),
    why: z.string(),
    try: z.string(),
    verify: z.string().optional(),
  })
  .strict();

// ------------------------------------------------------------------ задание

export const exerciseKindSchema = z.enum(['repeat', 'modify', 'write', 'fix', 'read']);

export const exerciseSchema = z
  .object({
    id,
    kind: exerciseKindSchema,
    title: z.string(),
    statement: markdown,
    /** Входные данные. */
    input: z.string().optional(),
    /** Ожидаемый результат. */
    output: z.string().optional(),
    constraints: z.array(z.string()).default([]),
    filename: z.string().default('main.py'),
    starterCode: z.string(),
    tests: z.array(testSchema).min(1),
    rules: z.array(ruleSchema).default([]),
    /** Критерии проверки для человека. */
    criteria: z.array(z.string()).min(1),
    hints: z.tuple([z.string(), z.string(), z.string()]),
    solution: z.object({ code: z.string(), explanation: markdown }).strict(),
    /** Типичные неверные решения — только для автоматической проверки материалов. */
    wrongSolutions: z
      .array(
        z
          .object({
            code: z.string(),
            note: z.string(),
            /**
             * id разбора из mistakes, который должен сработать; null — ни один разбор из материалов
             * срабатывать не должен (ученик увидит общий разбор проверки). Указывается всегда:
             * без него проверка материалов не знает, какой разбор правильный.
             */
            expectMistake: z.string().nullable().optional(),
          })
          .strict(),
      )
      .min(1),
    /**
     * Другие верные решения — только для автоматической проверки материалов: каждое должно
     * пройти все тесты и правила, как эталон. Так правила не отклоняют верный код, написанный иначе.
     */
    altSolutions: z.array(z.object({ code: z.string(), note: z.string() }).strict()).optional(),
    mistakes: z.array(mistakeSchema).default([]),
    /** Что получилось и одно уместное улучшение — после успешной проверки. */
    afterPass: markdown.optional(),
    skills: z.array(id).min(1),
    timeLimitMs: z.number().int().positive().optional(),
    /** Самостоятельная работа: подсказки открываются только после первой попытки. */
    noHintsBeforeAttempt: z.boolean().optional(),
  })
  .strict();

// ------------------------------------------------------------------ шаги урока

const stepBase = { id, title: z.string() };

export const theoryStepSchema = z
  .object({
    ...stepBase,
    type: z.literal('theory'),
    body: markdown,
    /** Объяснение попроще — для кнопки «Объясни проще». */
    simpler: markdown.optional(),
    /** Короткая реплика наставника рядом с текстом. */
    coach: markdown.optional(),
  })
  .strict();

export const exampleStepSchema = z
  .object({
    ...stepBase,
    type: z.literal('example'),
    body: markdown.optional(),
    code: z.string(),
    stdin: z.string().optional(),
    /** Пояснения к существенным строкам. */
    notes: z.array(z.object({ line: z.number().int().positive(), text: z.string() }).strict()).min(1),
    /** Предложение что-нибудь изменить и запустить снова. */
    tryIt: markdown.optional(),
    coach: markdown.optional(),
  })
  .strict();

export const predictStepSchema = z
  .object({
    ...stepBase,
    type: z.literal('predict'),
    prompt: markdown,
    code: z.string(),
    stdin: z.string().optional(),
    /** Варианты ответа (необязательно). Если есть — answer совпадает с одним из них. */
    options: z.array(z.string()).optional(),
    /** Что выведет программа. Проверяется запуском при сборке материалов. */
    answer: z.string(),
    /** Ответ не является выводом программы (например, «ошибка в строке 2»). */
    answerIsNotOutput: z.boolean().optional(),
    explanation: markdown,
    coach: markdown.optional(),
  })
  .strict();

export const orderStepSchema = z
  .object({
    ...stepBase,
    type: z.literal('order'),
    prompt: markdown,
    /** Шаги в правильном порядке (в интерфейсе перемешиваются). */
    items: z.array(z.object({ id, text: z.string() }).strict()).min(3),
    /** Если порядок допускает варианты — пары «a раньше b». Иначе нужен ровно порядок items. */
    before: z.array(z.tuple([id, id])).optional(),
    explanation: markdown,
    coach: markdown.optional(),
  })
  .strict();

export const exerciseStepSchema = z
  .object({
    ...stepBase,
    type: z.literal('exercise'),
    exercise: exerciseSchema,
  })
  .strict();

export const checklistStepSchema = z
  .object({
    ...stepBase,
    type: z.literal('checklist'),
    body: markdown,
    /** Инструкция для внешнего инструмента: ученик отмечает шаги сам. */
    items: z.array(z.object({ id, text: markdown, help: markdown.optional() }).strict()).min(1),
    coach: markdown.optional(),
  })
  .strict();

export const quizStepSchema = z
  .object({
    ...stepBase,
    type: z.literal('quiz'),
    question: markdown,
    options: z.array(z.string()).min(2),
    correct: z.number().int().nonnegative(),
    explanation: markdown,
    coach: markdown.optional(),
  })
  .strict();

export const recapStepSchema = z
  .object({
    ...stepBase,
    type: z.literal('recap'),
    points: z.array(z.string()).min(2),
    /** Вопрос на понимание — ответ ученик пишет своими словами. */
    question: z.string(),
    answer: markdown,
  })
  .strict();

export const stepSchema = z.discriminatedUnion('type', [
  theoryStepSchema,
  exampleStepSchema,
  predictStepSchema,
  orderStepSchema,
  exerciseStepSchema,
  checklistStepSchema,
  quizStepSchema,
  recapStepSchema,
]);

// ------------------------------------------------------------------ урок и модуль

export const environmentSchema = z.enum(['python', 'web', 'external']);

export const lessonSchema = z
  .object({
    id,
    module: id,
    number: z.string(),
    title: z.string(),
    /** Одна учебная цель. */
    objective: z.string(),
    minutes: z.tuple([z.number().int().positive(), z.number().int().positive()]),
    prerequisites: z.array(id).default([]),
    skills: z.array(id).min(1),
    environment: environmentSchema,
    story: z
      .object({
        title: z.string(),
        text: markdown,
        /** Пример придуманный или составной — так и показывается ученику. */
        fictional: z.boolean(),
      })
      .strict(),
    /** Зачем это нужно: 1–2 предложения и пример. */
    why: markdown,
    /** Где это используется. */
    usedIn: markdown,
    steps: z.array(stepSchema).min(2),
  })
  .strict();

export const moduleFileSchema = z
  .object({
    id,
    lessons: z.array(lessonSchema).min(1),
  })
  .strict();

// ------------------------------------------------------------------ карта курса

export const skillSchema = z
  .object({
    id,
    title: z.string(),
    module: id,
    description: z.string(),
  })
  .strict();

export const moduleSummarySchema = z
  .object({
    id,
    number: z.number().int().nonnegative(),
    part: z.enum(['basics', 'deepening']),
    title: z.string(),
    /** Зачем модуль нужен в реальной программе. */
    why: z.string(),
    outcomes: z.array(z.string()).min(1),
    prerequisites: z.array(z.string()).default([]),
    /** Ориентировочно, в учебных часах (диапазон). */
    hours: z.tuple([z.number().positive(), z.number().positive()]),
    /** План уроков. Готовые уроки подставляются из файлов при сборке. */
    lessons: z.array(z.object({ id, title: z.string() }).strict()).min(1),
    practice: z.string(),
    mistakes: z.array(z.string()).min(1),
    completion: z.string(),
    environment: z.enum(['browser', 'local', 'mixed']),
  })
  .strict();

export const paidTaskSchema = z
  .object({
    title: z.string(),
    /** Пример требований заказчика — всегда учебный, без бюджета. */
    example: z.string(),
    /** Чего новичку пока не хватает. */
    gap: z.string(),
  })
  .strict();

export const labSchema = z
  .object({
    id,
    title: z.string(),
    hook: z.string(),
    story: z.object({ title: z.string(), text: markdown, fictional: z.boolean() }).strict(),
    day: z.string(),
    products: z.array(z.string()).min(1),
    likes: z.array(z.string()).min(1),
    hard: z.array(z.string()).min(1),
    project: z
      .object({
        title: z.string(),
        result: z.string(),
        sessions: z.tuple([z.number().int().positive(), z.number().int().positive()]),
        environment: environmentSchema,
        tools: z.string(),
        prototype: z.enum(['working', 'simulation', 'concept']),
      })
      .strict(),
    prerequisites: z.array(z.string()).min(1),
    unlockAfter: id,
    realWork: z.array(z.string()).min(1),
    paidTasks: z.array(paidTaskSchema).min(2).max(3),
    ready: z.boolean(),
  })
  .strict();

export const projectSchema = z
  .object({
    id,
    title: z.string(),
    after: id,
    story: z.string(),
    environment: z.enum(['browser', 'local', 'mixed']),
    minimum: z.array(z.string()).min(1),
    extras: z.array(z.string()).min(2).max(3),
    criteria: z.array(z.string()).min(1),
    stages: z.array(z.object({ id, title: z.string(), description: z.string() }).strict()).min(2),
    changeRequest: z.string(),
    ready: z.boolean(),
  })
  .strict();

export const courseSourceSchema = z
  .object({
    title: z.string(),
    subtitle: z.string(),
    stages: z.array(z.object({ id, title: z.string(), description: z.string() }).strict()).min(3),
    skills: z.array(skillSchema).min(1),
    modules: z.array(moduleSummarySchema).min(1),
    labs: z.array(labSchema).min(1),
    projects: z.array(projectSchema).min(1),
  })
  .strict();

// ------------------------------------------------------------------ типы

export type CompareOptions = z.infer<typeof compareOptionsSchema>;
export type ContentTest = z.infer<typeof testSchema>;
export type IoTest = z.infer<typeof ioTestSchema>;
export type CallTest = z.infer<typeof callTestSchema>;
export type AssertTest = z.infer<typeof assertTestSchema>;
export type Rule = z.infer<typeof ruleSchema>;
export type Matcher = z.infer<typeof matcherSchema>;
export type Mistake = z.infer<typeof mistakeSchema>;
export type ExerciseKind = z.infer<typeof exerciseKindSchema>;
export type Exercise = z.infer<typeof exerciseSchema>;
export type TheoryStep = z.infer<typeof theoryStepSchema>;
export type ExampleStep = z.infer<typeof exampleStepSchema>;
export type PredictStep = z.infer<typeof predictStepSchema>;
export type OrderStep = z.infer<typeof orderStepSchema>;
export type ExerciseStep = z.infer<typeof exerciseStepSchema>;
export type ChecklistStep = z.infer<typeof checklistStepSchema>;
export type QuizStep = z.infer<typeof quizStepSchema>;
export type RecapStep = z.infer<typeof recapStepSchema>;
export type Step = z.infer<typeof stepSchema>;
export type StepType = Step['type'];
export type Environment = z.infer<typeof environmentSchema>;
export type Lesson = z.infer<typeof lessonSchema>;
export type ModuleFile = z.infer<typeof moduleFileSchema>;
export type Skill = z.infer<typeof skillSchema>;
export type ModuleSummarySource = z.infer<typeof moduleSummarySchema>;
export type Lab = z.infer<typeof labSchema>;
export type PaidTask = z.infer<typeof paidTaskSchema>;
export type Project = z.infer<typeof projectSchema>;
export type CourseSource = z.infer<typeof courseSourceSchema>;

/** Готовность материалов модуля. */
export type MaterialStatus = 'ready' | 'partial' | 'planned';

export interface LessonSummary {
  id: string;
  title: string;
  ready: boolean;
  number?: string;
  minutes?: [number, number];
  environment?: Environment;
  exerciseCount?: number;
}

export interface ModuleSummary extends Omit<ModuleSummarySource, 'lessons'> {
  lessons: LessonSummary[];
  status: MaterialStatus;
  /** Файл с уроками (если хотя бы один урок готов). */
  file: string | null;
  sizeBytes: number;
}

/**
 * course.json — карта курса, которую получает приложение. Файл входит в оболочку, по которой
 * считается версия service worker, поэтому в нём нет ничего, что меняется от сборки к сборке
 * (например, времени сборки): иначе каждый запуск выпускал бы «новую версию».
 */
export interface Course extends Omit<CourseSource, 'modules'> {
  contentVersion: string;
  modules: ModuleSummary[];
}
