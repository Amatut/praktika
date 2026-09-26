// Тесты проверки материалов (scripts/verify-content.ts).
// Часть тестов запускает настоящий Python (Pyodide в отдельном процессе) — поэтому лимиты времени большие.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadContent } from '../build/content-lib.ts';
import { exerciseSchema, type Exercise, type Lesson, type PredictStep } from '../src/content/schema.ts';
import type { CheckPayload, CheckResult, RunResult, TestResult } from '../src/runner/types.ts';
import {
  checkCode,
  formatReport,
  formatSummary,
  NodePython,
  parseCli,
  selectLessons,
  UsageError,
  verifyContent,
  verifyExample,
  verifyExercise,
  verifyPredict,
  type CallOutcome,
  type Problem,
  type PythonExecutor,
  type VerifyReport,
} from './verify-content.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const sampleRoot = path.join(here, 'fixtures', 'sample');
const brokenRoot = path.join(here, 'fixtures', 'broken');
const PYTHON_TIMEOUT = 120_000;

const SOLUTION = 'a = int(input())\nb = int(input())\nprint(a + b)\n';
const STARTER = '# напиши программу\n';
const CONCAT = 'print(input() + input())\n';

function makeExercise(overrides: Record<string, unknown> = {}): Exercise {
  return exerciseSchema.parse({
    id: 'demo',
    kind: 'write',
    title: 'Сумма',
    statement: 'Выведи сумму двух чисел.',
    starterCode: STARTER,
    tests: [
      { id: 't1', kind: 'io', example: true, stdin: '2\n3\n', expected: '5' },
      { id: 't2', kind: 'io', example: true, stdin: '10\n-4\n', expected: '6' },
      { id: 't3', kind: 'io', stdin: '0\n0\n', expected: '0' },
    ],
    criteria: ['Выводится сумма.'],
    hints: ['Подумай о типах.', 'Пример: int("7").', 'Сложи два int(input()).'],
    solution: { code: SOLUTION, explanation: 'Числа складываются.' },
    wrongSolutions: [{ code: CONCAT, note: 'Склейка строк.', expectMistake: 'concat' }],
    mistakes: [{ id: 'concat', when: { outputEquals: '23' }, why: 'Строки склеиваются.', try: 'Используй int().' }],
    skills: ['demo'],
    ...overrides,
  });
}

function testResult(id: string, fields: Partial<TestResult> = {}): TestResult {
  return {
    id,
    kind: 'io',
    passed: true,
    stdin: '',
    output: '',
    transcript: [],
    error: null,
    limit: false,
    truncated: false,
    exitCode: null,
    durationMs: 1,
    ...fields,
  };
}

/** Что заглушка Python делает с тестом: результат, зависание или сбой самой проверки. */
type TestScript = Partial<TestResult> | 'timeout' | 'failed';

interface ScriptedOptions {
  /** По коду и id теста — что вернуть. По умолчанию тест проходит за 1 мс. */
  test?: (code: string, testId: string) => TestScript;
  /** Обычный запуск (predict, example, проверка самих тестов). По умолчанию — пустой вывод. */
  run?: (code: string, stdin: string, limitMs: number) => CallOutcome<RunResult>;
}

/** Python-заглушка: ведёт себя так, как скажет сценарий. */
class ScriptedPython implements PythonExecutor {
  requested: string[] = [];
  options: ScriptedOptions;
  constructor(options: ScriptedOptions = {}) {
    this.options = options;
  }
  async run(code: string, stdin: string, limitMs: number): Promise<CallOutcome<RunResult>> {
    return this.options.run?.(code, stdin, limitMs) ?? { status: 'done', result: { stdout: '', transcript: [], error: null, limit: false } };
  }
  async check(payload: CheckPayload, limitMs: number): Promise<CallOutcome<CheckResult>> {
    const tests = payload.tests as { id: string }[];
    const rules = payload.rules as { id: string; message: string }[];
    if (tests.length === 0) {
      return { status: 'done', result: { compileError: null, rules: rules.map((rule) => ({ ...rule, passed: true })), tests: [] } };
    }
    const id = tests[0]?.id ?? '';
    this.requested.push(id);
    const script = this.options.test?.(payload.code, id) ?? {};
    if (script === 'timeout') return { status: 'timeout', limitMs };
    if (script === 'failed') return { status: 'failed', message: 'ValueError: сбой внутри проверки' };
    return { status: 'done', result: { compileError: null, rules: [], tests: [testResult(id, script)] } };
  }
}

function fakeLesson(): Lesson {
  return { id: 'demo-lesson' } as Lesson;
}

function context(py: PythonExecutor, problems: Problem[], stepId = 'step') {
  return { py, lesson: fakeLesson(), stepId, timeoutMs: 1000, problems };
}

function predictStep(fields: Partial<PredictStep>): PredictStep {
  return {
    id: 'guess',
    type: 'predict',
    title: 'Прогноз',
    prompt: 'Что появится?',
    code: 'print(1)',
    answer: '1',
    explanation: 'Объяснение.',
    ...fields,
  };
}

interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[]): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    // Без переменных npm: иначе скрипт решит, что его запустили через npm run verify:content.
    const env = { ...process.env, npm_lifecycle_event: undefined, npm_config_json: undefined, npm_config_root: undefined };
    const child = spawn(process.execPath, [path.join(here, 'verify-content.ts'), ...args], { cwd: projectRoot, env });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function errorsOf(report: VerifyReport): Problem[] {
  return report.lessons.flatMap((lesson) => lesson.problems).filter((problem) => problem.severity === 'error');
}

function summaryOf(problems: Problem[]): string[] {
  return problems.map((problem) => `${problem.subject}:${problem.severity}:${problem.testId ?? ''}:${problem.message}`);
}

// ------------------------------------------------------------------ без Python

describe('parseCli', () => {
  it('разбирает id, --root, --json и --timeout', () => {
    const cli = parseCli(['m1', 'm0-l2', '--root', 'scripts/fixtures/sample', '--json', '--timeout', '2000'], projectRoot);
    expect(cli.only).toEqual(['m1', 'm0-l2']);
    expect(cli.root).toBe(sampleRoot);
    expect(cli.json).toBe(true);
    expect(cli.timeoutMs).toBe(2000);
    expect(cli.help).toBe(false);
  });

  it('по умолчанию проверяет корень проекта с лимитом 5 с', () => {
    const cli = parseCli([], projectRoot);
    expect(cli.root).toBe(projectRoot);
    expect(cli.only).toEqual([]);
    expect(cli.timeoutMs).toBe(5000);
    expect(cli.json).toBe(false);
  });

  it('отвергает неизвестные параметры и неверный лимит', () => {
    expect(() => parseCli(['--jsn'])).toThrow(UsageError);
    expect(() => parseCli(['--timeout', 'abc'])).toThrow(UsageError);
    expect(() => parseCli(['--timeout', '10'])).toThrow(/не меньше 100/);
  });

  it('не принимает путь за id урока', () => {
    expect(() => parseCli(['scripts/fixtures/sample'], projectRoot)).toThrow(/похоже на путь.*--root scripts\/fixtures\/sample/);
    expect(() => parseCli(['fixtures\\sample'], projectRoot)).toThrow(UsageError);
  });

  it('через npm без «--»: подсказывает, куда делись параметры, а --root=папка и --timeout=мс принимает', () => {
    const npm = { npm_lifecycle_event: 'verify:content' };
    // npm run verify:content --root scripts/fixtures/sample
    expect(() => parseCli(['scripts/fixtures/sample'], projectRoot, projectRoot, { ...npm, npm_config_root: 'true' })).toThrow(
      /npm забрал себе --root.*npm run verify:content -- --root <папка>/,
    );
    // npm run verify:content --json --timeout 3000
    expect(() =>
      parseCli(['3000'], projectRoot, projectRoot, { ...npm, npm_config_json: 'true', npm_config_timeout: 'true' }),
    ).toThrow(/npm забрал себе --timeout, --json — до проверки они не дошли/);
    // npm run verify:content --root=scripts/fixtures/sample --timeout=2500 fx-l1, запущенный из корня проекта.
    const cli = parseCli(['fx-l1'], path.join(projectRoot, 'src'), projectRoot, {
      ...npm,
      INIT_CWD: projectRoot,
      npm_config_root: 'scripts/fixtures/sample',
      npm_config_timeout: '2500',
    });
    expect(cli).toMatchObject({ only: ['fx-l1'], root: sampleRoot, timeoutMs: 2500, json: false });
    // Через «--» всё доходит само, переменные npm не мешают.
    expect(parseCli(['--json'], projectRoot, projectRoot, { ...npm, npm_config_json: 'true' }).json).toBe(true);
    // Другие npm-скрипты (например, npm test) переменные npm_config_* не трогают.
    expect(parseCli([], projectRoot, projectRoot, { npm_lifecycle_event: 'test', npm_config_json: 'true' }).json).toBe(false);
  });
});

describe('selectLessons', () => {
  it('выбирает уроки по id урока или модуля и сообщает о ненайденных', async () => {
    const content = await loadContent(sampleRoot);
    expect(selectLessons(content, []).lessons.map((lesson) => lesson.id)).toEqual(['fx-l1']);
    expect(selectLessons(content, ['fx']).lessons.map((lesson) => lesson.id)).toEqual(['fx-l1']);
    expect(selectLessons(content, ['fx-l1']).missing).toEqual([]);
    const unknown = selectLessons(content, ['nope']);
    expect(unknown.lessons).toEqual([]);
    expect(unknown.missing).toEqual(['не найден урок или модуль «nope»']);
  });

  it('сломанная фикстура проходит проверку формата — её отвергает только запуск кода', async () => {
    const content = await loadContent(brokenRoot);
    expect(content.lessons.map((lesson) => lesson.id)).toEqual(['bx-l1']);
    expect(content.warnings).toEqual([]);
  });
});

