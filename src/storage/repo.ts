// Асинхронное API хранилища для интерфейса. Каждая функция — одна транзакция IndexedDB;
// после успешной записи подписчики onChange получают список изменённых хранилищ.
// Каждая запись перед сохранением проверяется теми же схемами, что и файл экспорта (schemas.ts):
// неверные данные не попадают в базу, поэтому экспорт и резервные копии всегда можно прочитать.

import type { IDBPObjectStore, IDBPTransaction } from 'idb';
import { getDb, notifyChange } from './db.ts';
import type { PraktikaDB, StoreName } from './db.ts';
import {
  activitySchema,
  attemptSchema,
  checkRecord,
  coachDraftSchema,
  exerciseSchema,
  interestSchema,
  lessonSchema,
  marketDatasetSchema,
  metaSchema,
  projectSchema,
  reviewSchema,
  settingsSchema,
} from './schemas.ts';
import {
  addLocalDays,
  exerciseReviewKey,
  firstReview,
  localDateKey,
  nextReview,
  reviewReasonForFirstPass,
  startOfLocalDay,
} from './schedule.ts';
import { DEFAULT_META, DEFAULT_SETTINGS } from './types.ts';
import type {
  ActivityRecord,
  AttemptRecord,
  CoachDraft,
  ExerciseRecord,
  HelpLevel,
  InterestRecord,
  LessonRecord,
  MarketDataset,
  Meta,
  ProjectRecord,
  ReviewRecord,
  Settings,
} from './types.ts';

export { onChange, StorageUnavailableError } from './db.ts';
export type { ChangeListener, StorageProblem } from './db.ts';
export { InvalidDataError } from './schemas.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

type KvStore = IDBPObjectStore<PraktikaDB, ArrayLike<StoreName>, 'kv', 'readwrite'>;

function asKvStore<T extends ArrayLike<StoreName>>(store: IDBPObjectStore<PraktikaDB, T, 'kv', 'readwrite'>): KvStore {
  return store as unknown as KvStore;
}

/** Убрать ключи со значением undefined, чтобы они не затирали данные при слиянии. */
function defined<T extends object>(patch: T): Partial<T> {
  const result: Partial<T> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) (result as Record<string, unknown>)[key] = value;
  }
  return result;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function makeId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `${prefix}-${uuid}`;
  // crypto.randomUUID есть только в защищённом контексте (https, localhost); в локальной сети по http — нет.
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function toCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

type WriteTx<Names extends ArrayLike<StoreName>> = IDBPTransaction<PraktikaDB, Names, 'readwrite'>;

/**
 * Одна транзакция записи. work складывает в changed имена изменённых хранилищ; подписчики onChange
 * узнают о них только после успешного завершения транзакции.
 * Если work бросает исключение или запрос завершается ошибкой (например, не хватило места),
 * транзакция откатывается, наружу уходит исходная ошибка, а отказ tx.done не остаётся необработанным.
 */
async function writeTx<const Names extends ArrayLike<StoreName>, R>(
  names: Names,
  work: (tx: WriteTx<Names>, changed: Set<StoreName>) => Promise<R>,
): Promise<R> {
  const db = await getDb();
  const tx = db.transaction(names, 'readwrite');
  const changed = new Set<StoreName>();
  let result: R;
  try {
    result = await work(tx, changed);
    await tx.done;
  } catch (error) {
    tx.done.catch(() => undefined);
    try {
      tx.abort();
    } catch {
      // Транзакция уже отменена браузером или завершилась.
    }
    throw error;
  }
  if (changed.size > 0) notifyChange([...changed]);
  return result;
}

// ------------------------------------------------------------------ настройки и служебные данные

export type SettingsPatch = Partial<Omit<Settings, 'coach' | 'market'>> & {
  coach?: Partial<Settings['coach']>;
  market?: Partial<Settings['market']>;
};

/** Глубокое слияние настроек: coach и market сливаются по полям, остальное заменяется. */
export function mergeSettings(base: Settings, patch: SettingsPatch): Settings {
  const { coach, market, ...rest } = patch;
  return {
    ...base,
    ...defined(rest),
    coach: { ...base.coach, ...(coach ? defined(coach) : {}) },
    market: { ...base.market, ...(market ? defined(market) : {}) },
  };
}

