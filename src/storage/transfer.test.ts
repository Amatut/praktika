import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteDatabase, getDb } from './db.ts';
import {
  addActivity,
  addCoachDraft,
  getAllExercises,
  getAllLessons,
  getAllReviews,
  getAttempts,
  getCoachDrafts,
  getExercise,
  getInterests,
  getLesson,
  getMarketDatasets,
  getMeta,
  getProject,
  getSettings,
  markHintShown,
  onChange,
  recordCheck,
  recordRun,
  saveDraft,
  saveInterest,
  saveLesson,
  saveMarketDataset,
  saveProject,
  saveSettings,
  updateMeta,
} from './repo.ts';
import {
  applyImport,
  exportAll,
  exportFileName,
  ImportError,
  listBackups,
  MAX_BACKUPS,
  mergeExercise,
  parseImport,
  resetAll,
  restoreBackup,
  serializeExport,
} from './transfer.ts';
import { DEFAULT_META, DEFAULT_SETTINGS, EXPORT_FORMAT, SCHEMA_VERSION } from './types.ts';
import type {
  CoachDraft,
  ExerciseRecord,
  ExportFile,
  ImportPreview,
  InterestRecord,
  LessonRecord,
  MarketDataset,
  ProgressData,
  ProjectRecord,
} from './types.ts';

const APP = { version: '0.1.0', contentVersion: 'c-1' };
const T0 = new Date(2026, 8, 20, 12, 0).getTime();

function setTime(ts: number): void {
  vi.setSystemTime(ts);
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  setTime(T0);
  await deleteDatabase();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Немного прогресса во всех хранилищах. */
async function seed(): Promise<void> {
  await saveSettings({ theme: 'dark', lessonFontSize: 18, market: { region: 'Россия', currency: 'RUB' } });
  await updateMeta({ currentLessonId: 'l-1', lastOpenedAt: T0 });
  await saveDraft('ex-1', 'l-1', 'print(1)');
  await recordRun('ex-1', 'l-1', 'SyntaxError');
  await recordCheck('ex-1', 'l-1', { passed: false, errorType: 'output', failed: 1, total: 2, help: 0 });
  await markHintShown('ex-2', 'l-1', 3);
  await recordCheck('ex-2', 'l-1', { passed: true, errorType: null, failed: 0, total: 2, help: 3 });
  await saveLesson('l-1', { stepIndex: 3, completedSteps: ['a', 'b'], quizzes: { q1: { choice: 2, correct: true } } });
  await addActivity(120_000);
  await saveInterest({ labId: 'data', status: 'tried', continue: 'yes' });
  await saveProject({ projectId: 'quiz', stagesDone: ['plan'], notes: 'заметка' });
  await saveMarketDataset({
    id: 'm-1',
    title: 'Набор',
    region: 'Россия',
    currency: 'RUB',
    importedAt: T0,
    checkedAt: '2026-09-01',
    entries: [
      {
        lab: 'web',
        type: 'salary',
        title: 'Junior frontend',
        amountMin: 60000,
        amountMax: 90000,
        currency: 'RUB',
        period: 'month',
        region: 'Москва',
        level: 'junior',
        publishedAt: '2026-08-30',
        checkedAt: '2026-09-01',
        url: 'https://example.com/v/1',
        sourceType: 'vacancy',
        isOffer: true,
        note: '',
      },
    ],
  });
  await addCoachDraft({ id: 'd-1', text: 'Где: строка 1', exerciseId: 'ex-1', lessonId: 'l-1' });
}

function withoutTime(file: ExportFile): Omit<ExportFile, 'exportedAt'> {
  const { exportedAt: _ignored, ...rest } = file;
  return rest;
}

function emptyData(): ProgressData {
  return {
    settings: structuredClone(DEFAULT_SETTINGS),
    meta: { ...DEFAULT_META },
    exercises: [],
    lessons: [],
    attempts: [],
    activity: [],
    interests: [],
    reviews: [],
    projects: [],
    market: [],
    coachDrafts: [],
  };
}

function fileWith(data: Partial<ProgressData>): ExportFile {
  return {
    format: EXPORT_FORMAT,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date(T0).toISOString(),
    app: APP,
    data: { ...emptyData(), ...data },
  };
}

function exercise(patch: Partial<ExerciseRecord> & Pick<ExerciseRecord, 'exerciseId'>): ExerciseRecord {
  return {
    lessonId: 'l-1',
    draft: null,
    draftUpdatedAt: null,
    status: 'new',
    checks: 0,
    runs: 0,
    hintsShown: 0,
    solutionViewed: false,
    firstPassedAt: null,
    firstPassHelp: null,
    lastCheckAt: null,
    updatedAt: T0,
    ...patch,
  };
}

function lesson(patch: Partial<LessonRecord> & Pick<LessonRecord, 'lessonId'>): LessonRecord {
  return {
    stepIndex: 0,
    completedSteps: [],
    startedAt: T0,
    completedAt: null,
    predictions: {},
    orders: {},
    quizzes: {},
    checklists: {},
    recap: null,
    updatedAt: T0,
    ...patch,
  };
}

function dataset(patch: Partial<MarketDataset> & Pick<MarketDataset, 'id'>): MarketDataset {
  return { title: 'Набор', region: 'Россия', currency: 'RUB', importedAt: T0, checkedAt: '2026-09-01', entries: [], ...patch };
}

function interest(patch: Partial<InterestRecord> & Pick<InterestRecord, 'labId'>): InterestRecord {
  return { status: 'curious', liked: '', tiring: '', continue: null, updatedAt: T0, ...patch };
}

function project(patch: Partial<ProjectRecord> & Pick<ProjectRecord, 'projectId'>): ProjectRecord {
  return { stagesDone: [], notes: '', updatedAt: T0, ...patch };
}

function draft(patch: Partial<CoachDraft> & Pick<CoachDraft, 'id'>): CoachDraft {
  return { exerciseId: null, lessonId: null, text: 'Вопрос', createdAt: T0, ...patch };
}

/**
 * Запись в хранилище storeName будет завершаться ошибкой запроса (ConstraintError), как при сбое браузера:
 * put подменяется двумя add с одним ключом. Возвращает функцию отмены подмены.
 */
function failPutsIn(storeName: string): () => void {
  const originalPut = IDBObjectStore.prototype.put;
  const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
    if (this.name !== storeName) return originalPut.call(this, value, key);
    this.add(value, key);
    return this.add(value, key);
  });
  return () => spy.mockRestore();
}

