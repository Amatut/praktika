// Экспорт, импорт (слияние или замена), резервные копии и полный сброс прогресса.
//
// Главное правило: повреждённый или чужой файл никогда не меняет данные. parseImport только читает
// и проверяет; applyImport ещё раз проверяет файл и меняет базу одной транзакцией, в которой сначала
// сохраняется резервная копия текущих данных. Если что-то пошло не так (в том числе не хватило места),
// транзакция откатывается целиком — не остаётся ни изменений, ни новой копии — и наружу уходит ImportError
// с объяснением на русском.
//
// Решение о настройках.
// Слияние: настройки устройства (тема, шрифты, подключение к наставнику) остаются текущими — у телефона
// и компьютера они обычно разные. Из файла берутся только регион и валюта рынка, причём парой и только
// если на устройстве не задано ни то, ни другое (иначе получилось бы «Россия + KZT»).
// Замена: тема, шрифты, регион и валюта берутся из файла, а подключение к наставнику (режим, адрес, токен)
// всегда остаётся текущим. Файл приходит извне, и адрес из него не должен получать ни токен доступа,
// ни код ученика. Токен в экспорт не попадает (файл часто пересылают через мессенджер или почту);
// во внутренних резервных копиях он есть, чтобы восстановление вернуло всё, но listBackups отдаёт копии без него.

import type { IDBPTransaction } from 'idb';
import type { z } from 'zod';
import { ALL_STORES, DATA_STORES, getDb, notifyChange } from './db.ts';
import type { BackupRecord, PraktikaDB, StoreName } from './db.ts';
import { normalizeMeta, normalizeSettings } from './repo.ts';
import {
  activitySchema,
  attemptSchema,
  coachDraftSchema,
  describeIssues,
  exerciseSchema,
  exportFileSchema,
  formatPath,
  interestSchema,
  lessonSchema,
  marketDatasetSchema,
  metaSchema,
  projectSchema,
  reviewSchema,
  russianIssue,
  settingsSchema,
} from './schemas.ts';
import { localDateKey } from './schedule.ts';
import { DEFAULT_META, DEFAULT_SETTINGS, EXPORT_FORMAT, SCHEMA_VERSION } from './types.ts';
import type {
  ActivityRecord,
  AttemptRecord,
  CoachDraft,
  ExerciseRecord,
  ExerciseStatus,
  ExportFile,
  ImportPreview,
  ImportProblem,
  ImportStrategy,
  InterestRecord,
  LessonRecord,
  MarketDataset,
  Meta,
  ProgressData,
  ProjectRecord,
  ReviewRecord,
  Settings,
} from './types.ts';

export { exportFileSchema } from './schemas.ts';

/** Сколько автоматических резервных копий хранить. */
export const MAX_BACKUPS = 5;

export interface AppInfo {
  version: string;
  contentVersion: string | null;
}

// Версия приложения для резервных копий: запоминается при exportAll или задаётся явно.
let appInfo: AppInfo = { version: 'unknown', contentVersion: null };

export function setAppInfo(app: AppInfo): void {
  appInfo = { version: app.version, contentVersion: app.contentVersion };
}

// ------------------------------------------------------------------ миграции формата файла

type RawObject = Record<string, unknown>;

// EXPORT_MIGRATIONS[n] переводит файл из schemaVersion n - 1 в n. Пока версия одна — шагов нет.
const EXPORT_MIGRATIONS: Record<number, (raw: RawObject) => RawObject> = {};

function migrateExport(raw: RawObject, fromVersion: number): RawObject {
  let current = raw;
  for (let version = fromVersion + 1; version <= SCHEMA_VERSION; version += 1) {
    const step = EXPORT_MIGRATIONS[version];
    if (!step) throw new Error(`Нет шага миграции файла до версии ${version}`);
    current = { ...step(current), schemaVersion: version };
  }
  return current;
}

// ------------------------------------------------------------------ проверка файла

export interface DataCounts {
  exercises: number;
  passed: number;
  lessons: number;
  attempts: number;
  days: number;
}

export function countData(data: ProgressData): DataCounts {
  return {
    exercises: data.exercises.length,
    passed: data.exercises.filter((e) => e.status === 'passed').length,
    lessons: data.lessons.length,
    attempts: data.attempts.length,
    days: data.activity.length,
  };
}

