// «Настройки», «Работа без сети» и экран ошибки: разметка, на которую опираются e2e, и правки пользователя к редизайну
// (нет поясняющих абзацев, честные пометки — коротко, статусы — значком и словом).
// Рендер без хранилища и без браузера: данные и состояние Cache Storage подставляет тест.

import { readFileSync } from 'node:fs';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScreenErrorBoundary } from '../app/ErrorBoundary.tsx';
import { CoachAccessError, CoachEndpointError, CoachUnavailableError } from '../coach/ai-client.ts';
import type { Course } from '../content/schema.ts';
import type { OfflineFile, OfflineManifest } from '../pwa/offline.ts';
import type { BackupInfo } from '../storage/transfer.ts';
import { DEFAULT_SETTINGS, type MarketDataset, type Settings } from '../storage/types.ts';
import { OfflineModuleControl, OfflineOverview, refreshOffline } from './offline-controls.tsx';
import { CheckResult, SettingsScreen, type CoachCheck } from './SettingsScreen.tsx';

// Экран показывает версию, которую подставляет сборка (src/vite-env.d.ts; тесты собираются без него).
declare global {
  const __APP_VERSION__: string;
}

const state = vi.hoisted(() => ({
  settings: null as Settings | null,
  backups: [] as unknown[],
  market: [] as unknown[],
  bundled: [] as unknown[],
  online: true,
  offline: {
    supported: false,
    manifest: null as unknown,
    /** Файлы в Cache Storage: имя кеша → адреса (как в манифесте, без «/» в начале). */
    cached: {} as Record<string, string[]>,
  },
}));

vi.mock('../app/hooks.ts', () => ({
  initSettings: () => Promise.resolve(),
  updateSettings: () => Promise.resolve(),
  // Загрузка уже завершена: данные — из теста (по имени функции загрузки; список готовых обзоров — безымянный).
  useAsync: (load: () => Promise<unknown>) => ({
    value: { listBackups: state.backups, getMarketDatasets: state.market, storageEstimate: { usage: 73_728, quota: 1e9 } }[load.name] ?? state.bundled,
    error: null,
    loading: false,
  }),
  useDataVersion: () => 0,
  useOnline: () => state.online,
  useRunnerState: () => ({ phase: 'idle' }),
  useSettings: () => state.settings ?? DEFAULT_SETTINGS,
  useSettingsEpoch: () => 0,
}));
vi.mock('../storage/transfer.ts', () => ({
  applyImport: () => Promise.resolve(),
  exportAll: () => Promise.resolve({}),
  listBackups: function listBackups() {
    return Promise.resolve(state.backups);
  },
  parseImport: () => ({ ok: false, message: '' }),
  resetAll: () => Promise.resolve(),
  restoreBackup: () => Promise.resolve(),
}));
vi.mock('../storage/repo.ts', () => ({
  deleteMarketDataset: () => Promise.resolve(),
  getMarketDatasets: function getMarketDatasets() {
    return Promise.resolve(state.market);
  },
  saveMarketDataset: () => Promise.resolve(),
}));
vi.mock('../storage/persist.ts', () => ({
  isStoragePersisted: () => Promise.resolve(false),
  requestPersistentStorage: () => Promise.resolve('denied'),
  storageEstimate: function storageEstimate() {
    return Promise.resolve({ usage: 73_728, quota: 1e9 });
  },
}));
vi.mock('../pwa/register.ts', () => ({ useUpdateState: () => ({ supported: false, controlled: false, updateReady: false, reloadNeeded: false }) }));
// Офлайн-режим собранной версии: манифест и содержимое кеша — из теста.
vi.mock('../pwa/offline.ts', async (importActual) => {
  const actual = await importActual<typeof import('../pwa/offline.ts')>();
  return {
    CONTENT_CACHE: actual.CONTENT_CACHE,
    formatBytes: actual.formatBytes,
    offlineSupported: () => state.offline.supported,
    loadOfflineManifest: () => Promise.resolve(state.offline.supported ? state.offline.manifest : null),
    bundleStatus: (cache: string, files: OfflineFile[]) => {
      const cached = files.filter((file) => (state.offline.cached[cache] ?? []).includes(file.url));
      return Promise.resolve({
        bytesTotal: files.reduce((sum, file) => sum + file.bytes, 0),
        bytesCached: cached.reduce((sum, file) => sum + file.bytes, 0),
        filesTotal: files.length,
        filesCached: cached.length,
        complete: files.length > 0 && cached.length === files.length,
      });
    },
    downloadBundle: () => Promise.resolve(),
    removeBundle: () => Promise.resolve(),
  };
});

