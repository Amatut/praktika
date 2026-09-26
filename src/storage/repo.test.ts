import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, DB_NAME, DB_VERSION, deleteDatabase, getDb, StorageUnavailableError } from './db.ts';
import {
  addActivity,
  addCoachDraft,
  completeReview,
  deleteCoachDraft,
  deleteMarketDataset,
  getActivity,
  getAllExercises,
  getAllLessons,
  getAllReviews,
  getAttempts,
  getCoachDrafts,
  getDueReviews,
  getExercise,
  getExercisesByLesson,
  getInterests,
  getLesson,
  getMarketDatasets,
  getMeta,
  getProject,
  getSettings,
  InvalidDataError,
  markHintShown,
  markSolutionViewed,
  onChange,
  recordCheck,
  recordRun,
  resetDraft,
  saveDraft,
  saveInterest,
  saveLesson,
  saveMarketDataset,
  saveProject,
  saveSettings,
  scheduleReview,
  updateMeta,
} from './repo.ts';
import type { CheckInput } from './repo.ts';
import { addLocalDays, exerciseReviewKey, REVIEW_REASONS } from './schedule.ts';
import { parseImport, serializeExport, exportAll } from './transfer.ts';
import { DEFAULT_SETTINGS } from './types.ts';
import type { MarketDataset, MarketEntry } from './types.ts';

const T0 = new Date(2026, 8, 20, 12, 0).getTime();

/** Начало местного дня через days дней после from. */
function dayStart(from: number, days: number): number {
  const d = new Date(from);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days).getTime();
}

const fail: CheckInput = { passed: false, errorType: 'output', failed: 2, total: 3, help: 0 };
const pass = (help: CheckInput['help'] = 0): CheckInput => ({ passed: true, errorType: null, failed: 0, total: 3, help });

function setTime(ts: number): void {
  vi.setSystemTime(ts);
}

/**
 * Запись в хранилище storeName будет завершаться ошибкой запроса (ConstraintError), как при сбое браузера:
 * put подменяется на add, а запись с таким ключом уже есть. Возвращает функцию отмены подмены.
 */
function failPutsIn(storeName: string): () => void {
  const originalPut = IDBObjectStore.prototype.put;
  const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
    return this.name === storeName ? this.add(value, key) : originalPut.call(this, value, key);
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

/** Открыть базу более новой версии «из другой вкладки» (как это сделает обновлённое приложение). */
function openNewerVersion(version: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, version);
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
}

function marketEntry(patch: Partial<MarketEntry> = {}): MarketEntry {
  return {
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
    ...patch,
  };
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  setTime(T0);
  await deleteDatabase();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('открытие базы', () => {
  it('создаёт все хранилища и индексы', async () => {
    const db = await getDb();
    expect([...db.objectStoreNames].sort()).toEqual(
      ['activity', 'attempts', 'backups', 'coachDrafts', 'exercises', 'interests', 'kv', 'lessons', 'market', 'projects', 'reviews'].sort(),
    );
    const tx = db.transaction(['exercises', 'attempts', 'reviews']);
    expect([...tx.objectStore('exercises').indexNames]).toEqual(['lessonId']);
    expect([...tx.objectStore('attempts').indexNames].sort()).toEqual(['at', 'exerciseId']);
    expect([...tx.objectStore('reviews').indexNames]).toEqual(['dueAt']);
    await tx.done;
  });

  it('без IndexedDB даёт понятную ошибку', async () => {
    await deleteDatabase();
    vi.stubGlobal('indexedDB', undefined);
    try {
      await expect(getDb()).rejects.toBeInstanceOf(StorageUnavailableError);
      await expect(getDb()).rejects.toThrow(/приватном режиме/);
    } finally {
      vi.unstubAllGlobals();
    }
    // После восстановления IndexedDB база открывается снова.
    await expect(getDb()).resolves.toBeTruthy();
  });

  it('если другая вкладка обновила базу, просит перезагрузить страницу, а не говорит о приватном режиме', async () => {
    await saveDraft('ex-1', 'l-1', 'x');
    await openNewerVersion(DB_VERSION + 1);

    const error: unknown = await getDb().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StorageUnavailableError);
    expect(error).toMatchObject({ reason: 'outdated' });
    expect((error as Error).message).toMatch(/обновилось в другой вкладке/);
    expect((error as Error).message).toMatch(/Перезагрузи страницу/);
    expect((error as Error).message).not.toMatch(/приватном режиме/);
    await expect(getExercise('ex-1')).rejects.toBeInstanceOf(StorageUnavailableError);

    // Новая попытка открыть старую версию базы получает VersionError — причина та же.
    await closeDb();
    const again: unknown = await getDb().catch((e: unknown) => e);
    expect(again).toMatchObject({ reason: 'outdated' });
    expect((again as Error).cause).toMatchObject({ name: 'VersionError' });
  });

  it('прочие ошибки открытия — общий совет без утверждения про приватный режим', async () => {
    await deleteDatabase();
    const spy = vi.spyOn(indexedDB, 'open').mockImplementation(() => {
      throw new DOMException('сбой', 'UnknownError');
    });
    try {
      const error: unknown = await getDb().catch((e: unknown) => e);
      expect(error).toMatchObject({ name: 'StorageUnavailableError', reason: 'unknown' });
      expect((error as Error).message).toMatch(/Перезагрузи страницу/);
      expect((error as Error).message).not.toMatch(/приватном режиме/);
    } finally {
      spy.mockRestore();
    }
    await expect(getDb()).resolves.toBeTruthy();
  });
});

