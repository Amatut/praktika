import { describe, expect, it } from 'vitest';
import type { SkillProgress } from '../../progress/model.ts';
import type { CheckOutcome } from '../../runner/runner.ts';
import type { CheckResult, TestResult } from '../../runner/types.ts';
import { checkAnnouncement, failedChecks, onlyRulesFailed, testCounter } from './check-summary.ts';
import { isActiveReview, lessonReviewKey, recapUnchanged, reviewReasonAfter } from './review.ts';
import { skillCardLines, skillIdsFor } from './skill-card.ts';

function test(passed: boolean, id = 't'): TestResult {
  return {
    id,
    kind: 'io',
    passed,
    stdin: '',
    output: '',
    transcript: [],
    error: null,
    limit: false,
    truncated: false,
    exitCode: 0,
    durationMs: 1,
  } as TestResult;
}

function done(result: Partial<CheckResult>): CheckOutcome {
  return { status: 'done', result: { compileError: null, rules: [], tests: [], ...result } };
}

describe('итог урока: что сохранять', () => {
  it('уход с пустого поля ничего не записывает, изменение — записывает', () => {
    expect(recapUnchanged(null, '', null)).toBe(true);
    expect(recapUnchanged({ answer: 'ответ', selfCheck: 'partly' }, 'ответ', 'partly')).toBe(true);
    expect(recapUnchanged({ answer: 'ответ', selfCheck: null }, '', null)).toBe(false);
    expect(recapUnchanged({ answer: 'ответ', selfCheck: null }, 'ответ', 'understood')).toBe(false);
    expect(recapUnchanged(null, 'новый', null)).toBe(false);
  });

  it('причина повторения обновляется по итогу', () => {
    expect(lessonReviewKey('m0-l1')).toBe('lesson:m0-l1');
    expect(reviewReasonAfter('lesson', true, 1)).toBe('Закрепляем: повторение 2 из 4');
    expect(reviewReasonAfter('lesson', true, 3)).toBe('Закрепляем: повторение 4 из 4');
    expect(reviewReasonAfter('lesson', false, 0)).toBe('При повторении тема пока не держится');
    expect(reviewReasonAfter('exercise', false, 0)).toBe('При повторении понадобилась помощь');
  });

  it('закрытое повторение не активно', () => {
    const base = { key: 'k', lessonId: 'l', exerciseId: null, stage: 0, dueAt: 0, reason: '', createdAt: 0, updatedAt: 0 };
    expect(isActiveReview({ ...base, doneAt: null })).toBe(true);
    expect(isActiveReview({ ...base, doneAt: 5 })).toBe(false);
    expect(isActiveReview(null)).toBe(false);
  });
});

describe('итог проверки задания', () => {
  it('синтаксическая ошибка: без счётчика 0/0, в попытке не пройдены все проверки', () => {
    const outcome = done({ compileError: { phase: 'compile', type: 'SyntaxError', line: 2, summary: 's' } as CheckResult['compileError'] });
    expect(testCounter(outcome, [])).toBeNull();
    expect(failedChecks(outcome, [], 3)).toBe(3);
    expect(checkAnnouncement(outcome, [])).toBe('Проверка не прошла: код не запустился (SyntaxError, строка 2). Разбор — у наставника.');
  });

  it('тесты пройдены, но правило не выполнено — так и сказано', () => {
    const tests = [test(true)];
    const outcome = done({ tests, rules: [{ id: 'r', passed: false, message: 'Используй цикл' }] as CheckResult['rules'] });
    expect(onlyRulesFailed(outcome)).toBe(true);
    expect(failedChecks(outcome, tests, 1)).toBe(0);
    expect(testCounter(outcome, tests)).toBe('1/1');
    expect(checkAnnouncement(outcome, tests)).toBe('Тесты пройдены, но не выполнено требование к коду. Разбор — у наставника.');
  });

  it('непройденные тесты считаются по тестам', () => {
    const tests = [test(true, 'a'), test(false, 'b'), test(false, 'c')];
    const outcome = done({ tests });
    expect(onlyRulesFailed(outcome)).toBe(false);
    expect(testCounter(outcome, tests)).toBe('1/3');
    expect(failedChecks(outcome, tests, 3)).toBe(2);
    expect(checkAnnouncement(outcome, tests)).toBe('Не пройдено: 2 из 3. Разбор — у наставника.');
    expect(checkAnnouncement(done({ tests: [test(true)] }), [test(true)])).toBe('Все проверки пройдены.');
  });

  it('прерванная проверка', () => {
    const timeout: CheckOutcome = { status: 'timeout', limitMs: 3000, testIndex: 0 };
    expect(testCounter(timeout, [test(false)])).toBeNull();
    expect(failedChecks(timeout, [test(false)], 2)).toBe(2);
    expect(checkAnnouncement(timeout, [])).toContain('дольше 3 с');
    expect(checkAnnouncement({ status: 'stopped', testIndex: 0 }, [])).toBe('Проверка остановлена.');
  });
});

describe('карточка навыков для наставника', () => {
  it('навыки задания идут первыми, без повторов', () => {
    expect(skillIdsFor({ skills: ['a', 'b'] }, { skills: ['b', 'c'] })).toEqual(['b', 'c', 'a']);
    expect(skillIdsFor({ skills: ['a'] }, null)).toEqual(['a']);
  });

  it('строки из настоящего прогресса, не больше шести', () => {
    const progress = new Map<string, SkillProgress>([
      [
        'print',
        {
          skillId: 'print',
          state: 'practice',
          evidence: [
            { exerciseId: 'e1', exerciseTitle: '', lessonId: 'l', help: 0, at: 1 },
            { exerciseId: 'e2', exerciseTitle: '', lessonId: 'l', help: 3, at: 2 },
          ],
          attemptedExercises: 2,
          totalExercises: 4,
          selfReported: false,
          dueReview: true,
        },
      ],
    ]);
    const skills = [
      { id: 'print', title: 'Вывод на экран' },
      { id: 'vars', title: 'Переменные' },
    ];
    expect(skillCardLines(skills, progress)).toEqual([
      'Вывод на экран: нужна практика; решено заданий 2 из 4, сам или с одной подсказкой — 1; ждёт повторения',
      'Переменные: не начат',
    ]);
    const many = Array.from({ length: 9 }, (_, index) => ({ id: `s${index}`, title: `Навык ${index}` }));
    expect(skillCardLines(many, new Map())).toHaveLength(6);
  });
});
