// «Направления» и «Прогресс»: разметка, на которую опираются e2e, и правки пользователя к редизайну
// (нет поясняющих абзацев, честные пометки рынка — коротко, статусы — значком и словом, без процентов).
// Рендер без хранилища: данные подставляет тест.

import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Course, ModuleFile } from '../content/schema.ts';
import type { LearnerData } from '../progress/useLearnerData.ts';
import { DEFAULT_SETTINGS, type ExerciseRecord, type InterestRecord, type MarketDataset, type Settings } from '../storage/types.ts';
import { DirectionsScreen } from './DirectionsScreen.tsx';
import { ProgressScreen } from './ProgressScreen.tsx';

// Данные экранов подставляются тестом: отметки интересов, обзоры рынка, сеть, настройки, данные ученика.
const state = vi.hoisted(() => ({
  interests: [] as InterestRecord[],
  market: [] as MarketDataset[],
  online: true,
  settings: null as Settings | null,
  learner: null as LearnerData | null,
  wide: true,
}));
vi.mock('../storage/repo.ts', () => ({
  getInterests: function getInterests() {
    return Promise.resolve(state.interests);
  },
  getMarketDatasets: function getMarketDatasets() {
    return Promise.resolve(state.market);
  },
  saveInterest: () => Promise.resolve(),
}));
vi.mock('../app/hooks.ts', () => ({
  // Загрузка уже завершена: отметки и обзоры — из теста (по имени функции загрузки).
  useAsync: (load: () => Promise<unknown>) => ({
    value: load.name === 'getInterests' ? state.interests : state.market,
    error: null,
    loading: false,
  }),
  useDataVersion: () => 0,
  useOnline: () => state.online,
  useSettings: () => state.settings ?? DEFAULT_SETTINGS,
  useMediaQuery: () => state.wide,
}));
vi.mock('../progress/useLearnerData.ts', () => ({ useLearnerData: () => ({ data: state.learner, error: null }) }));

// Карта курса, модуль 0 и готовый обзор рынка — из собранных материалов (только чтение, числа не зашиваем).
const course = JSON.parse(readFileSync(new URL('../../public/content/course.json', import.meta.url), 'utf8')) as Course;
const firstModule = course.modules[0];
const firstFile = JSON.parse(readFileSync(new URL(`../../public/${firstModule.file}`, import.meta.url), 'utf8')) as ModuleFile;
const review = JSON.parse(readFileSync(new URL('../../public/market/international-freelance-usd.json', import.meta.url), 'utf8')) as Omit<
  MarketDataset,
  'id' | 'importedAt'
>;
const dataset: MarketDataset = { ...review, id: 'international-freelance-usd', importedAt: 1 };

beforeEach(() => {
  // Даты проверки источников сравниваются с «сегодня»: время теста фиксировано.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-05T10:00:00'));
});

afterEach(() => {
  vi.useRealTimers();
  state.interests = [];
  state.market = [];
  state.online = true;
  state.settings = null;
  state.learner = null;
  state.wide = true;
});

