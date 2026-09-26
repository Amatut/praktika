// Итог урока и повторения: что сохранять и какой причиной подписывать повторение.
// Только чистые функции — их проверяют модульные тесты.

import { REVIEW_INTERVALS_DAYS } from '../../storage/schedule.ts';
import type { LessonRecord, ReviewRecord, SelfCheck } from '../../storage/types.ts';

// Ключ повторения темы урока — один на всё приложение (его читает и модель прогресса).
export { lessonReviewKey } from '../../progress/model.ts';

/** Ответ и самооценка в итоге не изменились — записывать нечего (уход с пустого поля ничего не затирает). */
export function recapUnchanged(previous: LessonRecord['recap'], answer: string, selfCheck: SelfCheck | null): boolean {
  return (previous?.answer ?? '') === answer && (previous?.selfCheck ?? null) === selfCheck;
}

/** Причина для списка «На повторение» после очередного повторения. stage — новая ступень расписания. */
export function reviewReasonAfter(kind: 'lesson' | 'exercise', success: boolean, stage: number): string {
  if (!success) return kind === 'lesson' ? 'При повторении тема пока не держится' : 'При повторении понадобилась помощь';
  return `Закрепляем: повторение ${Math.min(stage + 1, REVIEW_INTERVALS_DAYS.length)} из ${REVIEW_INTERVALS_DAYS.length}`;
}

/** Повторение открыто (не закрыто окончательно). */
export function isActiveReview(review: ReviewRecord | null | undefined): review is ReviewRecord {
  return Boolean(review) && review!.doneAt === null;
}