/** Запись в хранилище storeName бросает ошибку браузера с именем errorName. */
function throwOnPutIn(storeName: string, errorName: string): () => void {
  const originalPut = IDBObjectStore.prototype.put;
  const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
    if (this.name === storeName) throw new DOMException('The operation failed', errorName);
    return originalPut.call(this, value, key);
  });
  return () => spy.mockRestore();
}

/** Собрать необработанные отказы промисов за время работы fn. */
async function collectUnhandled(fn: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const onUnhandled = (reason: unknown) => seen.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    await fn();
    await new Promise((resolve) => setTimeout(resolve, 30));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  return seen;
}

function preview(text: string): ImportPreview {
  const result = parseImport(text);
  if (!result.ok) throw new Error(`Ожидался корректный файл: ${result.message} ${result.details ?? ''}`);
  return result;
}

describe('экспорт', () => {
  it('содержит все данные, формат и версии', async () => {
    await seed();
    const file = await exportAll(APP);
    expect(file.format).toBe('praktika-progress');
    expect(file.schemaVersion).toBe(SCHEMA_VERSION);
    expect(file.app).toEqual(APP);
    expect(file.data.exercises).toHaveLength(2);
    expect(file.data.attempts).toHaveLength(3);
    expect(file.data.reviews).toHaveLength(1);
    expect(file.data.settings.theme).toBe('dark');
    expect(file.data.meta.currentLessonId).toBe('l-1');
    expect(exportFileName(new Date(2026, 8, 26))).toBe('praktika-progress-2026-09-26.json');
  });

  it('не включает токен доступа к наставнику', async () => {
    await saveSettings({ coach: { accessToken: 'секрет' } });
    const file = await exportAll(APP);
    expect(file.data.settings.coach.accessToken).toBe('');
    expect(serializeExport(file)).not.toContain('секрет');
  });
});

describe('импорт с заменой', () => {
  it('экспорт → сброс → импорт восстанавливает всё', async () => {
    await seed();
    const before = await exportAll(APP);
    const text = serializeExport(before);

    await resetAll();
    expect(await getAllExercises()).toEqual([]);
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);

    const checked = preview(text);
    expect(checked.counts).toEqual({ exercises: 2, passed: 1, lessons: 1, attempts: 3, days: 1 });
    const result = await applyImport(checked.file, 'replace');
    expect(result.counts).toEqual(checked.counts);

    const after = await exportAll(APP);
    expect(withoutTime(after)).toEqual(withoutTime(before));
  });

  it('удаляет записи, которых нет в файле, и сохраняет текущий токен', async () => {
    await saveSettings({ coach: { accessToken: 'мой-токен' } });
    await saveDraft('old', 'l-9', 'старое');
    await applyImport(fileWith({ exercises: [exercise({ exerciseId: 'new', status: 'attempted', checks: 1 })] }), 'replace');
    expect((await getAllExercises()).map((e) => e.exerciseId)).toEqual(['new']);
    expect((await getSettings()).coach.accessToken).toBe('мой-токен');
  });

  it('адрес наставника из файла не подменяет текущий: токен не уйдёт на чужой сервер', async () => {
    await saveSettings({ coach: { mode: 'ai', endpoint: 'https://my-coach.example', accessToken: 'SECRET' } });
    const file = fileWith({
      settings: {
        ...DEFAULT_SETTINGS,
        theme: 'dark',
        coach: { mode: 'ai', endpoint: 'https://attacker.example', accessToken: '' },
      },
    });
    await applyImport(file, 'replace');
    const settings = await getSettings();
    expect(settings.coach).toEqual({ mode: 'ai', endpoint: 'https://my-coach.example', accessToken: 'SECRET' });
    // Остальные настройки при замене берутся из файла.
    expect(settings.theme).toBe('dark');

    // Режим тоже не меняется: файл не может включить отправку кода на сервер.
    await saveSettings({ coach: { mode: 'course' } });
    await applyImport(fileWith({ settings: { ...DEFAULT_SETTINGS, coach: { mode: 'ai', endpoint: 'https://x.example', accessToken: 't' } } }), 'replace');
    expect((await getSettings()).coach).toEqual({ mode: 'course', endpoint: 'https://my-coach.example', accessToken: 'SECRET' });
  });
});

