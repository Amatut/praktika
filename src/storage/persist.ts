// Постоянное хранилище: просьба к браузеру не удалять данные сайта при нехватке места
// и оценка занятого места. Очистку данных вручную это не отменяет — поэтому нужен экспорт.

export type PersistResult = 'granted' | 'denied' | 'unsupported';

function storageManager(): StorageManager | null {
  try {
    if (typeof navigator === 'undefined' || !navigator) return null;
    return navigator.storage ?? null;
  } catch {
    return null;
  }
}

/** Попросить браузер хранить данные постоянно. Если уже разрешено — сразу 'granted'. */
export async function requestPersistentStorage(): Promise<PersistResult> {
  const storage = storageManager();
  if (!storage || typeof storage.persist !== 'function') return 'unsupported';
  try {
    if (typeof storage.persisted === 'function' && (await storage.persisted())) return 'granted';
    return (await storage.persist()) ? 'granted' : 'denied';
  } catch {
    return 'unsupported';
  }
}

/** Уже ли данные хранятся постоянно. null — браузер не сообщает. */
export async function isStoragePersisted(): Promise<boolean | null> {
  const storage = storageManager();
  if (!storage || typeof storage.persisted !== 'function') return null;
  try {
    return await storage.persisted();
  } catch {
    return null;
  }
}

/** Сколько места занято и доступно (байты). null — браузер не сообщает. */
export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  const storage = storageManager();
  if (!storage || typeof storage.estimate !== 'function') return null;
  try {
    const { usage, quota } = await storage.estimate();
    if (typeof usage !== 'number' || typeof quota !== 'number') return null;
    return { usage, quota };
  } catch {
    return null;
  }
}
