import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CoachAbortedError,
  CoachAccessError,
  CoachLimitError,
  CoachNetworkError,
  CoachNotConfiguredError,
  CoachUnavailableError,
} from './ai-client.ts';
import { connectionFromError, connectionLabel, getCoachConnection, refreshCoachConnection, reportCoachResult } from './connection.ts';

const ENDPOINT = 'http://127.0.0.1:8787';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('состояние связи с ИИ-наставником', () => {
  it('ошибки связи меняют состояние, остальные — нет', () => {
    expect(connectionFromError(new CoachUnavailableError())).toMatchObject({ state: 'unavailable' });
    expect(connectionFromError(new CoachNetworkError())).toMatchObject({ state: 'unavailable' });
    expect(connectionFromError(new CoachAccessError())).toMatchObject({ state: 'unavailable' });
    expect(connectionFromError(new CoachNotConfiguredError())).toMatchObject({ state: 'not-configured' });
    expect(connectionFromError(new CoachLimitError())).toBeNull();
    expect(connectionFromError(new CoachAbortedError())).toBeNull();
    expect(connectionFromError(new Error('что-то ещё'))).toBeNull();
  });

  it('подпись честно называет состояние, без сети — «нет сети»', () => {
    expect(connectionLabel({ state: 'ready', model: 'm' }, true)).toEqual({ text: 'подключён', tone: 'good' });
    expect(connectionLabel({ state: 'unavailable', message: '' }, true).text).toBe('нет связи');
    expect(connectionLabel({ state: 'not-configured', message: '' }, true).text).toBe('не настроен');
    expect(connectionLabel({ state: 'unknown' }, true).text).toBe('проверяю…');
    expect(connectionLabel({ state: 'ready', model: 'm' }, false).text).toBe('нет сети');
  });

  it('проверка /health: адаптер без ключа — «ИИ не настроен», не запущен — «недоступен»', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, provider: 'anthropic', model: 'm', configured: false, mode: 'local' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    expect((await refreshCoachConnection(ENDPOINT, 'a', { force: true })).state).toBe('not-configured');
    expect(getCoachConnection(ENDPOINT, 'a').state).toBe('not-configured');
    // Свежий результат не перепроверяется без force.
    await refreshCoachConnection(ENDPOINT, 'a');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Другой токен — ещё не проверено.
    expect(getCoachConnection(ENDPOINT, 'b').state).toBe('unknown');

    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    expect((await refreshCoachConnection(ENDPOINT, 'a', { force: true })).state).toBe('unavailable');
  });

  it('ответ наставника отмечает связь, ошибка связи — снимает', () => {
    reportCoachResult(ENDPOINT, 'c', { ok: true, model: 'claude' });
    expect(getCoachConnection(ENDPOINT, 'c')).toEqual({ state: 'ready', model: 'claude' });
    reportCoachResult(ENDPOINT, 'c', { ok: false, error: new CoachLimitError() });
    expect(getCoachConnection(ENDPOINT, 'c').state).toBe('ready');
    reportCoachResult(ENDPOINT, 'c', { ok: false, error: new CoachUnavailableError() });
    expect(getCoachConnection(ENDPOINT, 'c').state).toBe('unavailable');
  });
});
