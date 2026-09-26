import { afterEach, describe, expect, it, vi } from 'vitest';
import { isStoragePersisted, requestPersistentStorage, storageEstimate } from './persist.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubStorage(storage: Partial<StorageManager> | undefined): void {
  vi.stubGlobal('navigator', storage === undefined ? {} : { storage });
}

describe('requestPersistentStorage', () => {
  it('без StorageManager — unsupported', async () => {
    stubStorage(undefined);
    expect(await requestPersistentStorage()).toBe('unsupported');
    expect(await isStoragePersisted()).toBeNull();
    expect(await storageEstimate()).toBeNull();
  });

  it('уже разрешено — granted без повторного запроса', async () => {
    const persist = vi.fn(async () => false);
    stubStorage({ persisted: async () => true, persist });
    expect(await requestPersistentStorage()).toBe('granted');
    expect(persist).not.toHaveBeenCalled();
  });

  it('браузер разрешил или отказал', async () => {
    stubStorage({ persisted: async () => false, persist: async () => true });
    expect(await requestPersistentStorage()).toBe('granted');
    stubStorage({ persisted: async () => false, persist: async () => false });
    expect(await requestPersistentStorage()).toBe('denied');
  });

  it('ошибка браузера не выбрасывается наружу', async () => {
    stubStorage({
      persist: async () => {
        throw new Error('нет');
      },
      estimate: async () => {
        throw new Error('нет');
      },
    });
    expect(await requestPersistentStorage()).toBe('unsupported');
    expect(await storageEstimate()).toBeNull();
  });
});

describe('storageEstimate', () => {
  it('возвращает занятое место и квоту', async () => {
    stubStorage({ estimate: async () => ({ usage: 1024, quota: 1_000_000 }) });
    expect(await storageEstimate()).toEqual({ usage: 1024, quota: 1_000_000 });
  });

  it('неполный ответ — null', async () => {
    stubStorage({ estimate: async () => ({ usage: 5 }) });
    expect(await storageEstimate()).toBeNull();
  });
});
