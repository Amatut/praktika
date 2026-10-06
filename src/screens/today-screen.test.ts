// «Сегодня»: один вход в урок, ряды «На повторение» не дублируют главную кнопку, решённый шаг не зовёт назад,
// «всё пройдено» не противоречит само себе, на телефоне разметка идёт в видимом порядке. Рендер без хранилища.

import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Course, Exercise, ModuleFile } from '../content/schema.ts';
import type { LearnerData } from '../progress/useLearnerData.ts';
import type { ExerciseRecord, LessonRecord, ReviewRecord } from '../storage/types.ts';
import { TodayScreen } from './TodayScreen.tsx';

// Данные ученика и ширина окна подставляются тестом.
const learner = vi.hoisted(() => ({ data: null as LearnerData | null, narrow: false }));
vi.mock('../progress/useLearnerData.ts', () => ({ useLearnerData: () => ({ data: learner.data, error: null }) }));
vi.mock('../app/hooks.ts', () => ({ useMediaQuery: () => learner.narrow }));
// Строка состояния читает Python, сеть и настройки — здесь не нужна.
vi.mock('../app/AppShell.tsx', () => ({ SystemStatus: () => null }));

// Материалы — из собранного курса (уроки правит другой процесс — названия и номера шагов не зашиваем).
const course = JSON.parse(readFileSync(new URL('../../public/content/course.json', import.meta.url), 'utf8')) as Course;
const firstModule = course.modules[0];
const firstFile = JSON.parse(readFileSync(new URL(`../../public/${firstModule.file}`, import.meta.url), 'utf8')) as ModuleFile;
const lesson = firstFile.lessons[0];
/** Шаги урока, как на экране: 0 — история, дальше шаги материалов. */
const exerciseSteps = lesson.steps.flatMap((step, index) => (step.type === 'exercise' ? [{ exercise: step.exercise, index: index + 1 }] : []));
const firstNonExercise = lesson.steps.findIndex((step) => step.type !== 'exercise') + 1;

function lessonRecord(record: Partial<LessonRecord>): LessonRecord {
  return {
    lessonId: lesson.id,
    stepIndex: 0,
    completedSteps: [],
    startedAt: 1,
    completedAt: null,
    predictions: {},
    orders: {},
    quizzes: {},
    checklists: {},
    recap: null,
    updatedAt: 1,
    ...record,
  };
}

function passed(exercise: Exercise): ExerciseRecord {
  return { exerciseId: exercise.id, lessonId: lesson.id, draft: null, status: 'passed', checks: 1, runs: 0, hintsShown: 0, solutionViewed: true } as ExerciseRecord;
}

function learnerWith(options: { lessons?: LessonRecord[]; exercises?: ExerciseRecord[]; reviews?: ReviewRecord[]; current?: string | null } = {}): LearnerData {
  const lessons = options.lessons ?? [];
  return {
    files: new Map([[firstModule.id, firstFile]]),
    unavailable: [],
    lessons: new Map(lessons.map((record) => [record.lessonId, record])),
    exercises: new Map((options.exercises ?? []).map((record) => [record.exerciseId, record])),
    reviews: options.reviews ?? [],
    attempts: [],
    activity: [],
    interests: new Map(),
    projects: new Map(),
    market: [],
    meta: { currentLessonId: options.current ?? null, lastOpenedAt: null, firstActivityAt: null },
  };
}

function render(data: LearnerData, narrow = false): string {
  learner.data = data;
  learner.narrow = narrow;
  return renderToStaticMarkup(createElement(TodayScreen, { course }));
}

