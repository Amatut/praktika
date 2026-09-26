// Провайдер Anthropic: запрос к Messages API через официальный SDK (@anthropic-ai/sdk).
// SDK используется только здесь, на сервере адаптера; в приложение (src/) он не попадает.
// Ключ берётся ТОЛЬКО из process.env.ANTHROPIC_API_KEY, не логируется и не уходит в приложение.

import Anthropic from '@anthropic-ai/sdk';
import type { APIConnectionError, APIError } from '@anthropic-ai/sdk';
import { CoachProviderError } from './types.ts';
import type { CoachCompletion, CoachCompletionRequest, CoachProvider } from './types.ts';

/**
 * Адрес API задан явно: переменная ANTHROPIC_BASE_URL из окружения не может увести ключ
 * и данные ученика на другой сервер.
 */
const API_BASE_URL = 'https://api.anthropic.com';

/** Модель по умолчанию. Обоснование — в docs/coach.md. Меняется переменной COACH_MODEL. */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5';

/** Сколько SDK-клиент ждёт ответа API, если не задано иное (совпадает с COACH_TIMEOUT_MS по умолчанию). */
export const DEFAULT_ANTHROPIC_TIMEOUT_MS = 30_000;

export type AnthropicEffort = 'low' | 'medium' | 'high';
export const ANTHROPIC_EFFORTS: readonly AnthropicEffort[] = ['low', 'medium', 'high'];

/** Модели, которые принимают output_config.effort (на других он вызывает ошибку 400). */
const EFFORT_MODELS = /^claude-(opus-(4-[5-9]|5)|fable-|mythos-|sonnet-(4-6|5))/;

/**
 * Резервная модель на стороне API: если классификатор безопасности отклонит безобидный учебный
 * вопрос, API сам повторит запрос на рекомендованной модели внутри того же вызова
 * (fallbacks: "default", бета-функция server-side-fallback-2026-07-01).
 * Включается только для моделей, где это описано в документации.
 */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const FALLBACK_MODELS: ReadonlySet<string> = new Set(['claude-opus-5', 'claude-fable-5-1']);

type CreateParams = Anthropic.Beta.MessageCreateParamsNonStreaming;
type BetaMessage = Anthropic.Beta.BetaMessage;

export interface AnthropicProviderOptions {
  model: string;
  /** Глубина рассуждений. Для коротких подсказок достаточно low. null — не передавать. */
  effort?: AnthropicEffort | null;
  /** Тайм-аут SDK-клиента, мс. Адаптер передаёт сюда COACH_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Подмена fetch внутри SDK-клиента — только для тестов: так тесты не делают настоящих запросов. */
  fetchImpl?: typeof fetch;
}

function readKey(): string | null {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  return key ? key : null;
}

/** Убирает ключ из текста на случай, если он когда-нибудь окажется в сообщении об ошибке. */
function scrub(text: string, key: string): string {
  return key ? text.split(key).join('***') : text;
}