describe('импорт со слиянием', () => {
  it('упражнения: статус, первое прохождение, счётчики, черновик, подсказки', async () => {
    await applyImport(
      fileWith({
        settings: { ...DEFAULT_SETTINGS, theme: 'dark' },
        exercises: [
          exercise({ exerciseId: 'a', status: 'passed', checks: 5, runs: 1, firstPassedAt: T0 + 100, firstPassHelp: 3, hintsShown: 3 }),
          exercise({ exerciseId: 'b', status: 'attempted', checks: 2, draft: 'новый', draftUpdatedAt: T0 + 500 }),
          exercise({ exerciseId: 'c', status: 'passed', firstPassedAt: T0 + 100, firstPassHelp: 1 }),
          exercise({ exerciseId: 'only-here', status: 'new' }),
        ],
      }),
      'replace',
    );

    const incoming = fileWith({
      settings: { ...DEFAULT_SETTINGS, theme: 'light', lessonFontSize: 20, market: { region: 'Казахстан', currency: 'KZT' } },
      exercises: [
        exercise({ exerciseId: 'a', status: 'passed', checks: 2, runs: 7, firstPassedAt: T0 + 900, firstPassHelp: 0, solutionViewed: true }),
        exercise({ exerciseId: 'b', status: 'passed', checks: 1, firstPassedAt: T0 + 50, firstPassHelp: 2, draft: 'старый', draftUpdatedAt: T0 + 10 }),
        exercise({ exerciseId: 'c', status: 'passed', firstPassedAt: T0 + 20, firstPassHelp: 1 }),
        exercise({ exerciseId: 'only-there', status: 'attempted', checks: 1 }),
      ],
    });
    const result = await applyImport(incoming, 'merge');
    expect(result.strategy).toBe('merge');
    expect(result.backupId).not.toBeNull();

    const a = await getExercise('a');
    expect(a).toMatchObject({
      status: 'passed',
      firstPassedAt: T0 + 900, // меньше помощи важнее более ранней даты
      firstPassHelp: 0,
      checks: 5,
      runs: 7,
      hintsShown: 3,
      solutionViewed: true,
    });
    const b = await getExercise('b');
    expect(b).toMatchObject({ status: 'passed', firstPassedAt: T0 + 50, firstPassHelp: 2, checks: 2, draft: 'новый' });
    const c = await getExercise('c');
    expect(c).toMatchObject({ firstPassedAt: T0 + 20, firstPassHelp: 1 }); // одинаковая помощь — более ранняя дата
    expect((await getAllExercises()).map((e) => e.exerciseId).sort()).toEqual(['a', 'b', 'c', 'only-here', 'only-there']);

    // Настройки устройства остаются текущими, регион и валюта берутся, раз их не было.
    const settings = await getSettings();
    expect(settings.theme).toBe('dark');
    expect(settings.lessonFontSize).toBe(DEFAULT_SETTINGS.lessonFontSize);
    expect(settings.market).toEqual({ region: 'Казахстан', currency: 'KZT' });
  });

  it('настройки: подключение к наставнику и токен остаются текущими', async () => {
    await saveSettings({ coach: { mode: 'ai', endpoint: 'https://my-coach.example', accessToken: '' } });
    await applyImport(
      fileWith({ settings: { ...DEFAULT_SETTINGS, coach: { mode: 'course', endpoint: 'https://other.example', accessToken: 'чужой' } } }),
      'merge',
    );
    expect((await getSettings()).coach).toEqual({ mode: 'ai', endpoint: 'https://my-coach.example', accessToken: '' });

    await saveSettings({ coach: { accessToken: 'мой' } });
    await applyImport(fileWith({}), 'merge');
    expect((await getSettings()).coach.accessToken).toBe('мой');
  });

  it('настройки: регион и валюта берутся из файла только парой и только если на устройстве их нет', async () => {
    const kz = fileWith({ settings: { ...DEFAULT_SETTINGS, market: { region: 'Казахстан', currency: 'KZT' } } });

    await saveSettings({ market: { region: 'Россия', currency: null } });
    await applyImport(kz, 'merge');
    expect((await getSettings()).market).toEqual({ region: 'Россия', currency: null });

    await saveSettings({ market: { region: null, currency: 'USD' } });
    await applyImport(kz, 'merge');
    expect((await getSettings()).market).toEqual({ region: null, currency: 'USD' });

    await saveSettings({ market: { region: null, currency: null } });
    await applyImport(kz, 'merge');
    expect((await getSettings()).market).toEqual({ region: 'Казахстан', currency: 'KZT' });
  });

  it('интересы, проекты, наборы рынка и черновики вопросов', async () => {
    await applyImport(
      fileWith({
        interests: [
          interest({ labId: 'web', status: 'tried', liked: 'текущее', updatedAt: T0 + 100 }),
          interest({ labId: 'data', liked: 'старое', updatedAt: T0 }),
          interest({ labId: 'games', liked: 'равная дата', updatedAt: T0 }),
        ],
        projects: [project({ projectId: 'quiz', stagesDone: ['plan', 'code'], notes: 'старые заметки', updatedAt: T0 })],
        market: [
          dataset({ id: 'm-1', title: 'Текущий свежий', importedAt: T0 + 100 }),
          dataset({ id: 'm-2', title: 'Текущий старый', importedAt: T0 }),
        ],
        coachDrafts: [draft({ id: 'd-1', text: 'Вопрос с этого устройства' })],
      }),
      'replace',
    );

    await applyImport(
      fileWith({
        interests: [
          interest({ labId: 'web', status: 'curious', liked: 'из файла', updatedAt: T0 + 50 }),
          interest({ labId: 'data', status: 'tried', liked: 'новое', updatedAt: T0 + 200 }),
          interest({ labId: 'games', liked: 'из файла', updatedAt: T0 }),
          interest({ labId: 'mobile', liked: 'только в файле' }),
        ],
        projects: [
          project({ projectId: 'quiz', stagesDone: ['test'], notes: 'новые заметки', updatedAt: T0 + 10 }),
          project({ projectId: 'bot', stagesDone: ['plan'] }),
        ],
        market: [
          dataset({ id: 'm-1', title: 'Файл старый', importedAt: T0 }),
          dataset({ id: 'm-2', title: 'Файл свежий', importedAt: T0 + 100 }),
          dataset({ id: 'm-3', title: 'Только в файле' }),
        ],
        coachDrafts: [
          draft({ id: 'd-1', text: 'Тот же id из файла' }),
          draft({ id: 'd-2', text: 'Вопрос с другого устройства' }),
        ],
      }),
      'merge',
    );

    const interests = new Map((await getInterests()).map((i) => [i.labId, i]));
    expect(interests.get('web')).toMatchObject({ status: 'tried', liked: 'текущее' }); // текущая свежее
    expect(interests.get('data')).toMatchObject({ status: 'tried', liked: 'новое' }); // из файла свежее
    expect(interests.get('games')?.liked).toBe('равная дата'); // при равенстве остаётся текущая
    expect(interests.get('mobile')?.liked).toBe('только в файле');

    expect(await getProject('quiz')).toMatchObject({ notes: 'новые заметки', stagesDone: ['plan', 'code', 'test'] });
    expect(await getProject('bot')).toMatchObject({ stagesDone: ['plan'] });

    const market = new Map((await getMarketDatasets()).map((m) => [m.id, m.title]));
    expect(Object.fromEntries(market)).toEqual({ 'm-1': 'Текущий свежий', 'm-2': 'Файл свежий', 'm-3': 'Только в файле' });

    const drafts = new Map((await getCoachDrafts()).map((d) => [d.id, d.text]));
    expect(Object.fromEntries(drafts)).toEqual({ 'd-1': 'Вопрос с этого устройства', 'd-2': 'Вопрос с другого устройства' });
  });

  it('passed важнее attempted важнее new', () => {
    const cur = exercise({ exerciseId: 'x', status: 'attempted' });
    expect(mergeExercise(cur, exercise({ exerciseId: 'x', status: 'new' })).status).toBe('attempted');
    expect(mergeExercise(exercise({ exerciseId: 'x', status: 'new' }), cur).status).toBe('attempted');
    const passed = exercise({ exerciseId: 'x', status: 'passed', firstPassedAt: T0, firstPassHelp: 0 });
    expect(mergeExercise(cur, passed)).toMatchObject({ status: 'passed', firstPassedAt: T0, firstPassHelp: 0 });
  });

  it('уроки, попытки, активность, повторения, мета', async () => {
    await applyImport(
      fileWith({
        meta: { currentLessonId: 'l-1', lastOpenedAt: T0, firstActivityAt: T0 - 1000 },
        lessons: [
          lesson({
            lessonId: 'l-1',
            stepIndex: 4,
            completedSteps: ['s1', 's2'],
            startedAt: T0 - 500,
            predictions: { p1: { answer: 'старый', matched: false } },
            orders: { o1: { attempts: 3, solved: false } },
            checklists: { c1: ['a'] },
            updatedAt: T0,
          }),
        ],
        attempts: [
          { key: 'ex-1:1', exerciseId: 'ex-1', lessonId: 'l-1', at: 1, kind: 'run', passed: true, errorType: null, failed: 0, total: 0 },
        ],
        activity: [
          { date: '2026-09-18', activeMs: 5000 },
          { date: '2026-09-19', activeMs: 1000 },
        ],
        reviews: [
          { key: 'exercise:ex-1', lessonId: 'l-1', exerciseId: 'ex-1', stage: 2, dueAt: T0 + 7, reason: 'x', createdAt: T0, updatedAt: T0 + 50, doneAt: null },
        ],
      }),
      'replace',
    );

    await applyImport(
      fileWith({
        meta: { currentLessonId: 'l-5', lastOpenedAt: T0 + 10_000, firstActivityAt: T0 },
        lessons: [
          lesson({
            lessonId: 'l-1',
            stepIndex: 2,
            completedSteps: ['s3'],
            startedAt: T0 - 100,
            completedAt: T0 + 300,
            predictions: { p1: { answer: 'новый', matched: true }, p2: { answer: '7', matched: null } },
            orders: { o1: { attempts: 1, solved: true } },
            checklists: { c1: ['b'] },
            recap: { answer: 'итог', selfCheck: 'understood' },
            updatedAt: T0 + 100,
          }),
        ],
        attempts: [
          { key: 'ex-1:1', exerciseId: 'ex-1', lessonId: 'l-1', at: 1, kind: 'run', passed: true, errorType: null, failed: 0, total: 0 },
          { key: 'ex-1:2', exerciseId: 'ex-1', lessonId: 'l-1', at: 2, kind: 'check', passed: false, errorType: 'rule', failed: 1, total: 1 },
        ],
        activity: [
          { date: '2026-09-18', activeMs: 3000 },
          { date: '2026-09-19', activeMs: 9000 },
          { date: '2026-09-20', activeMs: 100 },
        ],
        reviews: [
          { key: 'exercise:ex-1', lessonId: 'l-1', exerciseId: 'ex-1', stage: 0, dueAt: T0 + 1, reason: 'x', createdAt: T0, updatedAt: T0 + 10, doneAt: null },
        ],
      }),
      'merge',
    );

    const l1 = await getLesson('l-1');
    expect(l1).toMatchObject({
      stepIndex: 4,
      completedSteps: ['s1', 's2', 's3'],
      startedAt: T0 - 500,
      completedAt: T0 + 300,
      predictions: { p1: { answer: 'новый', matched: true }, p2: { answer: '7', matched: null } },
      orders: { o1: { attempts: 3, solved: true } },
      checklists: { c1: ['a', 'b'] },
      recap: { answer: 'итог', selfCheck: 'understood' },
      updatedAt: T0 + 100,
    });
    expect((await getAttempts()).map((a) => a.key)).toEqual(['ex-1:1', 'ex-1:2']);
    const file = await exportAll(APP);
    expect(file.data.activity).toEqual([
      { date: '2026-09-18', activeMs: 5000 },
      { date: '2026-09-19', activeMs: 9000 },
      { date: '2026-09-20', activeMs: 100 },
    ]);
    expect((await getAllReviews())[0]).toMatchObject({ stage: 2, updatedAt: T0 + 50 });
    expect(await getMeta()).toEqual({ currentLessonId: 'l-5', lastOpenedAt: T0 + 10_000, firstActivityAt: T0 - 1000 });
  });
});