const UNCHANGED = 'Текущие данные не изменены.';

function problem(message: string, details?: string): ImportProblem {
  return details === undefined ? { ok: false, message } : { ok: false, message, details };
}

function isRawObject(value: unknown): value is RawObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Проверить уже разобранный объект: формат, версию, структуру. Никогда не бросает исключений. */
export function checkExportObject(raw: unknown): ImportPreview | ImportProblem {
  try {
    if (!isRawObject(raw) || !('format' in raw)) {
      return problem(
        `Это не файл прогресса «Практики». Выбери файл, который приложение сохранило через экспорт. ${UNCHANGED}`,
        isRawObject(raw) ? 'В файле нет поля format.' : 'В файле не объект JSON.',
      );
    }
    if (raw.format !== EXPORT_FORMAT) {
      return problem(
        `Это файл другого формата, а не прогресс «Практики». ${UNCHANGED}`,
        `format: ${JSON.stringify(raw.format)}, ожидалось "${EXPORT_FORMAT}".`,
      );
    }
    const version = raw.schemaVersion;
    if (version === undefined) {
      return problem(`Файл прогресса повреждён: не указана версия формата данных. ${UNCHANGED}`, 'В файле нет поля schemaVersion.');
    }
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
      return problem(
        `Файл прогресса повреждён: версия формата данных указана неверно. ${UNCHANGED}`,
        `schemaVersion: ${JSON.stringify(version)}, ожидалось целое число от 1.`,
      );
    }
    if (version > SCHEMA_VERSION) {
      return problem(
        `Файл создан более новой версией приложения (формат данных ${version}, эта версия понимает до ${SCHEMA_VERSION}). ` +
          `Обнови приложение и попробуй импорт снова. ${UNCHANGED}`,
        `schemaVersion: ${version}, поддерживается: ${SCHEMA_VERSION}.`,
      );
    }
    const migrated = migrateExport(raw, version);
    const parsed = exportFileSchema.safeParse(migrated, { error: russianIssue });
    if (!parsed.success) {
      return problem(
        `Файл прогресса повреждён: часть данных не в том виде, который ожидает приложение. ${UNCHANGED}`,
        describeIssues(parsed.error.issues),
      );
    }
    const file: ExportFile = parsed.data;
    return { ok: true, file, counts: countData(file.data) };
  } catch (error) {
    return problem(`Не получилось проверить файл прогресса. ${UNCHANGED}`, errorText(error));
  }
}

function errorName(error: unknown): string {
  return typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : '';
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.name && error.name !== 'Error' ? `${error.name}: ${error.message}` : error.message;
  return String(error);
}

/** Прочитать текст файла и проверить его. Никогда не бросает исключений и ничего не меняет. */
export function parseImport(text: string): ImportPreview | ImportProblem {
  try {
    if (typeof text !== 'string' || text.trim() === '') {
      return problem(`Файл пустой — в нём нет данных прогресса. ${UNCHANGED}`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text.replace(/^﻿/, ''));
    } catch (error) {
      return problem(
        `Файл не читается как JSON: возможно, он повреждён, сохранился не полностью или это файл другого типа. ${UNCHANGED}`,
        errorText(error),
      );
    }
    return checkExportObject(raw);
  } catch (error) {
    return problem(`Не получилось прочитать файл. ${UNCHANGED}`, errorText(error));
  }
}

// ------------------------------------------------------------------ спасение данных по записям

export interface SalvageResult {
  data: ProgressData;
  /** Что пропущено или заменено значениями по умолчанию — по строке на запись. */
  skipped: string[];
}

function recordLabel(item: unknown, keyField: string): string {
  const key = isRawObject(item) ? item[keyField] : undefined;
  return typeof key === 'string' && key !== '' ? ` «${key}»` : '';
}