describe('настройки и служебные данные', () => {
  it('по умолчанию возвращает DEFAULT_SETTINGS', async () => {
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('сливает coach и market по полям', async () => {
    await saveSettings({ theme: 'dark', coach: { mode: 'ai' } });
    const saved = await saveSettings({ market: { currency: 'RUB' }, coach: { accessToken: 'abc' } });
    expect(saved.theme).toBe('dark');
    expect(saved.coach).toEqual({ mode: 'ai', endpoint: DEFAULT_SETTINGS.coach.endpoint, accessToken: 'abc' });
    expect(saved.market).toEqual({ region: null, currency: 'RUB' });
    expect(await getSettings()).toEqual(saved);
  });

  it('updateMeta меняет только переданные поля', async () => {
    await updateMeta({ currentLessonId: 'py-01', lastOpenedAt: 5 });
    const meta = await updateMeta({ lastOpenedAt: 10 });
    expect(meta).toEqual({ currentLessonId: 'py-01', lastOpenedAt: 10, firstActivityAt: null });
    expect(await getMeta()).toEqual(meta);
  });

  it('первое действие ученика запоминается один раз', async () => {
    await saveDraft('ex-1', 'l-1', 'print(1)');
    setTime(T0 + 1000);
    await recordRun('ex-1', 'l-1', null);
    expect((await getMeta()).firstActivityAt).toBe(T0);
  });
});

describe('статусы упражнений', () => {
  it('new → attempted → passed, passed не откатывается', async () => {
    const afterFail = await recordCheck('ex-1', 'l-1', fail);
    expect(afterFail.status).toBe('attempted');
    expect(afterFail.checks).toBe(1);
    expect(afterFail.firstPassedAt).toBeNull();

    setTime(T0 + 60_000);
    const afterPass = await recordCheck('ex-1', 'l-1', pass());
    expect(afterPass.status).toBe('passed');
    expect(afterPass.firstPassedAt).toBe(T0 + 60_000);
    expect(afterPass.firstPassHelp).toBe(0);
    expect(afterPass.lastCheckAt).toBe(T0 + 60_000);

    setTime(T0 + 120_000);
    const afterLaterFail = await recordCheck('ex-1', 'l-1', fail);
    expect(afterLaterFail.status).toBe('passed');
    expect(afterLaterFail.firstPassedAt).toBe(T0 + 60_000);
    expect(afterLaterFail.checks).toBe(3);
    expect(await getExercise('ex-1')).toEqual(afterLaterFail);
  });

  it('запуск увеличивает runs, пишет попытку run и не меняет статус', async () => {
    const rec = await recordRun('ex-1', 'l-1', 'NameError');
    expect(rec.runs).toBe(1);
    expect(rec.status).toBe('new');
    const attempts = await getAttempts({ exerciseId: 'ex-1' });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ kind: 'run', passed: false, errorType: 'NameError', key: `ex-1:${T0}` });
  });

  it('попытки в одну миллисекунду не затирают друг друга', async () => {
    await recordRun('ex-1', 'l-1', null);
    await recordRun('ex-1', 'l-1', null);
    await recordCheck('ex-1', 'l-1', fail);
    const attempts = await getAttempts({ exerciseId: 'ex-1' });
    expect(attempts.map((a) => a.key)).toEqual([`ex-1:${T0}`, `ex-1:${T0 + 1}`, `ex-1:${T0 + 2}`]);
    expect(attempts.map((a) => a.kind)).toEqual(['run', 'run', 'check']);
    expect(attempts[2]).toMatchObject({ passed: false, errorType: 'output', failed: 2, total: 3 });
  });

  it('упражнения ищутся по уроку', async () => {
    await saveDraft('ex-1', 'l-1', 'a');
    await saveDraft('ex-2', 'l-1', 'b');
    await saveDraft('ex-3', 'l-2', 'c');
    expect((await getExercisesByLesson('l-1')).map((e) => e.exerciseId).sort()).toEqual(['ex-1', 'ex-2']);
    expect(await getAllExercises()).toHaveLength(3);
  });

  it('подсказки хранят максимальный уровень, решение — флаг', async () => {
    await markHintShown('ex-1', 'l-1', 2);
    await markHintShown('ex-1', 'l-1', 1);
    expect((await getExercise('ex-1'))?.hintsShown).toBe(2);
    await markHintShown('ex-1', 'l-1', 3);
    const rec = await markSolutionViewed('ex-1', 'l-1');
    expect(rec.hintsShown).toBe(3);
    expect(rec.solutionViewed).toBe(true);
    expect(rec.status).toBe('new');
  });
});

