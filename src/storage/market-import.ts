// Импорт проверенного обзора рынка труда (JSON). Записи без источника, даты проверки,
// региона, валюты или уровня отклоняются: приложение не показывает неподтверждённые суммы.

import { z } from 'zod';
import type { MarketDataset } from './types.ts';

/** Дата в виде ГГГГ-ММ-ДД по местному времени. */
function localDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Такая дата есть в календаре: 2026-02-30 и 2026-13-01 — нет. */
function isCalendarDate(value: string): boolean {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * Дата проверки или публикации: ГГГГ-ММ-ДД, настоящая и не из будущего. Без этого на экране
 * появилось бы «проверено Invalid Date», а старые сведения можно было бы выдать за свежие.
 * Завтрашняя дата допускается: автор обзора мог жить в часовом поясе впереди ученика.
 */
function checkedDate(today: string) {
  const tomorrow = localDate(new Date(new Date(`${today}T12:00:00`).getTime() + 24 * 60 * 60 * 1000));
  return z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'нужна дата в виде ГГГГ-ММ-ДД, например 2026-09-26')
    .refine(isCalendarDate, 'такой даты нет в календаре')
    .refine((value) => value <= tomorrow, 'дата из будущего — проверь год и месяц');
}

function schemas(today: string) {
  const date = checkedDate(today);
  const entrySchema = z
    .object({
      lab: z.string().min(1),
      type: z.enum(['salary', 'hourly', 'project']),
      title: z.string().min(1),
      amountMin: z.number().nonnegative().nullable(),
      amountMax: z.number().nonnegative().nullable(),
      currency: z.string().min(3).max(3),
      period: z.enum(['month', 'year', 'hour', 'project']),
      region: z.string().min(1),
      level: z.string().min(1),
      publishedAt: date.nullable(),
      checkedAt: date,
      url: z.string().url().refine((value) => /^https?:\/\//.test(value), 'Ссылка должна начинаться с http(s)'),
      sourceType: z.enum(['vacancy', 'order', 'statistics', 'survey', 'platform']),
      isOffer: z.boolean(),
      note: z.string().default(''),
    })
    .refine((entry) => entry.publishedAt === null || entry.publishedAt <= entry.checkedAt, {
      message: 'дата публикации позже даты проверки',
      path: ['publishedAt'],
    });

  const fileSchema = z.object({
    format: z.literal('praktika-market'),
    title: z.string().min(1),
    region: z.string().min(1),
    currency: z.string().min(3).max(3),
    checkedAt: date,
    entries: z.array(entrySchema).min(1),
  });
  return fileSchema;
}

export type MarketImportResult = { ok: true; dataset: MarketDataset } | { ok: false; message: string };

/** now — для тестов: от него считается «сегодня». */
export function parseMarketFile(text: string, now: Date = new Date()): MarketImportResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, message: 'Это не JSON-файл.' };
  }
  const result = schemas(localDate(now)).safeParse(data);
  if (!result.success) {
    return {
      ok: false,
      message: `Файл не похож на проверенный обзор «Практики»: ${result.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join('.') || 'файл'} — ${issue.message}`)
        .join('; ')}`,
    };
  }
  const file = result.data;
  for (const entry of file.entries) {
    if (entry.amountMin === null && entry.amountMax === null) {
      return { ok: false, message: `Запись «${entry.title}» без суммы — такие записи не показываются.` };
    }
    if (entry.amountMin !== null && entry.amountMax !== null && entry.amountMin > entry.amountMax) {
      return { ok: false, message: `Запись «${entry.title}»: минимальная сумма больше максимальной.` };
    }
  }
  return {
    ok: true,
    dataset: {
      id: `${file.region}-${file.checkedAt}-${file.title}`.toLowerCase().replace(/[^a-zа-я0-9]+/gi, '-'),
      title: file.title,
      region: file.region,
      currency: file.currency,
      importedAt: Date.now(),
      checkedAt: file.checkedAt,
      entries: file.entries,
    },
  };
}