const course = JSON.parse(readFileSync(new URL('../../public/content/course.json', import.meta.url), 'utf8')) as Course;
const bundled = JSON.parse(readFileSync(new URL('../../public/market/index.json', import.meta.url), 'utf8')) as {
  title: string;
  checkedAt: string;
}[];

const PYTHON_CACHE = 'praktika-python-test';
const MANIFEST: OfflineManifest = {
  buildId: 'test',
  shell: { cache: 'praktika-shell-test', files: 40, bytes: 2_000_000 },
  python: {
    cache: PYTHON_CACHE,
    version: '314.0.7',
    bytes: 13_002_000,
    files: [
      { url: 'pyodide/pyodide.asm.wasm', bytes: 10_900_000 },
      { url: 'pyodide/python_stdlib.zip', bytes: 2_102_000 },
    ],
  },
  modules: {
    m0: { url: 'content/modules/m0.aaa111.json', bytes: 184_320 },
    m1: { url: 'content/modules/m1.bbb222.json', bytes: 221_184 },
  },
};
const OFFLINE_MODULES = [
  { id: 'm0', title: 'Что такое программа', number: 0 },
  { id: 'm1', title: 'Значения и переменные', number: 1 },
];

beforeEach(() => {
  // Даты копий и обзоров — в местном времени; адреса кеша строятся от window.location.
  vi.stubGlobal('__APP_VERSION__', '0.1.0');
  vi.stubGlobal('window', { location: { origin: 'http://localhost', hash: '#/settings' } });
  vi.stubGlobal('caches', {
    open: (name: string) =>
      Promise.resolve({
        keys: () => Promise.resolve((state.offline.cached[name] ?? []).map((url) => ({ url: `http://localhost/${url}` }))),
        delete: () => Promise.resolve(true),
      }),
  });
  state.bundled = bundled;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  state.settings = null;
  state.backups = [];
  state.market = [];
  state.online = true;
  state.offline = { supported: false, manifest: null, cached: {} };
  await refreshOffline();
});

/** Текст разметки без тегов — то, что прочитает человек или экранный диктор. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Кусок разметки от элемента с этим id до следующего раздела настроек. */
function section(html: string, id: string): string {
  const start = html.indexOf(`id="settings-${id}"`);
  expect(start).toBeGreaterThan(-1);
  const next = html.indexOf('<section', start + 1);
  return html.slice(start, next === -1 ? undefined : next);
}

/** Ряды «Работы без сети» по порядку (класс bundle-row — на нём e2e). */
function bundleRows(html: string): string[] {
  return html.split('class="setting-row bundle-row"').slice(1);
}

function renderSettings(settings: Partial<Settings> = {}): string {
  state.settings = { ...DEFAULT_SETTINGS, ...settings };
  return renderToStaticMarkup(createElement(SettingsScreen, { course, section: null }));
}

// Поясняющие тексты, убранные с экрана (раздел 5.5 спецификации редизайна и правка пользователя 1).
const REMOVED = [
  'всё хранится на этом устройстве',
  'размер основного текста',
  'размер в редакторе',
  'можно скачать заранее',
  'переносится файлом',
  'нужен для раздела',
  'браузер решает сам',
  'сохраняй резервн',
  'файл json со всем прогрессом',
  'перенос с другого устройства',
  'создаются автоматически',
  'начать курс заново',
  'лучшие результаты из обоих',
  'подсказки курса работают всегда',
  'заранее написаны',
  'сохраняются автоматически',
  'docs/coach.md',
  'собраны из открытых источников',
  'praktika-market',
  'смотри раздел',
  'нужна собранная версия',
  'npm start',
  'означает, что файлы',
  'один раз для всех модулей',
  'нужен для запуска кода',
  'проверь сеть и попробуй',
  'включая python',
];