function retryAfterSeconds(headers: Headers | undefined): number | null {
  const value = headers?.get('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(1, Math.ceil((date - Date.now()) / 1000));
  return null;
}

/** Подробность для журнала адаптера (не для приложения): статус, тип, request_id и текст ошибки API. */
function describeApiError(error: APIError, key: string): string {
  const parts = [error.status === undefined ? 'нет HTTP-ответа' : `HTTP ${error.status}`];
  if (error.type) parts.push(error.type);
  if (error.requestID) parts.push(`request_id=${error.requestID}`);
  if (error.message) parts.push(scrub(error.message, key).slice(0, 300));
  return parts.join(' · ');
}

/**
 * Коды ошибок, при которых соединение с провайдером так и не установилось: запрос до него
 * не дошёл и точно не оплачен. Всё остальное (обрыв во время ожидания ответа, ECONNRESET,
 * неизвестная причина) считаем возможно оплаченным — такой запрос расходует лимит.
 */
const CONNECT_ERROR_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EAI_NONAME',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/**
 * Системный код сетевой ошибки. SDK кладёт исходную ошибку fetch в APIConnectionError.cause,
 * а fetch — системную ошибку в свой cause (иногда в AggregateError.errors).
 */
function systemErrorCode(error: unknown, depth = 0): string | null {
  if (depth > 4 || typeof error !== 'object' || error === null) return null;
  const record = error as { code?: unknown; cause?: unknown; errors?: unknown };
  if (typeof record.code === 'string') return record.code;
  const fromCause = systemErrorCode(record.cause, depth + 1);
  if (fromCause) return fromCause;
  if (Array.isArray(record.errors)) {
    for (const item of record.errors) {
      const code = systemErrorCode(item, depth + 1);
      if (code) return code;
    }
  }
  return null;
}

function timeoutError(detail: string | null = null): CoachProviderError {
  return new CoachProviderError('timeout', 'ИИ не ответил за отведённое время. Попробуй ещё раз чуть позже.', 504, {
    detail,
  });
}

/** Отмена сигналом адаптера: его тайм-аут или приложение закрыло соединение. */
function abortError(signal: AbortSignal): CoachProviderError {
  const reason: unknown = signal.reason;
  if (reason instanceof Error && reason.name === 'TimeoutError') return timeoutError();
  return new CoachProviderError('aborted', 'Запрос отменён.', 499);
}

function connectionError(error: APIConnectionError, key: string): CoachProviderError {
  const code = systemErrorCode(error.cause);
  const cause = error.cause instanceof Error ? `${error.cause.name}: ${error.cause.message}` : error.message;
  const detail = scrub(code ? `${cause} (${code})` : cause, key).slice(0, 300);
  if (code !== null && CONNECT_ERROR_CODES.has(code)) {
    return new CoachProviderError(
      'network',
      'Адаптер не смог связаться с ИИ-провайдером. Проверь интернет на компьютере, где запущен адаптер.',
      502,
      { detail },
    );
  }
  return new CoachProviderError(
    'connection-lost',
    'Связь с ИИ-провайдером оборвалась до получения ответа. Попробуй ещё раз; если повторяется — проверь интернет на компьютере, где запущен адаптер.',
    502,
    { detail },
  );
}

/**
 * Переводит ошибку SDK в понятную ученику ошибку провайдера. Классы проверяются от частного
 * к общему: APIUserAbortError и APIConnectionError в SDK тоже наследуют APIError.
 */
function mapError(error: unknown, signal: AbortSignal, model: string, key: string): CoachProviderError {
  if (error instanceof CoachProviderError) return error;
  // Сигнал адаптера сработал — неважно, как именно SDK сообщил об обрыве.
  if (signal.aborted) return abortError(signal);

  if (error instanceof Anthropic.APIUserAbortError) {
    return new CoachProviderError('aborted', 'Запрос отменён.', 499);
  }
  // Тайм-аут SDK-клиента. Сюда же SDK относит тайм-аут подключения — считаем, что запрос мог быть оплачен.
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return timeoutError(scrub(error.message, key).slice(0, 300));
  }
  if (error instanceof Anthropic.APIConnectionError) return connectionError(error, key);

  if (error instanceof Anthropic.AuthenticationError) {
    return new CoachProviderError(
      'auth',
      'Ключ ANTHROPIC_API_KEY не принят (ошибка 401). Проверь ключ в файле .env и перезапусти адаптер.',
      502,
      { detail: describeApiError(error, key) },
    );
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return new CoachProviderError(
      'permission',
      'У этого ключа нет доступа к запрошенной модели или операции (ошибка 403).',
      502,
      { detail: describeApiError(error, key) },
    );
  }
  if (error instanceof Anthropic.NotFoundError) {
    return new CoachProviderError(
      'model',
      `Модель «${model}» не найдена или недоступна для этого ключа. Проверь COACH_MODEL в файле .env.`,
      502,
      { detail: describeApiError(error, key) },
    );
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new CoachProviderError(
      'rate-limit',
      'ИИ-провайдер сейчас ограничивает частоту запросов. Подожди немного и попробуй снова.',
      429,
      { retryAfterSec: retryAfterSeconds(error.headers) ?? 30, detail: describeApiError(error, key) },
    );
  }
  if (error instanceof Anthropic.BadRequestError) {
    return new CoachProviderError(
      'bad-request',
      'ИИ-провайдер отклонил запрос (ошибка 400). Подробности — в окне, где запущен адаптер.',
      502,
      { detail: describeApiError(error, key) },
    );
  }
  if (error instanceof Anthropic.InternalServerError) {
    const detail = describeApiError(error, key);
    if (error.status === 529 || error.type === 'overloaded_error') {
      return new CoachProviderError('overloaded', 'ИИ сейчас перегружен. Попробуй через минуту.', 503, {
        retryAfterSec: retryAfterSeconds(error.headers) ?? 60,
        detail,
      });
    }
    if (error.status === 504 || error.type === 'timeout_error') return timeoutError(detail);
    return new CoachProviderError(
      'upstream',
      `Ошибка на стороне ИИ-провайдера (${error.status}). Попробуй позже.`,
      502,
      { retryAfterSec: retryAfterSeconds(error.headers), detail },
    );
  }
  if (error instanceof Anthropic.APIError) {
    const detail = describeApiError(error, key);
    if (error.status === 402 || error.type === 'billing_error') {
      return new CoachProviderError(
        'billing',
        'ИИ-провайдер сообщил о проблеме с оплатой (ошибка 402). Проверь баланс в Claude Console.',
        502,
        { detail },
      );
    }
    if (error.status === 413) {
      return new CoachProviderError('bad-request', 'Запрос слишком большой для ИИ-провайдера.', 413, { detail });
    }
    return new CoachProviderError(
      'upstream',
      `ИИ-провайдер вернул неожиданный ответ (${error.status ?? 'без статуса'}).`,
      502,
      { detail },
    );
  }
  if (error instanceof SyntaxError) {
    return new CoachProviderError('upstream', 'ИИ-провайдер вернул повреждённый ответ. Попробуй ещё раз.', 502, {
      detail: 'ответ API — не JSON',
    });
  }
  // Неизвестная ошибка (например, связь оборвалась во время чтения ответа): запрос мог быть оплачен.
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return new CoachProviderError(
    'connection-lost',
    'Связь с ИИ-провайдером оборвалась до получения ответа. Попробуй ещё раз; если повторяется — проверь интернет на компьютере, где запущен адаптер.',
    502,
    { detail: scrub(text, key).slice(0, 300) },
  );
}

