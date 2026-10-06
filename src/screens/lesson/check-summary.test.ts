import { describe, expect, it } from 'vitest';
import type { CheckOutcome } from '../../runner/runner.ts';
import type { CheckResult, TestResult } from '../../runner/types.ts';
import { testCounts } from './check-summary.ts';

function test(passed: boolean, id = 't'): TestResult {
  return { id, kind: 'io', passed, stdin: '', output: '', transcript: [], error: null, limit: false, truncated: false, exitCode: 0, durationMs: 1 };
}

function done(result: Partial<CheckResult>): CheckOutcome {
  return { status: 'done', result: { compileError: null, rules: [], tests: [], ...result } };
}

describe('счёт проверки для бейджей и строки состояния', () => {
  it('считается по тестам', () => {
    const tests = [test(true, 'a'), test(false, 'b'), test(false, 'c')];
    expect(testCounts(done({ tests }), tests, 3)).toEqual({ failed: 2, passed: 1, total: 3 });
    expect(testCounts(null, [], 3)).toBeNull();
  });

  it('код не запустился — не пройдена ни одна', () => {
    const outcome = done({ compileError: { phase: 'compile', type: 'SyntaxError', line: 1, summary: 's' } as CheckResult['compileError'] });
    expect(testCounts(outcome, [], 4)).toEqual({ failed: 4, passed: 0, total: 4 });
  });

  it('тайм-аут — один непройденный тест, «Остановить» счёта не даёт', () => {
    const timeout: CheckOutcome = { status: 'timeout', limitMs: 3000, testIndex: 1 };
    expect(testCounts(timeout, [test(false, 'a'), test(false, 'b')], 2)).toEqual({ failed: 1, passed: 0, total: 2 });
    expect(testCounts({ status: 'stopped', testIndex: 0 }, [test(false)], 1)).toBeNull();
    expect(testCounts({ status: 'failed', message: 'x' } as CheckOutcome, [], 1)).toBeNull();
  });
});