describe('checkCode и verifyExercise с заглушкой Python', () => {
  it('после зависания прекращает проверку, как приложение', async () => {
    const py = new ScriptedPython({ test: (_code, id) => (id === 't2' ? 'timeout' : {}) });
    const check = await checkCode(py, makeExercise(), 'while True: pass', 1000);
    expect(py.requested).toEqual(['t1', 't2']);
    expect(check.passed).toBe(false);
    expect(check.timedOut).toEqual({ testId: 't2', limitMs: 1000 });
    expect(check.result.tests.map((test) => [test.id, test.passed, test.interrupted])).toEqual([
      ['t1', true, undefined],
      ['t2', false, 'timeout'],
      ['t3', false, 'skipped'],
    ]);
  });

  it('засчитывает зависшее неверное решение как отклонённое, но не как ожидаемый разбор', async () => {
    // Эталон и стартовый код проходят, неверное решение зависает на первом тесте.
    const py = new ScriptedPython({ test: (code) => (code === CONCAT ? 'timeout' : {}) });
    const problems: Problem[] = [];
    const result = await verifyExercise(context(py, problems), makeExercise());
    expect(result.report.solutionPassed).toBe(true);
    expect(result.report.wrongSolutions[0]).toMatchObject({ rejected: true, timedOutTest: 't1', matchedMistake: null });
    const messages = problems.map((problem) => `${problem.subject}:${problem.severity}:${problem.message}`);
    expect(messages).toContain('starter:error:уже проходит все тесты и правила — ученику нечего делать в этом задании');
    expect(messages.some((message) => message.startsWith('wrong:error:зависает на тесте «Пример 1»'))).toBe(true);
  });

  it('эталон медленнее лимита приложения — ошибка, больше половины лимита — предупреждение', async () => {
    const script = (code: string, id: string): TestScript => {
      if (code === SOLUTION) return { durationMs: id === 't1' ? 3500 : id === 't2' ? 2000 : 1 };
      return { passed: false, output: code === CONCAT ? '23' : '' };
    };
    const problems: Problem[] = [];
    const slow = await verifyExercise(context(new ScriptedPython({ test: script }), problems), makeExercise());
    expect(summaryOf(problems)).toEqual([
      'solution:error:t1:не укладывается в лимит приложения: тест «Пример 1» занимает 3,5 с, а лимит — 3 с; у ученика проверка остановится по тайм-ауту',
      'solution:warning:t2:эталон проходит тест «Пример 2» за 2 с — больше половины лимита приложения (3 с): на медленном устройстве может не уложиться',
    ]);
    expect(slow.report.solutionPassed).toBe(false);
    expect(slow.report.solution).toMatchObject({ passed: false, failedTests: [], overAppLimitTests: ['t1'] });
    expect(slow.report.wrongSolutions[0]).toMatchObject({ rejected: true, matchedMistake: 'concat' });

    // С timeLimitMs: 10000 те же 3,5 с укладываются с запасом.
    const relaxed: Problem[] = [];
    const ok = await verifyExercise(context(new ScriptedPython({ test: script }), relaxed), makeExercise({ timeLimitMs: 10_000 }));
    expect(relaxed).toEqual([]);
    expect(ok.report.solutionPassed).toBe(true);
  });

  it('неверное решение с expectMistake медленнее лимита приложения — ошибка, а не подтверждённый разбор', async () => {
    const py = new ScriptedPython({
      test: (code) => (code === SOLUTION ? {} : { passed: false, output: code === CONCAT ? '23' : '', durationMs: 3200 }),
    });
    const problems: Problem[] = [];
    const result = await verifyExercise(context(py, problems), makeExercise());
    expect(result.report.wrongSolutions[0]).toMatchObject({ rejected: true, matchedMistake: null, overAppLimitTests: ['t1', 't2', 't3'] });
    const wrong = problems.find((problem) => problem.subject === 'wrong');
    expect(wrong).toMatchObject({ severity: 'error', testId: 't1' });
    expect(wrong?.message).toBe(
      'не укладывается в лимит приложения на тесте «Пример 1» (3,2 с при лимите 3 с): ученик увидит сообщение о слишком долгой работе, а не разбор «concat»',
    );
  });

  it('сбой самой проверки — не отклонение: ошибка и для неверного решения, и для стартового кода', async () => {
    const py = new ScriptedPython({
      test: (code, id) => {
        if (code === SOLUTION) return {};
        if (code === STARTER) return id === 't2' ? 'failed' : { passed: false };
        return id === 't1' ? 'failed' : { passed: false };
      },
    });
    const problems: Problem[] = [];
    const exercise = makeExercise({ wrongSolutions: [{ code: CONCAT, note: 'Склейка строк.' }], mistakes: [] });
    const result = await verifyExercise(context(py, problems), exercise);
    expect(summaryOf(problems)).toEqual([
      'starter:error::проверка завершилась сбоем — ученик увидит «Python не смог выполнить проверку», а не проваленный тест',
      'wrong:error::проверка завершилась сбоем — ученик увидит «Python не смог выполнить проверку», а не проваленный тест',
    ]);
    expect(problems[1]?.details).toContain('  сбой проверки: ValueError: сбой внутри проверки');
    expect(result.report.starter).toMatchObject({ passed: false, checkFailures: ['t2: ValueError: сбой внутри проверки'] });
    expect(result.report.wrongSolutions[0]).toMatchObject({ rejected: false, failedTests: ['t1', 't2', 't3'] });
  });

  it('неверное решение без expectMistake — ошибка с названием разбора, который увидит ученик', async () => {
    const script = (code: string): TestScript => (code === SOLUTION ? {} : { passed: false, output: code === CONCAT ? '23' : '' });
    const problems: Problem[] = [];
    const exercise = makeExercise({
      wrongSolutions: [
        { code: CONCAT, note: 'Склейка строк.' },
        { code: 'print(0)\n', note: 'Всегда ноль.' },
      ],
    });
    const result = await verifyExercise(context(new ScriptedPython({ test: script }), problems), exercise);
    expect(summaryOf(problems)).toEqual([
      'wrong:error::не указан expectMistake — сработал разбор «concat»',
      'wrong:error::не указан expectMistake — не сработал ни один разбор из материалов',
    ]);
    expect(problems[0]?.details).toContain('если этот разбор верен, укажи expectMistake: concat; если нет — поправь его условие when');
    expect(problems[1]?.details).toContain('если общий разбор проверки здесь уместен, укажи expectMistake: null');
    expect(result.report.wrongSolutions.map((wrong) => wrong.matchedMistake)).toEqual(['concat', null]);
  });

  it('expectMistake: null — ошибка, если всё же срабатывает разбор из материалов', async () => {
    const script = (code: string): TestScript => (code === SOLUTION ? {} : { passed: false, output: code === CONCAT ? '23' : '' });
    const problems: Problem[] = [];
    const exercise = makeExercise({
      wrongSolutions: [
        { code: CONCAT, note: 'Склейка строк.', expectMistake: null },
        { code: 'print(0)\n', note: 'Всегда ноль.', expectMistake: null },
      ],
    });
    await verifyExercise(context(new ScriptedPython({ test: script }), problems), exercise);
    expect(summaryOf(problems)).toEqual([
      'wrong:error::ожидался общий разбор проверки (expectMistake: null), а сработал разбор «concat»',
    ]);
  });

  it('другое верное решение, которое отклоняют тесты или правила, — ошибка', async () => {
    const alt = 'print(int(input()) + int(input()))\n';
    const script = (code: string, id: string): TestScript =>
      code === SOLUTION || (code === alt && id !== 't2') ? {} : { passed: false, output: code === CONCAT ? '23' : '' };
    const problems: Problem[] = [];
    const exercise = makeExercise({ altSolutions: [{ code: alt, note: 'В одну строку.' }] });
    const result = await verifyExercise(context(new ScriptedPython({ test: script }), problems), exercise);
    expect(summaryOf(problems)).toEqual(['alt:error:t2:верное решение не проходит проверку — ученик с таким кодом получит ложный отказ']);
    expect(problems[0]).toMatchObject({ altIndex: 1, failedTests: ['t2'] });
    expect(problems[0]?.details[0]).toBe('чем оно отличается: В одну строку.');
    expect(result.report.altSolutions).toMatchObject([{ index: 1, passed: false, failedTests: ['t2'] }]);
  });

  it('в JSON видно, какие тесты и правила не прошёл эталон', async () => {
    const py = new ScriptedPython({ test: (code, id) => (code === SOLUTION && id !== 't2' ? {} : { passed: false }) });
    const problems: Problem[] = [];
    const result = await verifyExercise(context(py, problems), makeExercise({ wrongSolutions: [{ code: CONCAT, note: 'Склейка.' }], mistakes: [] }));
    const solution = problems.find((problem) => problem.subject === 'solution');
    expect(solution).toMatchObject({ message: 'не проходит проверку', testId: 't2', failedTests: ['t2'], failedRules: [] });
    expect(result.report.solution).toMatchObject({ passed: false, failedTests: ['t2'], failedRules: [], compileError: null });
    expect(result.report.starter).toMatchObject({ passed: false, failedTests: ['t1', 't2', 't3'] });
  });
});

