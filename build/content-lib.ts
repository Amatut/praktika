// Сборка учебных материалов: YAML из content/ → проверенный JSON в public/content/.
// Используется плагином Vite и скриптами (node scripts/build-content.ts).

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import {
  courseSourceSchema,
  lessonSchema,
  type ContentTest,
  type Course,
  type CourseSource,
  type Exercise,
  type HttpMock,
  type Lesson,
  type LessonSummary,
  type ModuleSummary,
  type Step,
} from '../src/content/schema.ts';

export interface LoadedContent {
  source: CourseSource;
  lessons: Lesson[];
  warnings: string[];
}

export class ContentError extends Error {}

async function listYaml(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listYaml(full)));
    else if (/\.ya?ml$/i.test(entry.name)) files.push(full);
  }
  return files.sort();
}

async function readYaml<T>(file: string, schema: z.ZodType<T>, root: string): Promise<T> {
  const relative = path.relative(root, file);
  let data: unknown;
  try {
    data = parse(await readFile(file, 'utf8'), { prettyErrors: true });
  } catch (error) {
    throw new ContentError(`${relative}: ошибка YAML\n${(error as Error).message}`);
  }
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ContentError(`${relative}: не соответствует формату\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

function wordCount(text: string): number {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .split(/\s+/)
    .filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

function sentenceCount(text: string): number {
  return text.split(/[.!?…]+(?:\s|$)/).filter((part) => part.trim().length > 0).length;
}

function exercisesOf(lesson: Lesson) {
  return lesson.steps.flatMap((step) => (step.type === 'exercise' ? [step.exercise] : []));
}

/** Ключ ответа сети: метод, адрес без query и query-параметры без учёта порядка — как в harness.py. */
export function httpKey(mock: HttpMock): string {
  const url = new URL(mock.url);
  const query = [...url.searchParams].sort(([a, x], [b, y]) => (a === b ? x.localeCompare(y) : a.localeCompare(b)));
  return `${mock.method ?? 'GET'} ${url.protocol}//${url.host}${url.pathname}${query.length > 0 ? `?${new URLSearchParams(query)}` : ''}`;
}

interface EnvironmentSource {
  files?: Record<string, string | null>;
  databases?: Record<string, string | null>;
  http?: HttpMock[];
}

/** Имена с непустым значением (null в тесте убирает файл задания). */
function presentNames(record: Record<string, string | null> | undefined): string[] {
  return Object.entries(record ?? {})
    .filter(([, value]) => value !== null)
    .map(([name]) => name);
}

/**
 * Окружение запуска: файл задания не перекрыт учебным файлом, файл не служит папкой для другого,
 * у одного адреса и метода — один ответ сети.
 */
function checkEnvironment(at: string, source: EnvironmentSource, filename: string, errors: string[]) {
  const files = presentNames(source.files);
  const databases = presentNames(source.databases);
  for (const name of [...files, ...databases]) {
    if (name === filename) {
      errors.push(`${at}: учебный файл ${name} совпадает с файлом кода (${filename}) — код ученика записывается под этим именем`);
    }
  }
  for (const name of databases) {
    if (files.includes(name)) errors.push(`${at}: ${name} указан и в files, и в databases`);
  }
  const paths = [...new Set([...files, ...databases, filename])];
  for (const a of paths) {
    for (const b of paths) {
      if (b.startsWith(`${a}/`)) errors.push(`${at}: ${a} — файл, а ${b} лежит в нём, как в папке`);
    }
  }
  const seen = new Set<string>();
  for (const mock of source.http ?? []) {
    const key = httpKey(mock);
    if (seen.has(key)) errors.push(`${at}: два ответа сети на ${key}`);
    seen.add(key);
  }
}

/** Окружение теста: поля задания, дополненные полями теста (как в harness.py). */
function testEnvironment(exercise: Exercise, test: ContentTest): EnvironmentSource {
  const http = new Map<string, HttpMock>();
  for (const mock of [...(exercise.http ?? []), ...(test.http ?? [])]) http.set(httpKey(mock), mock);
  return {
    files: { ...exercise.files, ...test.files },
    databases: { ...exercise.databases, ...test.databases },
    http: [...http.values()],
  };
}

/** Читает и проверяет все материалы. Ошибки формата останавливают сборку. */
export async function loadContent(root: string): Promise<LoadedContent> {
  const contentDir = path.join(root, 'content');
  const source = await readYaml(path.join(contentDir, 'course.yaml'), courseSourceSchema, root);
  const lessonFiles = await listYaml(path.join(contentDir, 'lessons'));
  const lessons: Lesson[] = [];
  for (const file of lessonFiles) lessons.push(await readYaml(file, lessonSchema, root));

  const errors: string[] = [];
  const warnings: string[] = [];
  const skillIds = new Set(source.skills.map((skill) => skill.id));
  const moduleIds = new Set(source.modules.map((module) => module.id));
  const plannedLessons = new Map<string, string>();
  for (const module of source.modules) {
    for (const planned of module.lessons) {
      if (plannedLessons.has(planned.id)) errors.push(`Урок ${planned.id} указан в плане дважды`);
      plannedLessons.set(planned.id, module.id);
    }
  }
  for (const skill of source.skills) {
    if (!moduleIds.has(skill.module)) errors.push(`Навык ${skill.id}: неизвестный модуль ${skill.module}`);
  }
  for (const lab of source.labs) {
    if (!moduleIds.has(lab.unlockAfter)) errors.push(`Лаборатория ${lab.id}: неизвестный модуль ${lab.unlockAfter}`);
  }
  for (const project of source.projects) {
    if (!moduleIds.has(project.after)) errors.push(`Проект ${project.id}: неизвестный модуль ${project.after}`);
  }

  const seenLessons = new Set<string>();
  const seenExercises = new Set<string>();
  for (const lesson of lessons) {
    const where = `Урок ${lesson.id}`;
    if (seenLessons.has(lesson.id)) errors.push(`${where}: повторяющийся id`);
    seenLessons.add(lesson.id);
    if (plannedLessons.get(lesson.id) !== lesson.module) {
      errors.push(`${where}: нет в плане модуля ${lesson.module} (content/course.yaml)`);
    }
    for (const skill of lesson.skills) if (!skillIds.has(skill)) errors.push(`${where}: неизвестный навык ${skill}`);
    for (const prerequisite of lesson.prerequisites) {
      if (!plannedLessons.has(prerequisite)) errors.push(`${where}: неизвестный урок в prerequisites: ${prerequisite}`);
    }
    const sentences = sentenceCount(lesson.story.text);
    if (sentences < 3 || sentences > 6) warnings.push(`${where}: история из ${sentences} предложений (ориентир 3–5)`);

    const stepIds = new Set<string>();
    for (const step of lesson.steps) checkStep(step, where, stepIds, errors, warnings);
    if (lesson.steps[lesson.steps.length - 1]?.type !== 'recap') {
      warnings.push(`${where}: последний шаг — не закрепление (recap)`);
    }

    for (const exercise of exercisesOf(lesson)) {
      const at = `${where}, задание ${exercise.id}`;
      if (seenExercises.has(exercise.id)) errors.push(`${at}: повторяющийся id задания`);
      seenExercises.add(exercise.id);
      for (const skill of exercise.skills) if (!skillIds.has(skill)) errors.push(`${at}: неизвестный навык ${skill}`);
      const testIds = new Set<string>();
      checkEnvironment(at, exercise, exercise.filename, errors);
      for (const test of exercise.tests) {
        if (testIds.has(test.id)) errors.push(`${at}: повторяющийся id теста ${test.id}`);
        testIds.add(test.id);
        const own = `${at}, тест ${test.id}`;
        // Сначала — ответы самого теста (повтор внутри него), потом — окружение теста вместе с заданием.
        checkEnvironment(own, { http: test.http }, exercise.filename, errors);
        if (test.files || test.databases) checkEnvironment(own, { ...testEnvironment(exercise, test), http: [] }, exercise.filename, errors);
        for (const [kind, record, base] of [
          ['files', test.files, exercise.files],
          ['databases', test.databases, exercise.databases],
        ] as const) {
          for (const [name, value] of Object.entries(record ?? {})) {
            if (value === null && !(base && name in base)) {
              errors.push(`${own}: ${kind}.${name}: null убирает файл задания, но у задания такого нет`);
            }
          }
        }
      }
      const mistakeIds = new Set(exercise.mistakes.map((mistake) => mistake.id));
      const ruleIds = new Set(exercise.rules.map((rule) => rule.id));
      for (const wrong of exercise.wrongSolutions) {
        if (wrong.expectMistake && !mistakeIds.has(wrong.expectMistake)) {
          errors.push(`${at}: expectMistake ссылается на неизвестный разбор ${wrong.expectMistake}`);
        }
      }
      for (const mistake of exercise.mistakes) {
        if (mistake.when.failedTest && !testIds.has(mistake.when.failedTest)) {
          errors.push(`${at}: разбор ${mistake.id} ссылается на неизвестный тест ${mistake.when.failedTest}`);
        }
        if (mistake.when.failedRule && !ruleIds.has(mistake.when.failedRule)) {
          errors.push(`${at}: разбор ${mistake.id} ссылается на неизвестное правило ${mistake.when.failedRule}`);
        }
        if (mistake.when.codeRegex) {
          try {
            // Приложение ищет с флагом m (src/coach/feedback.ts): ^ и $ — границы строк.
            new RegExp(mistake.when.codeRegex, 'm');
          } catch {
            errors.push(`${at}: разбор ${mistake.id} — неверное регулярное выражение`);
          }
          // С флагом m «^(?!…Спасибо)» совпадает в начале любой строки — и в пустой после последнего
          // перевода строки, где «Спасибо» дальше уже нет. «Во всём коде нет…» — это (?<![\s\S])(?!…).
          if (mistake.when.codeRegex.startsWith('^(?!')) {
            errors.push(
              `${at}: разбор ${mistake.id} — «^(?!…)» с флагом m проверяет каждую строку, а не весь код; для «в коде нет …» пиши (?<![\\s\\S])(?!…)`,
            );
          }
        }
      }
      const examples = exercise.tests.filter((test) => test.example).length;
      if (examples < 1) errors.push(`${at}: нет ни одного теста-примера (example: true)`);
      // Несколько примеров нужны, когда результат зависит от входных данных.
      const dependsOnInput = exercise.tests.some((test) => test.kind === 'call' || Boolean(test.stdin));
      if (examples < 2 && dependsOnInput && exercise.kind !== 'repeat' && exercise.kind !== 'fix') {
        warnings.push(`${at}: примеров ${examples} (ориентир 2–3)`);
      }
      if (exercise.starterCode.trim() === exercise.solution.code.trim()) {
        errors.push(`${at}: стартовый код совпадает с решением`);
      }
      const solutionLines = exercise.solution.code
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 12);
      for (const line of solutionLines) {
        if (exercise.hints[0].includes(line)) errors.push(`${at}: первая подсказка раскрывает строку решения «${line}»`);
        if (exercise.title.includes(line)) errors.push(`${at}: название раскрывает решение`);
      }
    }
  }

  for (const [lessonId, moduleId] of plannedLessons) {
    if (!moduleIds.has(moduleId)) errors.push(`План: урок ${lessonId} в неизвестном модуле ${moduleId}`);
  }

  if (errors.length > 0) {
    throw new ContentError(`Материалы содержат ошибки:\n- ${errors.join('\n- ')}`);
  }
  return { source, lessons, warnings };
}

