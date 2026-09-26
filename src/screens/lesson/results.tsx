// Результаты запуска и проверки: список тестов (ввод, ожидалось, получилось, причина)
// и консоль с выводом программы.

import { CircleCheck, CircleX, Hourglass } from 'lucide-react';
import { useState } from 'react';
import { testLabel } from '../../coach/feedback.ts';
import type { ContentTest, Exercise } from '../../content/schema.ts';
import type { CheckOutcome } from '../../runner/runner.ts';
import type { OutputDiff, TestResult, TranscriptPart } from '../../runner/types.ts';

export function Transcript({ parts, empty = 'Программа ничего не вывела.' }: { parts: TranscriptPart[]; empty?: string }) {
  if (parts.length === 0) return <div className="console console-empty">{empty}</div>;
  return (
    <pre className="console" aria-label="Вывод программы">
      {parts.map(([kind, text], index) => (
        <span key={index} className={kind === 'out' ? undefined : `t-${kind}`}>
          {text}
        </span>
      ))}
    </pre>
  );
}

/** Текст в моноширинном блоке; при различии в пробелах пробелы становятся видимыми. */
export function IoBlock({ text, showSpaces = false, emptyLabel = 'пусто' }: { text: string; showSpaces?: boolean; emptyLabel?: string }) {
  const value = text.replace(/\n$/, '');
  if (value === '') {
    return (
      <pre className="io-block">
        <span className="empty-mark">{emptyLabel}</span>
      </pre>
    );
  }
  if (!showSpaces) return <pre className="io-block">{value}</pre>;
  return (
    <pre className="io-block">
      {value.split(/( +)/).map((part, index) =>
        /^ +$/.test(part) ? (
          <span key={index} className="ws" title="пробел">
            {'·'.repeat(part.length)}
          </span>
        ) : (
          part
        ),
      )}
    </pre>
  );
}

export function shortReason(result: TestResult): string {
  if (result.interrupted === 'timeout') return 'не завершился вовремя';
  if (result.interrupted === 'stopped') return 'остановлен';
  if (result.interrupted === 'skipped') return 'проверка прервана — результат неизвестен';
  if (result.passed) return 'пройден';
  if (result.error) return result.error.origin === 'check' ? `ошибка проверки: ${result.error.type}` : `ошибка ${result.error.type}`;
  if (result.limit) return 'слишком много вывода';
  if (result.kind === 'call') return `ожидалось ${result.expected}, получилось ${result.actual ?? '—'}`;
  if (result.kind === 'assert') return result.message ?? 'условие не выполнено';
  return describeDiff(result.diff ?? null);
}

function describeDiff(diff: OutputDiff | null): string {
  if (!diff) return 'вывод не совпал';
  switch (diff.kind) {
    case 'empty':
      return 'программа ничего не вывела';
    case 'missing':
      return diff.line ? `не хватает строки ${diff.line}` : 'не хватает части вывода';
    case 'extra':
      return `лишняя строка ${diff.line ?? ''}`.trim();
    case 'pattern':
      return 'вывод не подходит под описание';
    default:
      if (diff.hint === 'case') return `строка ${diff.line}: отличие в регистре букв`;
      if (diff.hint === 'spaces') return `строка ${diff.line}: отличие в пробелах`;
      return `строка ${diff.line} отличается`;
  }
}