describe('predict и example с заглушкой Python', () => {
  const hanging = new ScriptedPython({ run: (_code, _stdin, limitMs) => ({ status: 'timeout', limitMs }) });

  it('зависшая программа в predict — ошибка, если ответ записан как вывод', async () => {
    const problems: Problem[] = [];
    await verifyPredict(context(hanging, problems), predictStep({}));
    expect(summaryOf(problems)).toEqual(['predict:error::программа не завершилась за 1 с']);
  });

  it('answerIsNotOutput: бесконечный цикл в ответе — не ошибка, ответ о другом — предупреждение', async () => {
    const problems: Problem[] = [];
    await verifyPredict(context(hanging, problems), predictStep({ answer: 'Будет работать бесконечно', answerIsNotOutput: true }));
    await verifyPredict(context(hanging, problems), predictStep({ answer: 'Программа зависнет', answerIsNotOutput: true }));
    expect(problems).toEqual([]);
    await verifyPredict(context(hanging, problems), predictStep({ answer: 'Ошибка TypeError', answerIsNotOutput: true }));
    expect(summaryOf(problems)).toEqual(['predict:warning::программа не завершилась за 1 с, а в ответе об этом не сказано']);
    expect(problems[0]?.details).toEqual(['ответ: Ошибка TypeError']);
  });

  it('зависший пример — ошибка', async () => {
    const problems: Problem[] = [];
    await verifyExample(context(hanging, problems), {
      id: 'show',
      type: 'example',
      title: 'Пример',
      code: 'while True:\n    pass',
      notes: [{ line: 1, text: 'Цикл.' }],
    });
    expect(summaryOf(problems)).toEqual(['example:error::код примера не завершился за 1 с']);
  });
});