/** Текст разметки без тегов — то, что прочитает человек или экранный диктор. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;|\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

afterEach(() => {
  learner.data = null;
  learner.narrow = false;
});

describe('TodayScreen', () => {
  it('новый ученик: метка «Начать», одна кнопка «Начать урок»; в «На повторение» только «Повторять пока нечего»', () => {
    const html = render(learnerWith());
    expect(html).toMatch(/<p class="plabel" id="today-resume-label">Начать<\/p>/);
    expect(html.match(/>Начать урок</g)).toHaveLength(1);
    expect(html.match(new RegExp(`href="#/lesson/${lesson.id}/0"`, 'g'))).toHaveLength(1);
    expect(text(html)).toContain('Повторять пока нечего');
    expect(text(html)).not.toContain('Если только 10 минут');
    expect(text(html)).not.toContain('Практика:');
    // Длительность урока — у строки шага.
    expect(text(html)).toContain(`Длительность урока: ${lesson.minutes[0]}–${lesson.minutes[1]} мин`);
  });

  it('урок начат, шаг не задание: «Цель урока», «Практика» впереди и короткий путь — другой, чем у кнопки', () => {
    const html = render(learnerWith({ lessons: [lessonRecord({ stepIndex: firstNonExercise })], current: lesson.id }));
    expect(html).toMatch(/>Продолжить<\/p>/);
    expect(html).toContain(`href="#/lesson/${lesson.id}/${firstNonExercise}"`);
    expect(text(html)).toContain('Цель урока');
    expect(text(html)).toContain(`Практика: ${exerciseSteps[0].exercise.title}`);
    expect(text(html)).toContain('История урока · 3 мин');
  });

  it('текущее задание уже решено: экран ведёт к следующему непройденному шагу, решённое не предлагается', () => {
    const [first, second] = exerciseSteps;
    const html = render(
      learnerWith({ lessons: [lessonRecord({ stepIndex: first.index })], exercises: [passed(first.exercise)], current: lesson.id }),
    );
    expect(html).toContain(`href="#/lesson/${lesson.id}/${second.index}"`);
    expect(html).not.toContain(`href="#/lesson/${lesson.id}/${first.index}"`);
    expect(text(html)).toContain(`Шаг ${second.index + 1} из ${lesson.steps.length + 1}`);
    // Ряд «Практика» на текущее задание не дублирует главную кнопку; название решённого — не ссылка.
    expect(text(html)).not.toContain('Практика:');
    expect(html).not.toMatch(new RegExp(`<a[^>]*>(?:(?!</a>).)*${first.exercise.title}`));
  });

  it('повторения: в шапке число тем и оценка времени; будущая дата — без точки в конце', () => {
    const [first] = exerciseSteps;
    const review = (dueAt: number): ReviewRecord => ({
      key: `exercise:${first.exercise.id}`,
      lessonId: lesson.id,
      exerciseId: first.exercise.id,
      stage: 0,
      dueAt,
      reason: 'Решено после просмотра решения',
      createdAt: 1,
      updatedAt: 1,
      doneAt: null,
    });
    const due = render(learnerWith({ lessons: [lessonRecord({ stepIndex: 1 })], reviews: [review(Date.now() - 1000)] }));
    expect(text(due)).toContain('1 тема · ≈ 5 мин');
    expect(due).toMatch(new RegExp(`<a class="row" href="#/lesson/${lesson.id}/${first.index}">`));
    expect(text(due)).toContain('Решено после просмотра решения');

    const later = render(learnerWith({ lessons: [lessonRecord({ stepIndex: 1 })], reviews: [review(Date.now() + 3 * 24 * 3600 * 1000)] }));
    expect(text(later)).toMatch(/Ближайшее повторение — \d+ [а-я]+(?: \d{4} г\.)?(?! *\.)/);
    expect(later).not.toMatch(/Ближайшее повторение[^<]*\.</);
  });

  it('все готовые уроки пройдены: нет метки «Продолжить»; «Основы» пройдены, только если все их уроки написаны', () => {
    const all = course.modules.flatMap((module) => module.lessons).map((item) => lessonRecord({ lessonId: item.id, completedAt: 2 }));
    const html = render(learnerWith({ lessons: all }));
    expect(text(html)).toContain('Готовые уроки пройдены');
    expect(html).not.toContain('id="today-resume-label"');
    expect(text(html)).not.toMatch(/Продолжить|Начать урок/);
    // Пока часть уроков «Основ» не написана, маршрут честно не показывает «Основы» пройденными.
    const basicsWritten = course.modules
      .filter((module) => module.part === 'basics')
      .every((module) => module.lessons.every((lesson) => lesson.ready));
    expect(html).toContain(basicsWritten ? 'class="today-route is-complete"' : 'class="today-route"');
  });

  it('телефон: секции в разметке идут в видимом порядке, состояние — внизу', () => {
    const html = render(learnerWith(), true);
    expect(html).toContain('class="today today-one"');
    const order = ['today-resume', 'today-review', 'today-route', 'today-dirs', 'today-status'].map((name) => html.indexOf(name));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('ПК: рабочая область и боковая панель; поясняющих абзацев нет', () => {
    const html = render(learnerWith());
    expect(html).toContain('class="page-split today"');
    expect(html).not.toContain('today-status');
    for (const phrase of ['пропуск дня', 'место остановки', 'темы возвращаются', 'можно вернуться']) {
      expect(text(html).toLowerCase()).not.toContain(phrase);
    }
  });
});