/** Проверить список по одной записи: неверные и повторяющиеся записи пропускаются и попадают в skipped. */
function salvageList<T>(
  name: string,
  raw: unknown,
  schema: z.ZodType<T>,
  keyField: string,
  keyOf: (item: T) => string,
  skipped: string[],
): T[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    skipped.push(`${name}: вместо списка записей другое значение — пропущено`);
    return [];
  }
  const seen = new Set<string>();
  const result: T[] = [];
  raw.forEach((item: unknown, index) => {
    const where = `${name}[${index}]${recordLabel(item, keyField)}`;
    const parsed = schema.safeParse(item, { error: russianIssue });
    if (!parsed.success) {
      const [first, ...rest] = parsed.error.issues;
      const more = rest.length > 0 ? ` (и ещё ${rest.length})` : '';
      skipped.push(`${where}: ${first ? `${formatPath(first.path)}: ${first.message}` : 'неверная запись'}${more}`);
      return;
    }
    const key = keyOf(parsed.data);
    if (seen.has(key)) {
      skipped.push(`${where}: запись повторяется — оставлена первая`);
      return;
    }
    seen.add(key);
    result.push(parsed.data);
  });
  return result;
}

/** Проверить объект целиком; неверные поля верхнего уровня заменяются значениями по умолчанию. */
function salvageObject<T extends object>(
  name: string,
  value: unknown,
  schema: z.ZodType<T>,
  defaults: T,
  skipped: string[],
): T {
  const first = schema.safeParse(value, { error: russianIssue });
  if (first.success) return first.data;
  const patched: RawObject = isRawObject(value) ? { ...value } : {};
  const fields = new Set<string>();
  for (const issue of first.error.issues) {
    const key = issue.path[0];
    if (typeof key === 'string' && key in defaults) {
      patched[key] = (defaults as RawObject)[key];
      fields.add(key);
    }
  }
  const second = schema.safeParse(patched);
  if (second.success) {
    skipped.push(`${name}: ${[...fields].join(', ')} — неверные значения заменены значениями по умолчанию`);
    return second.data;
  }
  skipped.push(`${name}: не прочитались — взяты значения по умолчанию`);
  return structuredClone(defaults);
}

/**
 * Собрать из данных всё, что проходит проверку: записи проверяются по одной, неверные пропускаются
 * (а не отвергают всю копию). Нужно для внутренних резервных копий и экспорта: одна испорченная запись
 * не должна делать невосстановимыми все остальные.
 */
export function salvageProgress(raw: unknown): SalvageResult {
  const source: RawObject = isRawObject(raw) ? raw : {};
  const skipped: string[] = [];
  const data: ProgressData = {
    settings: salvageObject<Settings>('settings', normalizeSettings(source.settings), settingsSchema, DEFAULT_SETTINGS, skipped),
    meta: salvageObject<Meta>('meta', normalizeMeta(source.meta), metaSchema, DEFAULT_META, skipped),
    exercises: salvageList<ExerciseRecord>('exercises', source.exercises, exerciseSchema, 'exerciseId', (r) => r.exerciseId, skipped),
    lessons: salvageList<LessonRecord>('lessons', source.lessons, lessonSchema, 'lessonId', (r) => r.lessonId, skipped),
    attempts: salvageList<AttemptRecord>('attempts', source.attempts, attemptSchema, 'key', (r) => r.key, skipped),
    activity: salvageList<ActivityRecord>('activity', source.activity, activitySchema, 'date', (r) => r.date, skipped),
    interests: salvageList<InterestRecord>('interests', source.interests, interestSchema, 'labId', (r) => r.labId, skipped),
    reviews: salvageList<ReviewRecord>('reviews', source.reviews, reviewSchema, 'key', (r) => r.key, skipped),
    projects: salvageList<ProjectRecord>('projects', source.projects, projectSchema, 'projectId', (r) => r.projectId, skipped),
    market: salvageList<MarketDataset>('market', source.market, marketDatasetSchema, 'id', (r) => r.id, skipped),
    coachDrafts: salvageList<CoachDraft>('coachDrafts', source.coachDrafts, coachDraftSchema, 'id', (r) => r.id, skipped),
  };
  return { data, skipped };
}

// ------------------------------------------------------------------ чтение и запись всей базы

type AnyTx<Mode extends IDBTransactionMode> = IDBPTransaction<PraktikaDB, StoreName[], Mode>;