/** Привести сохранённые настройки к полному виду: недостающие поля берутся из DEFAULT_SETTINGS. */
export function normalizeSettings(raw: unknown): Settings {
  if (!isObject(raw)) return mergeSettings(DEFAULT_SETTINGS, {});
  return mergeSettings(DEFAULT_SETTINGS, raw as SettingsPatch);
}

export function normalizeMeta(raw: unknown): Meta {
  if (!isObject(raw)) return { ...DEFAULT_META };
  return { ...DEFAULT_META, ...defined(raw as Partial<Meta>) };
}

export async function getSettings(): Promise<Settings> {
  const db = await getDb();
  return normalizeSettings(await db.get('kv', 'settings'));
}

export function saveSettings(patch: SettingsPatch): Promise<Settings> {
  return writeTx(['kv'], async (tx, changed) => {
    const kv = tx.objectStore('kv');
    const merged = mergeSettings(normalizeSettings(await kv.get('settings')), patch);
    const next = checkRecord<Settings>(settingsSchema, merged, 'настройки');
    await kv.put(next, 'settings');
    changed.add('kv');
    return next;
  });
}

export async function getMeta(): Promise<Meta> {
  const db = await getDb();
  return normalizeMeta(await db.get('kv', 'meta'));
}

export function updateMeta(patch: Partial<Meta>): Promise<Meta> {
  return writeTx(['kv'], async (tx, changed) => {
    const kv = tx.objectStore('kv');
    const merged: Meta = { ...normalizeMeta(await kv.get('meta')), ...defined(patch) };
    const next = checkRecord<Meta>(metaSchema, merged, 'служебные данные');
    await kv.put(next, 'meta');
    changed.add('kv');
    return next;
  });
}

/** Запомнить момент первого действия ученика; если meta изменилась, 'kv' добавляется в changed. */
async function touchFirstActivity(kv: KvStore, ts: number, changed: Set<StoreName>): Promise<void> {
  const meta = normalizeMeta(await kv.get('meta'));
  if (meta.firstActivityAt !== null) return;
  await kv.put({ ...meta, firstActivityAt: ts }, 'meta');
  changed.add('kv');
}

function checkExercise(record: ExerciseRecord): ExerciseRecord {
  return checkRecord<ExerciseRecord>(exerciseSchema, record, 'задание');
}

// ------------------------------------------------------------------ упражнения

function blankExercise(exerciseId: string, lessonId: string, ts: number): ExerciseRecord {
  return {
    exerciseId,
    lessonId,
    draft: null,
    draftUpdatedAt: null,
    status: 'new',
    checks: 0,
    runs: 0,
    hintsShown: 0,
    solutionViewed: false,
    firstPassedAt: null,
    firstPassHelp: null,
    lastCheckAt: null,
    updatedAt: ts,
  };
}

export async function getExercise(exerciseId: string): Promise<ExerciseRecord | undefined> {
  const db = await getDb();
  return db.get('exercises', exerciseId);
}

export async function getExercisesByLesson(lessonId: string): Promise<ExerciseRecord[]> {
  const db = await getDb();
  return db.getAllFromIndex('exercises', 'lessonId', lessonId);
}

export async function getAllExercises(): Promise<ExerciseRecord[]> {
  const db = await getDb();
  return db.getAll('exercises');
}

/**
 * Изменить запись упражнения (создав её при необходимости) и, если нужно, отметить первое действие.
 * change возвращает новую запись или null, если менять нечего.
 */
function modifyExercise(
  exerciseId: string,
  lessonId: string,
  change: (prev: ExerciseRecord, ts: number) => ExerciseRecord | null,
): Promise<ExerciseRecord> {
  return writeTx(['exercises', 'kv'], async (tx, changed) => {
    const ts = Date.now();
    const store = tx.objectStore('exercises');
    const prev = (await store.get(exerciseId)) ?? blankExercise(exerciseId, lessonId, ts);
    const proposed = change(prev, ts);
    if (!proposed) return prev;
    const next = checkExercise(proposed);
    await store.put(next);
    changed.add('exercises');
    await touchFirstActivity(asKvStore(tx.objectStore('kv')), ts, changed);
    return next;
  });
}

