// «Карта курса», «Модуль» и «Проекты»: разметка, на которую опираются e2e и правки пользователя
// (нет поясняющих абзацев, статусы — словом, ряды на линиях). Рендер без хранилища: данные ещё «загружаются».

import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Course, ModuleFile } from '../content/schema.ts';
import type { LearnerData } from '../progress/useLearnerData.ts';
import type { LessonRecord } from '../storage/types.ts';
import { CourseScreen, ModuleScreen } from './CourseScreen.tsx';
import { ProjectsScreen } from './ProjectsScreen.tsx';

// Управление офлайном читает сеть и кэши браузера — в этом тесте оно не нужно (его проверяет экран «Настройки»).
vi.mock('./offline-controls.tsx', () => ({ OfflineModuleControl: () => null }));

// Данные ученика подставляются тестом; по умолчанию — null («ещё загружаются»), как при первом рендере.
const learner = vi.hoisted(() => ({ data: null as LearnerData | null }));
vi.mock('../progress/useLearnerData.ts', () => ({ useLearnerData: () => ({ data: learner.data, error: null }) }));

// Карта курса из собранных материалов (только чтение; уроки правит другой процесс — числа не зашиваем).
const course = JSON.parse(readFileSync(new URL('../../public/content/course.json', import.meta.url), 'utf8')) as Course;
const firstModule = course.modules[0];
const firstFile = JSON.parse(readFileSync(new URL(`../../public/${firstModule.file}`, import.meta.url), 'utf8')) as ModuleFile;

/** Данные ученика: скачан только первый модуль, записи уроков — из теста. */
function learnerWith(lessons: Partial<LessonRecord>[] = [], currentLessonId: string | null = null): LearnerData {
  const records = lessons.map((record) => ({
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
    lessonId: '',
    ...record,
  }));
  return {
    files: new Map([[firstModule.id, firstFile]]),
    unavailable: [],
    lessons: new Map(records.map((record) => [record.lessonId, record])),
    exercises: new Map(),
    reviews: [],
    attempts: [],
    activity: [],
    interests: new Map(),
    projects: new Map(),
    market: [],
    meta: { currentLessonId, lastOpenedAt: null, firstActivityAt: null },
  };
}

afterEach(() => {
  learner.data = null;
});

