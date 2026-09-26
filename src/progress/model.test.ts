import { describe, expect, it } from 'vitest';
import type { Exercise, Lesson, ModuleFile, ModuleSummary } from '../content/schema.ts';
import type { ExerciseRecord, LessonRecord, ReviewRecord } from '../storage/types.ts';
import { lessonState, moduleState, skillProgress, splitReviews, suggestNextLesson } from './model.ts';

function exercise(id: string, skills: string[]): Exercise {
  return {
    id,
    kind: 'write',
    title: `Задание ${id}`,
    statement: 'Условие',
    constraints: [],
    filename: 'main.py',
    starterCode: '',
    tests: [{ id: 't1', kind: 'io', expected: '1', example: true }],
    rules: [],
    criteria: ['Верный вывод'],
    hints: ['a', 'b', 'c'],
    solution: { code: 'print(1)', explanation: 'x' },
    wrongSolutions: [{ code: 'print(2)', note: 'x' }],
    altSolutions: [],
    mistakes: [],
    skills,
  };
}

function lesson(id: string, exercises: Exercise[], skills: string[] = ['s1']): Lesson {
  return {
    id,
    module: 'm0',
    number: '0.1',
    title: `Урок ${id}`,
    objective: 'Цель',
    minutes: [20, 30],
    prerequisites: [],
    skills,
    environment: 'python',
    story: { title: 'История', text: 'Раз. Два. Три.', fictional: true },
    why: 'Зачем',
    usedIn: 'Где',
    steps: [
      ...exercises.map((item) => ({ id: `step-${item.id}`, title: 'Практика', type: 'exercise' as const, exercise: item })),
      { id: 'recap', type: 'recap' as const, title: 'Итог', points: ['a', 'b'], question: 'q', answer: 'a' },
    ],
  };
}

function record(exerciseId: string, patch: Partial<ExerciseRecord>): ExerciseRecord {
  return {
    exerciseId,
    lessonId: 'l1',
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
    updatedAt: 0,
    ...patch,
  };
}

function lessonRecord(lessonId: string, patch: Partial<LessonRecord> = {}): LessonRecord {
  return {
    lessonId,
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
    ...patch,
  };
}

const passed = (id: string, help: 0 | 1 | 2 | 3 | 4, at = 10) =>
  record(id, { status: 'passed', checks: 1, firstPassedAt: at, firstPassHelp: help });

function review(patch: Partial<ReviewRecord>): ReviewRecord {
  return {
    key: 'exercise:e1',
    lessonId: 'l1',
    exerciseId: 'e1',
    stage: 0,
    dueAt: 100,
    reason: 'x',
    createdAt: 1,
    updatedAt: 1,
    doneAt: null,
    ...patch,
  };
}

/** Урок без заданий: два чек-листа (как «Мастерская на компьютере») и итог. */
function setupLesson(id: string, skills: string[] = ['setup']): Lesson {
  return {
    ...lesson(id, [], skills),
    environment: 'external',
    steps: [
      { id: 'install', type: 'checklist', title: 'Установи', body: 'b', items: [{ id: 'a', text: 'a' }, { id: 'b', text: 'b' }] },
      { id: 'run', type: 'checklist', title: 'Запусти', body: 'b', items: [{ id: 'c', text: 'c' }] },
      { id: 'recap', type: 'recap', title: 'Итог', points: ['a', 'b'], question: 'q', answer: 'a' },
    ],
  };
}