function checkStep(step: Step, where: string, stepIds: Set<string>, errors: string[], warnings: string[]) {
  const at = `${where}, шаг ${step.id}`;
  if (stepIds.has(step.id)) errors.push(`${at}: повторяющийся id шага`);
  stepIds.add(step.id);
  switch (step.type) {
    case 'theory': {
      const words = wordCount(step.body);
      if (words > 350) warnings.push(`${at}: теория ${words} слов (ориентир до 350)`);
      break;
    }
    case 'predict':
      if (step.options && !step.options.includes(step.answer)) {
        errors.push(`${at}: ответ не входит в варианты`);
      }
      checkEnvironment(at, step, 'main.py', errors);
      break;
    case 'example':
      checkEnvironment(at, step, 'main.py', errors);
      break;
    case 'order': {
      const ids = new Set(step.items.map((item) => item.id));
      if (ids.size !== step.items.length) errors.push(`${at}: повторяющиеся id пунктов`);
      for (const [a, b] of step.before ?? []) {
        if (!ids.has(a) || !ids.has(b)) errors.push(`${at}: before ссылается на неизвестный пункт`);
      }
      break;
    }
    case 'quiz':
      if (step.correct >= step.options.length) errors.push(`${at}: correct вне диапазона вариантов`);
      break;
    default:
      break;
  }
}