/** Текст разметки без тегов — то, что прочитает человек или экранный диктор. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Фразы-пояснения, убранные с этих экранов (раздел 5.4 спецификации редизайна).
const REMOVED = [
  'решать, кем стать, пока не нужно',
  'история-пример: придумана',
  'имеет смысл после модуля',
  'показаны записи всех рынков',
  'ещё не выбраны',
  'до налогов и комиссий',
  'нет сети — показан',
  'суммы одного рынка нельзя переносить',
  'приложение не придумывает',
  'ни один курс и ни один заказ',
  'интерес хранится отдельно',
  'ответь на три вопроса',
  'после пробы отметь',
  'навык считается освоенным',
  'освоение подтверждают твои отметки',
  'здесь соберутся',
  'они появятся, если',
  'пропуски — это нормально',
  'интерес не влияет на навыки',
  'отметь интересные направления',
  'можно передать наставнику',
];

function expectNoExplanations(html: string) {
  const plain = text(html).toLowerCase();
  for (const phrase of REMOVED) expect(plain).not.toContain(phrase);
  expect(html).not.toContain('page-lead');
}

function directions(labId: string | null = 'automation') {
  return renderToStaticMarkup(createElement(DirectionsScreen, { course, labId }));
}

function interest(record: Partial<InterestRecord>): InterestRecord {
  return { labId: 'automation', status: 'curious', liked: '', tiring: '', continue: null, updatedAt: 1, ...record };
}

describe('DirectionsScreen', () => {
  it('список — ссылки .lab-card на каждое направление, выбранное — aria-current; счётчик «10 из 10»', () => {
    const html = directions();
    expect(html.match(/class="row lab-card"/g)).toHaveLength(course.labs.length);
    for (const lab of course.labs) expect(html).toContain(`href="#/directions/${lab.id}"`);
    expect(html.match(/aria-current="true"/g)).toHaveLength(1);
    expect(html).toMatch(/href="#\/directions\/automation" aria-current="true"/);
    expect(text(html)).toContain(`${course.labs.length} из ${course.labs.length}`);
    expect(html).toContain('aria-label="Поиск направления"');
    expectNoExplanations(html);
  });

  it('документ: section#lab-detail, фокусируемый h2#lab-title, «после модуля» — словами, номер — числом', () => {
    const html = directions();
    expect(html).toMatch(/<section id="lab-detail"[^>]*aria-labelledby="lab-title"/);
    expect(html).toMatch(/<h2 id="lab-title" tabindex="-1">/);
    const lab = course.labs.find((item) => item.id === 'automation')!;
    const unlock = course.modules.find((module) => module.id === lab.unlockAfter);
    if (unlock) expect(html).toContain(`после модуля <span class="n">${unlock.number}</span>`);
    // Пометка «вымышленная» — короткой меткой, не фразой.
    if (lab.story.fictional) expect(text(html)).toContain('Вымышленная история');
    // «Материалы пишутся» (как у «Проектов» и «Курса») — бейдж со значком в заголовке «Первой пробы», а не ещё одна метка в шапке.
    if (!lab.ready) expect(html).toMatch(/<h3 id="lab-try-title">Первая проба<\/h3><span class="badge"><svg[^>]*>.*?<\/svg>Материалы пишутся/);
    // На узком экране от документа можно вернуться к списку.
    expect(html).toMatch(/class="btn btn-sm btn-ghost dir-back"><svg[^>]*>.*?<\/svg>К списку<\/button>/);
  });

  it('рынок без данных: «Регион и валюта не выбраны», «Данные ещё не загружены» и один вход в настройки рынка', () => {
    const html = directions();
    expect(text(html)).toContain('Регион и валюта не выбраны');
    expect(text(html)).toContain('Данные ещё не загружены');
    // «Загрузить обзор» — единственная ссылка в настройки рынка («Выбрать» вела бы туда же).
    expect(html.match(/href="#\/settings\/market"/g)).toHaveLength(1);
    expect(text(html)).toContain('Загрузить обзор');
    expect(text(html)).not.toContain('Выбрать');
    expect(html).not.toContain('market-table');
  });

  it('обзоры есть, регион не выбран: «Выбрать» рядом с «Работой и заказами»', () => {
    state.market = [dataset];
    const html = directions('web');
    expect(text(html)).toContain('Все рынки · регион не выбран');
    expect(html).toMatch(/<a class="btn btn-sm" href="#\/settings\/market">Выбрать<\/a>/);
  });

  it('рынок с обзором: «Рынок: X, USD», у каждой суммы вид, «до налогов», ссылка на источник и дата проверки', () => {
    state.market = [dataset];
    state.settings = { ...DEFAULT_SETTINGS, market: { region: dataset.region, currency: dataset.currency } };
    const html = directions('web');
    expect(text(html)).toContain(`Рынок: ${dataset.region}, ${dataset.currency}`);
    const rows = html.split('<tr>').slice(2);
    const entries = dataset.entries.filter((entry) => entry.lab === 'web');
    expect(rows).toHaveLength(entries.length);
    // Сумма и валюта не разрываются: между ними неразрывный пробел.
    expect(html).toMatch(/<span class="mt-amount"><span class="n">[\d\u00a0–]+<\/span>\u00a0USD<\/span>/);
    // «Подробнее об источнике» — кнопка под источником; заметка — отдельной скрытой строкой на всю ширину таблицы.
    const withNote = entries.filter((entry) => entry.note.trim()).length;
    expect(html.match(/<button type="button" class="mt-note-toggle" aria-expanded="false" aria-controls="[^"]+">/g) ?? []).toHaveLength(withNote);
    expect(html.match(/<tr class="mt-note-row" id="[^"]+" hidden=""><td colSpan="4">/gi) ?? []).toHaveLength(withNote);
    if (withNote > 0) expect(text(html)).toContain('Подробнее об источнике');
    for (const row of rows) {
      expect(row).toMatch(/href="https?:\/\//);
      expect(text(row)).toMatch(/объявление, не выплата|опрос, со слов участников|статистика выплат|подтверждённая оплата/);
      expect(text(row)).toContain('до налогов');
      expect(text(row)).toContain('проверено');
      // Дата проверки — с годом, словами, как везде в приложении, без «г.»: «26 сентября 2026».
      expect(row).toMatch(/проверено <time datetime="[\d-]+" class="nowrap">\d+ [а-я]+ \d{4}<\/time>/i);
    }
    // У ячеек таблицы есть подписи для узкой раскладки (строки-карточки).
    expect(html).toContain('data-label="Сумма"');
    expect(html).toContain('data-label="Источник"');
    expect(html).not.toContain('могло устареть');
    expectNoExplanations(html);
  });

  it('старый обзор — «могло устареть» со значком; без сети — метка «Без сети · сохранённый обзор»', () => {
    vi.setSystemTime(new Date('2026-12-01T10:00:00'));
    state.market = [dataset];
    state.online = false;
    const html = directions('web');
    expect(html).toMatch(/class="mt-stale"><svg[^>]*>.*?<\/svg>могло устареть/);
    expect(text(html)).toContain('Без сети · сохранённый обзор');
    // Регион не выбран — показаны все записи, и это сказано коротко.
    expect(text(html)).toContain('Все рынки · регион не выбран');
  });

  it('карта интересов: точные метки полей, ответ «Хочется продолжить?» — радиогруппой, «Сохранить» выключена без изменений', () => {
    const html = directions();
    expect(text(html)).toContain('Что понравилось?');
    expect(text(html)).toContain('Что утомило или показалось скучным?');
    expect(html).toContain('role="radiogroup"');
    expect(html).toMatch(/<button type="button" class="btn btn-primary" disabled="">Сохранить<\/button>/);
    // До сохранения бейджа «Сохранено» нет (e2e ищет ровно один).
    expect(text(html)).not.toContain('Сохранено');
  });

  it('«Интересно, хочу попробовать» — одна кнопка, в шапке документа, а не внизу у вопросов', () => {
    const html = directions();
    expect(text(html).match(/Интересно, хочу попробовать/g)).toHaveLength(1);
    const head = html.slice(html.indexOf('<header class="dir-head">'), html.indexOf('</header>'));
    expect(head).toMatch(/<div class="dir-head-mark" tabindex="-1"><button type="button" class="btn"><svg[^>]*>.*?<\/svg>Интересно, хочу попробовать<\/button>/);
  });

  it('отметка интереса: бейдж «Интересно» со значком в шапке документа и у выбранного ряда', () => {
    state.interests = [interest({ continue: 'yes', liked: 'Боты' })];
    const html = directions();
    expect(text(html)).not.toContain('Интересно, хочу попробовать');
    expect(text(html)).not.toContain('Отмечено');
    const head = html.slice(html.indexOf('<header class="dir-head">'), html.indexOf('</header>'));
    expect(head).toMatch(/class="badge badge-accent"><svg[^>]*>.*?<\/svg>Интересно<\/span>/);
    const selected = html.slice(html.indexOf('aria-current="true"'), html.indexOf('</a>', html.indexOf('aria-current="true"')));
    expect(selected).toMatch(/class="badge badge-accent"><svg[^>]*>.*?<\/svg>Интересно/);
    expect(html).toContain('>Боты</textarea>');
  });

  it('после пробы — бейдж «Пробовал»', () => {
    state.interests = [interest({ status: 'tried' })];
    const head = directions().slice(0, directions().indexOf('</header>'));
    expect(head).toMatch(/class="badge badge-accent"><svg[^>]*>.*?<\/svg>Пробовал<\/span>/);
  });
});

// ------------------------------------------------------------ «Прогресс»

const day = 24 * 3600 * 1000;
const now = new Date('2026-10-05T10:00:00').getTime();
const firstLesson = firstFile.lessons[0];
const firstExercises = firstLesson.steps.flatMap((step) => (step.type === 'exercise' ? [step.exercise] : []));

function exerciseRecord(exerciseId: string, help: 0 | 1 | 2 | 3 | 4 | null): ExerciseRecord {
  return {
    exerciseId,
    lessonId: firstLesson.id,
    draft: null,
    draftUpdatedAt: null,
    status: help === null ? 'attempted' : 'passed',
    checks: 2,
    runs: 0,
    hintsShown: 0,
    solutionViewed: help === 4,
    firstPassedAt: help === null ? null : now - 2 * day,
    firstPassHelp: help,
    lastCheckAt: now - 2 * day,
    updatedAt: now - 2 * day,
  };
}

function learner(options: Partial<LearnerData> = {}): LearnerData {
  return {
    files: new Map([[firstModule.id, firstFile]]),
    unavailable: [],
    lessons: new Map(),
    exercises: new Map(),
    reviews: [],
    attempts: [],
    activity: [],
    interests: new Map(),
    projects: new Map(),
    market: [],
    meta: { currentLessonId: null, lastOpenedAt: null, firstActivityAt: null },
    ...options,
  };
}

function progress() {
  return renderToStaticMarkup(createElement(ProgressScreen, { course }));
}

describe('ProgressScreen', () => {
  it('новый ученик: h1 без вводного абзаца, текущий модуль раскрыт, остальные без попыток свёрнуты, пустые секции — коротко', () => {
    const second = course.modules[1];
    state.learner = learner({ files: new Map([[firstModule.id, firstFile], [second.id, { ...firstFile, id: second.id }]]) });
    const html = progress();
    expect(html).toMatch(/<h1>Что ты уже умеешь<\/h1>/);
    // Модуль, где идёт ученик, — секцией с навыками («освоено 0 из N»), даже без попыток.
    expect(html).toContain(`<h2 id="skills-${firstModule.id}">Модуль ${firstModule.number} · ${firstModule.title}</h2>`);
    expect(text(html)).toMatch(/освоено 0 из \d+/);
    expect(text(html)).toContain('Ещё не было попыток');
    // Следующий модуль свёрнут; «· не начат» не отрывается от названия.
    expect(html).toMatch(/<details class="disclosure prog-module-closed"/);
    expect(text(html)).toContain(`Модуль ${second.number} · ${second.title} · не начат`);
    expect(html).toMatch(/<span class="prog-closed-st">·\u00a0не начат<\/span>/);
    expect(text(html)).toContain('Пока нет');
    expect(text(html)).toContain('Повторений нет');
    expect(text(html)).toContain('За 14 дней: 0 мин');
    expect(text(html)).toContain('Пока пусто');
    expect(html).toContain('href="#/directions"');
    expectNoExplanations(html);
  });

  it('с данными: доказательства навыка с помощью и датой, ошибки по частоте, повторение «сегодня», интересы', () => {
    const [first, second] = firstExercises;
    state.learner = learner({
      exercises: new Map([
        [first.id, exerciseRecord(first.id, 0)],
        ...(second ? [[second.id, exerciseRecord(second.id, 4)] as const] : []),
      ]),
      attempts: [0, 1, 2].map((index) => ({
        key: `${first.id}:${index}`,
        exerciseId: first.id,
        lessonId: firstLesson.id,
        at: now - day - index,
        kind: 'check' as const,
        passed: false,
        errorType: 'NameError',
        failed: 1,
        total: 1,
      })),
      reviews: [
        { key: 'r1', lessonId: firstLesson.id, exerciseId: first.id, stage: 0, dueAt: now - 3600_000, reason: 'Решено после просмотра решения', createdAt: 1, updatedAt: 1, doneAt: null },
      ],
      activity: [{ date: '2026-10-04', activeMs: 25 * 60_000 }],
      interests: new Map([['data', interest({ labId: 'data', status: 'tried', continue: 'yes' })]]),
    });
    const html = progress();
    expect(text(html)).toContain(`«${first.title}» — сам`);
    // Тире не начинает строку, «сам (дата)» не разрывается.
    expect(html).toMatch(/»\u00a0— <span class="nowrap">сам \(\d+\s[а-я]+\)<\/span>/);
    expect(text(html)).toMatch(/Неизвестное имя \(NameError\) 3 раза · 4 октября/);
    // Ряд плана повторения — к шагу задания, с номером урока, как на «Сегодня».
    const step = firstLesson.steps.findIndex((item) => item.type === 'exercise' && item.exercise.id === first.id) + 1;
    expect(text(html)).toContain(`${firstLesson.number} ${first.title} Решено после просмотра решения сегодня`);
    expect(html).toContain(`href="#/lesson/${firstLesson.id}/${step}"`);
    expect(text(html)).toContain('За 14 дней: 25 мин');
    expect(html).toMatch(/role="img" aria-label="Минуты занятий по дням: [^"]*4 октября — 25/);
    // Шкала: подпись максимума (не меньше 30 минут) над пунктиром.
    expect(html).toMatch(/<span class="activity-scale" aria-hidden="true"><span class="n">30<\/span> мин<\/span>/);
    expect(text(html)).toContain('пробовал · продолжить: да');
    // Ряды-ссылки (план повторения, интересы) — со стрелкой; ряды ошибок — без неё.
    expect(html.match(/<a class="row prog-row"[^>]*>.*?<\/a>/g)?.every((row) => row.includes('lucide-chevron-right'))).toBe(true);
    expect(html).not.toMatch(/<div class="row prog-row">(?:(?!<\/div>).)*lucide-chevron-right/);
    // Модуль с попытками раскрыт секцией со счётом освоенного; статусы навыков — бейдж со значком.
    expect(html).toMatch(/<section class="prog-module"/);
    expect(text(html)).toMatch(/освоено \d+ из \d+/);
    expect(html).toMatch(/class="badge badge-[a-z]+"><svg/);
    // Без декоративных процентов.
    expect(text(html)).not.toMatch(/\d\s*%/);
    expectNoExplanations(html);
  });

  it('карточка ученика — блок-«файл» student-card.md с копированием и скачиванием; текст экспорта прежний', () => {
    state.learner = learner();
    const html = progress();
    expect(text(html)).toContain('student-card.md');
    expect(text(html)).toContain('Скопировать');
    expect(text(html)).toContain('Скачать .md');
    expect(html).toMatch(/<pre class="prog-file-body" tabindex="0" aria-label="Текст карточки ученика"># Карточка ученика «Практики»/);
    expect(text(html)).toContain('## Освоенные навыки (с доказательствами)');
    // Подписи кнопок — отдельным элементом (на узком телефоне — только значки), статус копирования — для скринридера.
    expect(html).toMatch(/title="Скопировать"><svg[^>]*>.*?<\/svg><span class="prog-btn-text">Скопировать<\/span>/);
    expect(html).toMatch(/<span class="visually-hidden" role="status"><\/span>/);
  });

  it('карточка ученика: на ПК — под навыками, в одну колонку — после боковой панели', () => {
    state.learner = learner();
    const wide = progress();
    expect(wide.indexOf('id="card-title"')).toBeLessThan(wide.indexOf('<aside'));
    state.wide = false;
    const narrow = progress();
    expect(narrow.indexOf('id="card-title"')).toBeGreaterThan(narrow.indexOf('</aside>'));
    expect(narrow).toContain('<div class="page prog-page prog-card-end"><section class="prog-card"');
    expect(narrow.match(/id="card-title"/g)).toHaveLength(1);
    expect(narrow).toContain('<aside class="prog-side" aria-label="Ошибки, повторение, время и интересы">');
  });
});
