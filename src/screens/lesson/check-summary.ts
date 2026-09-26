// Итог проверки задания словами и числами: объявление для скринридера, счётчик на вкладке
// и число непройденных проверок для попытки. Считается по типу результата, а не только по тестам:
// у кода с синтаксической ошибкой тестов нет вовсе, а требование к коду — не тест.

import type { CheckOutcome } from '../../runner/runner.ts';
import type { TestResult } from '../../runner/types.ts';

/** Сколько проверок не пройдено (для записи попытки). Код не запустился или прерван — не пройдена ни одна. */
export function failedChecks(outcome: CheckOutcome, results: TestResult[], total: number): number {
  if (outcome.status !== 'done' || outcome.result.compileError) return total;
  return results.filter((test) => !test.passed).length;
}

/** Счётчик на вкладке «Проверка»: «2/3». Когда тесты не выполнялись (код не запустился), счётчика нет. */
export function testCounter(outcome: CheckOutcome | null, results: TestResult[]): string | null {
  if (outcome?.status !== 'done' || outcome.result.compileError || results.length === 0) return null;
  return `${results.filter((test) => test.passed).length}/${results.length}`;
}

/** Требование к коду не выполнено, хотя все тесты пройдены. */
export function onlyRulesFailed(outcome: CheckOutcome | null): boolean {
  if (outcome?.status !== 'done' || outcome.result.compileError) return false;
  const { rules, tests } = outcome.result;
  return tests.every((test) => test.passed) && rules.some((rule) => !rule.passed);
}

/** Короткое объявление результата проверки. */
export function checkAnnouncement(outcome: CheckOutcome, results: TestResult[]): string {
  switch (outcome.status) {
    case 'stopped':
      return 'Проверка остановлена.';
    case 'failed':
      return 'Python не смог выполнить проверку.';
    case 'timeout':
      return `Программа работала дольше ${Math.round(outcome.limitMs / 1000)} с и была остановлена. Разбор — у наставника.`;
  }
  const { compileError, rules } = outcome.result;
  if (compileError) {
    return `Проверка не прошла: код не запустился (${compileError.type}${compileError.line ? `, строка ${compileError.line}` : ''}). Разбор — у наставника.`;
  }
  const failed = results.filter((test) => !test.passed).length;
  if (failed > 0) return `Не пройдено: ${failed} из ${results.length}. Разбор — у наставника.`;
  if (rules.some((rule) => !rule.passed)) return 'Тесты пройдены, но не выполнено требование к коду. Разбор — у наставника.';
  return 'Все проверки пройдены.';
}
