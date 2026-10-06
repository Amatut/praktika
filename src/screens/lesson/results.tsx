// Результаты запуска и проверки — нижняя панель «Проверка / Вывод» в духе тест-раннера: строка прогона,
// итог, тесты строками (значок в колонке полей редактора, название, статус словом, причина), раскрытый тест —
// «ввод / ожидалось / получилось». «Вывод» — консоль программы и файлы, которые она создала.

import { ChevronRight, CircleCheck, CircleStop, CircleX, Hourglass, ListChecks, Play, type LucideIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { testLabel } from '../../coach/feedback.ts';
import { StatusLine, plural } from '../../components/ui.tsx';
import type { ContentTest, Exercise } from '../../content/schema.ts';
import type { CheckOutcome, RunOutcome } from '../../runner/runner.ts';
import type { OutputDiff, TestResult, TranscriptPart } from '../../runner/types.ts';
import { onlyRulesFailed } from './check-summary.ts';
import { ChangedFiles } from './environment.tsx';

/** Последнее действие в задании: проверка (с кодом на тот момент) или запуск (с вводом). */
export type LastRun = { kind: 'check'; outcome: CheckOutcome; code: string } | { kind: 'run'; outcome: RunOutcome; stdin: string };

export function Transcript({ parts, empty = 'Программа ничего не вывела.' }: { parts: TranscriptPart[]; empty?: string }) {
  if (parts.length === 0) return <p className="console console-empty">{empty}</p>;
  return (
    <pre className="console" aria-label="Вывод программы" tabIndex={0}>
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

/** Строка прогона («Проверка main.py · 4 теста»): значок в колонке полей редактора, текст — на линии кода. */
export function RunLine({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <p className="results-run">
      <Icon aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

/** Ожидание в панели результатов: спиннер + слово. */
export function RunState({ children }: { children: ReactNode }) {
  return (
    <p className="results-wait" role="status">
      <span className="spinner" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

/** «2, 3» — ввод строками через запятую. */
export function inputSummary(stdin: string): string {
  return stdin.trim().split('\n').join(', ');
}

/** Значение в причине теста видно без раскрытия, если оно короткое и в одну строку. */
const REASON_VALUE_MAX = 30;

function shortValue(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null;
  const value = text.replace(/\n$/, '');
  return value !== '' && !value.includes('\n') && value.length <= REASON_VALUE_MAX ? value : null;
}

/** «ожидалось 3800 · получилось 15002300»: слова — тоном причины, значения — кодом. */
function ExpectedGot({ prefix, expected, actual }: { prefix?: string; expected: string; actual: string }) {
  return (
    <>
      {prefix}ожидалось <span className="reason-val">{expected}</span> · получилось <span className="reason-val">{actual}</span>
    </>
  );
}

export function shortReason(result: TestResult): ReactNode {
  if (result.interrupted === 'timeout') return 'не завершился вовремя';
  if (result.interrupted === 'stopped') return 'остановлен';
  if (result.interrupted === 'skipped') return 'проверка прервана — результат неизвестен';
  if (result.passed) return 'пройден';
  if (result.error) return result.error.origin === 'check' ? `ошибка проверки: ${result.error.type}` : `ошибка ${result.error.type}`;
  if (result.limit) return 'слишком много вывода';
  if (result.kind === 'call') {
    const expected = shortValue(result.expected);
    const actual = shortValue(result.actual);
    if (expected && actual) return <ExpectedGot expected={expected} actual={actual} />;
    return `ожидалось ${result.expected}, получилось ${result.actual ?? '—'}`;
  }
  if (result.kind === 'assert') return result.message ?? 'условие не выполнено';
  return diffValues(result) ?? describeDiff(result.diff ?? null);
}

/**
 * Различие вывода значениями: весь вывод в одну строку — «ожидалось 3800 · получилось 15002300»,
 * иначе — «строка 2: ожидалось Какао · получилось какао». Отличие в пробелах значениями не показать — словами.
 */
function diffValues(result: TestResult): ReactNode | null {
  const diff = result.diff;
  if (!diff || diff.kind !== 'mismatch' || diff.hint === 'spaces') return null;
  const expected = shortValue(diff.expectedLine);
  const actual = shortValue(diff.actualLine);
  if (!expected || !actual) return null;
  const oneLine = shortValue(result.expected) !== null && shortValue(result.output) !== null;
  return <ExpectedGot prefix={oneLine || !diff.line ? undefined : `строка ${diff.line}: `} expected={expected} actual={actual} />;
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
  const failed = !result.passed && !result.interrupted;
  const expectedText =
    test?.kind === 'io' && test.compare?.mode === 'regex' ? (test.expectedLabel ?? 'вывод по описанию в условии') : (result.expected ?? '');
  const got = (
    <dt className={failed ? 'is-got' : undefined}>
      {failed && <CircleX aria-hidden="true" />}
      Получилось
    </dt>
  );
  return (
    <div className="test-detail">
      {result.kind === 'assert' ? (
        <p className="test-message">{result.message}</p>
      ) : (
        <dl className="test-io">
          {result.kind === 'call' ? (
            <>
              <dt>Вызов</dt>
              <dd>
                <IoBlock text={result.call ?? ''} />
              </dd>
              <dt>Ожидалось</dt>
              <dd>
                <IoBlock text={result.expected ?? ''} />
              </dd>
              {got}
              <dd>
                <IoBlock text={result.error ? '—' : (result.actual ?? '')} />
              </dd>
            </>
          ) : (
            <>
              {result.stdin && (
                <>
                  <dt>Ввод</dt>
                  <dd>
                    <IoBlock text={result.stdin} />
                  </dd>
                </>
              )}
              <dt>Ожидалось</dt>
              <dd>
                <IoBlock text={expectedText} showSpaces={showSpaces} />
              </dd>
              {got}
              <dd>
                <IoBlock text={result.interrupted ? '—' : result.output} showSpaces={showSpaces} emptyLabel="ничего" />
              </dd>
            </>
          )}
        </dl>
      )}
      {result.error && (
        <StatusLine tone="err" icon={CircleX} className="is-long">
          {result.error.line ? `Строка ${result.error.line}: ` : ''}
          <span className="mono">{result.error.summary}</span>
        </StatusLine>
      )}
      {result.limit && <StatusLine tone="err">Вывод превысил допустимый объём — программа остановлена.</StatusLine>}
      <ChangedFiles files={result.files} />
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
        // Остановлен учеником или не дошла очередь — не ошибка кода: нейтральный тон. Тайм-аут — ошибка (цикл не кончается).
        const state = result.passed ? 'pass' : result.interrupted === 'skipped' || result.interrupted === 'stopped' ? 'skip' : 'fail';
        const Icon = result.passed ? CircleCheck : result.interrupted === 'stopped' ? CircleStop : result.interrupted ? Hourglass : CircleX;
        const word = result.passed
          ? 'прошёл'
          : result.interrupted === 'skipped'
            ? 'не проверен'
            : result.interrupted === 'stopped'
              ? 'остановлен'
              : result.interrupted
                ? 'прерван'
                : 'не прошёл';
        const expanded = open === result.id;
        return (
          <li key={result.id} className="test-item" data-state={state}>
            <button type="button" className="test-row" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : result.id)}>
              <span className="test-gut" aria-hidden="true">
                <ChevronRight className="test-chev" />
                <Icon className="test-ic" />
              </span>
              <span className="test-main">
                <span className="test-name">{label}</span>
                <span className="test-state">{word}</span>
                {!result.passed && result.interrupted !== 'stopped' && <span className="test-reason">{shortReason(result)}</span>}
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

/** Время запуска по-русски: «0,6 мс», «12 мс»; меньше миллисекунды — «< 1 мс». */
const MS_FORMAT = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });

export function formatMs(ms: number): string {
  return ms < 1 ? '< 1' : MS_FORMAT.format(ms);
}

/** Число — моноширинным, знак «<» — шрифтом строки, чтобы не растягивался. */
function Duration({ ms }: { ms: number }) {
  return (
    <>
      {ms < 1 ? (
        <>
          &lt;{'\u00a0'}
          <span className="n">1</span>
        </>
      ) : (
        <span className="n">{formatMs(ms)}</span>
      )}{' '}
      мс
    </>
  );
}

/**
 * Вкладка «Проверка»: строка прогона, итог (точные формулировки — на них опираются проверки), тесты.
 * state — строка ожидания или сбоя Python: до первой проверки — вместо пустого состояния, во время проверки —
 * под строкой прогона, после — под итогом. checking — идёт проверка: прежние результаты не показываются.
 */
export function CheckView({
  exercise,
  outcome,
  results,
  state,
  checking = false,
}: {
  exercise: Exercise;
  outcome: CheckOutcome | null;
  results: TestResult[];
  state?: ReactNode;
  checking?: boolean;
}) {
  const count = exercise.tests.length;
  const runLine = (
    <RunLine icon={ListChecks}>
      Проверка <span className="file">{exercise.filename}</span> · <span className="n">{count}</span> {plural(count, ['тест', 'теста', 'тестов'])}
    </RunLine>
  );
  if (checking || !outcome) {
    return (
      <>
        {runLine}
        {state ?? <p className="results-empty">Проверки ещё не было</p>}
      </>
    );
  }
  if (outcome.status === 'failed') {
    return (
      <>
        {runLine}
        <div className="results-summary">
          <StatusLine tone="warn" className="is-long">
            <span className="status-lead">Проверка не выполнена:</span> {outcome.message} Это не ошибка в твоём коде.
          </StatusLine>
        </div>
        {state}
      </>
    );
  }
  if (outcome.status === 'done' && outcome.result.compileError) {
    const error = outcome.result.compileError;
    return (
      <>
        {runLine}
        <div className="results-summary">
          <StatusLine tone="err" icon={CircleX}>
            Код не запустился: {error.type}
            {error.line ? ` в строке ${error.line}` : ''}
          </StatusLine>
        </div>
        {state}
      </>
    );
  }
  const ok = checkPassed(outcome);
  const failedRules = outcome.status === 'done' ? outcome.result.rules.filter((rule) => !rule.passed) : [];
  const passedCount = results.filter((result) => result.passed).length;
  return (
    <>
      {runLine}
      <div className="results-summary">
        {ok ? (
          <StatusLine tone="ok">
            Все проверки пройдены: {results.length} из {results.length}
          </StatusLine>
        ) : outcome.status === 'timeout' ? (
          <StatusLine tone="err" icon={Hourglass}>
            Программа работала дольше {Math.round(outcome.limitMs / 1000)} с и была остановлена
          </StatusLine>
        ) : outcome.status === 'stopped' ? (
          <StatusLine tone="muted" icon={CircleStop}>
            Проверка остановлена
          </StatusLine>
        ) : onlyRulesFailed(outcome) ? (
          <StatusLine tone="err" icon={CircleX}>
            Тесты пройдены: {passedCount} из {results.length}, но не выполнено требование к коду
          </StatusLine>
        ) : (
          <StatusLine tone="err" icon={CircleX}>
            Пройдено {passedCount} из {results.length}
            {failedRules.length > 0 ? ' · не выполнено требование к коду' : ''}
          </StatusLine>
        )}
        {failedRules.map((rule) => (
          <StatusLine key={rule.id} tone="err" icon={CircleX} className="is-long">
            {rule.message}
          </StatusLine>
        ))}
      </div>
      {state}
      <TestList
        key={outcome.status === 'done' ? JSON.stringify(results.map((result) => result.passed)) : outcome.status}
        exercise={exercise}
        results={results}
      />
    </>
  );
}

/**
 * Вкладка «Вывод»: что напечатала программа при «Запустить» или в первой непройденной проверке.
 * state — как у «Проверки»: до первого запуска и во время запуска — вместо содержимого, после — в конце.
 */
export function OutputView({
  last,
  file,
  state,
  running = false,
}: {
  last: LastRun | null;
  file: string;
  state?: ReactNode;
  running?: boolean;
}) {
  if (running || !last) return state ?? <p className="results-empty results-empty-solo">Запусков ещё не было</p>;
  return (
    <>
      <OutputContent last={last} file={file} />
      {state}
    </>
  );
}

function OutputContent({ last, file }: { last: LastRun; file: string }) {
  if (last.kind === 'check') {
    if (last.outcome.status !== 'done') return <p className="results-empty results-empty-solo">Вывода нет: проверка прервана.</p>;
    const tests = last.outcome.result.tests;
    const shown = tests.find((test) => !test.passed) ?? tests[0];
    if (!shown) return <p className="results-empty results-empty-solo">Вывода нет.</p>;
    return (
      <>
        <RunLine icon={ListChecks}>
          Проверка <span className="n">{tests.indexOf(shown) + 1}</span>
          {shown.stdin ? (
            <>
              {' '}
              · ввод <span className="n">{inputSummary(shown.stdin)}</span>
            </>
          ) : null}
        </RunLine>
        <Transcript parts={shown.transcript} />
        <ChangedFiles files={shown.files} />
      </>
    );
  }
  const outcome = last.outcome;
  if (outcome.status === 'timeout') {
    return (
      <StatusLine tone="err" icon={Hourglass}>
        Программа работала дольше {Math.round(outcome.limitMs / 1000)} с и была остановлена · Python перезапущен
      </StatusLine>
    );
  }
  if (outcome.status === 'stopped') {
    return (
      <StatusLine tone="muted" icon={CircleStop}>
        Программа остановлена
      </StatusLine>
    );
  }
  if (outcome.status === 'failed') {
    return (
      <StatusLine tone="warn" className="is-long">
        {outcome.message}
      </StatusLine>
    );
  }
  const result = outcome.result;
  const runLine = (
    <RunLine icon={Play}>
      Запуск <span className="file">{file}</span> · {last.stdin.trim() ? <>ввод <span className="n">{inputSummary(last.stdin)}</span></> : 'без ввода'}
      {result.durationMs !== undefined && (
        <>
          {' '}
          · <Duration ms={result.durationMs} />
        </>
      )}
    </RunLine>
  );
  if (result.compileError) {
    return (
      <>
        {runLine}
        <StatusLine tone="err" icon={CircleX} className="is-long">
          {result.compileError.line ? `Строка ${result.compileError.line}: ` : ''}
          <span className="mono">{result.compileError.summary}</span> — программа не запустилась
        </StatusLine>
      </>
    );
  }
  return (
    <>
      {runLine}
      <Transcript parts={result.transcript ?? []} />
      {result.error && (
        <StatusLine tone="err" icon={CircleX} className="is-long">
          {result.error.line ? `Строка ${result.error.line}: ` : ''}
          <span className="mono">{result.error.summary}</span>
        </StatusLine>
      )}
      {result.limit && <StatusLine tone="err">Слишком много вывода — программа остановлена.</StatusLine>}
      <ChangedFiles files={result.files} />
    </>
  );
}
