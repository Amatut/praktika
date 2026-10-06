// Состояние связи с ИИ-наставником для интерфейса: подключён, не настроен (нет ключа), нет связи с адаптером
// или ещё не проверено. Проверка /health бесплатная; запросы к ИИ по-прежнему только по кнопке ученика.
// Последний запрос к наставнику тоже обновляет состояние: если адаптер перестал отвечать, это видно сразу.

import { useEffect, useSyncExternalStore } from 'react';
import { CoachError, CoachNotConfiguredError, checkHealth, describeCoachError, type CoachHealth } from './ai-client.ts';

export type CoachConnection =
  | { state: 'unknown' }
  | { state: 'checking' }
  | { state: 'ready'; model: string }
  | { state: 'not-configured'; message: string }
  | { state: 'unavailable'; message: string };

/** Сколько считать результат проверки свежим, мс: чаще адаптер не опрашиваем. */
export const CONNECTION_TTL_MS = 60_000;

const UNKNOWN: CoachConnection = { state: 'unknown' };
const CHECKING: CoachConnection = { state: 'checking' };

let current: { key: string; value: CoachConnection; at: number } = { key: '', value: UNKNOWN, at: 0 };
let inflight: { key: string; promise: Promise<CoachConnection> } | null = null;
const listeners = new Set<() => void>();

function keyOf(endpoint: string, token: string): string {
  return `${endpoint.trim()}\n${token.trim()}`;
}

function publish(key: string, value: CoachConnection) {
  current = { key, value, at: Date.now() };
  for (const listener of listeners) listener();
}

/** Что ошибка обращения говорит о связи. null — о связи ничего не известно (отмена, лимит, сбой ИИ). */
export function connectionFromError(error: unknown): CoachConnection | null {
  if (!(error instanceof CoachError)) return null;
  switch (error.kind) {
    case 'not-configured':
      return { state: 'not-configured', message: error.message };
    case 'network':
    case 'unavailable':
    case 'endpoint':
    case 'access':
      return { state: 'unavailable', message: error.message };
    default:
      return null;
  }
}

function fromHealth(health: CoachHealth): CoachConnection {
  return health.configured ? { state: 'ready', model: health.model } : { state: 'not-configured', message: new CoachNotConfiguredError().message };
}

/** Проверка /health не прошла: по этому адресу наставник недоступен, какой бы ни была причина. */
function fromHealthError(error: unknown): CoachConnection {
  return connectionFromError(error) ?? { state: 'unavailable', message: describeCoachError(error) };
}

/** Итог проверки /health, сделанной в другом месте (Настройки → «Проверить соединение»). */
export function reportCoachHealth(endpoint: string, token: string, result: { health: CoachHealth } | { error: unknown }) {
  publish(keyOf(endpoint, token), 'health' in result ? fromHealth(result.health) : fromHealthError(result.error));
}

/** Состояние для адреса и токена из настроек. Другой адрес — «ещё не проверено». */
export function getCoachConnection(endpoint: string, token: string): CoachConnection {
  return current.key === keyOf(endpoint, token) ? current.value : UNKNOWN;
}

/**
 * Проверить связь с адаптером (бесплатный GET /health). Свежий результат не перепроверяется,
 * одновременные вызовы с одним адресом делят один запрос. force — проверить заново.
 */
export function refreshCoachConnection(endpoint: string, token: string, { force = false } = {}): Promise<CoachConnection> {
  const key = keyOf(endpoint, token);
  if (inflight?.key === key) return inflight.promise;
  const fresh = current.key === key && current.value.state !== 'unknown' && Date.now() - current.at < CONNECTION_TTL_MS;
  if (fresh && !force) return Promise.resolve(current.value);
  // Перепроверка того же адреса не мигает «проверяю»: до ответа виден прежний результат.
  if (current.key !== key || current.value.state === 'unknown') publish(key, CHECKING);
  const promise = checkHealth(endpoint, token).then(fromHealth, fromHealthError);
  inflight = { key, promise };
  return promise.then((value) => {
    if (inflight?.promise === promise) {
      inflight = null;
      publish(key, value);
    }
    return value;
  });
}

/** Итог настоящего запроса к наставнику: ответ пришёл — связь есть; ошибка связи — состояние меняется. */
export function reportCoachResult(endpoint: string, token: string, result: { ok: true; model: string } | { ok: false; error: unknown }) {
  const key = keyOf(endpoint, token);
  if (result.ok) {
    publish(key, { state: 'ready', model: result.model });
    return;
  }
  const value = connectionFromError(result.error);
  if (value) publish(key, value);
}

/** Коротко (1–2 слова) для строки состояния и метки наставника: «ИИ: нет связи». Подробности — в title. */
export function connectionLabel(connection: CoachConnection | { state: CoachConnection['state'] }, online: boolean): { text: string; tone: 'good' | 'warn' | 'muted' } {
  if (!online) return { text: 'нет сети', tone: 'warn' };
  switch (connection.state) {
    case 'ready':
      return { text: 'подключён', tone: 'good' };
    case 'not-configured':
      return { text: 'не настроен', tone: 'warn' };
    case 'unavailable':
      return { text: 'нет связи', tone: 'warn' };
    default:
      return { text: 'проверяю…', tone: 'muted' };
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Состояние связи с наставником; в режиме ИИ при сети — с проверкой адаптера при первом показе
 * и после смены адреса (не чаще раза в минуту).
 */
export function useCoachConnection(coach: { mode: 'course' | 'ai'; endpoint: string; accessToken: string }, online: boolean): CoachConnection {
  const { mode, endpoint, accessToken } = coach;
  const connection = useSyncExternalStore(subscribe, () => getCoachConnection(endpoint, accessToken));
  useEffect(() => {
    if (mode === 'ai' && online) void refreshCoachConnection(endpoint, accessToken);
  }, [mode, endpoint, accessToken, online]);
  return connection;
}
