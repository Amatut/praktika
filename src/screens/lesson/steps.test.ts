import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ChecklistStep as ChecklistStepData, OrderStep, QuizStep as QuizStepData, RecapStep as RecapStepData } from '../../content/schema.ts';
import { LessonPlayground } from './LessonPlayground.tsx';
import { ChecklistStep, OrderStep as OrderStepView, QuizStep, RecapStep, isOrderCorrect, normalizeOutput, stdinPreview } from './steps.tsx';

function orderStep(extra: Partial<OrderStep> = {}): OrderStep {
  return {
    type: 'order',
    id: 'plan',
    title: 'План',
    prompt: 'Расставь',
    items: [
      { id: 'a', text: 'Взять чашку' },
      { id: 'b', text: 'Налить эспрессо' },
      { id: 'c', text: 'Отдать гостю' },
    ],
    explanation: 'Так',
    ...extra,
  } as OrderStep;
}

describe('normalizeOutput', () => {
  it('убирает пробелы в конце строк и пустые строки по краям', () => {
    expect(normalizeOutput('\nа  \r\nб\t\n\n')).toBe('а\nб');
  });
});

describe('isOrderCorrect', () => {
  it('без ограничений сравнивает с порядком из материалов', () => {
    expect(isOrderCorrect(orderStep(), ['a', 'c', 'b'])).toEqual([true, false, false]);
    expect(isOrderCorrect(orderStep(), ['a', 'b', 'c'])).toEqual([true, true, true]);
  });

  it('с ограничениями «до» отмечает только нарушившие их пункты', () => {
    const step = orderStep({ before: [['a', 'c']] });
    expect(isOrderCorrect(step, ['b', 'a', 'c'])).toEqual([true, true, true]);
    expect(isOrderCorrect(step, ['c', 'b', 'a'])).toEqual([false, true, false]);
  });
});

describe('stdinPreview', () => {
  it('показывает ввод программы через запятую', () => {
    expect(stdinPreview('2\n3\n')).toBe('2, 3');
    expect(stdinPreview('Катя')).toBe('Катя');
  });

  it('без ввода — ничего', () => {
    expect(stdinPreview(undefined)).toBeNull();
    expect(stdinPreview('')).toBeNull();
    expect(stdinPreview('\n')).toBeNull();
  });
});

/** Текст разметки без тегов — то, что прочитает человек. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Поясняющие фразы-заглушки, убранные из шагов урока (правка пользователя 1). */
const EXPLANATIONS = [
  'без оценки',
  'это нормально',
  'разберёмся',
  'место сохранится',
  'отметки ставишь ты сам',
  'оценки нет',
  'попробуй объяснить себе',
  'урок будет засчитан',
  'прогресс сохранён',
  'запускай по одной строке',
  'попробуй наглядно',
];

function expectNoExplanations(html: string) {
  const plain = text(html).toLowerCase();
  for (const phrase of EXPLANATIONS) expect(plain).not.toContain(phrase);
}

describe('шаги урока без пояснений интерфейса', () => {
  it('вопрос: метка вида, варианты-радио, одна кнопка «Ответить»', () => {
    const step = {
      type: 'quiz',
      id: 'q',
      title: 'Какая команда точная?',
      question: 'Выбери',
      options: ['Сделай вкусно', 'Налей 200 мл'],
      correct: 1,
      explanation: 'Потому что',
    } as QuizStepData;
    const html = renderToStaticMarkup(createElement(QuizStep, { step, record: null, onAnswer: () => {} }));
    expect(html).toContain('class="step-title"');
    expect(text(html)).toContain('Вопрос');
    expect(html.match(/role="radio"/g)).toHaveLength(2);
    expect(text(html)).toContain('Ответить');
    expectNoExplanations(html);
  });

  it('чек-лист: метки «Внешний инструмент» и «Отмечаешь сам» вместо абзаца, счётчик отметок', () => {
    const step = {
      type: 'checklist',
      id: 'c',
      title: 'Установи Python',
      body: 'Делай по пункту',
      items: [
        { id: 'a', text: 'Скачай', help: 'Если сайт не открылся' },
        { id: 'b', text: 'Установи' },
      ],
    } as ChecklistStepData;
    const html = renderToStaticMarkup(createElement(ChecklistStep, { step, record: null, onChange: () => {} }));
    expect(text(html)).toContain('Внешний инструмент');
    expect(text(html)).toContain('Отмечаешь сам');
    expect(text(html)).toContain('Отмечено 0 из 2');
    expect(text(html)).toContain('Если не получается');
    expectNoExplanations(html);
  });

  it('порядок: ряды с кнопками «Поднять / Опустить» и «Проверить порядок»', () => {
    const html = renderToStaticMarkup(createElement(OrderStepView, { step: orderStep(), record: null, onResult: () => {} }));
    expect(html.match(/class="order-item"/g)).toHaveLength(3);
    expect(html).toContain('aria-label="Поднять: Взять чашку"');
    expect(html).toContain('aria-label="Опустить: Отдать гостю"');
    expect(text(html)).toContain('Проверить порядок');
    expect(text(html)).not.toContain('Показать ответ');
    expectNoExplanations(html);
  });

  it('итог: «Вопрос на понимание», сам вопрос и короткий статус «Остались задания:» со ссылками на шаги', () => {
    const step = {
      type: 'recap',
      id: 'r',
      title: 'Что мы узнали',
      points: ['Программа — список команд', 'print выводит текст'],
      question: 'Почему так?',
      answer: 'Потому что',
    } as RecapStepData;
    const html = renderToStaticMarkup(
      createElement(RecapStep, {
        step,
        record: null,
        review: null,
        exercisesLeft: [{ id: 'e1', title: 'Первое приветствие', index: 6 }],
        nextLesson: null,
        onSave: () => {},
        onReview: async () => undefined,
        onFinish: () => {},
      }),
    );
    expect(text(html)).toContain('Вопрос на понимание Почему так?');
    expect(html).toContain('<textarea');
    expect(text(html)).toContain('Остались задания:');
    expect(html).toContain('href="#6"');
    expect(text(html)).not.toContain('Завершить урок');
    expectNoExplanations(html);
  });
});

describe('LessonPlayground', () => {
  it('блок «Попробуй» без метки «Без оценки» и вступлений; учебная строка про // и % остаётся', () => {
    const html = renderToStaticMarkup(createElement(LessonPlayground, { lessonId: 'm1-l1' }));
    expect(text(html)).toContain('Попробуй');
    expect(text(html)).toContain('В коробке 6 мест: // — полные коробки, % — остаток.');
    expectNoExplanations(html);
  });

  it('у урока без модели — ничего', () => {
    expect(renderToStaticMarkup(createElement(LessonPlayground, { lessonId: 'nope' }))).toBe('');
  });
});