describe('Настройки', () => {
  it('разделы с адресами для оглавления, баннеров и e2e; без вводных абзацев', () => {
    const html = renderSettings();
    for (const id of ['appearance', 'offline', 'data', 'coach', 'market', 'about']) {
      expect(html).toContain(`id="settings-${id}"`);
      expect(html).toContain(`href="#/settings/${id}"`);
    }
    expect(html).toContain('aria-label="Разделы настроек"');
    expect(html).toMatch(/<h1>Настройки<\/h1>/);
    // Оглавление (≥ 1200 — колонкой, уже — полосой разделов сверху), затем своя область прокрутки с заголовком
    // и разделами: под полосу ничего не заходит.
    const body = html.indexOf('<div class="settings-body" id="settings-body">');
    expect(html.indexOf('aria-label="Разделы настроек"')).toBeLessThan(body);
    expect(body).toBeLessThan(html.indexOf('<h1>'));
    expect(html.indexOf('<h1>')).toBeLessThan(html.indexOf('id="settings-appearance"'));
    expect(html).not.toContain('page-lead');
    expect(html).not.toContain('eyebrow');
    const words = text(html).toLowerCase();
    for (const phrase of REMOVED) expect(words, phrase).not.toContain(phrase);
  });

  it('оформление: тема и размеры — переключатели с выбранным значением', () => {
    const html = section(renderSettings({ theme: 'dark', codeFontSize: 16 }), 'appearance');
    expect(html).toMatch(/role="radio" aria-checked="true"[^>]*>Тёмная</);
    expect(html).toMatch(/role="radio" aria-checked="false"[^>]*>Как в системе</);
    expect(html).toMatch(/role="radio" aria-checked="true"[^>]*>16</);
    // Группы подписаны своими метками (aria-labelledby), а не повтором слова.
    expect(html.match(/role="radiogroup" aria-labelledby="/g)).toHaveLength(3);
    expect(html).toContain('aria-label="Пример кода"');
    // У текста урока — образец выбранным кеглем, без подписи «Пример».
    expect(html).toMatch(/<p class="prose settings-sample" aria-hidden="true">[^<]+<\/p>/);
  });

  it('прогресс и копии: экспорт, импорт файлом, сброс с предупреждением; пустой список копий — коротко', () => {
    const html = section(renderSettings(), 'data');
    const words = text(html);
    // Нейтральная метка, а не второе предупреждение подряд (тревожная строка — у «Хранилища»).
    expect(html).toMatch(/<span class="tag settings-lead"><svg[^]*?<\/svg>Прогресс — только на этом устройстве<\/span>/);
    expect(words).not.toContain('Очистка данных браузера');
    expect(words).toContain('Сохранить в файл');
    expect(words).toContain('Выбрать файл');
    expect(html).toMatch(/<input type="file" accept="application\/json,\.json" hidden=""/);
    expect(words).toContain('Резервные копии Пока нет');
    expect(words).toContain('Сбросить прогресс');
    // Диалог сброса — предупреждение перед необратимым действием (e2e ищет эту фразу).
    expect(words).toContain('Настройки тоже вернутся к исходным');
  });

  it('резервная копия — строкой с датой, временем и причиной и кнопкой «Восстановить»', () => {
    state.backups = [{ id: 'b1', createdAt: new Date(2026, 8, 26, 10, 0).getTime(), reason: 'перед импортом' } as unknown as BackupInfo];
    const words = text(section(renderSettings(), 'data'));
    expect(words).toContain('26.09.2026, 10:00 · перед импортом');
    expect(words).toContain('Восстановить');
    expect(words).not.toContain('Пока нет');
  });

  it('наставник: подсказки курса — честная пометка одной строкой, полей сервера нет', () => {
    const html = section(renderSettings(), 'coach');
    expect(html).toMatch(/role="radio" aria-checked="true"[^>]*>Подсказки курса</);
    expect(text(html)).toContain('Не ИИ · работают без сети');
    expect(html).not.toContain('Адрес сервера');
  });

  it('наставник через сервер: подписанные поля, пометка о платных запросах; без токена — без предупреждения', () => {
    const html = section(renderSettings({ coach: { mode: 'ai', endpoint: '', accessToken: '' } }), 'coach');
    const words = text(html);
    expect(words).toContain('Только по кнопке · каждый запрос платный');
    // Поле «Адрес сервера» связано с подписью (e2e: getByLabel), подсказка адреса — плейсхолдером.
    const endpoint = html.match(/<label for="([^"]+)"[^>]*>Адрес сервера<\/label>/);
    expect(endpoint).not.toBeNull();
    expect(html).toContain(`id="${endpoint![1]}"`);
    expect(html).toContain('placeholder="http://127.0.0.1:8787"');
    const token = html.match(/<label for="([^"]+)"[^>]*>Токен доступа<\/label>/);
    expect(token).not.toBeNull();
    expect(html).toMatch(new RegExp(`type="password"[^>]*aria-describedby="${token![1]}-hint"`));
    expect(words).toContain('Токен своего сервера, не ключ ИИ');
    expect(words).not.toContain('Пока токен указан');
    // e2e ищет итог проверки как #settings-coach .notice — до проверки сообщений нет.
    expect(html).not.toContain('class="notice');
    expect(words).toContain('Проверить соединение');
  });

  it('токен указан: предупреждение о чужом коде — сообщением, связано с полем', () => {
    const html = section(renderSettings({ coach: { mode: 'ai', endpoint: '', accessToken: 'secret' } }), 'coach');
    const token = html.match(/<label for="([^"]+)"[^>]*>Токен доступа<\/label>/)![1];
    expect(html).toMatch(new RegExp(`type="password"[^>]*aria-describedby="${token}-hint ${token}-risk"`));
    expect(html).toMatch(new RegExp(`id="${token}-risk"[^>]*><div class="notice notice-warn"`));
    expect(text(html)).toContain('Пока токен указан, не запускай чужой код: коду доступны данные приложения');
  });

  it('рынок труда: готовый обзор — «Загрузить», после загрузки — бейдж «Загружен» со значком', () => {
    let html = section(renderSettings(), 'market');
    expect(text(html)).toContain(bundled[0].title);
    expect(text(html)).toMatch(/\d+ запис(ь|и|ей) · проверено \d+ \S+ \d{4}/);
    expect(text(html)).toContain('Загрузить');
    expect(text(html)).toContain('Данные ещё не загружены');

    const dataset = { id: 'd1', title: bundled[0].title, checkedAt: bundled[0].checkedAt, region: 'Международный фриланс', currency: 'USD', entries: [] };
    state.market = [dataset as unknown as MarketDataset];
    html = section(renderSettings(), 'market');
    expect(html).toMatch(/class="badge badge-ok"><svg[^]*?<\/svg>Загружен<\/span>/);
    expect(text(html)).not.toMatch(/Загрузить(?! )/);
    // Удаление — значком и словом, имя кнопки с названием обзора; подстрока — число записей и дата, не регион.
    expect(html).toMatch(new RegExp(`aria-label="Удалить обзор ${bundled[0].title}"><svg[^]*?</svg>Удалить</button>`));
    expect(text(html)).toMatch(/0 записей · проверено \d+ \S+ \d{4}/);
    expect(text(html)).not.toContain('Международный фриланс, USD ·');
    // Единичные действия ряда — обычного размера, маленькие — только в списках.
    expect(html).toMatch(/<button type="button" class="btn"><svg[^]*?<\/svg>Импортировать обзор<\/button>/);
  });

  it('о приложении: версии и честные ограничения — свёрнуты', () => {
    const html = section(renderSettings(), 'about');
    expect(text(html)).toContain('Версия приложения 0.1.0');
    expect(text(html)).toContain('Офлайн-оболочка Не сохранена');
    expect(html).toMatch(/<details class="disclosure settings-limits">/);
  });
});