/** Сохранить черновик кода. */
export function saveDraft(exerciseId: string, lessonId: string, code: string): Promise<ExerciseRecord> {
  return modifyExercise(exerciseId, lessonId, (prev, ts) => ({
    ...prev,
    lessonId,
    draft: code,
    draftUpdatedAt: ts,
    updatedAt: ts,
  }));
}

/**
 * Вернуть стартовый код: черновик становится null. Время сброса запоминается,
 * чтобы при слиянии с другим устройством сброс не потерялся. Если записи нет — ничего не делает.
 */
export function resetDraft(exerciseId: string): Promise<ExerciseRecord | undefined> {
  return writeTx(['exercises'], async (tx, changed) => {
    const store = tx.objectStore('exercises');
    const prev = await store.get(exerciseId);
    if (!prev) return undefined;
    const ts = Date.now();
    const next = checkExercise({ ...prev, draft: null, draftUpdatedAt: ts, updatedAt: ts });
    await store.put(next);
    changed.add('exercises');
    return next;
  });
}

type AttemptStore = IDBPObjectStore<PraktikaDB, ArrayLike<StoreName>, 'attempts', 'readwrite'>;

/** Записать попытку. Ключ `${exerciseId}:${at}`; если в ту же миллисекунду уже была попытка — at сдвигается. */
async function putAttempt(store: AttemptStore, attempt: Omit<AttemptRecord, 'key'>): Promise<AttemptRecord> {
  let at = attempt.at;
  while ((await store.getKey(`${attempt.exerciseId}:${at}`)) !== undefined) at += 1;
  const record = checkRecord<AttemptRecord>(attemptSchema, { ...attempt, at, key: `${attempt.exerciseId}:${at}` }, 'попытку');
  await store.put(record);
  return record;
}