describe('verifyContent: причины, по которым проверка не состоялась', () => {
  let tmp = '';

  beforeAll(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'verify-content-'));
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('нет папки или в ней нет content/course.yaml — понятное сообщение', async () => {
    const nowhere = await verifyContent({ root: path.join(tmp, 'nope'), python: new ScriptedPython() });
    expect(nowhere).toMatchObject({ ok: false, lessons: [] });
    expect(nowhere.fatal).toBe(`Папка ${path.join(tmp, 'nope')} не найдена — проверь --root.`);
    const empty = await verifyContent({ root: tmp, python: new ScriptedPython() });
    expect(empty.fatal).toMatch(/^В папке .* нет content\/course\.yaml — проверь --root/);
  });

  it('разбор с «^(?!…)» и ссылкой на неизвестное правило отклоняется ещё при чтении материалов', async () => {
    const root = path.join(tmp, 'bad-mistakes');
    await cp(sampleRoot, root, { recursive: true });
    const file = path.join(root, 'content', 'lessons', 'fx', 'fx-l1.yaml');
    const text = (await readFile(file, 'utf8')).replace(/\r\n/g, '\n');
    const patched = text.replace(
      '      mistakes:\n        - id: concat\n',
      [
        '      mistakes:',
        '        - id: no-thanks',
        '          when:',
        "            codeRegex: '^(?![\\s\\S]*Спасибо)'",
        '          why: Нет благодарности.',
        '          try: Добавь её.',
        '        - id: ghost-rule',
        '          when:',
        '            failedRule: no-such-rule',
        '          why: Нет правила.',
        '          try: Добавь его.',
        '        - id: concat',
        '',
      ].join('\n'),
    );
    expect(patched).not.toBe(text);
    await writeFile(file, patched);
    const error = await loadContent(root).then(
      () => null,
      (reason: unknown) => reason as Error,
    );
    // С флагом m «^(?!…Спасибо)» срабатывал на пустой строке после последнего перевода строки.
    expect(error?.message).toContain('разбор no-thanks — «^(?!…)» с флагом m проверяет каждую строку, а не весь код');
    expect(error?.message).toContain('разбор ghost-rule ссылается на неизвестное правило no-such-rule');
  });

  it('ошибка формата материалов — fatal, Python не запускается', async () => {
    const root = path.join(tmp, 'bad-format');
    await mkdir(path.join(root, 'content'), { recursive: true });
    await writeFile(path.join(root, 'content', 'course.yaml'), 'title: Курс без остального\n');
    const py = new ScriptedPython();
    const report = await verifyContent({ root, python: py });
    expect(report.ok).toBe(false);
    expect(report.fatal).toMatch(/content[\\/]course\.yaml: не соответствует формату/);
    expect(py.requested).toEqual([]);
  });

  it('проверяет найденные уроки и отмечает ненайденные', async () => {
    const report = await verifyContent({ root: sampleRoot, only: ['fx-l1', 'nope-l9'], python: new ScriptedPython() });
    expect(report.fatal).toBeNull();
    expect(report.lessons.map((lesson) => lesson.id)).toEqual(['fx-l1']);
    expect(report.missing).toEqual(['не найден урок или модуль «nope-l9»']);
    expect(report.ok).toBe(false);
    expect(formatSummary(report)).toContain('Не найдено: не найден урок или модуль «nope-l9».');
  });

  it('Python не загрузился — fatal без зависания', async () => {
    // В этой папке нет pyodide.mjs — процесс с Python сообщит об ошибке загрузки.
    const broken = new NodePython({ pyodideDir: path.join(here, 'fixtures') });
    try {
      const started = performance.now();
      const report = await verifyContent({ root: sampleRoot, python: broken });
      expect(report.ok).toBe(false);
      expect(report.lessons).toEqual([]);
      expect(report.fatal).toMatch(/^Python не запустился: /);
      expect(performance.now() - started).toBeLessThan(30_000);
      expect(broken.failure).toBe(report.fatal);
      expect(await broken.run('print(1)', '', 1000)).toEqual({ status: 'failed', message: report.fatal });
    } finally {
      await broken.close();
    }
  }, PYTHON_TIMEOUT);
});