describe('Работа без сети', () => {
  async function renderOffline(cached: Record<string, string[]>): Promise<string> {
    state.offline = { supported: true, manifest: MANIFEST, cached };
    await refreshOffline();
    return renderToStaticMarkup(createElement(OfflineOverview, { modules: OFFLINE_MODULES }));
  }

  it('в версии для разработки — одна строка вместо объяснений', () => {
    const words = text(renderToStaticMarkup(createElement(OfflineOverview, { modules: OFFLINE_MODULES })));
    expect(words).toBe('Python и уроки Офлайн — только в собранной версии');
  });

  it('ничего не скачано: Python — первым рядом и главной кнопкой, у модуля — свой объём и «+ Python»', async () => {
    const rows = bundleRows(await renderOffline({}));
    expect(rows).toHaveLength(3);
    expect(text(rows[0])).toContain('Python 3.14 Pyodide 314.0.7 · 12,4 МБ');
    expect(text(rows[0])).toContain('Скачать · 12,4 МБ');
    expect(rows[0]).toContain('<button type="button" class="btn btn-primary" aria-label="Скачать Python, 12,4 МБ">');
    expect(text(rows[1])).toContain('Модуль 0 · Что такое программа Уроки · 180 КБ');
    expect(text(rows[1])).toContain('Скачать модуль · 180 КБ + Python');
    // Итог вместе с Python — в имени кнопки (e2e ищет /Скачать модуль/); повторяющейся строки под кнопкой нет.
    expect(rows[1]).toContain('aria-label="Скачать модуль 0 вместе с Python, всего 12,6 МБ"');
    expect(text(rows[1])).not.toContain('включая');
    // Тот же объём на кнопке — строка под названием на телефоне прячется.
    expect(rows[1]).toContain('class="setting-hint offline-size"');
  });

  it('уроки скачаны, Python нет — «Скачать Python»; прежняя версия уроков — «Модуль обновился» и «Скачать заново»', async () => {
    const rows = bundleRows(
      await renderOffline({ 'praktika-content': [MANIFEST.modules.m0.url, 'content/modules/m1.old000.json'] }),
    );
    expect(text(rows[1])).toContain('Без Python код офлайн не запустится');
    expect(text(rows[1])).toContain('Скачать Python · 12,4 МБ');
    expect(text(rows[1])).not.toContain('включая Python');
    expect(text(rows[2])).toContain('Модуль обновился');
    expect(text(rows[2])).toContain('Скачать заново');
    // Предупреждения — значком и словом.
    expect(rows[2]).toMatch(/class="status-line status-warn"><svg/);
  });

  it('всё скачано: «Скачан» и «Доступен без сети» бейджами со значком, удалить можно', async () => {
    const rows = bundleRows(
      await renderOffline({ [PYTHON_CACHE]: MANIFEST.python.files.map((file) => file.url), 'praktika-content': [MANIFEST.modules.m0.url] }),
    );
    expect(rows[0]).toMatch(/class="badge badge-ok"><svg[^]*?<\/svg>Скачан<\/span>/);
    // Удаление везде одной формы: значок + «Удалить», в имени кнопки — что удаляется.
    expect(rows[0]).toMatch(/aria-label="Удалить Python из офлайн-хранилища"><svg[^]*?<\/svg>Удалить<\/button>/);
    expect(rows[1]).toMatch(/class="badge badge-ok"><svg[^]*?<\/svg>Доступен без сети<\/span>/);
    expect(rows[1]).toMatch(/aria-label="Удалить уроки: модуль 0"><svg[^]*?<\/svg>Удалить<\/button>/);
    expect(rows[1]).toContain('class="setting-hint"');
    expect(text(rows[2])).toContain('Скачать модуль · 216 КБ');
    expect(text(rows[2])).not.toContain('Python');
  });

  it('без сети кнопка выключена и сказано почему', async () => {
    state.online = false;
    const rows = bundleRows(await renderOffline({}));
    expect(rows[1]).toMatch(/<button type="button" class="btn" aria-label="[^"]+" disabled="">/);
    expect(text(rows[1])).toContain('Нужна сеть');
  });

  it('в шапке модуля (compact) — только статус, без «Удалить уроки»', async () => {
    state.offline = { supported: true, manifest: MANIFEST, cached: { [PYTHON_CACHE]: MANIFEST.python.files.map((file) => file.url), 'praktika-content': [MANIFEST.modules.m0.url] } };
    await refreshOffline();
    const words = text(renderToStaticMarkup(createElement(OfflineModuleControl, { moduleId: 'm0', compact: true })));
    expect(words).toBe('Доступен без сети');
  });
});