function TestDetail({ result, test }: { result: TestResult; test: ContentTest | undefined }) {
  const showSpaces = result.diff?.hint === 'spaces';
  const expectedText =
    test?.kind === 'io' && test.compare?.mode === 'regex' ? (test.expectedLabel ?? 'вывод по описанию в условии') : (result.expected ?? '');
  return (
    <div className="test-detail">
      {result.kind === 'call' ? (
        <div className="io-grid">
          <div className="io-cell">
            <span className="label">Вызов</span>
            <IoBlock text={result.call ?? ''} />
          </div>
          <div className="io-cell">
            <span className="label">Ожидалось</span>
            <IoBlock text={result.expected ?? ''} />
          </div>
          <div className="io-cell">
            <span className="label">Получилось</span>
            <IoBlock text={result.error ? '—' : (result.actual ?? '')} />
          </div>
        </div>
      ) : result.kind === 'assert' ? (
        <p className="small">{result.message}</p>
      ) : (
        <div className="io-grid" style={result.stdin ? undefined : { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
          {result.stdin && (
            <div className="io-cell">
              <span className="label">Ввод</span>
              <IoBlock text={result.stdin} />
            </div>
          )}
          <div className="io-cell">
            <span className="label">Ожидалось</span>
            <IoBlock text={expectedText} showSpaces={showSpaces} />
          </div>
          <div className="io-cell">
            <span className="label">Получилось</span>
            <IoBlock text={result.interrupted ? '—' : result.output} showSpaces={showSpaces} emptyLabel="ничего" />
          </div>
        </div>
      )}
      {result.error && (
        <p className="small status-error">
          {result.error.line ? `Строка ${result.error.line}: ` : ''}
          <span className="mono">{result.error.summary}</span>
        </p>
      )}
      {result.limit && <p className="small status-error">Вывод превысил допустимый объём — программа остановлена.</p>}
    </div>
  );
}

export function TestList({ exercise, results }: { exercise: Exercise; results: TestResult[] }) {
  const [open, setOpen] = useState<string | null>(() => results.find((result) => !result.passed)?.id ?? null);
  return (
    <ul className="test-list" aria-label="Результаты проверок">
      {results.map((result, index) => {
        const test = exercise.tests.find((item) => item.id === result.id);
        const label = test ? testLabel(test, index) : `Проверка ${index + 1}`;
        const state = result.passed ? 'pass' : result.interrupted === 'skipped' ? 'skip' : 'fail';
        const Icon = result.passed ? CircleCheck : result.interrupted ? Hourglass : CircleX;
        const expanded = open === result.id;
        return (
          <li key={result.id} className="test-item" data-state={state}>
            <button
              type="button"
              className="test-row"
              aria-expanded={expanded}
              onClick={() => setOpen(expanded ? null : result.id)}
            >
              <Icon aria-hidden="true" className={result.passed ? 'status-good' : state === 'skip' ? 'status-muted' : 'status-error'} />
              <span>
                <span className="test-name">{label}</span>
                <span className="test-reason"> — {shortReason(result)}</span>
              </span>
            </button>
            {expanded && <TestDetail result={result} test={test} />}
          </li>
        );
      })}
    </ul>
  );
}

/** Результаты проверки с учётом прерванных тестов (тайм-аут или «Остановить»). */
export function resultsFromOutcome(exercise: Exercise, outcome: CheckOutcome): TestResult[] {
  if (outcome.status === 'done') return outcome.result.tests;
  if (outcome.status === 'timeout' || outcome.status === 'stopped') {
    return exercise.tests.map((test, index) => ({
      id: test.id,
      kind: test.kind,
      passed: false,
      stdin: test.stdin ?? '',
      expected: test.kind === 'assert' ? undefined : test.expected,
      call: test.kind === 'call' ? test.call : undefined,
      message: test.kind === 'assert' ? test.message : undefined,
      output: '',
      transcript: [],
      error: null,
      limit: false,
      truncated: false,
      exitCode: null,
      durationMs: 0,
      interrupted:
        index < outcome.testIndex ? 'skipped' : index === outcome.testIndex ? (outcome.status === 'timeout' ? 'timeout' : 'stopped') : 'skipped',
    }));
  }
  return [];
}

export function checkPassed(outcome: CheckOutcome | null): boolean {
  if (!outcome || outcome.status !== 'done') return false;
  const { compileError, rules, tests } = outcome.result;
  return !compileError && rules.every((rule) => rule.passed) && tests.every((test) => test.passed);
}

/** Тип ошибки попытки для статистики повторяющихся ошибок. */
export function attemptErrorType(outcome: CheckOutcome): string | null {
  if (outcome.status === 'timeout') return 'timeout';
  if (outcome.status !== 'done') return null;
  const { compileError, rules, tests } = outcome.result;
  if (compileError) return compileError.type;
  const errored = tests.find((test) => test.error);
  if (errored?.error) return errored.error.type;
  if (tests.some((test) => test.limit)) return 'limit';
  if (rules.some((rule) => !rule.passed)) return 'rule';
  if (tests.some((test) => !test.passed)) return 'output';
  return null;
}