describe('ошибочные файлы не меняют данные', () => {
  async function expectRejected(text: string, message: RegExp): Promise<void> {
    await seed();
    const before = await exportAll(APP);
    const backupsBefore = (await listBackups()).length;
    const result = parseImport(text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(message);
    expect(result.message).toMatch(/Текущие данные не изменены/);
    expect(withoutTime(await exportAll(APP))).toEqual(withoutTime(before));
    expect(await listBackups()).toHaveLength(backupsBefore);
  }

  it('повреждённый JSON', async () => {
    await expectRejected('{"format": "praktika-progress", "schemaVersion": 1, "data": {', /не читается как JSON/);
  });

  it('пустой файл', async () => {
    await expectRejected('   \n', /пустой/);
  });

  it('чужой формат', async () => {
    await expectRejected(JSON.stringify({ users: [1, 2, 3] }), /не файл прогресса/);
    expect(parseImport(JSON.stringify({ format: 'other-app', schemaVersion: 1 }))).toMatchObject({
      ok: false,
      message: expect.stringMatching(/другого формата/),
    });
    expect(parseImport('[1, 2]').ok).toBe(false);
    expect(parseImport('null').ok).toBe(false);
  });

  it('файл от более новой версии приложения', async () => {
    const file = { ...fileWith({}), schemaVersion: SCHEMA_VERSION + 1 };
    await expectRejected(JSON.stringify(file), /более новой версией приложения/);
  });

  it('нарушение структуры — с подробностями', async () => {
    const file = fileWith({ exercises: [exercise({ exerciseId: 'x' })] });
    const broken = JSON.parse(JSON.stringify(file));
    broken.data.exercises[0].status = 'done';
    broken.data.exercises[0].hintsShown = 7;
    delete broken.data.activity;
    await expectRejected(JSON.stringify(broken), /повреждён/);
    const result = parseImport(JSON.stringify(broken));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.details).toContain('data.exercises[0].status');
      expect(result.details).toContain('data.exercises[0].hintsShown');
      expect(result.details).toContain('data.activity');
    }
  });

  it('подробности — по-русски, без английских названий типов', () => {
    const file = fileWith({ exercises: [exercise({ exerciseId: 'x' })], lessons: [lesson({ lessonId: 'l-1' })] });
    const broken = JSON.parse(JSON.stringify(file));
    broken.data.exercises[0].status = 'done';
    broken.data.exercises[0].checks = -1;
    broken.data.exercises[0].lessonId = 5;
    broken.data.lessons[0].stepIndex = 1.5;
    delete broken.data.activity;
    const result = parseImport(JSON.stringify(broken));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const details = result.details ?? '';
    expect(details).toContain('data.exercises[0].status: нужно одно из значений: "new", "attempted", "passed", а указана строка "done"');
    expect(details).toContain('data.exercises[0].checks: должно быть не меньше 0');
    expect(details).toContain('data.exercises[0].lessonId: нужна строка, а указано число 5');
    expect(details).toContain('data.lessons[0].stepIndex: нужно целое число, а указано число 1.5');
    expect(details).toContain('data.activity: нужен список, а поля нет');
    expect(details).not.toMatch(/\b(string|number|int|array|undefined|expected|received)\b/);
  });

  it('неверная версия формата — «указана неверно», отсутствующая — «не указана»', () => {
    const base = fileWith({}) as unknown as Record<string, unknown>;
    for (const version of ['1', 0, 1.5, null]) {
      const result = parseImport(JSON.stringify({ ...base, schemaVersion: version }));
      expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/версия формата данных указана неверно/) });
    }
    const { schemaVersion: _omit, ...withoutVersion } = base;
    expect(parseImport(JSON.stringify(withoutVersion))).toMatchObject({
      ok: false,
      message: expect.stringMatching(/не указана версия формата данных/),
    });
  });

  it('повторяющиеся ключи в файле — отказ, а не потеря прохождения', async () => {
    const passed = exercise({ exerciseId: 'd', status: 'passed', checks: 1, firstPassedAt: T0, firstPassHelp: 0 });
    const file = fileWith({ exercises: [passed, exercise({ exerciseId: 'd' })] });
    await expectRejected(JSON.stringify(file), /повреждён/);
    const result = parseImport(JSON.stringify(file));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.details).toContain('data.exercises[1].exerciseId: «d» повторяется');
    const attempts = fileWith({
      attempts: [
        { key: 'a:1', exerciseId: 'a', lessonId: 'l', at: 1, kind: 'run', passed: true, errorType: null, failed: 0, total: 0 },
        { key: 'a:1', exerciseId: 'a', lessonId: 'l', at: 1, kind: 'run', passed: true, errorType: null, failed: 0, total: 0 },
      ],
    });
    expect(parseImport(JSON.stringify(attempts)).ok).toBe(false);
  });

  it('пройденное задание без даты первого прохождения — отказ', async () => {
    const file = fileWith({ exercises: [exercise({ exerciseId: 'p', status: 'passed', firstPassedAt: null, firstPassHelp: null })] });
    await expectRejected(JSON.stringify(file), /повреждён/);
    const other = fileWith({ exercises: [exercise({ exerciseId: 'p', status: 'attempted', firstPassedAt: T0, firstPassHelp: 1 })] });
    expect(parseImport(JSON.stringify(other)).ok).toBe(false);
    const noHelp = fileWith({ exercises: [exercise({ exerciseId: 'p', status: 'passed', firstPassedAt: T0, firstPassHelp: null })] });
    expect(parseImport(JSON.stringify(noHelp)).ok).toBe(false);
  });

  it('applyImport отклоняет неверный объект и ничего не меняет', async () => {
    await seed();
    const before = await exportAll(APP);
    const bad = { ...fileWith({}), data: { ...emptyData(), exercises: [{ exerciseId: 1 }] } } as unknown as ExportFile;
    await expect(applyImport(bad, 'replace')).rejects.toBeInstanceOf(ImportError);
    await expect(applyImport(fileWith({}), 'oops' as 'merge')).rejects.toBeInstanceOf(ImportError);
    expect(withoutTime(await exportAll(APP))).toEqual(withoutTime(before));
    expect(await listBackups()).toEqual([]);
  });

  it('лишние поля игнорируются', () => {
    const file = fileWith({ exercises: [exercise({ exerciseId: 'x' })] }) as unknown as Record<string, unknown>;
    const withExtra = JSON.parse(JSON.stringify(file));
    withExtra.extra = true;
    withExtra.data.exercises[0].futureField = 'что-то новое';
    const result = preview(JSON.stringify(withExtra));
    expect(result.file).not.toHaveProperty('extra');
    expect(result.file.data.exercises[0]).not.toHaveProperty('futureField');
    expect(result.counts.exercises).toBe(1);
  });

  it('BOM в начале файла не мешает', async () => {
    await seed();
    const text = '﻿' + serializeExport(await exportAll(APP));
    expect(parseImport(text).ok).toBe(true);
  });
});