describe('повторения', () => {
  it('третья подсказка при первом прохождении ставит задание на повторение на следующий день', async () => {
    await markHintShown('ex-1', 'l-1', 3);
    await recordCheck('ex-1', 'l-1', pass(3));
    const reviews = await getAllReviews();
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      key: exerciseReviewKey('ex-1'),
      lessonId: 'l-1',
      exerciseId: 'ex-1',
      stage: 0,
      dueAt: dayStart(T0, 1),
      reason: REVIEW_REASONS.hint3,
      doneAt: null,
    });
    expect(await getDueReviews(new Date(2026, 8, 20, 23, 59).getTime())).toEqual([]);
    expect((await getDueReviews(new Date(2026, 8, 21, 0, 0).getTime())).map((r) => r.key)).toEqual(['exercise:ex-1']);
  });

  it('решено вечером — повторение доступно уже утром следующего дня (сравнение по дням, а не по часам)', async () => {
    setTime(new Date(2026, 8, 20, 20, 15).getTime());
    await markHintShown('ex-1', 'l-1', 3);
    await recordCheck('ex-1', 'l-1', pass(3));
    expect(await getDueReviews(new Date(2026, 8, 20, 23, 0).getTime())).toHaveLength(0);
    expect(await getDueReviews(new Date(2026, 8, 21, 8, 0).getTime())).toHaveLength(1);
    expect(await getDueReviews(new Date(2026, 8, 21, 19, 0).getTime())).toHaveLength(1);
  });

  it('старый срок со временем суток тоже считается по дню', async () => {
    const db = await getDb();
    await db.put('reviews', {
      key: 'skill:loops',
      lessonId: 'l-1',
      exerciseId: null,
      stage: 0,
      dueAt: new Date(2026, 8, 21, 20, 15).getTime(),
      reason: 'x',
      createdAt: T0,
      updatedAt: T0,
      doneAt: null,
    });
    expect(await getDueReviews(new Date(2026, 8, 21, 8, 0).getTime())).toHaveLength(1);
    expect(await getDueReviews(new Date(2026, 8, 20, 22, 0).getTime())).toHaveLength(0);
  });

  it('просмотр решения учитывается, даже если интерфейс передал меньшую помощь', async () => {
    await markSolutionViewed('ex-1', 'l-1');
    const rec = await recordCheck('ex-1', 'l-1', pass(0));
    expect(rec.firstPassHelp).toBe(4);
    expect((await getAllReviews())[0]?.reason).toBe('Решено после просмотра решения');
  });

  it('4 неудачные проверки до успеха — повторение, 3 — нет', async () => {
    for (let i = 0; i < 3; i += 1) await recordCheck('ex-3', 'l-1', fail);
    await recordCheck('ex-3', 'l-1', pass());
    expect(await getAllReviews()).toEqual([]);

    for (let i = 0; i < 4; i += 1) await recordCheck('ex-4', 'l-1', fail);
    await recordCheck('ex-4', 'l-1', pass());
    const reviews = await getAllReviews();
    expect(reviews.map((r) => [r.exerciseId, r.reason])).toEqual([['ex-4', 'Понадобилось много попыток']]);
  });

  it('повторная удачная проверка не создаёт повторение заново', async () => {
    await recordCheck('ex-1', 'l-1', pass(0));
    await markHintShown('ex-1', 'l-1', 3);
    await recordCheck('ex-1', 'l-1', pass(3));
    expect(await getAllReviews()).toEqual([]);
  });

  it('completeReview: 1 → 3 → 7 → 14 дней, неудача — снова через день', async () => {
    await markHintShown('ex-1', 'l-1', 3);
    await recordCheck('ex-1', 'l-1', pass(3));
    const key = exerciseReviewKey('ex-1');

    let now = addLocalDays(T0, 1);
    setTime(now);
    let r = await completeReview(key, true);
    expect(r).toMatchObject({ stage: 1, dueAt: dayStart(now, 3), doneAt: null });

    now = addLocalDays(now, 3);
    setTime(now);
    r = await completeReview(key, false);
    expect(r).toMatchObject({ stage: 0, dueAt: dayStart(now, 1), doneAt: null });

    for (const days of [3, 7, 14]) {
      r = await completeReview(key, true);
      expect(r).toMatchObject({ dueAt: dayStart(now, days), doneAt: null });
    }
    r = await completeReview(key, true);
    expect(r?.doneAt).toBe(now);
    expect(await getDueReviews(addLocalDays(now, 100))).toEqual([]);

    // Закрытое повторение больше не меняется.
    expect(await completeReview(key, false)).toEqual(r);
    expect(await completeReview('нет-такого', true)).toBeUndefined();
  });

  it('scheduleReview добавляет навык на повторение', async () => {
    const r = await scheduleReview({ key: 'skill:range', lessonId: 'l-2', reason: 'Самопроверка: пока не понял' });
    expect(r).toMatchObject({ exerciseId: null, stage: 0, dueAt: dayStart(T0, 1) });
  });

  it('completeReview обновляет причину, если её передали', async () => {
    await scheduleReview({ key: 'lesson:l-2', lessonId: 'l-2', reason: 'В итоге урока отмечено «частично»' });
    const r = await completeReview('lesson:l-2', true, (step) => `Закрепляем: ступень ${step.stage}`);
    expect(r).toMatchObject({ stage: 1, reason: 'Закрепляем: ступень 1' });
    expect((await completeReview('lesson:l-2', false))?.reason).toBe('Закрепляем: ступень 1');
  });
});