describe('skillProgress', () => {
  const lessons = [lesson('l1', [exercise('e1', ['s1']), exercise('e2', ['s1']), exercise('e3', ['s2'])])];

  it('без попыток — «не начат», открытый урок навыком не считается', () => {
    const result = skillProgress('s1', lessons, new Map([['l1', lessonRecord('l1')]]), new Map(), []);
    expect(result.state).toBe('not-started');
  });

  it('две самостоятельные победы — «освоен», с доказательствами', () => {
    const exercises = new Map([
      ['e1', passed('e1', 0, 5)],
      ['e2', passed('e2', 1, 6)],
    ]);
    const result = skillProgress('s1', lessons, new Map(), exercises, []);
    expect(result.state).toBe('mastered');
    expect(result.evidence.map((item) => item.exerciseId)).toEqual(['e1', 'e2']);
  });

  it('решение после просмотра эталона — «нужна практика», а не «освоен»', () => {
    const exercises = new Map([
      ['e1', passed('e1', 4)],
      ['e2', passed('e2', 0)],
    ]);
    expect(skillProgress('s1', lessons, new Map(), exercises, []).state).toBe('practice');
  });

  it('попытки без решения — «изучаю»', () => {
    const exercises = new Map([['e1', record('e1', { status: 'attempted', checks: 3 })]]);
    expect(skillProgress('s1', lessons, new Map(), exercises, []).state).toBe('learning');
  });

  it('наступившее повторение не даёт считать навык освоенным', () => {
    const exercises = new Map([
      ['e1', passed('e1', 0)],
      ['e2', passed('e2', 0)],
    ]);
    expect(skillProgress('s1', lessons, new Map(), exercises, [review({})], 200).state).toBe('practice');
  });

  it('повторение темы урока относится к навыкам этого урока', () => {
    const exercises = new Map([
      ['e1', passed('e1', 0)],
      ['e2', passed('e2', 0)],
    ]);
    const lessonReview = review({ key: 'lesson:l1', exerciseId: null });
    expect(skillProgress('s1', lessons, new Map(), exercises, [lessonReview], 200).state).toBe('practice');
    // Пока срок не наступил, навык остаётся освоенным.
    const later = review({ key: 'lesson:l1', exerciseId: null, dueAt: new Date(2026, 8, 27).getTime() });
    expect(skillProgress('s1', lessons, new Map(), exercises, [later], new Date(2026, 8, 26, 18).getTime()).state).toBe('mastered');
  });

  it('навык без заданий не «освоен» от одного нажатия «Завершить урок»', () => {
    const local = [setupLesson('l2')];
    const result = skillProgress('setup', local, new Map([['l2', lessonRecord('l2', { completedAt: 5 })]]), new Map(), []);
    expect(result.state).toBe('learning');
    expect(result.selfReported).toBe(true);
    expect(result.selfMarks).toEqual([
      { lessonId: 'l2', lessonTitle: 'Урок l2', checklistDone: 0, checklistTotal: 3, selfCheck: null, completedAt: 5 },
    ]);
  });

  it('навык без заданий «освоен» по отметкам: все пункты чек-листов и «Понимаю»', () => {
    const local = [setupLesson('l2')];
    const marked = lessonRecord('l2', {
      completedAt: 5,
      checklists: { install: ['a', 'b'], run: ['c'] },
      recap: { answer: '', selfCheck: 'understood' },
    });
    const result = skillProgress('setup', local, new Map([['l2', marked]]), new Map(), []);
    expect(result.state).toBe('mastered');
    expect(result.selfMarks?.[0]).toMatchObject({ checklistDone: 3, checklistTotal: 3, selfCheck: 'understood' });

    const partial = { ...marked, checklists: { install: ['a'], run: ['c'] } };
    expect(skillProgress('setup', local, new Map([['l2', partial]]), new Map(), []).state).toBe('learning');
    const unsure = { ...marked, recap: { answer: '', selfCheck: 'partly' as const } };
    expect(skillProgress('setup', local, new Map([['l2', unsure]]), new Map(), []).state).toBe('practice');
  });
});