describe('Ошибка экрана', () => {
  function renderError(error: Error): string {
    const boundary = new ScreenErrorBoundary({ resetKey: '/progress', children: null });
    boundary.state = { error };
    return renderToStaticMarkup(boundary.render() as ReactElement);
  }

  it('не загрузилась часть приложения: заголовок, одна строка и два действия', () => {
    const chunk = new TypeError('Failed to fetch dynamically imported module: /assets/ProgressScreen.js');
    const html = renderError(chunk);
    expect(html).toContain('role="alert"');
    // Другого заголовка на упавшем экране нет — этот h1.
    expect(html).toMatch(/<h1 class="empty-title">Не получилось открыть экран<\/h1>/);
    expect(text(html)).toBe('Не получилось открыть экран Прогресс на месте. Обновить страницу На главную');
    expect(html).toContain('href="#/"');
  });

  it('экран упал: подробности для разработчика — свёрнуты', () => {
    const html = renderError(new Error("Cannot read properties of undefined (reading 'skills')"));
    expect(text(html)).toContain('На этом экране что-то пошло не так Прогресс на месте.');
    expect(html).toMatch(/<details class="disclosure screen-error-details">/);
    expect(text(html)).toContain("Подробности для разработчика Cannot read properties of undefined (reading 'skills')");
  });
});