/** Текст разметки без тегов — то, что прочитает человек или экранный диктор. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

// Фразы-пояснения, убранные с этих экранов (раздел 5.3 спецификации редизайна).
const REMOVED = [
  'готовность приложения и полнота курса',
  'не нужно проходить её целиком',
  'недостающие уроки появятся',
  'уроки модуля можно скачать',
  'все уроки модуля освоены',
  'сохраняется автоматически',
  'отметки ставишь ты',
  'требования уже можно прочитать',
  'урок ещё не написан',
  'нет сети: урок не скачан',
];

function expectNoExplanations(html: string) {
  const plain = text(html).toLowerCase();
  for (const phrase of REMOVED) expect(plain).not.toContain(phrase);
  // Абзацев-вводных у экранов нет.
  expect(html).not.toContain('page-lead');
}

describe('CourseScreen', () => {
  const html = renderToStaticMarkup(createElement(CourseScreen, { course }));

  it('заголовок «Карта курса» и честные счётчики готовности', () => {
    expect(html).toMatch(/<h1[^>]*>Карта курса<\/h1>/);
    const lessons = course.modules.flatMap((module) => module.lessons);
    const ready = lessons.filter((lesson) => lesson.ready).length;
    expect(text(html)).toContain(`${ready} из ${lessons.length} уроков готово`);
    expect(text(html)).toContain(`из ${course.projects.length} проектов готово`);
  });

  it('модули — ряды-ссылки на линиях, обе части курса; в конце — вход в проекты', () => {
    for (const module of course.modules) {
      if (module.status === 'planned') continue;
      expect(html).toContain(`href="#/course/${module.id}"`);
    }
    expect(text(html)).toContain('Общая база на Python');
    expect(html).toContain('href="#/projects"');
    expectNoExplanations(html);
  });

  it('счётчики подписаны «Материалы» — это счёт написанного, а не прогресс ученика', () => {
    expect(html).toMatch(/<span class="plabel" id="cmap-materials">Материалы<\/span>/);
    expect(html).toContain('aria-labelledby="cmap-materials"');
  });

  it('подпись ряда ломается только на точках: «браузер + компьютер» не разрывается', () => {
    if (!course.modules.some((module) => module.environment === 'mixed')) return;
    expect(html).toContain('<span class="nowrap">браузер + компьютер</span>');
  });

  it('новый ученик: под «Основами» — уроки основ, как на «Сегодня»; текущий модуль — словом «Сейчас», «Не начат» не повторяется', () => {
    learner.data = learnerWith();
    const page = renderToStaticMarkup(createElement(CourseScreen, { course }));
    const basics = course.modules.filter((module) => module.part === 'basics').flatMap((module) => module.lessons.filter((lesson) => lesson.ready));
    expect(text(page)).toContain(`пройдено 0 из ${basics.length} уроков`);
    expect(page.match(/>Сейчас</g)).toHaveLength(1);
    // «Не начат» — только для скринридера, видимых бейджей с этим словом нет.
    const notStarted = page.match(/Не начат/g) ?? [];
    expect(notStarted.length).toBeGreaterThan(0);
    expect(page.match(/class="visually-hidden">, Не начат/g)).toHaveLength(notStarted.length);
  });

  it('урок пройден: под «Основами» — 1, у текущего модуля «Изучаю» вместо «Сейчас»', () => {
    learner.data = learnerWith([{ lessonId: 'm0-l1', completedAt: 2 }, { lessonId: 'm0-l2' }], 'm0-l2');
    const page = renderToStaticMarkup(createElement(CourseScreen, { course }));
    expect(text(page)).toContain('пройдено 1 из');
    expect(text(page)).toContain('Изучаю');
    expect(page).not.toMatch(/>Сейчас</);
  });
});

describe('ModuleScreen', () => {
  it('неизвестный модуль — пустое состояние с заголовком страницы h1, значком и действием', () => {
    const html = renderToStaticMarkup(createElement(ModuleScreen, { course, moduleId: 'nope' }));
    expect(html).toMatch(/<h1 class="empty-title">Модуль не найден<\/h1>/);
    expect(html).toContain('empty-icon');
    expect(html).toContain('href="#/course"');
  });

  it('номер в заголовке — шрифтом заголовка; соседний модуль — с названием, не только в title', () => {
    const html = renderToStaticMarkup(createElement(ModuleScreen, { course, moduleId: firstModule.id }));
    expect(html).toMatch(new RegExp(`<h1><span class="module-h1-num">Модуль ${firstModule.number} ·</span>`));
    const next = course.modules[1];
    expect(html).toContain(`<span class="module-pager-title">${next.title}</span>`);
    expect(html).not.toMatch(/module-pager[^>]*title=/);
  });

  it('главное действие: «Начать урок» у нового ученика, «Продолжить урок» у начатого текущего', () => {
    const [first, second] = firstFile.lessons;
    learner.data = learnerWith();
    let html = renderToStaticMarkup(createElement(ModuleScreen, { course, moduleId: firstModule.id }));
    expect(html).toMatch(new RegExp(`class="btn btn-primary btn-sm" href="#/lesson/${first.id}"><span>Начать урок ${first.number}</span>`));

    learner.data = learnerWith([{ lessonId: first.id, completedAt: 2 }, { lessonId: second.id }], second.id);
    html = renderToStaticMarkup(createElement(ModuleScreen, { course, moduleId: firstModule.id }));
    expect(html).toMatch(new RegExp(`class="btn btn-primary btn-sm" href="#/lesson/${second.id}"><span>Продолжить урок ${second.number}</span>`));
    // Ряд урока без aria-label: имя ссылки — видимый текст с номером, временем и счётом заданий.
    expect(html).not.toMatch(/class="row cmap-row"[^>]*aria-label=/);
    expect(text(html)).toContain(`Урок ${first.number}. ${first.title}`);
  });

  it('описание навыка видно под названием (не только во всплывающей подсказке)', () => {
    const skill = course.skills.find((item) => item.module === firstModule.id);
    if (!skill) return;
    learner.data = learnerWith();
    const html = renderToStaticMarkup(createElement(ModuleScreen, { course, moduleId: firstModule.id }));
    expect(html).toContain(`<span class="module-skill-text">${skill.description}</span>`);
  });

  it('модуль: зачем (содержание курса), уроки-ссылки, результат и критерий завершения', () => {
    const module = course.modules[0];
    const html = renderToStaticMarkup(createElement(ModuleScreen, { course, moduleId: module.id }));
    expect(html).toMatch(/<h1[^>]*>/);
    expect(text(html)).toContain(module.title);
    expect(text(html)).toContain(text(module.why));
    for (const lesson of module.lessons.filter((item) => item.ready)) expect(html).toContain(`href="#/lesson/${lesson.id}"`);
    // Боковые секции — метки панели из одного слова со значком, как у «Сегодня» и «Прогресса».
    expect(html).toMatch(/<h2 class="plabel" id="outcomes-title"><svg[^>]*>.*?<\/svg>Результат<\/h2>/);
    expect(html).toMatch(/<h2 class="plabel" id="completion-title"><svg[^>]*>.*?<\/svg>Завершение<\/h2>/);
    for (const item of module.outcomes) expect(text(html)).toContain(text(item));
    expect(text(html)).toContain(text(module.completion));
    expect(text(html)).toContain('Типичные ошибки');
    expectNoExplanations(html);
  });
});

describe('ProjectsScreen', () => {
  const third = course.projects[2];
  const html = renderToStaticMarkup(createElement(ProjectsScreen, { course, projectId: third.id }));

  it('шапка списка — метка панели h1 «Проекты», как у «Направлений»; без счёта «Готово 0 / 4»', () => {
    expect(html).toMatch(/<div class="pane-head projects-head"><h1 class="plabel">/);
    expect(text(html)).toContain('Проекты');
    expect(text(html)).not.toMatch(/Готово \d/);
  });

  it('лестница — ряды .lesson-row (e2e телефона кликает третий), выбранный отмечен aria-current', () => {
    expect(html.match(/class="row lesson-row project-row"/g)).toHaveLength(course.projects.length);
    expect(html).toMatch(new RegExp(`href="#/projects/${third.id}" aria-current="true"`));
    expect(html).toContain('aria-label="Лестница проектов"');
  });

  it('документ проекта: заголовок для фокуса, этапы «Отмечаешь сам», поле «Мои решения» без подсказки-абзаца', () => {
    expect(html).toMatch(/<h2 id="project-title" tabindex="-1">/);
    expect(text(html)).toContain(third.title);
    expect(text(html)).toContain('Отмечаешь сам');
    expect(html.match(/type="checkbox"/g)).toHaveLength(third.stages.length);
    expect(html).toContain('placeholder="План, структуры данных, что пришлось поменять"');
    expectNoExplanations(html);
  });
});