// ------------------------------------------------------------------ настоящий Python

describe('NodePython и проверки с настоящим Python', () => {
  const py = new NodePython();

  beforeAll(async () => {
    await py.start();
  }, PYTHON_TIMEOUT);

  afterAll(async () => {
    await py.close();
  });

  it('запускает программу с вводом', async () => {
    const outcome = await py.run('name = input("Имя? ")\nprint("Привет,", name)', 'Аня\n', 5000);
    expect(outcome.status).toBe('done');
    if (outcome.status === 'done') expect(outcome.result.stdout).toBe('Привет, Аня\n');
  });

  it('останавливает бесконечный цикл и перезапускает Python', async () => {
    const before = py.restarts;
    const outcome = await py.run('while True:\n    pass\n', '', 1000);
    expect(outcome).toEqual({ status: 'timeout', limitMs: 1000 });
    const after = await py.run('print(2 + 2)', '', 5000);
    expect(after.status).toBe('done');
    if (after.status === 'done') expect(after.result.stdout).toBe('4\n');
    expect(py.restarts).toBe(before + 1);
  }, PYTHON_TIMEOUT);

  it('процесс с Python завершился посреди запроса — сбой, а следующий запрос работает', async () => {
    const before = py.restarts;
    const outcome = await py.run('import importlib\nimportlib.import_module("js").process.exit(3)\n', '', 5000);
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.message).toMatch(/^Процесс с Python неожиданно завершился \(код 3\)/);
    const after = await py.run('print("снова работает")', '', 5000);
    expect(after.status === 'done' && after.result.stdout).toBe('снова работает\n');
    expect(py.restarts).toBe(before + 1);
    expect(py.failure).toBeNull();
  }, PYTHON_TIMEOUT);

  it('после неисправимого сбоя Pyodide (переполнение стека) Python перезапускается', async () => {
    const before = py.restarts;
    const deep = 'import sys\nsys.setrecursionlimit(1_000_000)\ndef f(n):\n    return f(n + 1)\nf(0)\n';
    const outcome = await py.run(deep, '', 30_000);
    expect(outcome.status).toBe('failed');
    const after = await py.run('print(1)', '', 5000);
    expect(after.status === 'done' && after.result.stdout).toBe('1\n');
    expect(py.restarts).toBe(before + 1);
  }, PYTHON_TIMEOUT);

  it('код из материалов не может писать файлы, запускать программы и читать переменные окружения', async () => {
    const target = path.join(os.tmpdir(), `verify-content-${process.pid}-${Date.now()}.txt`);
    const js = 'import importlib\njs = importlib.import_module("js")\n';
    const write = await py.run(`${js}js.process.getBuiltinModule("node:fs").writeFileSync(${JSON.stringify(target)}, "x")\n`, '', 5000);
    expect(write.status === 'done' && write.result.error?.message).toMatch(/--allow-fs-write/);
    expect(existsSync(target)).toBe(false);

    const exec = await py.run(`${js}js.process.getBuiltinModule("node:child_process").execSync("echo hi")\n`, '', 5000);
    expect(exec.status === 'done' && exec.result.error?.message).toMatch(/--allow-child-process/);

    expect(process.env.VITEST).toBeDefined();
    const env = await py.run(`${js}print(hasattr(js.process.env, "VITEST"))\n`, '', 5000);
    expect(env.status === 'done' && env.result.stdout).toBe('False\n');
  }, PYTHON_TIMEOUT);

  it('правила dependsOn и fromNumbers смотрят, откуда берётся значение, а не сколько в коде имён', async () => {
    const rules = [
      { id: 'greeting', dependsOn: { greeting: ['name'] }, message: 'Возьми имя из name.' },
      { id: 'printed', dependsOn: { print: ['name'] }, message: 'Выведи имя из name.' },
      { id: 'pizza', fromNumbers: { total: [540, 3, 330] }, message: 'Посчитай total из переменных.' },
    ];
    const passed = async (code: string): Promise<Record<string, boolean>> => {
      const outcome = await py.check({ code, tests: [], rules }, 5000);
      if (outcome.status !== 'done') throw new Error(`проверка не состоялась: ${outcome.status}`);
      expect(outcome.result.compileError).toBeNull();
      return Object.fromEntries(outcome.result.rules.map((rule) => [rule.id, rule.passed]));
    };
    // Верное решение другим способом: пять имён вместо шести — счётчик Name его бы отклонил.
    expect(await passed('name = "Марат"\ngreeting = "Привет, " + name + "!"\nprint(greeting + "\\n" + "-" * 14)\n')).toEqual({
      greeting: true,
      printed: true,
      pizza: false,
    });
    expect(await passed('name = "Марат"\ngreeting = "Привет, "\ngreeting = greeting + name + "!"\nprint(greeting)\n')).toMatchObject({
      greeting: true,
      printed: true,
    });
    expect(await passed('name = "Марат"\ngreeting = "Привет, " + "Марат" + "!"\nprint(greeting)\n')).toMatchObject({
      greeting: false,
      printed: false,
    });
    expect(await passed('price = 540\ncount = 3\ndrink = 330\ntotal = price * count + drink\n')).toMatchObject({ pizza: true });
    expect(await passed('price, count, drink = 540, 3, 330\ntotal = 0\ntotal += price * count\ntotal += drink\n')).toMatchObject({
      pizza: true,
    });
    expect(await passed('total = 540 * 3 + 330\n')).toMatchObject({ pizza: false });
    expect(await passed('total = 1950\n')).toMatchObject({ pizza: false });
    expect(await passed('price = 540\ndrink = 330\ntotal = price * 3 + drink\n')).toMatchObject({ pizza: false });
    expect(await passed('price = 540\ncount = 3\ndrink = 330\npizzas = 1620\ntotal = pizzas + drink\n')).toMatchObject({ pizza: false });
  }, PYTHON_TIMEOUT);

  it('число с подписью: подсказка про число, а не про обрезанную строку', async () => {
    const tests = [{ id: 't1', kind: 'io', expected: 'Итого: 269.7' }];
    const diffOf = async (code: string) => {
      const outcome = await py.check({ code, tests, rules: [] }, 5000);
      if (outcome.status !== 'done') throw new Error(`проверка не состоялась: ${outcome.status}`);
      return outcome.result.tests[0]?.diff;
    };
    expect(await diffOf('print("Итого:", 269)\n')).toMatchObject({ hint: 'number', expectedNumber: '269.7', actualNumber: '269' });
    expect(await diffOf('print("Итого:", "269.70")\n')).toMatchObject({ hint: 'number-format', actualNumber: '269.70' });
    expect(await diffOf('print("Итого:", 1502)\n')).toMatchObject({ hint: 'number', actualNumber: '1502' });
    const cut = await diffOf('print("Итого:")\n');
    expect(cut).toMatchObject({ hint: 'cut' });
    expect(cut?.expectedNumber).toBeUndefined();
  }, PYTHON_TIMEOUT);

  it('ошибки в самих тестах находит заранее и код задания не запускает', async () => {
    const exercise = makeExercise({
      tests: [
        { id: 'c1', kind: 'call', example: true, call: 'answer()', expected: 'ok' },
        { id: 'c2', kind: 'call', example: true, call: 'answer(', expected: "'ok'" },
        { id: 'c3', kind: 'call', call: 'answer()', expected: '[1, 2' },
        { id: 'a1', kind: 'assert', code: 'assert answer() ==', message: 'Функция возвращает ok.' },
      ],
      solution: { code: 'def answer():\n    return "ok"\n', explanation: 'Эталон.' },
      wrongSolutions: [{ code: 'def answer():\n    return "no"\n', note: 'Не то слово.' }],
      mistakes: [],
    });
    const problems: Problem[] = [];
    const result = await verifyExercise(context(py, problems), exercise);
    expect(summaryOf(problems)).toEqual([
      'content:error:c1:тест «Пример 1» (c1): expected «ok» — не литерал Python',
      'content:error:c2:тест «Пример 2» (c2): call «answer(» — не выражение Python',
      'content:error:c3:тест «Проверка 3» (c3): expected «[1, 2» — не литерал Python',
      'content:error:a1:тест «Проверка 4» (a1): в коде проверки синтаксическая ошибка',
    ]);
    expect(problems[0]?.details).toEqual(["если это строка, нужны кавычки: 'ok'", 'код задания не запускался — сначала исправь тесты']);
    expect(problems[2]?.details[1]).toMatch(/^Python: SyntaxError: /);
    expect(result.report).toMatchObject({ invalidTests: ['c1', 'c2', 'c3', 'a1'], solution: null, starter: null, wrongSolutions: [] });
    expect(result.checks).toBe(1);
  }, PYTHON_TIMEOUT);

  it('находит сломанный эталон и неверный разбор, а верное задание пропускает', async () => {
    const problems: Problem[] = [];
    const ctx = { py, lesson: fakeLesson(), stepId: 'step', timeoutMs: 5000, problems };
    const good = await verifyExercise(ctx, makeExercise());
    expect(problems).toEqual([]);
    expect(good.report.wrongSolutions[0]).toMatchObject({ rejected: true, matchedMistake: 'concat' });

    await verifyExercise(ctx, makeExercise({ solution: { code: CONCAT, explanation: 'Сломанный эталон.' } }));
    const solution = problems.find((problem) => problem.subject === 'solution');
    expect(solution?.message).toBe('не проходит проверку');
    expect(solution?.failedTests).toEqual(['t1', 't2', 't3']);
    expect(solution?.details).toContain('  ожидалось: 5');
    expect(solution?.details).toContain('  получилось: 23');
  }, PYTHON_TIMEOUT);

  it('сравнивает ответ predict с выводом и с тем, что видно в консоли', async () => {
    const problems: Problem[] = [];
    const ctx = { py, lesson: fakeLesson(), stepId: 'guess', timeoutMs: 5000, problems };
    const step = predictStep({ code: 'name = input("Имя? ")\nprint("Привет,", name)', stdin: 'Аня\n' });
    await verifyPredict(ctx, { ...step, answer: 'Привет, Аня  \n\n' });
    await verifyPredict(ctx, { ...step, answer: 'Имя? Аня\nПривет, Аня' });
    expect(problems).toEqual([]);
    await verifyPredict(ctx, { ...step, answer: 'Привет, Боря' });
    expect(problems.map((problem) => problem.message)).toEqual(['ответ не совпадает с тем, что выводит программа']);
  }, PYTHON_TIMEOUT);
});