describe('резервные копии', () => {
  it('перед импортом сохраняется копия; хранятся последние 5', async () => {
    await seed();
    const original = await exportAll(APP);
    const first = await applyImport(fileWith({}), 'replace');
    expect(first.backupId).not.toBeNull();

    let backups = await listBackups();
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatchObject({ id: first.backupId, reason: 'Перед импортом (замена)' });
    expect(backups[0]?.counts.exercises).toBe(2);
    expect(withoutTime({ ...backups[0]!.file, app: APP })).toEqual(
      withoutTime({ ...original, data: { ...original.data } }),
    );

    for (let i = 1; i <= 7; i += 1) {
      setTime(T0 + i * 1000);
      await saveDraft(`ex-${i}`, 'l-1', `v${i}`);
      await applyImport(fileWith({}), 'merge');
    }
    backups = await listBackups();
    expect(backups).toHaveLength(MAX_BACKUPS);
    expect(backups.map((b) => b.createdAt)).toEqual([7, 6, 5, 4, 3].map((i) => T0 + i * 1000));
  });

  it('restoreBackup возвращает данные и сначала сохраняет текущие', async () => {
    await seed();
    const original = await exportAll(APP);
    const { backupId } = await applyImport(fileWith({ exercises: [exercise({ exerciseId: 'z' })] }), 'replace');
    expect((await getAllExercises()).map((e) => e.exerciseId)).toEqual(['z']);

    setTime(T0 + 60_000);
    const restored = await restoreBackup(backupId!);
    expect(restored.counts.exercises).toBe(2);
    expect(withoutTime(await exportAll(APP))).toEqual(withoutTime(original));

    const backups = await listBackups();
    expect(backups).toHaveLength(2);
    expect(backups[0]?.reason).toMatch(/^Перед восстановлением копии/);
    expect(backups[0]?.counts.exercises).toBe(1);

    await expect(restoreBackup('нет-такой')).rejects.toBeInstanceOf(ImportError);
    expect(withoutTime(await exportAll(APP))).toEqual(withoutTime(original));
  });

  it('resetAll очищает данные после резервной копии; пустую базу не копирует', async () => {
    await seed();
    await saveSettings({ coach: { accessToken: 'токен' } });
    const { backupId } = await resetAll();
    expect(backupId).not.toBeNull();
    expect(await getAllExercises()).toEqual([]);
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
    expect(await getMeta()).toEqual(DEFAULT_META);

    const second = await resetAll();
    expect(second.backupId).toBeNull();
    const backups = await listBackups();
    expect(backups).toHaveLength(1);
    expect(backups[0]?.reason).toBe('Перед сбросом прогресса');
    // Список копий токен не отдаёт (его могут сохранить в файл), но во внутренней копии он есть,
    // поэтому восстановление возвращает всё.
    expect(backups[0]?.file.data.settings.coach.accessToken).toBe('');
    expect(JSON.stringify(backups)).not.toContain('токен');

    const restored = await restoreBackup(backups[0]!.id);
    expect(restored.skipped).toEqual([]);
    expect((await getSettings()).coach.accessToken).toBe('токен');
    expect(await getAllExercises()).toHaveLength(2);
  });

  it('копия после resetAll восстанавливается, даже если в базе были неверные записи', async () => {
    await seed();
    // Записи, сохранённые в обход проверки (например, старой версией приложения).
    const db = await getDb();
    const [validEntry] = (await getMarketDatasets())[0]!.entries;
    await db.put('market', {
      ...dataset({ id: 'm-bad' }),
      entries: [{ ...validEntry, amountMin: '60000' }],
    } as unknown as MarketDataset);
    await db.put('lessons', lesson({ lessonId: 'l-bad', stepIndex: 1.5 }));
    await db.put('exercises', exercise({ exerciseId: 'ex-bad', status: 'passed' }));

    const { backupId } = await resetAll();
    expect(await getAllExercises()).toEqual([]);

    const restored = await restoreBackup(backupId!);
    expect(restored.skipped).toHaveLength(3);
    expect(restored.skipped.join('\n')).toContain('market[1] «m-bad»: entries[0].amountMin: нужно число, а указана строка "60000"');
    expect(restored.skipped.join('\n')).toMatch(/lessons\[\d] «l-bad»: stepIndex: нужно целое число/);
    expect(restored.skipped.join('\n')).toMatch(/exercises\[\d] «ex-bad»: firstPassedAt: статус и первое прохождение не согласованы/);
    expect(restored.counts).toMatchObject({ exercises: 2, lessons: 1 });
    expect((await getAllExercises()).map((e) => e.exerciseId).sort()).toEqual(['ex-1', 'ex-2']);
    expect((await getAllLessons()).map((l) => l.lessonId)).toEqual(['l-1']);
    expect((await getMarketDatasets()).map((m) => m.id)).toEqual(['m-1']);
    expect((await getSettings()).theme).toBe('dark');
    // Восстановленные данные снова экспортируются в файл, который принимает импорт.
    expect(parseImport(serializeExport(await exportAll(APP))).ok).toBe(true);
  });

  it('копия с неверными настройками: неверные поля заменяются значениями по умолчанию', async () => {
    await seed();
    const db = await getDb();
    await db.put('kv', { ...(await getSettings()), theme: 'purple', lessonFontSize: 18 } as never, 'settings');
    const { backupId } = await resetAll();
    const restored = await restoreBackup(backupId!);
    expect(restored.skipped).toEqual(['settings: theme — неверные значения заменены значениями по умолчанию']);
    expect(await getSettings()).toMatchObject({ theme: DEFAULT_SETTINGS.theme, lessonFontSize: 18 });
  });

  it('копия не в формате «Практики» не восстанавливается и ничего не меняет', async () => {
    await seed();
    const before = await exportAll(APP);
    const db = await getDb();
    await db.put('backups', { id: 'broken', createdAt: T0, reason: 'x', file: { format: 'other' } as unknown as ExportFile });
    await expect(restoreBackup('broken')).rejects.toMatchObject({ name: 'ImportError', message: expect.stringMatching(/повреждена/) });
    const newer = { ...fileWith({}), schemaVersion: SCHEMA_VERSION + 1 };
    await db.put('backups', { id: 'newer', createdAt: T0, reason: 'x', file: newer });
    await expect(restoreBackup('newer')).rejects.toMatchObject({ message: expect.stringMatching(/более новой версией/) });
    expect(withoutTime(await exportAll(APP))).toEqual(withoutTime(before));
  });
});