describe('lessonState и moduleState', () => {
  const l1 = lesson('l1', [exercise('e1', ['s1'])]);
  const file: ModuleFile = { id: 'm0', lessons: [l1] };
  const summary = { id: 'm0', status: 'ready' } as ModuleSummary;

  it('урок не завершён, пока задание не решено', () => {
    const state = lessonState(l1, lessonRecord('l1', { completedAt: 5 }), new Map([['e1', record('e1', { status: 'attempted' })]]));
    expect(state).toBe('learning');
  });

  it('завершённый урок с самостоятельным решением — «освоен»', () => {
    const exercises = new Map([['e1', passed('e1', 0)]]);
    expect(lessonState(l1, lessonRecord('l1', { completedAt: 5 }), exercises)).toBe('mastered');
    expect(moduleState(summary, file, new Map([['l1', lessonRecord('l1', { completedAt: 5 })]]), exercises)).toBe('mastered');
  });

  it('самооценка «пока нет» и «частично» — «нужна практика»', () => {
    const exercises = new Map([['e1', passed('e1', 0)]]);
    const rec = lessonRecord('l1', { completedAt: 5, recap: { answer: '', selfCheck: 'not-yet' } });
    expect(lessonState(l1, rec, exercises)).toBe('practice');
    const partly = lessonRecord('l1', { completedAt: 5, recap: { answer: '', selfCheck: 'partly' } });
    expect(lessonState(l1, partly, exercises)).toBe('practice');
  });

  it('урок и навык по одним порогам: решено со второй подсказкой — «нужна практика», а не «освоен»', () => {
    const exercises = new Map([['e1', passed('e1', 2)]]);
    const rec = lessonRecord('l1', { completedAt: 5 });
    expect(lessonState(l1, rec, exercises)).toBe('practice');
    expect(moduleState(summary, file, new Map([['l1', rec]]), exercises)).toBe('practice');
    expect(skillProgress('s1', [l1], new Map([['l1', rec]]), exercises, []).state).toBe('practice');
    // С первой подсказкой — ещё самостоятельно.
    expect(lessonState(l1, rec, new Map([['e1', passed('e1', 1)]]))).toBe('mastered');
  });

  it('наступившее повторение урока — «нужна практика»', () => {
    const exercises = new Map([['e1', passed('e1', 0)]]);
    const rec = lessonRecord('l1', { completedAt: 5 });
    const due = review({ key: 'lesson:l1', exerciseId: null, dueAt: 100 });
    expect(lessonState(l1, rec, exercises, [due], 200)).toBe('practice');
    expect(lessonState(l1, rec, exercises, [{ ...due, doneAt: 150 }], 200)).toBe('mastered');
  });

  it('урок без заданий: «Завершить урок» без отметок — «изучаю»', () => {
    const setup = setupLesson('l3');
    expect(lessonState(setup, lessonRecord('l3', { completedAt: 5 }), new Map())).toBe('learning');
    const marked = lessonRecord('l3', {
      completedAt: 5,
      checklists: { install: ['a', 'b'], run: ['c'] },
      recap: { answer: '', selfCheck: 'understood' },
    });
    expect(lessonState(setup, marked, new Map())).toBe('mastered');
  });

  it('модуль с неготовыми уроками не бывает «освоен»', () => {
    const exercises = new Map([['e1', passed('e1', 0)]]);
    const partial = { id: 'm0', status: 'partial' } as ModuleSummary;
    expect(moduleState(partial, file, new Map([['l1', lessonRecord('l1', { completedAt: 5 })]]), exercises)).toBe('learning');
  });

  it('следующий урок — первый незавершённый', () => {
    const l2 = lesson('l2', [exercise('e2', ['s1'])]);
    const course = { modules: [{ id: 'm0' }] } as unknown as Parameters<typeof suggestNextLesson>[0];
    const files = new Map([['m0', { id: 'm0', lessons: [l1, l2] }]]);
    const exercises = new Map([['e1', passed('e1', 0)]]);
    const next = suggestNextLesson(course, files, new Map([['l1', lessonRecord('l1', { completedAt: 5 })]]), exercises);
    expect(next?.lesson.id).toBe('l2');
  });

  it('завершённый учеником урок без отметок не предлагается снова, хотя и не освоен', () => {
    const setup = setupLesson('l0');
    const l2 = lesson('l2', [exercise('e2', ['s1'])]);
    const course = { modules: [{ id: 'm0' }] } as unknown as Parameters<typeof suggestNextLesson>[0];
    const files = new Map([['m0', { id: 'm0', lessons: [setup, l2] }]]);
    const next = suggestNextLesson(course, files, new Map([['l0', lessonRecord('l0', { completedAt: 5 })]]), new Map());
    expect(next?.lesson.id).toBe('l2');
  });
});

describe('splitReviews', () => {
  const evening = new Date(2026, 8, 26, 18, 0).getTime();
  const tomorrow = new Date(2026, 8, 27).getTime();

  it('повторение на завтра вечером сегодня ещё не наступило', () => {
    const result = splitReviews([review({ key: 'a', dueAt: tomorrow })], evening);
    expect(result.due).toEqual([]);
    expect(result.upcoming.map((item) => item.key)).toEqual(['a']);
  });

  it('с утра нужного дня повторение наступило; закрытые не показываются', () => {
    const morning = new Date(2026, 8, 27, 7, 0).getTime();
    const result = splitReviews(
      [review({ key: 'b', dueAt: tomorrow }), review({ key: 'a', dueAt: tomorrow - 86_400_000 }), review({ key: 'c', doneAt: 1 })],
      morning,
    );
    expect(result.due.map((item) => item.key)).toEqual(['a', 'b']);
    expect(result.upcoming).toEqual([]);
  });
});