// ------------------------------------------------------------------ командная строка на фикстурах

describe('node scripts/verify-content.ts', () => {
  it('принимает корректную фикстуру, включая зависающее неверное решение и predict о бесконечном цикле', async () => {
    const run = await runCli(['--root', 'scripts/fixtures/sample', '--json', '--timeout', '2000']);
    expect(run.stderr).toBe('');
    const report = JSON.parse(run.stdout) as VerifyReport;
    expect(errorsOf(report)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(run.code).toBe(0);
    expect(report.totals).toMatchObject({ lessons: 1, exercises: 2, errors: 0, warnings: 0, pythonRestarts: 2 });
    const sum = report.lessons[0]?.exercises.find((exercise) => exercise.id === 'fx-sum');
    expect(sum?.solutionPassed).toBe(true);
    expect(sum?.starterPassed).toBe(false);
    expect(sum?.solution).toMatchObject({ passed: true, failedTests: [], overAppLimitTests: [], checkFailures: [] });
    expect(sum?.starter).toMatchObject({ passed: false, failedTests: ['t1', 't2', 't3'] });
    expect(sum?.wrongSolutions.map((wrong) => [wrong.rejected, wrong.matchedMistake, wrong.timedOutTest])).toEqual([
      [true, 'concat', null],
      [true, null, 't1'],
    ]);
    expect(sum?.altSolutions).toMatchObject([{ index: 1, passed: true }]);
    // В текстовом отчёте видно, какой разбор увидит ученик с каждым неверным решением.
    expect(formatReport(report)).toContain('  · fx-sum, разборы неверных решений: №1 concat, №2 слишком долго');
  }, PYTHON_TIMEOUT);

  it('отвергает сломанную фикстуру и называет каждую ошибку', async () => {
    const run = await runCli(['--root', 'scripts/fixtures/broken', '--json', '--timeout', '2000']);
    const report = JSON.parse(run.stdout) as VerifyReport;
    expect(run.code).toBe(1);
    expect(report.ok).toBe(false);
    const found = errorsOf(report).map((problem) =>
      [problem.subject, problem.exerciseId ?? problem.stepId, problem.wrongIndex ?? null, problem.testId ?? null].join(' '),
    );
    expect(found.sort()).toEqual(
      [
        'content broken-example  ',
        'example broken-example  ',
        'predict wrong-guess  ',
        'solution bx-sum  ',
        'wrong bx-sum 1 t1',
        'starter bx-double  ',
        'alt bx-double  ',
        'wrong bx-double 1 ',
        'wrong bx-double 2 ',
        'solution bx-slow  s1',
        'content bx-literal  g1',
        'content bx-literal  g2',
      ].sort(),
    );
    expect(report.totals.warnings).toBe(3);
    const exercises = report.lessons[0]?.exercises ?? [];
    expect(exercises.find((exercise) => exercise.id === 'bx-sum')?.solution?.failedTests).toEqual(['t1', 't2']);
    expect(exercises.find((exercise) => exercise.id === 'bx-slow')?.solution).toMatchObject({ passed: false, overAppLimitTests: ['s1'] });
    expect(exercises.find((exercise) => exercise.id === 'bx-literal')).toMatchObject({ invalidTests: ['g1', 'g2'], solution: null });

    const text = formatReport(report);
    expect(text).toContain('✗ bx-l1 «Сломанный урок»');
    expect(text).toContain('задание bx-sum, эталонное решение: не проходит проверку');
    expect(text).toContain('зависает на тесте «Пример 1»');
    expect(text).toContain('задание bx-slow, эталонное решение: не укладывается в лимит приложения');
    expect(text).toContain('задание bx-double, другое верное решение №1: верное решение не проходит проверку');
    expect(text).toContain("если это строка, нужны кавычки: 'ok'");
    expect(text).toContain('Есть ошибки');
  }, PYTHON_TIMEOUT);

  it('сообщает о ненайденном уроке кодом 1, а о неверных аргументах — кодом 2', async () => {
    const missing = await runCli(['--root', 'scripts/fixtures/sample', 'no-such-lesson']);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('Нечего проверять: не найден урок или модуль «no-such-lesson».');
    const usage = await runCli(['--bad-flag']);
    expect(usage.code).toBe(2);
    expect(usage.stderr).toContain('Запуск:');
    const pathAsId = await runCli(['scripts/fixtures/sample']);
    expect(pathAsId.code).toBe(2);
    expect(pathAsId.stderr).toContain('похоже на путь к папке');
  }, PYTHON_TIMEOUT);
});