describe('черновики', () => {
  it('сохраняет и сбрасывает черновик', async () => {
    const saved = await saveDraft('ex-1', 'l-1', 'print("привет")');
    expect(saved).toMatchObject({ draft: 'print("привет")', draftUpdatedAt: T0, status: 'new', checks: 0 });

    setTime(T0 + 5000);
    await saveDraft('ex-1', 'l-1', 'print("мир")');
    expect((await getExercise('ex-1'))?.draft).toBe('print("мир")');

    setTime(T0 + 9000);
    const reset = await resetDraft('ex-1');
    expect(reset).toMatchObject({ draft: null, draftUpdatedAt: T0 + 9000 });
    expect(await resetDraft('нет-такого')).toBeUndefined();
    expect(await getExercise('нет-такого')).toBeUndefined();
  });

  it('черновик не теряет счётчики и статус', async () => {
    await recordCheck('ex-1', 'l-1', pass());
    const rec = await saveDraft('ex-1', 'l-1', 'x = 1');
    expect(rec).toMatchObject({ status: 'passed', checks: 1, draft: 'x = 1' });
  });
});

describe('уроки', () => {
  it('создаёт запись при первом сохранении и сливает ответы по ключу', async () => {
    const created = await saveLesson('l-1');
    expect(created).toMatchObject({ lessonId: 'l-1', stepIndex: 0, startedAt: T0, completedSteps: [], completedAt: null });

    setTime(T0 + 1000);
    await saveLesson('l-1', { stepIndex: 1, completedSteps: ['s1'], predictions: { p1: { answer: '5', matched: true } } });
    await saveLesson('l-1', { stepIndex: 2, completedSteps: ['s2'], predictions: { p2: { answer: 'x', matched: null } } });
    await saveLesson('l-1', { checklists: { c1: ['a'] }, recap: { answer: 'понял', selfCheck: 'partly' } });
    const lesson = await getLesson('l-1');
    expect(lesson).toMatchObject({
      stepIndex: 2,
      startedAt: T0,
      completedSteps: ['s1', 's2'],
      predictions: { p1: { answer: '5', matched: true }, p2: { answer: 'x', matched: null } },
      checklists: { c1: ['a'] },
      recap: { answer: 'понял', selfCheck: 'partly' },
      updatedAt: T0 + 1000,
    });
    expect(await getAllLessons()).toHaveLength(1);
  });
});

