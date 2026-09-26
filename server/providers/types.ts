// Общий интерфейс провайдера ИИ для адаптера наставника.
// Провайдер заменяемый: сервер знает только этот интерфейс, а не конкретный API.

export interface CoachMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface CoachCompletionRequest {
  /** Системный промпт наставника (coach/system-prompt.md). */
  system: string;
  messages: CoachMessage[];
  /** Жёсткий предел длины ответа в токенах. */
  maxTokens: number;
  /** Отмена: тайм-аут сервера или ученик закрыл соединение. */
  signal: AbortSignal;
}

export interface CoachUsage {
  /** Токены на входе (включая системный промпт). */
  input: number;
  /** Токены на выходе. */
  output: number;
}

export interface CoachCompletion {
  text: string;
  usage: CoachUsage;
  /** Модель, которая фактически ответила (может отличаться от настроенной при резервной модели). */
  model?: string;
  /** Ответ обрезан по лимиту длины. */
  truncated?: boolean;
}

export interface CoachProvider {
  /** Короткое имя: anthropic, mock. */
  readonly name: string;
  /** Идентификатор модели. */
  readonly model: string;
  /** Есть ли всё нужное для запросов (например, ключ API). */
  readonly configured: boolean;
  complete(request: CoachCompletionRequest): Promise<CoachCompletion>;
}

export type CoachProviderErrorCode =
  | 'not-configured' // нет ключа
  | 'auth' // ключ не принят
  | 'permission' // у ключа нет доступа к модели или операции
  | 'model' // модель не найдена или недоступна
  | 'rate-limit' // лимит провайдера
  | 'overloaded' // провайдер перегружен
  | 'billing' // проблема с оплатой
  | 'bad-request' // провайдер отклонил запрос
  | 'upstream' // ошибка на стороне провайдера (5xx)
  | 'timeout' // провайдер не ответил вовремя
  | 'aborted' // запрос отменён (ученик закрыл соединение)
  | 'network' // не удалось подключиться к провайдеру: запрос до него не дошёл
  | 'connection-lost' // связь оборвалась после отправки запроса: генерация могла быть оплачена
  | 'refusal' // модель отказалась отвечать
  | 'empty'; // пустой ответ

/**
 * Ошибка провайдера с понятным сообщением для ученика.
 * Сообщение никогда не содержит ключ API и сырые ответы провайдера.
 */
export class CoachProviderError extends Error {
  readonly code: CoachProviderErrorCode;
  /** HTTP-статус, который сервер вернёт приложению. */
  readonly status: number;
  /** Через сколько секунд можно повторить (для 429/529). */
  readonly retryAfterSec: number | null;
  /** Техническая подробность только для журнала сервера (не отправляется приложению). */
  readonly detail: string | null;

  constructor(
    code: CoachProviderErrorCode,
    message: string,
    status: number,
    options: { retryAfterSec?: number | null; detail?: string | null } = {},
  ) {
    super(message);
    this.name = 'CoachProviderError';
    this.code = code;
    this.status = status;
    this.retryAfterSec = options.retryAfterSec ?? null;
    this.detail = options.detail ?? null;
  }
}
