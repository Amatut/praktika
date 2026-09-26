// Открытие локальной базы IndexedDB «praktika» и общая шина уведомлений об изменениях.
// Все остальные модули хранилища получают соединение только через getDb().

import { deleteDB, openDB } from 'idb';
import type { DBSchema, IDBPDatabase, IDBPTransaction, StoreNames } from 'idb';
import type {
  ActivityRecord,
  AttemptRecord,
  CoachDraft,
  ExerciseRecord,
  ExportFile,
  InterestRecord,
  LessonRecord,
  MarketDataset,
  Meta,
  ProjectRecord,
  ReviewRecord,
  Settings,
} from './types.ts';

export const DB_NAME = 'praktika';
/** Версия структуры базы (хранилища и индексы). Меняя её, добавь шаг в MIGRATIONS. */
export const DB_VERSION = 1;

/** Автоматическая резервная копия: снимок всех данных в формате экспорта. */
export interface BackupRecord {
  id: string;
  createdAt: number;
  /** Почему сделана копия: «Перед импортом (замена)», «Перед сбросом прогресса»… */
  reason: string;
  file: ExportFile;
}

export type KvKey = 'settings' | 'meta';

export interface PraktikaDB extends DBSchema {
  kv: { key: KvKey; value: Settings | Meta };
  exercises: { key: string; value: ExerciseRecord; indexes: { lessonId: string } };
  lessons: { key: string; value: LessonRecord };
  attempts: { key: string; value: AttemptRecord; indexes: { exerciseId: string; at: number } };
  activity: { key: string; value: ActivityRecord };
  interests: { key: string; value: InterestRecord };
  reviews: { key: string; value: ReviewRecord; indexes: { dueAt: number } };
  projects: { key: string; value: ProjectRecord };
  market: { key: string; value: MarketDataset };
  coachDrafts: { key: string; value: CoachDraft };
  backups: { key: string; value: BackupRecord };
}

export type StoreName = StoreNames<PraktikaDB>;
export type PraktikaDatabase = IDBPDatabase<PraktikaDB>;

/** Хранилища с данными ученика (всё, кроме резервных копий). */
export const DATA_STORES = [
  'kv',
  'exercises',
  'lessons',
  'attempts',
  'activity',
  'interests',
  'reviews',
  'projects',
  'market',
  'coachDrafts',
] as const satisfies readonly StoreName[];

export const ALL_STORES = [...DATA_STORES, 'backups'] as const satisfies readonly StoreName[];

type UpgradeTx = IDBPTransaction<PraktikaDB, StoreName[], 'versionchange'>;
type Migration = (db: PraktikaDatabase, tx: UpgradeTx) => void;

// MIGRATIONS[n] переводит базу из версии n - 1 в версию n. Старые шаги не меняются никогда:
// у ученика может лежать база любой прошлой версии, и шаги выполняются по очереди.
const MIGRATIONS: Record<number, Migration> = {
  1: (db) => {
    db.createObjectStore('kv');
    db.createObjectStore('exercises', { keyPath: 'exerciseId' }).createIndex('lessonId', 'lessonId');
    db.createObjectStore('lessons', { keyPath: 'lessonId' });
    const attempts = db.createObjectStore('attempts', { keyPath: 'key' });
    attempts.createIndex('exerciseId', 'exerciseId');
    attempts.createIndex('at', 'at');
    db.createObjectStore('activity', { keyPath: 'date' });
    db.createObjectStore('interests', { keyPath: 'labId' });
    db.createObjectStore('reviews', { keyPath: 'key' }).createIndex('dueAt', 'dueAt');
    db.createObjectStore('projects', { keyPath: 'projectId' });
    db.createObjectStore('market', { keyPath: 'id' });
    db.createObjectStore('coachDrafts', { keyPath: 'id' });
    db.createObjectStore('backups', { keyPath: 'id' });
  },
};

/**
 * Почему база недоступна:
 * unsupported — IndexedDB нет или она запрещена (приватный режим, запрет хранить данные сайтов);
 * outdated — в другой вкладке открыта более новая версия приложения, эта вкладка устарела;
 * quota — на устройстве не хватает места;
 * unknown — другая ошибка браузера.
 */
export type StorageProblem = 'unsupported' | 'outdated' | 'quota' | 'unknown';

const MESSAGES: Record<StorageProblem, string> = {
  unsupported:
    'Не получилось открыть локальное хранилище браузера (IndexedDB), поэтому прогресс сейчас не сохраняется. ' +
    'Так бывает в приватном режиме или когда в браузере запрещено хранить данные сайтов. ' +
    'Открой приложение в обычном окне или разреши сайту хранить данные.',
  outdated:
    'Приложение обновилось в другой вкладке, и эта вкладка больше не может сохранять прогресс. ' +
    'Перезагрузи страницу — всё, что уже сохранено, на месте.',
  quota:
    'Не получилось открыть локальное хранилище: на устройстве не хватает места. ' +
    'Освободи немного места и перезагрузи страницу.',
  unknown:
    'Не получилось открыть локальное хранилище браузера (IndexedDB), поэтому прогресс сейчас не сохраняется. ' +
    'Перезагрузи страницу; если не поможет — закрой другие вкладки приложения и перезапусти браузер.',
};

/** IndexedDB недоступна или не открылась. reason — причина, message — объяснение для ученика. */
export class StorageUnavailableError extends Error {
  reason: StorageProblem;
  constructor(reason: StorageProblem, options?: { cause?: unknown }) {
    super(MESSAGES[reason], options);
    this.name = 'StorageUnavailableError';
    this.reason = reason;
  }
}

