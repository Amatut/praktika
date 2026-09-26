import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Поддельный BroadcastChannel: проверяем обмен уведомлениями между вкладками без настоящих каналов.
class FakeChannel {
  static instances: FakeChannel[] = [];
  name: string;
  posted: unknown[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor(name: string) {
    this.name = name;
    FakeChannel.instances.push(this);
  }
  postMessage(message: unknown): void {
    this.posted.push(message);
  }
  receive(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  FakeChannel.instances = [];
});

async function loadDbInBrowser() {
  vi.stubGlobal('window', {});
  vi.stubGlobal('BroadcastChannel', FakeChannel);
  vi.resetModules();
  return import('./db.ts');
}

describe('уведомления между вкладками', () => {
  it('изменения рассылаются другим вкладкам', async () => {
    const db = await loadDbInBrowser();
    const seen: string[][] = [];
    const off = db.onChange((stores) => seen.push(stores));
    db.notifyChange(['exercises', 'attempts', 'exercises']);
    expect(seen).toEqual([['exercises', 'attempts']]);
    const channel = FakeChannel.instances[0];
    expect(channel?.name).toBe('praktika-storage');
    expect(channel?.posted).toEqual([{ type: 'praktika-change', stores: ['exercises', 'attempts'] }]);
    off();
  });

  it('сообщение из другой вкладки доходит до подписчиков, мусор игнорируется', async () => {
    const db = await loadDbInBrowser();
    const seen: string[][] = [];
    const off = db.onChange((stores) => seen.push(stores));
    const channel = FakeChannel.instances[0]!;
    channel.receive({ type: 'praktika-change', stores: ['reviews', 42] });
    channel.receive({ type: 'другое', stores: ['kv'] });
    channel.receive('строка');
    channel.receive(null);
    expect(seen).toEqual([['reviews']]);
    // Входящее сообщение не пересылается дальше.
    expect(channel.posted).toEqual([]);
    off();
  });

  it('без окна браузера канал не создаётся', async () => {
    vi.stubGlobal('BroadcastChannel', FakeChannel);
    vi.resetModules();
    const db = await import('./db.ts');
    const off = db.onChange(() => undefined);
    db.notifyChange(['kv']);
    expect(FakeChannel.instances).toEqual([]);
    off();
  });

  it('пустой список изменений не рассылается', async () => {
    const db = await loadDbInBrowser();
    const listener = vi.fn();
    const off = db.onChange(listener);
    db.notifyChange([]);
    expect(listener).not.toHaveBeenCalled();
    off();
  });
});

describe('миграции', () => {
  it('повторное открытие существующей базы не ломает данные', async () => {
    const db = await import('./db.ts');
    await db.deleteDatabase();
    const first = await db.getDb();
    await first.put('lessons', {
      lessonId: 'l-1',
      stepIndex: 2,
      completedSteps: [],
      startedAt: 1,
      completedAt: null,
      predictions: {},
      orders: {},
      quizzes: {},
      checklists: {},
      recap: null,
      updatedAt: 1,
    });
    await db.closeDb();
    const second = await db.getDb();
    expect(second).not.toBe(first);
    expect(second.version).toBe(db.DB_VERSION);
    expect((await second.get('lessons', 'l-1'))?.stepIndex).toBe(2);
    await db.deleteDatabase();
  });
});