describe('экспорт при неверных записях в базе', () => {
  it('неверные записи пропускаются с предупреждением, файл принимает импорт', async () => {
    await seed();
    const db = await getDb();
    await db.put('lessons', lesson({ lessonId: 'l-bad', stepIndex: -1 }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const file = await exportAll(APP);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
    expect(file.data.lessons.map((l) => l.lessonId)).toEqual(['l-1']);
    expect(parseImport(serializeExport(file)).ok).toBe(true);
  });
});

describe('сбой записи во время импорта, восстановления и сброса', () => {
  async function expectUnchanged(action: () => Promise<unknown>, messagePattern: RegExp): Promise<void> {
    const before = await exportAll(APP);
    const backupsBefore = (await listBackups()).map((b) => b.id);
    const listener = vi.fn();
    const off = onChange(listener);
    let caught: unknown;
    const unhandled = await collectUnhandled(async () => {
      caught = await action().catch((e: unknown) => e);
    });
    off();
    expect(unhandled).toEqual([]);
    expect(caught).toBeInstanceOf(ImportError);
    expect((caught as ImportError).message).toMatch(messagePattern);
    expect((caught as ImportError).message).toMatch(/Текущие данные не изменены/);
    expect(listener).not.toHaveBeenCalled();
    expect(withoutTime(await exportAll(APP))).toEqual(withoutTime(before));
    // Транзакция откатилась целиком: новой резервной копии тоже нет.
    expect((await listBackups()).map((b) => b.id)).toEqual(backupsBefore);
  }

  it('импорт со слиянием', async () => {
    await seed();
    const restore = failPutsIn('market');
    try {
      await expectUnchanged(() => applyImport(fileWith({ market: [dataset({ id: 'm-2' })] }), 'merge'), /^Импорт не выполнен/);
    } finally {
      restore();
    }
  });

  it('импорт с заменой', async () => {
    await seed();
    const restore = failPutsIn('exercises');
    try {
      await expectUnchanged(() => applyImport(fileWith({ exercises: [exercise({ exerciseId: 'z' })] }), 'replace'), /^Импорт не выполнен/);
    } finally {
      restore();
    }
  });

  it('восстановление копии', async () => {
    await seed();
    const { backupId } = await applyImport(fileWith({ exercises: [exercise({ exerciseId: 'z' })] }), 'replace');
    const restore = failPutsIn('exercises');
    try {
      await expectUnchanged(() => restoreBackup(backupId!), /^Восстановление не выполнено/);
    } finally {
      restore();
    }
    expect((await getAllExercises()).map((e) => e.exerciseId)).toEqual(['z']);
  });

  it('сброс', async () => {
    await seed();
    const restore = failPutsIn('backups');
    try {
      await expectUnchanged(() => resetAll(), /^Сброс не выполнен/);
    } finally {
      restore();
    }
    expect(await getAllExercises()).toHaveLength(2);
  });

  it('нехватка места — понятное сообщение на русском, подробности браузера — в details', async () => {
    await seed();
    const restore = throwOnPutIn('exercises', 'QuotaExceededError');
    try {
      await expectUnchanged(() => applyImport(fileWith({ exercises: [exercise({ exerciseId: 'z' })] }), 'merge'), /не хватает места/);
      const error = await applyImport(fileWith({ exercises: [exercise({ exerciseId: 'z' })] }), 'replace').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ImportError);
      expect((error as ImportError).details).toMatch(/QuotaExceededError/);
    } finally {
      restore();
    }
  });
});

describe('уведомления', () => {
  it('импорт сообщает об изменении всех хранилищ', async () => {
    const calls: string[][] = [];
    const off = onChange((stores) => calls.push(stores));
    await applyImport(fileWith({}), 'merge');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(expect.arrayContaining(['exercises', 'kv', 'backups']));
    parseImport('не json');
    expect(calls).toHaveLength(1);
    off();
  });
});