/** Причина по ошибке открытия базы. */
function problemOf(error: unknown): StorageProblem {
  const name = typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : '';
  // VersionError: база на диске новее этого кода — её уже обновила более новая версия приложения.
  if (name === 'VersionError') return 'outdated';
  if (name === 'QuotaExceededError') return 'quota';
  // SecurityError — хранение данных сайтов запрещено; InvalidStateError — так отвечает приватный режим Firefox.
  if (name === 'SecurityError' || name === 'InvalidStateError') return 'unsupported';
  return 'unknown';
}

let dbPromise: Promise<PraktikaDatabase> | null = null;
let openedDb: PraktikaDatabase | null = null;
// Соединение отдано более новой версии приложения из другой вкладки: база на диске уже новее этого кода.
let outdated = false;

function forgetConnection(db: PraktikaDatabase | null): void {
  if (db && openedDb === db) {
    openedDb = null;
    dbPromise = null;
  }
}

async function open(): Promise<PraktikaDatabase> {
  if (outdated) throw new StorageUnavailableError('outdated');
  if (typeof indexedDB === 'undefined' || indexedDB === null) {
    throw new StorageUnavailableError('unsupported');
  }
  let db: PraktikaDatabase | null = null;
  try {
    db = await openDB<PraktikaDB>(DB_NAME, DB_VERSION, {
      upgrade(database, oldVersion, newVersion, tx) {
        const target = newVersion ?? DB_VERSION;
        for (let version = oldVersion + 1; version <= target; version += 1) {
          const migrate = MIGRATIONS[version];
          if (!migrate) throw new Error(`Нет шага миграции базы до версии ${version}`);
          migrate(database, tx);
        }
      },
      blocking(_currentVersion, blockedVersion) {
        // Другая вкладка открывает более новую версию базы (или удаляет её) — уступаем ей соединение.
        // После обновления эта вкладка работать с базой не сможет: следующий getDb() попросит перезагрузить
        // страницу. После удаления базы (blockedVersion === null) следующий getDb() откроет её заново.
        if (blockedVersion !== null && blockedVersion > DB_VERSION) outdated = true;
        const current = db;
        forgetConnection(current);
        current?.close();
      },
      terminated() {
        forgetConnection(db);
      },
    });
  } catch (error) {
    if (error instanceof StorageUnavailableError) throw error;
    throw new StorageUnavailableError(problemOf(error), { cause: error });
  }
  openedDb = db;
  return db;
}

/** Соединение с базой. Открывается при первом обращении; при ошибке следующий вызов попробует снова. */
export function getDb(): Promise<PraktikaDatabase> {
  if (!dbPromise) {
    const attempt = open();
    dbPromise = attempt;
    attempt.catch(() => {
      if (dbPromise === attempt) dbPromise = null;
    });
  }
  return dbPromise;
}

/** Закрыть соединение (нужно тестам и перед удалением базы). Следующий getDb() откроет базу заново. */
export async function closeDb(): Promise<void> {
  const pending = dbPromise;
  dbPromise = null;
  openedDb = null;
  outdated = false;
  if (!pending) return;
  try {
    (await pending).close();
  } catch {
    // Соединение и так не открылось — закрывать нечего.
  }
}

/** Полностью удалить базу вместе с резервными копиями. Используется в тестах. */
export async function deleteDatabase(): Promise<void> {
  await closeDb();
  await deleteDB(DB_NAME);
}

// ------------------------------------------------------------------ уведомления об изменениях

export type ChangeListener = (stores: string[]) => void;

const listeners = new Set<ChangeListener>();
const CHANNEL_NAME = 'praktika-storage';
const MESSAGE_TYPE = 'praktika-change';

interface ChannelLike {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent) => void) | null;
}

let channel: ChannelLike | null | undefined;

// Другие вкладки приложения тоже узнают об изменениях (если браузер поддерживает BroadcastChannel).
// Канал нужен только в окне браузера: в Node и тестах его нет, чтобы параллельные процессы не мешали друг другу.
function getChannel(): ChannelLike | null {
  if (channel !== undefined) return channel;
  channel = null;
  try {
    if (typeof window !== 'undefined' && typeof BroadcastChannel === 'function') {
      const created = new BroadcastChannel(CHANNEL_NAME);
      // В Node канал иначе не даёт процессу завершиться; в браузере такого метода нет.
      (created as unknown as { unref?: () => void }).unref?.();
      created.onmessage = (event: MessageEvent) => {
        const data: unknown = event.data;
        if (!data || typeof data !== 'object') return;
        const { type, stores } = data as { type?: unknown; stores?: unknown };
        if (type !== MESSAGE_TYPE || !Array.isArray(stores)) return;
        emitLocal(stores.filter((s): s is string => typeof s === 'string'));
      };
      channel = created;
    }
  } catch {
    channel = null;
  }
  return channel;
}

function emitLocal(stores: string[]): void {
  for (const listener of Array.from(listeners)) {
    try {
      listener([...stores]);
    } catch (error) {
      console.error('Ошибка в обработчике изменений хранилища', error);
    }
  }
}

/** Сообщить подписчикам, что данные в этих хранилищах изменились. Вызывается после завершения записи. */
export function notifyChange(stores: readonly string[]): void {
  const list = [...new Set(stores)];
  if (list.length === 0) return;
  emitLocal(list);
  try {
    getChannel()?.postMessage({ type: MESSAGE_TYPE, stores: list });
  } catch {
    // Другие вкладки узнают об изменениях при следующем чтении.
  }
}

/** Подписка на изменения. Возвращает функцию отписки. */
export function onChange(listener: ChangeListener): () => void {
  listeners.add(listener);
  getChannel();
  return () => {
    listeners.delete(listener);
  };
}