function isMessage(value: unknown): value is BetaMessage {
  return typeof value === 'object' && value !== null && Array.isArray((value as { content?: unknown }).content);
}

export function createAnthropicProvider(options: AnthropicProviderOptions): CoachProvider {
  const model = options.model;
  const effort = options.effort === undefined ? 'low' : options.effort;
  const timeoutMs = options.timeoutMs ?? DEFAULT_ANTHROPIC_TIMEOUT_MS;
  // Если организация не подключена к бета-функции резервной модели, отключаем её до перезапуска.
  let fallbacksEnabled = FALLBACK_MODELS.has(model);
  let cached: { key: string; client: Anthropic } | null = null;

  /** Клиент SDK создаётся заново, только если ключ в окружении поменялся. */
  function clientFor(key: string): Anthropic {
    if (cached?.key === key) return cached.client;
    const client = new Anthropic({
      apiKey: key,
      // Только ключ API: ANTHROPIC_AUTH_TOKEN и профили из окружения не подмешиваются.
      authToken: null,
      baseURL: API_BASE_URL,
      timeout: timeoutMs,
      // Без автоповторов: каждый повтор мог бы быть оплачен и расходовал бы лимиты ученика.
      // Отказ до генерации лимит не расходует — ученик просто нажмёт кнопку ещё раз.
      maxRetries: 0,
      // Журнал SDK выключен: в нём могли бы оказаться код и вопросы ученика.
      logLevel: 'off',
      ...(options.fetchImpl ? { fetch: options.fetchImpl } : {}),
    });
    cached = { key, client };
    return client;
  }

  async function send(client: Anthropic, params: CreateParams, signal: AbortSignal): Promise<BetaMessage> {
    if (!fallbacksEnabled) return client.beta.messages.create(params, { signal });
    try {
      return await client.beta.messages.create(
        { ...params, betas: [FALLBACK_BETA], fallbacks: 'default' },
        { signal },
      );
    } catch (error) {
      if (!(error instanceof Anthropic.BadRequestError)) throw error;
      // Ошибка 400 с включённой резервной моделью: возможно, организация не подключена к этой
      // бета-функции. Отклонённый запрос не оплачивается, поэтому один раз повторяем его без неё.
      // Прошёл — отключаем резервную модель до перезапуска адаптера. Не прошёл — дело не в ней,
      // и ученик увидит ошибку повторного запроса.
      const message = await client.beta.messages.create(params, { signal });
      fallbacksEnabled = false;
      return message;
    }
  }

  async function complete({ system, messages, maxTokens, signal }: CoachCompletionRequest): Promise<CoachCompletion> {
    const key = readKey();
    if (!key) {
      throw new CoachProviderError(
        'not-configured',
        'ИИ не настроен: на сервере нет ключа ANTHROPIC_API_KEY. Подсказки курса работают и без него.',
        503,
      );
    }

    const params: CreateParams = {
      model,
      max_tokens: maxTokens,
      // Системный промпт одинаков во всех запросах — кешируем его, повторные запросы дешевле.
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: messages.map((message) => ({ role: message.role, content: message.content })),
    };
    if (effort && EFFORT_MODELS.test(model)) params.output_config = { effort };

    let message: BetaMessage;
    try {
      message = await send(clientFor(key), params, signal);
    } catch (error) {
      throw mapError(error, signal, model, key);
    }
    if (!isMessage(message)) {
      throw new CoachProviderError('upstream', 'ИИ-провайдер вернул повреждённый ответ. Попробуй ещё раз.', 502, {
        detail: 'в ответе API нет content',
      });
    }

    // Отказ проверяется до чтения текста: при отказе ответ пустой или неполный.
    // С резервной моделью stop_reason=refusal значит, что отказала вся цепочка моделей.
    if (message.stop_reason === 'refusal') {
      throw new CoachProviderError(
        'refusal',
        'ИИ отказался отвечать на этот запрос. Попробуй переформулировать вопрос — подсказки курса по-прежнему доступны.',
        502,
        { detail: `stop_reason=refusal, категория=${message.stop_details?.category ?? 'нет'}` },
      );
    }

    const text = message.content
      .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();
    const truncated = message.stop_reason === 'max_tokens' || message.stop_reason === 'model_context_window_exceeded';

    if (!text) {
      throw new CoachProviderError(
        'empty',
        truncated
          ? 'Модель израсходовала лимит длины ответа (COACH_MAX_TOKENS) на рассуждения и не успела ответить. ' +
              'Попробуй ещё раз; если повторяется — увеличь COACH_MAX_TOKENS в файле .env адаптера.'
          : 'ИИ вернул пустой ответ. Попробуй ещё раз.',
        502,
        { detail: `stop_reason=${message.stop_reason ?? 'нет'}` },
      );
    }

    const usage = message.usage;
    return {
      text,
      truncated,
      // Модель, которая фактически ответила: с резервной моделью она может отличаться от настроенной.
      model: typeof message.model === 'string' && message.model ? message.model : model,
      usage: {
        input:
          (usage?.input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0),
        output: usage?.output_tokens ?? 0,
      },
    };
  }

  return {
    name: 'anthropic',
    model,
    get configured() {
      return readKey() !== null;
    },
    complete,
  };
}