interface Snapshot {
  data: ProgressData;
  /** Хоть что-нибудь сохранено: настройки, служебные данные или записи. */
  hasAnything: boolean;
}

async function readSnapshot<Mode extends IDBTransactionMode>(tx: AnyTx<Mode>): Promise<Snapshot> {
  const kv = tx.objectStore('kv');
  const [rawSettings, rawMeta, exercises, lessons, attempts, activity, interests, reviews, projects, market, coachDrafts] =
    await Promise.all([
      kv.get('settings'),
      kv.get('meta'),
      tx.objectStore('exercises').getAll(),
      tx.objectStore('lessons').getAll(),
      tx.objectStore('attempts').getAll(),
      tx.objectStore('activity').getAll(),
      tx.objectStore('interests').getAll(),
      tx.objectStore('reviews').getAll(),
      tx.objectStore('projects').getAll(),
      tx.objectStore('market').getAll(),
      tx.objectStore('coachDrafts').getAll(),
    ]);
  const data: ProgressData = {
    settings: normalizeSettings(rawSettings),
    meta: normalizeMeta(rawMeta),
    exercises,
    lessons,
    attempts,
    activity,
    interests,
    reviews,
    projects,
    market,
    coachDrafts,
  };
  const hasRecords = [exercises, lessons, attempts, activity, interests, reviews, projects, market, coachDrafts].some(
    (list) => list.length > 0,
  );
  return { data, hasAnything: hasRecords || rawSettings !== undefined || rawMeta !== undefined };
}

/** Очистить хранилища данных и записать data. Резервные копии не трогаются. */
async function writeData(tx: AnyTx<'readwrite'>, data: ProgressData): Promise<void> {
  const requests: Promise<unknown>[] = [];
  try {
    for (const name of DATA_STORES) requests.push(tx.objectStore(name).clear());
    const kv = tx.objectStore('kv');
    requests.push(kv.put(data.settings, 'settings'), kv.put(data.meta, 'meta'));
    const put = <T>(list: T[], write: (item: T) => Promise<unknown>) => {
      for (const item of list) requests.push(write(item));
    };
    put(data.exercises, (r) => tx.objectStore('exercises').put(r));
    put(data.lessons, (r) => tx.objectStore('lessons').put(r));
    put(data.attempts, (r) => tx.objectStore('attempts').put(r));
    put(data.activity, (r) => tx.objectStore('activity').put(r));
    put(data.interests, (r) => tx.objectStore('interests').put(r));
    put(data.reviews, (r) => tx.objectStore('reviews').put(r));
    put(data.projects, (r) => tx.objectStore('projects').put(r));
    put(data.market, (r) => tx.objectStore('market').put(r));
    put(data.coachDrafts, (r) => tx.objectStore('coachDrafts').put(r));
  } catch (error) {
    // Запрос бросил исключение сразу (так браузер сообщает, например, о DataCloneError). Уже отправленные
    // запросы отменятся вместе с транзакцией — их отказы обрабатываем здесь, чтобы они не остались необработанными.
    for (const request of requests) request.catch(() => undefined);
    throw error;
  }
  await Promise.all(requests);
}

function makeExportFile(data: ProgressData, app: AppInfo): ExportFile {
  return {
    format: EXPORT_FORMAT,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    app: { version: String(app.version ?? 'unknown'), contentVersion: app.contentVersion ?? null },
    data,
  };
}

