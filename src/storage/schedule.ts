// Расписание повторений и календарные даты. Только чистые функции — без IndexedDB.
// Правило курса: к слабым темам возвращаемся примерно через 1, 3, 7 и 14 дней.

import type { HelpLevel } from './types.ts';

/** Через сколько дней повторять на ступенях 0, 1, 2, 3. */
export const REVIEW_INTERVALS_DAYS = [1, 3, 7, 14] as const;
export const LAST_REVIEW_STAGE = REVIEW_INTERVALS_DAYS.length - 1;
/** Столько неудачных проверок до первого успеха — повод повторить задание. */
export const MANY_FAILED_CHECKS = 4;

export const REVIEW_REASONS = {
  hint3: 'Решено с третьей подсказкой',
  solution: 'Решено после просмотра решения',
  manyAttempts: 'Понадобилось много попыток',
} as const;

/** Дата по местному времени в виде YYYY-MM-DD. */
export function localDateKey(date: Date | number = new Date()): string {
  const d = typeof date === 'number' ? new Date(date) : date;
  const y = String(d.getFullYear()).padStart(4, '0');
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Прибавить календарные дни по местному времени. Сохраняет время суток даже при переходе
 * на летнее/зимнее время (в отличие от прибавления 24 часов).
 */
export function addLocalDays(timestamp: number, days: number): number {
  const d = new Date(timestamp);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

/** Начало местного дня (00:00), в который попадает момент timestamp. */
export function startOfLocalDay(timestamp: number): number {
  const d = new Date(timestamp);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Наступил ли срок dueAt к моменту now. Сравниваются календарные дни по местному времени:
 * повторение «на 21-е» доступно весь день 21-го, в какое бы время ни было решено задание.
 */
export function isDue(dueAt: number, now: number): boolean {
  return localDateKey(dueAt) <= localDateKey(now);
}

function clampStage(stage: number): number {
  if (!Number.isFinite(stage)) return 0;
  return Math.min(LAST_REVIEW_STAGE, Math.max(0, Math.trunc(stage)));
}

/**
 * Когда повторять на этой ступени, если отсчитывать от момента now: начало местного дня через
 * 1, 3, 7 или 14 календарных дней. Время суток не важно — ученик занимается в разное время,
 * и повторение должно появиться с утра нужного дня, а не только к тому же часу.
 */
export function dueAtForStage(stage: number, now: number): number {
  return startOfLocalDay(addLocalDays(now, REVIEW_INTERVALS_DAYS[clampStage(stage)]));
}

export interface ReviewStep {
  /** Новая ступень 0..3. */
  stage: number;
  /** С какого момента повторять (начало местного дня); если повторения закончены — равно now. */
  dueAt: number;
  /** Повторения закончены: тема держится после 14-дневного интервала. */
  done: boolean;
}

/** Первое повторение нового задания: ступень 0, на следующий календарный день. */
export function firstReview(now: number): ReviewStep {
  return { stage: 0, dueAt: dueAtForStage(0, now), done: false };
}

/**
 * Следующий шаг после повторения на ступени stage.
 * Успех — переход к более длинному интервалу (1 → 3 → 7 → 14 дней), после последней ступени повторение закрыто.
 * Неудача — начинаем заново с интервала в один день: тема пока не держится.
 */
export function nextReview(stage: number, success: boolean, now: number): ReviewStep {
  const current = clampStage(stage);
  if (!success) return { stage: 0, dueAt: dueAtForStage(0, now), done: false };
  if (current >= LAST_REVIEW_STAGE) return { stage: LAST_REVIEW_STAGE, dueAt: now, done: true };
  const next = current + 1;
  return { stage: next, dueAt: dueAtForStage(next, now), done: false };
}

/**
 * Нужно ли поставить задание на повторение после ПЕРВОГО успешного решения.
 * help — сколько помощи понадобилось (3 — третья подсказка, 4 — смотрел решение);
 * failedChecks — сколько проверок до этого не прошли.
 * Возвращает причину для ученика или null, если повторять не нужно.
 */
export function reviewReasonForFirstPass(help: HelpLevel, failedChecks: number): string | null {
  if (help >= 4) return REVIEW_REASONS.solution;
  if (help === 3) return REVIEW_REASONS.hint3;
  if (failedChecks >= MANY_FAILED_CHECKS) return REVIEW_REASONS.manyAttempts;
  return null;
}

/** Ключ повторения для задания (в ReviewRecord.key). */
export function exerciseReviewKey(exerciseId: string): string {
  return `exercise:${exerciseId}`;
}