describe('активность', () => {
  it('накапливает время по дням и отдаёт последние дни', async () => {
    await addActivity(60_000);
    await addActivity(30_000);
    await addActivity(10_000, new Date(2026, 8, 10, 9, 0));
    await addActivity(-5);
    await addActivity(Number.NaN);
    expect(await getActivity(7)).toEqual([{ date: '2026-09-20', activeMs: 90_000 }]);
    expect(await getActivity()).toEqual([
      { date: '2026-09-10', activeMs: 10_000 },
      { date: '2026-09-20', activeMs: 90_000 },
    ]);
  });
});

describe('попытки', () => {
  it('фильтрует по упражнению и времени', async () => {
    await recordRun('ex-1', 'l-1', null);
    setTime(T0 + 1000);
    await recordRun('ex-2', 'l-1', null);
    setTime(T0 + 2000);
    await recordCheck('ex-1', 'l-1', fail);
    expect((await getAttempts()).map((a) => a.key)).toEqual([`ex-1:${T0}`, `ex-2:${T0 + 1000}`, `ex-1:${T0 + 2000}`]);
    expect((await getAttempts({ since: T0 + 1000 })).map((a) => a.exerciseId)).toEqual(['ex-2', 'ex-1']);
    expect((await getAttempts({ exerciseId: 'ex-1', since: T0 + 1 })).map((a) => a.kind)).toEqual(['check']);
  });
});

describe('интересы, проекты, рынок, черновики вопросов наставнику', () => {
  it('сохраняет интересы и проекты частями', async () => {
    await saveInterest({ labId: 'web', status: 'tried' });
    const interest = await saveInterest({ labId: 'web', liked: 'быстро видно результат' });
    expect(interest).toMatchObject({ status: 'tried', liked: 'быстро видно результат', tiring: '', continue: null });
    expect(await getInterests()).toHaveLength(1);

    await saveProject({ projectId: 'quiz', stagesDone: ['plan'] });
    const project = await saveProject({ projectId: 'quiz', notes: 'добавить таймер' });
    expect(project).toMatchObject({ stagesDone: ['plan'], notes: 'добавить таймер' });
    expect(await getProject('quiz')).toEqual(project);
  });

  it('хранит наборы рынка и черновики вопросов наставнику', async () => {
    const dataset: MarketDataset = {
      id: 'ru-2026-09',
      title: 'Россия, сентябрь',
      region: 'Россия',
      currency: 'RUB',
      importedAt: T0,
      checkedAt: '2026-09-15',
      entries: [],
    };
    await saveMarketDataset(dataset);
    expect(await getMarketDatasets()).toEqual([dataset]);
    await deleteMarketDataset(dataset.id);
    expect(await getMarketDatasets()).toEqual([]);

    // Вопрос, который не удалось отправить без связи, ждёт в черновиках.
    const first = await addCoachDraft({ text: 'Почему цикл не останавливается?', exerciseId: 'ex-1', lessonId: 'l-1' });
    setTime(T0 + 1);
    const second = await addCoachDraft({ text: 'Чем список отличается от кортежа?' });
    expect(second.exerciseId).toBeNull();
    expect((await getCoachDrafts()).map((d) => d.id)).toEqual([second.id, first.id]);
    expect((await getCoachDrafts({ exerciseId: 'ex-1' })).map((d) => d.id)).toEqual([first.id]);
    await deleteCoachDraft(first.id);
    expect(await getCoachDrafts()).toHaveLength(1);

    // Пустой id — как отсутствующий: создаётся новый.
    const third = await addCoachDraft({ id: '', text: 'Что такое срез?' });
    expect(third.id).not.toBe('');
  });
});

