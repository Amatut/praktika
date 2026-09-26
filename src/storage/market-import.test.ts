import { describe, expect, it } from 'vitest';
import { parseMarketFile } from './market-import.ts';

const NOW = new Date(2026, 8, 26, 15, 0); // 26 сентября 2026, местное время

function entry(fields: Record<string, unknown> = {}) {
  return {
    lab: 'automation',
    type: 'project',
    title: 'Скрипт обработки CSV-отчётов (объявление)',
    amountMin: 100,
    amountMax: 250,
    currency: 'USD',
    period: 'project',
    region: 'Международный фриланс',
    level: 'начинающий',
    publishedAt: '2026-09-20',
    checkedAt: '2026-09-25',
    url: 'https://example.com/job/1',
    sourceType: 'order',
    isOffer: true,
    ...fields,
  };
}

function file(fields: Record<string, unknown> = {}, entries = [entry()]) {
  return JSON.stringify({
    format: 'praktika-market',
    title: 'Обзор: автоматизация, фриланс',
    region: 'Международный фриланс',
    currency: 'USD',
    checkedAt: '2026-09-25',
    entries,
    ...fields,
  });
}

function message(text: string): string {
  const result = parseMarketFile(text, NOW);
  if (result.ok) throw new Error('обзор неожиданно принят');
  return result.message;
}

describe('parseMarketFile: даты', () => {
  it('принимает даты ГГГГ-ММ-ДД не позже сегодняшнего дня', () => {
    const result = parseMarketFile(file(), NOW);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.dataset.checkedAt).toBe('2026-09-25');
    expect(parseMarketFile(file({ checkedAt: '2026-09-26' }), NOW).ok).toBe(true);
    expect(parseMarketFile(file({}, [entry({ publishedAt: null })]), NOW).ok).toBe(true);
  });

  it('отклоняет строку вместо даты — на экране не будет «проверено Invalid Date»', () => {
    expect(message(file({ checkedAt: 'не помню когда' }))).toContain('checkedAt — нужна дата в виде ГГГГ-ММ-ДД');
    expect(message(file({}, [entry({ checkedAt: '26.09.2026' })]))).toContain('entries.0.checkedAt — нужна дата');
    expect(message(file({}, [entry({ publishedAt: 'вчера' })]))).toContain('entries.0.publishedAt — нужна дата');
  });

  it('отклоняет несуществующие даты и даты из будущего', () => {
    expect(message(file({ checkedAt: '2026-02-30' }))).toContain('такой даты нет в календаре');
    expect(message(file({ checkedAt: '2062-09-26' }))).toContain('дата из будущего');
    expect(message(file({}, [entry({ checkedAt: '2026-10-01' })]))).toContain('дата из будущего');
    // Завтра допустимо: автор обзора мог быть в часовом поясе впереди.
    expect(parseMarketFile(file({ checkedAt: '2026-09-27' }), NOW).ok).toBe(true);
  });

  it('дата публикации не может быть позже даты проверки', () => {
    expect(message(file({}, [entry({ publishedAt: '2026-09-26', checkedAt: '2026-09-25' })]))).toContain(
      'дата публикации позже даты проверки',
    );
  });
});