function hash(text: string, length = 10): string {
  return createHash('sha256').update(text).digest('hex').slice(0, length);
}

function summarizeLesson(lesson: Lesson): LessonSummary {
  return {
    id: lesson.id,
    title: lesson.title,
    ready: true,
    number: lesson.number,
    minutes: lesson.minutes,
    environment: lesson.environment,
    exerciseCount: exercisesOf(lesson).length,
  };
}

/** Собирает материалы в public/content и возвращает карту курса. */
export async function buildContent(root: string, outDir = path.join(root, 'public', 'content')): Promise<{
  course: Course;
  warnings: string[];
}> {
  const { source, lessons, warnings } = await loadContent(root);
  const byId = new Map(lessons.map((lesson) => [lesson.id, lesson]));
  const moduleDir = path.join(outDir, 'modules');
  await rm(moduleDir, { recursive: true, force: true });
  await mkdir(moduleDir, { recursive: true });

  const modules: ModuleSummary[] = [];
  const hashes: string[] = [];
  for (const module of source.modules) {
    const ready = module.lessons.map((planned) => byId.get(planned.id)).filter((lesson) => lesson !== undefined);
    const lessonsSummary: LessonSummary[] = module.lessons.map((planned) => {
      const lesson = byId.get(planned.id);
      return lesson ? summarizeLesson(lesson) : { id: planned.id, title: planned.title, ready: false };
    });
    let file: string | null = null;
    let sizeBytes = 0;
    if (ready.length > 0) {
      const json = JSON.stringify({ id: module.id, lessons: ready });
      const digest = hash(json);
      hashes.push(digest);
      file = `content/modules/${module.id}.${digest}.json`;
      sizeBytes = Buffer.byteLength(json);
      await writeFile(path.join(root, 'public', file), json);
    }
    const status = ready.length === 0 ? 'planned' : ready.length === module.lessons.length ? 'ready' : 'partial';
    modules.push({ ...module, lessons: lessonsSummary, status, file, sizeBytes });
  }

  const courseBody = { ...source, modules };
  const contentVersion = hash(JSON.stringify(courseBody) + hashes.join(''), 12);
  // Без времени сборки: course.json входит в оболочку, и одинаковые материалы должны давать
  // одинаковый файл — иначе каждая сборка выглядела бы для service worker новой версией.
  const course: Course = { ...courseBody, contentVersion };
  await writeFile(path.join(outDir, 'course.json'), JSON.stringify(course));
  return { course, warnings };
}