describe('проверка данных при записи', () => {
  it('неверный набор рынка не сохраняется, и экспорт по-прежнему читается', async () => {
    await saveDraft('ex-1', 'l-1', 'print(1)');
    const bad = {
      id: 'm-bad',
      title: 'Набор',
      region: 'Россия',
      currency: 'RUB',
      importedAt: T0,
      checkedAt: '2026-09-01',
      entries: [{ ...marketEntry(), amountMin: '60000', publishedAt: undefined }],
    } as unknown as MarketDataset;
    const error: unknown = await saveMarketDataset(bad).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidDataError);
    expect((error as Error).message).toMatch(/Не получилось сохранить набор данных о рынке/);
    expect((error as InvalidDataError).details).toContain('entries[0].amountMin: нужно число, а указана строка "60000"');
    expect((error as InvalidDataError).details).toContain('entries[0].publishedAt: нужна строка, а поля нет');
    expect(await getMarketDatasets()).toEqual([]);
    expect(parseImport(serializeExport(await exportAll({ version: '0.1.0', contentVersion: null }))).ok).toBe(true);
  });

  it('лишние поля набора рынка отбрасываются', async () => {
    const dataset = {
      id: 'm-1',
      title: 'Набор',
      region: 'Россия',
      currency: 'RUB',
      importedAt: T0,
      checkedAt: '2026-09-01',
      entries: [marketEntry()],
      extra: 'лишнее',
    } as MarketDataset;
    const saved = await saveMarketDataset(dataset);
    expect(saved).not.toHaveProperty('extra');
    expect((await getMarketDatasets())[0]).not.toHaveProperty('extra');
  });

  it('номер шага и счётчики урока приводятся к целому числу ≥ 0', async () => {
    let lesson = await saveLesson('l-1', { stepIndex: 1.5 });
    expect(lesson.stepIndex).toBe(1);
    lesson = await saveLesson('l-1', { stepIndex: -3 });
    expect(lesson.stepIndex).toBe(0);
    lesson = await saveLesson('l-1', { stepIndex: Number.NaN });
    expect(lesson.stepIndex).toBe(0);
    lesson = await saveLesson('l-1', {
      orders: { o1: { attempts: 2.7, solved: false } },
      quizzes: { q1: { choice: 1.2, correct: false } },
    });
    expect(lesson.orders.o1).toEqual({ attempts: 2, solved: false });
    expect(lesson.quizzes.q1).toEqual({ choice: 1, correct: false });
    expect(parseImport(serializeExport(await exportAll({ version: '0.1.0', contentVersion: null }))).ok).toBe(true);
  });

  it('неверные значения урока и настроек не сохраняются', async () => {
    await saveLesson('l-1', { stepIndex: 2 });
    const badLesson = saveLesson('l-1', { completedSteps: [42] as unknown as string[] });
    await expect(badLesson).rejects.toBeInstanceOf(InvalidDataError);
    expect((await getLesson('l-1'))?.completedSteps).toEqual([]);

    await expect(saveSettings({ lessonFontSize: 19 as 18 })).rejects.toBeInstanceOf(InvalidDataError);
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('тип ошибки без значения записывается как null', async () => {
    await recordRun('ex-1', 'l-1', undefined as unknown as null);
    const [attempt] = await getAttempts({ exerciseId: 'ex-1' });
    expect(attempt).toMatchObject({ errorType: null, passed: true });
  });

  it('после обычной работы собственный экспорт проходит проверку импорта', async () => {
    await saveSettings({ theme: 'dark', market: { region: 'Россия', currency: 'RUB' } });
    await saveDraft('ex-1', 'l-1', 'print(1)');
    await recordRun('ex-1', 'l-1', 'SyntaxError');
    await recordCheck('ex-1', 'l-1', fail);
    await markHintShown('ex-2', 'l-1', 3);
    await recordCheck('ex-2', 'l-1', pass(3));
    await saveLesson('l-1', { stepIndex: 3, recap: { answer: 'итог', selfCheck: 'partly' } });
    await addActivity(60_000);
    await saveInterest({ labId: 'data', status: 'tried' });
    await saveProject({ projectId: 'quiz', stagesDone: ['plan'] });
    await addCoachDraft({ text: 'Вопрос' });
    const result = parseImport(serializeExport(await exportAll({ version: '0.1.0', contentVersion: null })));
    expect(result.ok).toBe(true);
  });
});

describe('сбой записи', () => {
  it('ошибка запроса откатывает транзакцию и доходит до вызывающего без необработанных отказов', async () => {
    await saveDraft('ex-1', 'l-1', 'старый');
    const restore = failPutsIn('exercises');
    let caught: unknown;
    const unhandled = await collectUnhandled(async () => {
      caught = await saveDraft('ex-1', 'l-1', 'новый').catch((e: unknown) => e);
    });
    restore();
    expect(caught).toMatchObject({ name: 'ConstraintError' });
    expect(unhandled).toEqual([]);
    expect((await getExercise('ex-1'))?.draft).toBe('старый');
  });

  it('проверка с ошибкой запроса не оставляет ни попытки, ни повторения', async () => {
    await saveDraft('ex-1', 'l-1', 'x');
    await markHintShown('ex-1', 'l-1', 3);
    const restore = failPutsIn('exercises');
    let caught: unknown;
    const unhandled = await collectUnhandled(async () => {
      caught = await recordCheck('ex-1', 'l-1', pass(3)).catch((e: unknown) => e);
    });
    restore();
    expect(caught).toMatchObject({ name: 'ConstraintError' });
    expect(unhandled).toEqual([]);
    expect(await getAttempts()).toEqual([]);
    expect(await getAllReviews()).toEqual([]);
    expect((await getExercise('ex-1'))?.status).toBe('new');
  });

  it('о неудачной записи подписчики не узнают', async () => {
    await saveLesson('l-1');
    const listener = vi.fn();
    const off = onChange(listener);
    const restore = failPutsIn('lessons');
    const unhandled = await collectUnhandled(async () => {
      await expect(saveLesson('l-1', { stepIndex: 2 })).rejects.toMatchObject({ name: 'ConstraintError' });
    });
    restore();
    off();
    expect(unhandled).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
    expect((await getLesson('l-1'))?.stepIndex).toBe(0);
  });
});

describe('onChange', () => {
  it('сообщает об изменённых хранилищах после записи и перестаёт после отписки', async () => {
    const calls: string[][] = [];
    const unsubscribe = onChange((stores) => calls.push(stores));

    await recordCheck('ex-1', 'l-1', fail);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(expect.arrayContaining(['exercises', 'attempts']));

    await markHintShown('ex-1', 'l-1', 3);
    await recordCheck('ex-1', 'l-1', pass(3));
    expect(calls.at(-1)).toEqual(expect.arrayContaining(['exercises', 'attempts', 'reviews']));

    await saveSettings({ theme: 'light' });
    expect(calls.at(-1)).toEqual(['kv']);

    const before = calls.length;
    unsubscribe();
    await saveDraft('ex-1', 'l-1', 'print()');
    expect(calls).toHaveLength(before);
  });

  it('ошибка в одном подписчике не мешает другим', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const seen: string[][] = [];
    const off1 = onChange(() => {
      throw new Error('сбой');
    });
    const off2 = onChange((stores) => seen.push(stores));
    await addActivity(1000);
    expect(seen).toEqual([['activity']]);
    off1();
    off2();
    errorSpy.mockRestore();
  });

  it('чтение не вызывает уведомлений', async () => {
    const listener = vi.fn();
    const off = onChange(listener);
    await getSettings();
    await getAllExercises();
    await getDueReviews();
    expect(listener).not.toHaveBeenCalled();
    off();
  });
});