function makeBackupId(ts: number): string {
  return `backup-${ts}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Сохранить копию текущих данных и оставить только MAX_BACKUPS последних. Возвращает id копии. */
async function writeBackup(tx: AnyTx<'readwrite'>, data: ProgressData, reason: string): Promise<string> {
  const store = tx.objectStore('backups');
  const createdAt = Date.now();
  const record: BackupRecord = { id: makeBackupId(createdAt), createdAt, reason, file: makeExportFile(data, appInfo) };
  await store.put(record);
  const all = await store.getAll();
  const stale = sortBackups(all).slice(MAX_BACKUPS);
  await Promise.all(stale.map((b) => store.delete(b.id)));
  return record.id;
}

function sortBackups<T extends Pick<BackupRecord, 'id' | 'createdAt'>>(list: T[]): T[] {
  return [...list].sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/** Отменить транзакцию, не оставляя необработанных отказов. */
function abortQuietly(tx: AnyTx<IDBTransactionMode>): void {
  tx.done.catch(() => undefined);
  try {
    tx.abort();
  } catch {
    // Транзакция уже завершилась или отменена браузером.
  }
}

/** Ошибку браузера или кода — в ImportError с объяснением на русском. failure — «Импорт не выполнен» и т. п. */
function toImportError(failure: string, error: unknown): ImportError {
  if (error instanceof ImportError) return error;
  const reason =
    errorName(error) === 'QuotaExceededError'
      ? 'в хранилище браузера не хватает места. Освободи немного места на устройстве и попробуй снова'
      : 'не получилось записать данные в хранилище браузера. Попробуй ещё раз или перезагрузи страницу';
  return new ImportError(`${failure}: ${reason}. ${UNCHANGED}`, errorText(error), { cause: error });
}

/**
 * Выполнить работу в одной транзакции над всеми хранилищами. При любой ошибке (в коде, в запросе,
 * при завершении транзакции) транзакция откатывается целиком, а наружу уходит ImportError.
 */
async function inFullTransaction<T>(failure: string, work: (tx: AnyTx<'readwrite'>) => Promise<T>): Promise<T> {
  const db = await getDb();
  const tx = db.transaction([...ALL_STORES], 'readwrite');
  let result: T;
  try {
    result = await work(tx);
    await tx.done;
  } catch (error) {
    abortQuietly(tx);
    throw toImportError(failure, error);
  }
  notifyChange([...ALL_STORES]);
  return result;
}

// ------------------------------------------------------------------ экспорт

/**
 * Весь прогресс в формате файла экспорта. Токен доступа к наставнику не включается.
 * Записи, не прошедшие проверку (в базе их быть не должно — запись проверяется при сохранении),
 * пропускаются с предупреждением в консоли: иначе файл целиком не принял бы импорт.
 */
export async function exportAll(app: AppInfo): Promise<ExportFile> {
  setAppInfo(app);
  const db = await getDb();
  const tx = db.transaction([...DATA_STORES], 'readonly') as unknown as AnyTx<'readonly'>;
  let snapshot: Snapshot;
  try {
    snapshot = await readSnapshot(tx);
    await tx.done;
  } catch (error) {
    abortQuietly(tx);
    throw error;
  }
  const { data, skipped } = salvageProgress(snapshot.data);
  if (skipped.length > 0) console.warn('Экспорт прогресса: пропущены записи, которые не прошли проверку', skipped);
  const settings: Settings = { ...data.settings, coach: { ...data.settings.coach, accessToken: '' } };
  return makeExportFile({ ...data, settings }, app);
}

/** Текст файла экспорта. */
export function serializeExport(file: ExportFile): string {
  return JSON.stringify(file, null, 2);
}

/** Имя файла экспорта, например praktika-progress-2026-09-26.json. */
export function exportFileName(date: Date | number = new Date()): string {
  return `praktika-progress-${localDateKey(date)}.json`;
}

// ------------------------------------------------------------------ слияние

const STATUS_RANK: Record<ExerciseStatus, number> = { new: 0, attempted: 1, passed: 2 };

function maxNullable(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

function minNullable(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

function union(a: readonly string[], b: readonly string[]): string[] {
  return [...new Set([...a, ...b])];
}

/** Какая из записей лучше описывает первое прохождение: меньше помощи, затем раньше. */
function betterFirstPass(a: ExerciseRecord, b: ExerciseRecord): ExerciseRecord {
  if (a.firstPassedAt === null) return b.firstPassedAt === null ? a : b;
  if (b.firstPassedAt === null) return a;
  const helpA = a.firstPassHelp ?? 4;
  const helpB = b.firstPassHelp ?? 4;
  if (helpA !== helpB) return helpA < helpB ? a : b;
  return b.firstPassedAt < a.firstPassedAt ? b : a;
}

/** Слить запись упражнения: a — текущая, b — из файла. */
export function mergeExercise(a: ExerciseRecord, b: ExerciseRecord): ExerciseRecord {
  const status = STATUS_RANK[b.status] > STATUS_RANK[a.status] ? b.status : a.status;
  const first = betterFirstPass(a, b);
  const draftSource = (b.draftUpdatedAt ?? -Infinity) > (a.draftUpdatedAt ?? -Infinity) ? b : a;
  const newer = b.updatedAt > a.updatedAt ? b : a;
  return {
    exerciseId: a.exerciseId,
    lessonId: newer.lessonId,
    draft: draftSource.draft,
    draftUpdatedAt: draftSource.draftUpdatedAt,
    status,
    checks: Math.max(a.checks, b.checks),
    runs: Math.max(a.runs, b.runs),
    hintsShown: Math.max(a.hintsShown, b.hintsShown) as ExerciseRecord['hintsShown'],
    solutionViewed: a.solutionViewed || b.solutionViewed,
    firstPassedAt: first.firstPassedAt,
    firstPassHelp: first.firstPassedAt === null ? null : first.firstPassHelp,
    lastCheckAt: maxNullable(a.lastCheckAt, b.lastCheckAt),
    updatedAt: Math.max(a.updatedAt, b.updatedAt),
  };
}

/** Слить запись урока: a — текущая, b — из файла. При конфликте ответов побеждает более свежая запись. */
export function mergeLesson(a: LessonRecord, b: LessonRecord): LessonRecord {
  const bNewer = b.updatedAt > a.updatedAt;
  const newer = bNewer ? b : a;
  const older = bNewer ? a : b;
  const orders: LessonRecord['orders'] = { ...older.orders, ...newer.orders };
  for (const key of Object.keys(orders)) {
    const x = a.orders[key];
    const y = b.orders[key];
    if (x && y) orders[key] = { attempts: Math.max(x.attempts, y.attempts), solved: x.solved || y.solved };
  }
  const checklists: LessonRecord['checklists'] = { ...older.checklists, ...newer.checklists };
  for (const key of Object.keys(checklists)) {
    const x = a.checklists[key];
    const y = b.checklists[key];
    if (x && y) checklists[key] = union(x, y);
  }
  return {
    lessonId: a.lessonId,
    stepIndex: Math.max(a.stepIndex, b.stepIndex),
    completedSteps: union(a.completedSteps, b.completedSteps),
    startedAt: Math.min(a.startedAt, b.startedAt),
    completedAt: minNullable(a.completedAt, b.completedAt),
    predictions: { ...older.predictions, ...newer.predictions },
    orders,
    quizzes: { ...older.quizzes, ...newer.quizzes },
    checklists,
    recap: newer.recap ?? older.recap,
    updatedAt: Math.max(a.updatedAt, b.updatedAt),
  };
}

function mergeBy<T>(
  current: readonly T[],
  incoming: readonly T[],
  keyOf: (item: T) => string,
  merge: (a: T, b: T) => T,
): T[] {
  const map = new Map<string, T>();
  for (const item of current) map.set(keyOf(item), item);
  for (const item of incoming) {
    const key = keyOf(item);
    const existing = map.get(key);
    map.set(key, existing === undefined ? item : merge(existing, item));
  }
  return [...map.values()];
}

/** Более свежая по updatedAt; при равенстве остаётся текущая. */
function newerByUpdatedAt<T extends { updatedAt: number }>(a: T, b: T): T {
  return b.updatedAt > a.updatedAt ? b : a;
}

/** Настройки при слиянии: всё текущее; регион и валюта из файла — парой и только если на устройстве их нет. */
function mergeSettingsForImport(current: Settings, incoming: Settings): Settings {
  const marketUnset = current.market.region === null && current.market.currency === null;
  return {
    ...current,
    coach: { ...current.coach },
    market: marketUnset ? { ...incoming.market } : { ...current.market },
  };
}

function mergeMeta(current: Meta, incoming: Meta): Meta {
  const incomingIsFresher = (incoming.lastOpenedAt ?? -Infinity) > (current.lastOpenedAt ?? -Infinity);
  return {
    currentLessonId: incomingIsFresher
      ? (incoming.currentLessonId ?? current.currentLessonId)
      : (current.currentLessonId ?? incoming.currentLessonId),
    lastOpenedAt: maxNullable(current.lastOpenedAt, incoming.lastOpenedAt),
    firstActivityAt: minNullable(current.firstActivityAt, incoming.firstActivityAt),
  };
}

/** Слить весь прогресс: current — данные на устройстве, incoming — из файла. */
export function mergeProgress(current: ProgressData, incoming: ProgressData): ProgressData {
  return {
    settings: mergeSettingsForImport(current.settings, incoming.settings),
    meta: mergeMeta(current.meta, incoming.meta),
    exercises: mergeBy<ExerciseRecord>(current.exercises, incoming.exercises, (r) => r.exerciseId, mergeExercise),
    lessons: mergeBy<LessonRecord>(current.lessons, incoming.lessons, (r) => r.lessonId, mergeLesson),
    attempts: mergeBy<AttemptRecord>(current.attempts, incoming.attempts, (r) => r.key, (a) => a),
    activity: mergeBy<ActivityRecord>(current.activity, incoming.activity, (r) => r.date, (a, b) => ({
      date: a.date,
      activeMs: Math.max(a.activeMs, b.activeMs),
    })),
    interests: mergeBy<InterestRecord>(current.interests, incoming.interests, (r) => r.labId, newerByUpdatedAt),
    reviews: mergeBy<ReviewRecord>(current.reviews, incoming.reviews, (r) => r.key, newerByUpdatedAt),
    projects: mergeBy<ProjectRecord>(current.projects, incoming.projects, (r) => r.projectId, (a, b) => ({
      ...newerByUpdatedAt(a, b),
      stagesDone: union(a.stagesDone, b.stagesDone),
    })),
    market: mergeBy<MarketDataset>(current.market, incoming.market, (r) => r.id, (a, b) =>
      b.importedAt > a.importedAt ? b : a,
    ),
    coachDrafts: mergeBy<CoachDraft>(current.coachDrafts, incoming.coachDrafts, (r) => r.id, (a) => a),
  };
}

/** Замена: всё из файла, кроме подключения к наставнику — оно остаётся текущим (см. начало файла). */
function replaceProgress(current: ProgressData, incoming: ProgressData): ProgressData {
  return { ...incoming, settings: { ...incoming.settings, coach: { ...current.settings.coach } } };
}

// ------------------------------------------------------------------ импорт, копии, сброс

/** Импорт, восстановление или сброс не выполнены; данные не изменены. */
export class ImportError extends Error {
  details: string | undefined;
  constructor(message: string, details?: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ImportError';
    this.details = details;
  }
}

export interface ImportResult {
  strategy: ImportStrategy;
  /** Резервная копия данных до импорта; null — сохранять было нечего. */
  backupId: string | null;
  /** Что получилось после импорта. */
  counts: DataCounts;
}

const BACKUP_REASONS: Record<ImportStrategy, string> = {
  merge: 'Перед импортом (слияние)',
  replace: 'Перед импортом (замена)',
};

/**
 * Применить проверенный файл. Сначала резервная копия текущих данных (хранятся последние 5),
 * затем всё в одной транзакции: replace — очистить и записать из файла, merge — слить по правилам.
 */
export async function applyImport(file: ExportFile, strategy: ImportStrategy): Promise<ImportResult> {
  if (strategy !== 'merge' && strategy !== 'replace') {
    throw new ImportError(`Неизвестный способ импорта. ${UNCHANGED}`, String(strategy));
  }
  const checked = checkExportObject(file);
  if (!checked.ok) throw new ImportError(checked.message, checked.details);
  const incoming = checked.file.data;

  return inFullTransaction('Импорт не выполнен', async (tx) => {
    const snapshot = await readSnapshot(tx);
    // Сливаем с проверенными текущими данными; всё как было (включая неверные записи) остаётся в копии.
    const current = salvageProgress(snapshot.data).data;
    const result = strategy === 'replace' ? replaceProgress(current, incoming) : mergeProgress(current, incoming);
    const backupId = snapshot.hasAnything ? await writeBackup(tx, snapshot.data, BACKUP_REASONS[strategy]) : null;
    await writeData(tx, result);
    return { strategy, backupId, counts: countData(result) };
  });
}

export interface BackupInfo extends BackupRecord {
  counts: DataCounts;
}

/** Число записей без строгой проверки — для списка копий. */
function countLoose(data: unknown): DataCounts {
  const d: RawObject = isRawObject(data) ? data : {};
  const length = (value: unknown) => (Array.isArray(value) ? value.length : 0);
  const exercises: unknown[] = Array.isArray(d.exercises) ? d.exercises : [];
  return {
    exercises: exercises.length,
    passed: exercises.filter((e) => isRawObject(e) && e.status === 'passed').length,
    lessons: length(d.lessons),
    attempts: length(d.attempts),
    days: length(d.activity),
  };
}

/** Копия файла без токена доступа к наставнику — то, что можно показать или сохранить в файл. */
function withoutToken(file: ExportFile): ExportFile {
  const data: unknown = file?.data;
  if (!isRawObject(data) || !isRawObject(data.settings) || !isRawObject(data.settings.coach)) return file;
  const settings = { ...data.settings, coach: { ...data.settings.coach, accessToken: '' } };
  return { ...file, data: { ...(data as unknown as ProgressData), settings: settings as unknown as Settings } };
}

/** Резервные копии, новые сверху. Токен доступа к наставнику из копий не отдаётся. */
export async function listBackups(): Promise<BackupInfo[]> {
  const db = await getDb();
  const all = await db.getAll('backups');
  return sortBackups(all).map((b) => ({ ...b, file: withoutToken(b.file), counts: countLoose(b.file?.data) }));
}

export interface RestoreResult {
  /** Копия данных, которые были до восстановления; null — сохранять было нечего. */
  backupId: string | null;
  counts: DataCounts;
  /** Записи копии, которые не прошли проверку и не восстановлены (пустой список — восстановлено всё). */
  skipped: string[];
}

const BROKEN_BACKUP = `Резервная копия повреждена, восстановить её не получится. ${UNCHANGED}`;

/** Данные копии: формат и версия проверяются, записи — по одной (неверные пропускаются). */
function backupData(backup: BackupRecord): SalvageResult {
  const file: unknown = backup.file;
  if (!isRawObject(file) || file.format !== EXPORT_FORMAT || !isRawObject(file.data)) {
    throw new ImportError(BROKEN_BACKUP, 'Нет данных в формате «Практики».');
  }
  const version = file.schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new ImportError(BROKEN_BACKUP, `schemaVersion: ${JSON.stringify(version)}.`);
  }
  if (version > SCHEMA_VERSION) {
    throw new ImportError(
      `Резервная копия сделана более новой версией приложения. Обнови приложение и попробуй снова. ${UNCHANGED}`,
      `schemaVersion: ${version}, поддерживается: ${SCHEMA_VERSION}.`,
    );
  }
  return salvageProgress(migrateExport(file, version).data);
}

/**
 * Восстановить резервную копию. Перед этим текущие данные тоже сохраняются в копию.
 * Записи копии, которые не прошли проверку, пропускаются и перечисляются в skipped.
 */
export async function restoreBackup(backupId: string): Promise<RestoreResult> {
  return inFullTransaction('Восстановление не выполнено', async (tx) => {
    const backup = await tx.objectStore('backups').get(backupId);
    if (!backup) {
      throw new ImportError(`Резервная копия не найдена — возможно, она уже удалена. ${UNCHANGED}`);
    }
    const { data, skipped } = backupData(backup);
    const current = await readSnapshot(tx);
    const date = new Date(backup.createdAt).toLocaleString('ru-RU');
    const safetyId = current.hasAnything
      ? await writeBackup(tx, current.data, `Перед восстановлением копии от ${date}`)
      : null;
    await writeData(tx, data);
    return { backupId: safetyId, counts: countData(data), skipped };
  });
}

/** Удалить весь прогресс и настройки. Перед этим сохраняется резервная копия. Возвращает её id. */
export async function resetAll(): Promise<{ backupId: string | null }> {
  return inFullTransaction('Сброс не выполнен', async (tx) => {
    const current = await readSnapshot(tx);
    const backupId = current.hasAnything ? await writeBackup(tx, current.data, 'Перед сбросом прогресса') : null;
    await Promise.all(DATA_STORES.map((name) => tx.objectStore(name).clear()));
    return { backupId };
  });
}