describe('Проверка соединения с наставником', () => {
  const render = (check: CoachCheck) => renderToStaticMarkup(createElement(CheckResult, { check }));

  it('сервер не запущен: короткий заголовок и адрес, текст адаптера — свёрнут в «Подробностях»', () => {
    const error = new CoachUnavailableError(
      'Сервер наставника не запущен или недоступен (http://127.0.0.1:8787). Запусти его командой «npm run coach» и проверь адрес в настройках.',
    );
    const html = render({ kind: 'error', error, endpoint: 'http://127.0.0.1:8787' });
    expect(html).toMatch(/^<div class="notice notice-err" role="alert">/);
    expect(html).toContain('<div class="notice-title">Сервер недоступен</div>');
    expect(html).toContain('<span class="mono check-origin">http://127.0.0.1:8787</span>');
    expect(html).toMatch(/<details class="disclosure check-details">[^]*Подробности[^]*npm run coach/);
    expect(html).not.toMatch(/<details[^>]* open/);
    // e2e: в ошибке проверки нет слова «отвечает» — ни в заголовке, ни в подробностях.
    expect(text(html)).not.toContain('отвечает');
  });

  it('заголовок — по виду ошибки; при неверном адресе адрес строкой не повторяется', () => {
    expect(render({ kind: 'error', error: new CoachAccessError(), endpoint: 'https://coach.example.org/' })).toContain(
      '<span class="mono check-origin">https://coach.example.org</span>',
    );
    expect(text(render({ kind: 'error', error: new CoachAccessError(), endpoint: 'https://coach.example.org' }))).toMatch(
      /^Нет доступа: токен или адрес приложения/,
    );
    const wrong = render({ kind: 'error', error: new CoachEndpointError(), endpoint: 'localhost' });
    expect(text(wrong)).toMatch(/^Неверный адрес сервера Подробности/);
    expect(wrong).not.toContain('check-origin');
    expect(text(render({ kind: 'error', error: new Error('boom'), endpoint: '' }))).toMatch(/^Не удалось проверить/);
  });

  it('сервер отвечает / ключа нет — одной строкой', () => {
    expect(text(render({ kind: 'ok', provider: 'anthropic', model: 'claude' }))).toBe('Сервер отвечает: anthropic, claude');
    expect(text(render({ kind: 'no-key' }))).toBe('Ключа ИИ нет Сервер запущен · ключ — в .env на сервере');
  });
});
