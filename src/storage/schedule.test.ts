import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addLocalDays,
  dueAtForStage,
  exerciseReviewKey,
  firstReview,
  isDue,
  localDateKey,
  nextReview,
  REVIEW_REASONS,
  reviewReasonForFirstPass,
  startOfLocalDay,
} from './schedule.ts';

const NOW = new Date(2026, 8, 26, 10, 30).getTime();
const HOUR = 60 * 60 * 1000;

/** Начало местного дня через days дней после NOW. */
function dayStart(days: number, from: number = NOW): number {
  const d = new Date(from);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days).getTime();
}

describe('localDateKey', () => {
  it('даёт дату по местному времени в виде YYYY-MM-DD', () => {
    expect(localDateKey(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
    expect(localDateKey(new Date(2026, 11, 31, 0, 0))).toBe('2026-12-31');
    expect(localDateKey(new Date(2026, 8, 26).getTime())).toBe('2026-09-26');
  });
});

describe('addLocalDays и startOfLocalDay', () => {
  it('прибавляет календарные дни и сохраняет время суток', () => {
    const result = new Date(addLocalDays(NOW, 3));
    expect(localDateKey(result)).toBe('2026-09-29');
    expect(result.getHours()).toBe(10);
    expect(result.getMinutes()).toBe(30);
  });

  it('начало дня — 00:00 того же дня', () => {
    expect(startOfLocalDay(NOW)).toBe(new Date(2026, 8, 26).getTime());
    expect(startOfLocalDay(new Date(2026, 8, 26, 23, 59, 59, 999).getTime())).toBe(new Date(2026, 8, 26).getTime());
  });
});

describe('nextReview', () => {
  it('первое повторение — с начала следующего дня', () => {
    expect(firstReview(NOW)).toEqual({ stage: 0, dueAt: dayStart(1), done: false });
  });

  it('при успехе интервалы растут: 1 → 3 → 7 → 14 дней, затем повторение закрыто', () => {
    expect(nextReview(0, true, NOW)).toEqual({ stage: 1, dueAt: dayStart(3), done: false });
    expect(nextReview(1, true, NOW)).toEqual({ stage: 2, dueAt: dayStart(7), done: false });
    expect(nextReview(2, true, NOW)).toEqual({ stage: 3, dueAt: dayStart(14), done: false });
    expect(nextReview(3, true, NOW)).toEqual({ stage: 3, dueAt: NOW, done: true });
  });

  it('при неудаче расписание начинается заново — со следующего дня', () => {
    expect(nextReview(2, false, NOW)).toEqual({ stage: 0, dueAt: dayStart(1), done: false });
    expect(nextReview(0, false, NOW)).toEqual({ stage: 0, dueAt: dayStart(1), done: false });
  });

  it('ступень вне диапазона приводится к 0..3', () => {
    expect(nextReview(-5, true, NOW).stage).toBe(1);
    expect(nextReview(99, true, NOW).done).toBe(true);
    expect(nextReview(Number.NaN, true, NOW).stage).toBe(1);
  });
});

describe('срок по календарным дням', () => {
  it('задание решено вечером — повторение доступно весь следующий день, даже утром', () => {
    const solvedAt = new Date(2026, 8, 20, 20, 15).getTime();
    const due = firstReview(solvedAt).dueAt;
    expect(localDateKey(due)).toBe('2026-09-21');
    expect(isDue(due, new Date(2026, 8, 20, 23, 59).getTime())).toBe(false);
    expect(isDue(due, new Date(2026, 8, 21, 0, 0).getTime())).toBe(true);
    expect(isDue(due, new Date(2026, 8, 21, 8, 0).getTime())).toBe(true);
    expect(isDue(due, new Date(2026, 8, 21, 19, 0).getTime())).toBe(true);
  });

  it('интервал 3 дня — ровно три календарных дня, в какое бы время ни занимался ученик', () => {
    const at = new Date(2026, 8, 21, 22, 0).getTime();
    const due = dueAtForStage(1, at);
    expect(isDue(due, new Date(2026, 8, 23, 23, 0).getTime())).toBe(false);
    expect(isDue(due, new Date(2026, 8, 24, 7, 0).getTime())).toBe(true);
  });

  it('старые сроки со временем суток сравниваются тоже по дню', () => {
    const legacyDue = new Date(2026, 8, 21, 20, 15).getTime();
    expect(isDue(legacyDue, new Date(2026, 8, 21, 9, 0).getTime())).toBe(true);
    expect(isDue(legacyDue, new Date(2026, 8, 20, 21, 0).getTime())).toBe(false);
  });
});

describe('переход на летнее и зимнее время (Europe/Berlin)', () => {
  const previousTz = process.env.TZ;

  beforeAll(() => {
    process.env.TZ = 'Europe/Berlin';
  });

  afterAll(() => {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  });

  it('часовой пояс действительно сменился (иначе тест ничего не проверяет)', () => {
    // В Берлине 29.03.2026 часы переводят вперёд: смещение зимой UTC+1, летом UTC+2.
    expect(new Date(2026, 2, 28, 12).getTimezoneOffset()).toBe(-60);
    expect(new Date(2026, 2, 30, 12).getTimezoneOffset()).toBe(-120);
  });

  it('весна: 28.03 23:30 + 1 день — это 29.03, хотя 24 часа дали бы уже 30.03', () => {
    const at = new Date(2026, 2, 28, 23, 30).getTime();
    expect(localDateKey(at + 24 * HOUR)).toBe('2026-03-30');
    expect(localDateKey(addLocalDays(at, 1))).toBe('2026-03-29');
    const due = firstReview(at).dueAt;
    expect(due).toBe(new Date(2026, 2, 29).getTime());
    expect(localDateKey(due)).toBe('2026-03-29');
    // В сутках перехода 23 часа — но это по-прежнему один календарный день.
    expect(startOfLocalDay(addLocalDays(due, 1)) - due).toBe(23 * HOUR);
  });

  it('осень: 25.10 00:30 + 1 день — это 26.10, хотя 24 часа дали бы ещё 25.10', () => {
    // 25.10.2026 в 03:00 часы переводят назад: эти сутки длятся 25 часов.
    const at = new Date(2026, 9, 25, 0, 30).getTime();
    expect(localDateKey(at + 24 * HOUR)).toBe('2026-10-25');
    expect(localDateKey(addLocalDays(at, 1))).toBe('2026-10-26');
    expect(startOfLocalDay(addLocalDays(at, 1)) - startOfLocalDay(at)).toBe(25 * HOUR);
    const due = firstReview(at).dueAt;
    expect(localDateKey(due)).toBe('2026-10-26');
    expect(new Date(due).getHours()).toBe(0);
    expect(isDue(due, new Date(2026, 9, 25, 23, 59).getTime())).toBe(false);
    expect(isDue(due, new Date(2026, 9, 26, 6, 0).getTime())).toBe(true);
  });

  it('интервал 7 дней через переход остаётся семью календарными днями', () => {
    const at = new Date(2026, 2, 25, 21, 0).getTime();
    const due = dueAtForStage(2, at);
    expect(localDateKey(due)).toBe('2026-04-01');
    expect(new Date(due).getHours()).toBe(0);
  });
});

describe('reviewReasonForFirstPass', () => {
  it('просмотр решения и третья подсказка ставят задание на повторение', () => {
    expect(reviewReasonForFirstPass(4, 0)).toBe(REVIEW_REASONS.solution);
    expect(reviewReasonForFirstPass(3, 0)).toBe(REVIEW_REASONS.hint3);
    expect(REVIEW_REASONS.hint3).toBe('Решено с третьей подсказкой');
    expect(REVIEW_REASONS.solution).toBe('Решено после просмотра решения');
  });

  it('4 и больше неудачных проверок до успеха — «Понадобилось много попыток»', () => {
    expect(reviewReasonForFirstPass(0, 4)).toBe('Понадобилось много попыток');
    expect(reviewReasonForFirstPass(2, 7)).toBe(REVIEW_REASONS.manyAttempts);
  });

  it('помощь важнее числа попыток; без повода — null', () => {
    expect(reviewReasonForFirstPass(4, 10)).toBe(REVIEW_REASONS.solution);
    expect(reviewReasonForFirstPass(0, 3)).toBeNull();
    expect(reviewReasonForFirstPass(2, 0)).toBeNull();
  });

  it('ключ повторения задания', () => {
    expect(exerciseReviewKey('py-01-print')).toBe('exercise:py-01-print');
  });
});