/** Тип ошибки: строка или null (undefined и прочее от интерфейса считаются «без ошибки»). */
function toErrorType(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** «Запустить»: runs + 1 и попытка вида run. errorType — тип ошибки или null, если программа отработала. */
export function recordRun(exerciseId: string, lessonId: string, errorType: string | null): Promise<ExerciseRecord> {
  return writeTx(['exercises', 'attempts', 'kv'], async (tx, changed) => {
    const ts = Date.now();
    const store = tx.objectStore('exercises');
    const prev = (await store.get(exerciseId)) ?? blankExercise(exerciseId, lessonId, ts);
    const next = checkExercise({ ...prev, lessonId, runs: prev.runs + 1, updatedAt: ts });
    const error = toErrorType(errorType);
    await store.put(next);
    await putAttempt(tx.objectStore('attempts') as unknown as AttemptStore, {
      exerciseId,
      lessonId,
      at: ts,
      kind: 'run',
      passed: error === null,
      errorType: error,
      failed: 0,
      total: 0,
    });
    changed.add('exercises').add('attempts');
    await touchFirstActivity(asKvStore(tx.objectStore('kv')), ts, changed);
    return next;
  });
}

export interface CheckInput {
  passed: boolean;
  /** Тип ошибки Python или timeout / limit / output / rule; null — без ошибки. */
  errorType: string | null;
  /** Сколько тестов не прошло. */
  failed: number;
  /** Сколько тестов всего. */
  total: number;
  /** Сколько помощи было открыто к моменту проверки. */
  help: HelpLevel;
}

function clampHelp(value: number): HelpLevel {
  if (!Number.isFinite(value)) return 0;
  return Math.min(4, Math.max(0, Math.trunc(value))) as HelpLevel;
}

/** Помощь по записи упражнения: 4 — смотрел решение, иначе число открытых подсказок. */
export function helpFromRecord(record: Pick<ExerciseRecord, 'hintsShown' | 'solutionViewed'>): HelpLevel {
  return record.solutionViewed ? 4 : record.hintsShown;
}

/**
 * «Проверить»: checks + 1, статус new → attempted → passed (passed не откатывается).
 * При первом успехе запоминается время и помощь, и при необходимости задание ставится на повторение
 * (третья подсказка, просмотр решения или 4+ неудачные проверки до успеха).
 */
export function recordCheck(exerciseId: string, lessonId: string, input: CheckInput): Promise<ExerciseRecord> {
  return writeTx(['exercises', 'attempts', 'reviews', 'kv'], async (tx, changed) => {
    const ts = Date.now();
    const store = tx.objectStore('exercises');
    const prev = (await store.get(exerciseId)) ?? blankExercise(exerciseId, lessonId, ts);
    const passed = input.passed === true;
    const alreadyPassed = prev.status === 'passed' || prev.firstPassedAt !== null;
    const draft: ExerciseRecord = {
      ...prev,
      lessonId,
      checks: prev.checks + 1,
      lastCheckAt: ts,
      updatedAt: ts,
      status: passed || prev.status === 'passed' ? 'passed' : 'attempted',
    };
    let review: ReviewRecord | null = null;

    if (passed && !alreadyPassed) {
      const help = Math.max(clampHelp(input.help), helpFromRecord(prev)) as HelpLevel;
      draft.firstPassedAt = ts;
      draft.firstPassHelp = help;
      // До первого успеха все проверки были неудачными.
      const reason = reviewReasonForFirstPass(help, prev.checks);
      if (reason) {
        const key = exerciseReviewKey(exerciseId);
        const existing = await tx.objectStore('reviews').get(key);
        const step = firstReview(ts);
        review = checkRecord<ReviewRecord>(
          reviewSchema,
          {
            key,
            lessonId,
            exerciseId,
            stage: step.stage,
            dueAt: step.dueAt,
            reason,
            createdAt: existing?.createdAt ?? ts,
            updatedAt: ts,
            doneAt: null,
          },
          'повторение',
        );
      }
    }

    const next = checkExercise(draft);
    if (review) {
      await tx.objectStore('reviews').put(review);
      changed.add('reviews');
    }
    await store.put(next);
    await putAttempt(tx.objectStore('attempts') as unknown as AttemptStore, {
      exerciseId,
      lessonId,
      at: ts,
      kind: 'check',
      passed,
      errorType: toErrorType(input.errorType),
      failed: toCount(input.failed),
      total: toCount(input.total),
    });
    changed.add('exercises').add('attempts');
    await touchFirstActivity(asKvStore(tx.objectStore('kv')), ts, changed);
    return next;
  });
}

/** Открыт уровень подсказки 1..3; хранится максимальный открытый уровень. */
export function markHintShown(exerciseId: string, lessonId: string, level: 1 | 2 | 3): Promise<ExerciseRecord> {
  const safeLevel = Math.min(3, Math.max(1, Math.trunc(level))) as 1 | 2 | 3;
  return modifyExercise(exerciseId, lessonId, (prev, ts) =>
    prev.hintsShown >= safeLevel ? null : { ...prev, lessonId, hintsShown: safeLevel, updatedAt: ts },
  );
}

export function markSolutionViewed(exerciseId: string, lessonId: string): Promise<ExerciseRecord> {
  return modifyExercise(exerciseId, lessonId, (prev, ts) =>
    prev.solutionViewed ? null : { ...prev, lessonId, solutionViewed: true, updatedAt: ts },
  );
}

// ------------------------------------------------------------------ уроки

/**
 * Изменение урока. stepIndex, startedAt, completedAt, recap заменяются;
 * completedSteps объединяются (шаги только добавляются);
 * predictions, orders, quizzes, checklists сливаются по ключу — можно передать только новый ответ.
 */
export type LessonPatch = Partial<Omit<LessonRecord, 'lessonId' | 'updatedAt'>>;

function blankLesson(lessonId: string, ts: number): LessonRecord {
  return {
    lessonId,
    stepIndex: 0,
    completedSteps: [],
    startedAt: ts,
    completedAt: null,
    predictions: {},
    orders: {},
    quizzes: {},
    checklists: {},
    recap: null,
    updatedAt: ts,
  };
}

function union(a: readonly string[], b: readonly string[]): string[] {
  return [...new Set([...a, ...b])];
}

/** Номер шага и счётчики — целые числа ≥ 0 (номер шага может прийти из адреса страницы). */
function sanitizeLessonPatch(patch: LessonPatch): LessonPatch {
  const p = defined(patch);
  const result: LessonPatch = { ...p };
  if (p.stepIndex !== undefined) result.stepIndex = toCount(p.stepIndex);
  if (isObject(p.orders)) {
    result.orders = Object.fromEntries(
      Object.entries(p.orders).map(([key, value]) => [key, isObject(value) ? { ...value, attempts: toCount(value.attempts) } : value]),
    );
  }
  if (isObject(p.quizzes)) {
    result.quizzes = Object.fromEntries(
      Object.entries(p.quizzes).map(([key, value]) => [key, isObject(value) ? { ...value, choice: toCount(value.choice) } : value]),
    );
  }
  return result;
}

export function applyLessonPatch(prev: LessonRecord, patch: LessonPatch, ts: number): LessonRecord {
  const p = sanitizeLessonPatch(patch);
  return {
    ...prev,
    stepIndex: p.stepIndex ?? prev.stepIndex,
    startedAt: p.startedAt ?? prev.startedAt,
    completedAt: p.completedAt !== undefined ? p.completedAt : prev.completedAt,
    recap: p.recap !== undefined ? p.recap : prev.recap,
    completedSteps: p.completedSteps ? union(prev.completedSteps, p.completedSteps) : prev.completedSteps,
    predictions: { ...prev.predictions, ...p.predictions },
    orders: { ...prev.orders, ...p.orders },
    quizzes: { ...prev.quizzes, ...p.quizzes },
    checklists: { ...prev.checklists, ...p.checklists },
    updatedAt: ts,
  };
}

export async function getLesson(lessonId: string): Promise<LessonRecord | undefined> {
  const db = await getDb();
  return db.get('lessons', lessonId);
}

export async function getAllLessons(): Promise<LessonRecord[]> {
  const db = await getDb();
  return db.getAll('lessons');
}

/** Сохранить состояние урока; запись создаётся при первом обращении (stepIndex 0, startedAt — сейчас). */
export function saveLesson(lessonId: string, patch: LessonPatch = {}): Promise<LessonRecord> {
  return writeTx(['lessons', 'kv'], async (tx, changed) => {
    const ts = Date.now();
    const store = tx.objectStore('lessons');
    const prev = (await store.get(lessonId)) ?? blankLesson(lessonId, ts);
    const next = checkRecord<LessonRecord>(lessonSchema, applyLessonPatch(prev, patch, ts), 'урок');
    await store.put(next);
    changed.add('lessons');
    await touchFirstActivity(asKvStore(tx.objectStore('kv')), ts, changed);
    return next;
  });
}

// ------------------------------------------------------------------ повторения

/**
 * Повторения на день now (по возрастанию срока): срок — этот календарный день или раньше.
 * Сравниваются дни по местному времени, а не моменты: повторение «на завтра» доступно весь завтрашний
 * день, даже если задание решено вечером, а завтра ученик занимается утром (см. isDue в schedule.ts).
 */
export async function getDueReviews(now: number = Date.now()): Promise<ReviewRecord[]> {
  const db = await getDb();
  const endOfDay = addLocalDays(startOfLocalDay(now), 1) - 1;
  const due = await db.getAllFromIndex('reviews', 'dueAt', IDBKeyRange.upperBound(endOfDay));
  return due.filter((r) => r.doneAt === null);
}

/** Все повторения (включая закрытые) по возрастанию срока. */
export async function getAllReviews(): Promise<ReviewRecord[]> {
  const db = await getDb();
  return db.getAllFromIndex('reviews', 'dueAt');
}

export interface ReviewInput {
  key: string;
  lessonId: string;
  exerciseId?: string | null;
  reason: string;
}

/** Поставить навык или задание на повторение с первой ступени (на следующий день). */
export function scheduleReview(input: ReviewInput): Promise<ReviewRecord> {
  return writeTx(['reviews'], async (tx, changed) => {
    const store = tx.objectStore('reviews');
    const ts = Date.now();
    const existing = await store.get(input.key);
    const step = firstReview(ts);
    const record = checkRecord<ReviewRecord>(
      reviewSchema,
      {
        key: input.key,
        lessonId: input.lessonId,
        exerciseId: input.exerciseId ?? null,
        stage: step.stage,
        dueAt: step.dueAt,
        reason: input.reason,
        createdAt: existing?.createdAt ?? ts,
        updatedAt: ts,
        doneAt: null,
      },
      'повторение',
    );
    await store.put(record);
    changed.add('reviews');
    return record;
  });
}

/**
 * Итог повторения. Успех — следующий интервал (1 → 3 → 7 → 14 дней), после последнего повторение закрыто;
 * неудача — снова через день. Закрытое повторение не меняется.
 * reason — новая причина для списка «На повторение» по итогу (иначе остаётся прежняя).
 */
export function completeReview(
  key: string,
  success: boolean,
  reason?: (step: { stage: number; done: boolean }) => string,
): Promise<ReviewRecord | undefined> {
  return writeTx(['reviews'], async (tx, changed) => {
    const store = tx.objectStore('reviews');
    const prev = await store.get(key);
    if (!prev || prev.doneAt !== null) return prev;
    const ts = Date.now();
    const step = nextReview(prev.stage, success, ts);
    const next = checkRecord<ReviewRecord>(
      reviewSchema,
      {
        ...prev,
        stage: step.stage,
        dueAt: step.dueAt,
        reason: reason ? reason(step) : prev.reason,
        doneAt: step.done ? ts : null,
        updatedAt: ts,
      },
      'повторение',
    );
    await store.put(next);
    changed.add('reviews');
    return next;
  });
}

// ------------------------------------------------------------------ активность по дням

/** Добавить активное время (мс) к дню date по местному времени. Больше суток за день не накапливается. */
export function addActivity(ms: number, date: Date | number = new Date()): Promise<ActivityRecord> {
  const key = localDateKey(date);
  return writeTx(['activity'], async (tx, changed) => {
    const store = tx.objectStore('activity');
    const prev = (await store.get(key)) ?? { date: key, activeMs: 0 };
    if (!Number.isFinite(ms) || ms <= 0) return prev;
    const next = checkRecord<ActivityRecord>(
      activitySchema,
      { date: key, activeMs: Math.min(DAY_MS, prev.activeMs + Math.round(ms)) },
      'время занятий',
    );
    await store.put(next);
    changed.add('activity');
    return next;
  });
}

/** Активность за последние days дней, включая сегодня (по возрастанию даты). Без аргумента — вся. */
export async function getActivity(days?: number): Promise<ActivityRecord[]> {
  const db = await getDb();
  if (days === undefined) return db.getAll('activity');
  const count = Math.max(1, Math.floor(days));
  const from = localDateKey(addLocalDays(Date.now(), -(count - 1)));
  return db.getAll('activity', IDBKeyRange.lowerBound(from));
}

// ------------------------------------------------------------------ интересы, проекты, рынок, черновики вопросов наставнику

export async function getInterests(): Promise<InterestRecord[]> {
  const db = await getDb();
  return db.getAll('interests');
}

export type InterestInput = Pick<InterestRecord, 'labId'> & Partial<Omit<InterestRecord, 'labId' | 'updatedAt'>>;

/** Сохранить отметку о направлении. Можно передать только изменённые поля. */
export function saveInterest(record: InterestInput): Promise<InterestRecord> {
  return writeTx(['interests'], async (tx, changed) => {
    const store = tx.objectStore('interests');
    const ts = Date.now();
    const prev: InterestRecord = (await store.get(record.labId)) ?? {
      labId: record.labId,
      status: 'curious',
      liked: '',
      tiring: '',
      continue: null,
      updatedAt: ts,
    };
    const next = checkRecord<InterestRecord>(
      interestSchema,
      { ...prev, ...defined(record), labId: record.labId, updatedAt: ts },
      'отметку о направлении',
    );
    await store.put(next);
    changed.add('interests');
    return next;
  });
}

export async function getProject(projectId: string): Promise<ProjectRecord | undefined> {
  const db = await getDb();
  return db.get('projects', projectId);
}

export async function getAllProjects(): Promise<ProjectRecord[]> {
  const db = await getDb();
  return db.getAll('projects');
}

export type ProjectInput = Pick<ProjectRecord, 'projectId'> & Partial<Omit<ProjectRecord, 'projectId' | 'updatedAt'>>;

/** Сохранить проект. Можно передать только изменённые поля; stagesDone заменяется целиком. */
export function saveProject(record: ProjectInput): Promise<ProjectRecord> {
  return writeTx(['projects'], async (tx, changed) => {
    const store = tx.objectStore('projects');
    const ts = Date.now();
    const prev: ProjectRecord = (await store.get(record.projectId)) ?? {
      projectId: record.projectId,
      stagesDone: [],
      notes: '',
      updatedAt: ts,
    };
    const next = checkRecord<ProjectRecord>(
      projectSchema,
      { ...prev, ...defined(record), projectId: record.projectId, updatedAt: ts },
      'проект',
    );
    await store.put(next);
    changed.add('projects');
    return next;
  });
}

/** Наборы данных о рынке, новые сверху. */
export async function getMarketDatasets(): Promise<MarketDataset[]> {
  const db = await getDb();
  const all = await db.getAll('market');
  return all.sort((a, b) => b.importedAt - a.importedAt);
}

/**
 * Сохранить набор данных о рынке. Набор проверяется той же схемой, что и файл экспорта:
 * неверный набор не сохраняется (InvalidDataError), иначе экспорт и резервные копии перестали бы читаться.
 */
export async function saveMarketDataset(dataset: MarketDataset): Promise<MarketDataset> {
  const record = checkRecord<MarketDataset>(marketDatasetSchema, dataset, 'набор данных о рынке');
  const db = await getDb();
  await db.put('market', record);
  notifyChange(['market']);
  return record;
}

export async function deleteMarketDataset(id: string): Promise<void> {
  const db = await getDb();
  await db.delete('market', id);
  notifyChange(['market']);
}

/**
 * Черновики вопросов наставнику, новые сверху: вопрос, который не удалось отправить (нет связи),
 * сохраняется, чтобы потом предложить ученику отправить его. Можно отфильтровать по заданию или уроку.
 */
export async function getCoachDrafts(filter: { exerciseId?: string; lessonId?: string } = {}): Promise<CoachDraft[]> {
  const db = await getDb();
  const all = await db.getAll('coachDrafts');
  return all
    .filter((d) => (filter.exerciseId === undefined || d.exerciseId === filter.exerciseId) &&
      (filter.lessonId === undefined || d.lessonId === filter.lessonId))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export type CoachDraftInput = Pick<CoachDraft, 'text'> & Partial<Pick<CoachDraft, 'exerciseId' | 'lessonId' | 'id'>>;

/** Сохранить черновик вопроса наставнику. Без id (или с пустым id) создаётся новый. */
export async function addCoachDraft(input: CoachDraftInput): Promise<CoachDraft> {
  const draft = checkRecord<CoachDraft>(
    coachDraftSchema,
    {
      id: input.id || makeId('draft'),
      exerciseId: input.exerciseId ?? null,
      lessonId: input.lessonId ?? null,
      text: input.text,
      createdAt: Date.now(),
    },
    'черновик вопроса',
  );
  const db = await getDb();
  await db.put('coachDrafts', draft);
  notifyChange(['coachDrafts']);
  return draft;
}

export async function deleteCoachDraft(id: string): Promise<void> {
  const db = await getDb();
  await db.delete('coachDrafts', id);
  notifyChange(['coachDrafts']);
}

// ------------------------------------------------------------------ попытки

export interface AttemptQuery {
  exerciseId?: string;
  /** Только попытки не раньше этого момента (мс). */
  since?: number;
}

/** Попытки по возрастанию времени. */
export async function getAttempts(query: AttemptQuery = {}): Promise<AttemptRecord[]> {
  const db = await getDb();
  const { exerciseId, since } = query;
  let list: AttemptRecord[];
  if (exerciseId !== undefined) {
    list = await db.getAllFromIndex('attempts', 'exerciseId', exerciseId);
    if (since !== undefined) list = list.filter((a) => a.at >= since);
  } else if (since !== undefined) {
    list = await db.getAllFromIndex('attempts', 'at', IDBKeyRange.lowerBound(since));
  } else {
    list = await db.getAll('attempts');
  }
  return list.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
}
