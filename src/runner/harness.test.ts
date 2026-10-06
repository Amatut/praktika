// Тесты окружения запуска в harness.py на настоящем Pyodide (в этом же процессе): рабочая папка,
// учебные файлы, импорт модуля ученика, базы SQLite, seed и учебная симуляция сети.
// Pyodide здесь загружается напрямую, а не через verify-worker, — чтобы между запусками заглянуть
// в состояние интерпретатора: текущую папку, sys.path и sys.modules.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadPyodide, type PyodideAPI } from 'pyodide';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CheckPayload, CheckResult, RunEnvironment, RunResult, TestResult } from './types.ts';

const HARNESS = readFileSync(fileURLToPath(new URL('./harness.py', import.meta.url)), 'utf8');
const LOAD_TIMEOUT = 120_000;

interface PyCallable {
  (...args: unknown[]): unknown;
  destroy(): void;
}

let py: PyodideAPI;

beforeAll(async () => {
  py = await loadPyodide({ stdout: () => {}, stderr: () => {} });
  py.runPython(HARNESS);
}, LOAD_TIMEOUT);

function call<T>(name: string, ...args: unknown[]): T {
  const fn = py.globals.get(name) as PyCallable;
  try {
    return JSON.parse(fn(...args) as string) as T;
  } finally {
    fn.destroy();
  }
}

function run(code: string, environment?: RunEnvironment, stdin = ''): RunResult {
  return call<RunResult>('run_program', code, stdin, 20_000, environment ? JSON.stringify(environment) : null);
}

function check(payload: CheckPayload): CheckResult {
  return call<CheckResult>('check_program', JSON.stringify(payload));
}

/** Значение выражения Python — снаружи запусков, прямо в интерпретаторе. */
function python(expression: string): unknown {
  return JSON.parse(py.runPython(`import json as _json\n_json.dumps(${expression})`) as string);
}

function test(id: string, fields: Record<string, unknown>) {
  return { id, kind: 'io', expected: '', ...fields };
}

function passed(result: CheckResult): Record<string, boolean> {
  return Object.fromEntries(result.tests.map((item: TestResult) => [item.id, item.passed]));
}

describe('рабочая папка запуска', () => {
  it('учебные файлы лежат в новой папке рядом с программой, код ученика — под именем файла задания', () => {
    const code = [
      'import os',
      'print(sorted(os.listdir(".")))',
      'print(open("data/menu.txt", encoding="utf-8").read().strip())',
      'print(os.path.basename(__file__), os.getcwd().startswith("/tmp/praktika-"))',
    ].join('\n');
    const result = run(code, { filename: 'app.py', files: { 'data/menu.txt': 'чай\nкофе\n', 'notes.txt': '' } });
    expect(result.error).toBeNull();
    expect(result.stdout).toBe("['app.py', 'data', 'notes.txt']\nчай\nкофе\napp.py True\n");
  });

  it('после запуска: прежняя текущая папка и sys.path, рабочая папка удалена', () => {
    const before = python('[__import__("os").getcwd(), __import__("sys").path]');
    const result = run('import os\nos.chdir("/")\nprint(os.getcwd())\nprint(__file__)', { files: { 'a.txt': 'x' } });
    expect(result.stdout?.split('\n')[0]).toBe('/');
    const workdir = result.stdout?.split('\n')[1]?.replace(/\/main\.py$/, '') ?? '';
    expect(workdir).toMatch(/^\/tmp\/praktika-/);
    expect(python('[__import__("os").getcwd(), __import__("sys").path]')).toEqual(before);
    expect(python(`__import__("os").path.exists(${JSON.stringify(workdir)})`)).toBe(false);
  });

  it('«Файлы после запуска»: созданные и изменённые, без нетронутых; у двоичного нет текста, длинный обрезан', () => {
    const code = [
      'import os, sqlite3',
      'open("edit.txt", "a", encoding="utf-8").write("б")',
      'os.makedirs("out")',
      'open("out/report.txt", "w", encoding="utf-8").write("итог: 3\\n")',
      'open("big.txt", "w", encoding="utf-8").write("я" * 5000)',
      'sqlite3.connect("new.db").execute("CREATE TABLE t (a)")',
    ].join('\n');
    const result = run(code, { files: { 'keep.txt': 'а', 'edit.txt': 'а' } });
    expect(result.error).toBeNull();
    const files = result.files ?? [];
    expect(files.map((file) => [file.path, file.status])).toEqual([
      ['big.txt', 'created'],
      ['edit.txt', 'modified'],
      ['new.db', 'created'],
      ['out/report.txt', 'created'],
    ]);
    const [big, edit, db, report] = files;
    expect(big).toMatchObject({ size: 10_000, truncated: true });
    expect(big?.text).toHaveLength(4000);
    expect(edit).toMatchObject({ text: 'аб', size: 4, truncated: false });
    expect(db).toMatchObject({ text: null, truncated: false });
    expect(report?.text).toBe('итог: 3\n');
  });

  it('без окружения запуск работает как раньше (и со старым вызовом из трёх аргументов)', () => {
    const old = call<RunResult>('run_program', 'print(input() * 2)', 'ха\n', 20_000);
    expect(old.stdout).toBe('хаха\n');
    expect(old.files).toEqual([]);
    const compile = run('print(', { filename: 'calc.py' });
    expect(compile.compileError?.line).toBe(1);
  });

  it('каждый тест — в своей папке: файл, созданный в одном тесте, в другом не виден', () => {
    const code = 'import os\nprint(os.path.exists("mark.txt"))\nopen("mark.txt", "w").write("1")\n';
    const result = check({ code, rules: [], tests: [test('t1', { expected: 'False' }), test('t2', { expected: 'False' })] });
    expect(passed(result)).toEqual({ t1: true, t2: true });
    expect(result.tests[0]?.files?.map((file) => file.path)).toEqual(['mark.txt']);
  });

  it('тест дополняет и заменяет файлы задания, null убирает файл задания', () => {
    const code = 'import os\nprint(sorted(os.listdir(".")), open("a.txt").read() if os.path.exists("a.txt") else "-")\n';
    const result = check({
      code,
      rules: [],
      files: { 'a.txt': 'задание', 'b.txt': 'b' },
      tests: [
        test('base', { expected: "['a.txt', 'b.txt', 'main.py'] задание" }),
        test('replace', { files: { 'a.txt': 'тест', 'c.txt': 'c' }, expected: "['a.txt', 'b.txt', 'c.txt', 'main.py'] тест" }),
        test('remove', { files: { 'a.txt': null }, expected: "['b.txt', 'main.py'] -" }),
      ],
    });
    expect(passed(result)).toEqual({ base: true, replace: true, remove: true });
  });

  it('assert-тест импортирует модуль ученика и учебный модуль; модули из папки выгружаются после теста', () => {
    const payload: CheckPayload = {
      code: 'from helpers import VERSION\n\ndef add(a, b):\n    return a + b\n\nif __name__ == "__main__":\n    print(add(2, 3), VERSION)\n',
      filename: 'calc.py',
      files: { 'helpers.py': 'VERSION = 1\n' },
      rules: [],
      tests: [
        test('run', { expected: '5 1' }),
        { id: 'import', kind: 'assert', code: 'import calc, helpers\nassert calc.add(1, 2) == 3\nassert helpers.VERSION == 1', message: 'm' },
        // Новая версия учебного модуля: закешированный import вернул бы прежнюю.
        { id: 'fresh', kind: 'assert', code: 'import helpers\nassert helpers.VERSION == 2', message: 'm', files: { 'helpers.py': 'VERSION = 2\n' } },
      ],
    };
    expect(passed(check(payload))).toEqual({ run: true, import: true, fresh: true });
    expect(python('[name for name in ("calc", "helpers") if name in __import__("sys").modules]')).toEqual([]);
  });

  it('ошибка в модуле ученика, импортированном тестом, показывается в его файле и строке', () => {
    const result = check({
      code: 'def ratio(a, b):\n    return a / b\n',
      filename: 'calc.py',
      rules: [],
      tests: [{ id: 'a1', kind: 'assert', code: 'import calc\ncalc.ratio(1, 0)', message: 'm' }],
    });
    const error = result.tests[0]?.error;
    expect(error).toMatchObject({ type: 'ZeroDivisionError', line: 2, lineText: '    return a / b' });
    expect(error?.raw).toContain('File "calc.py", line 2, in ratio');
  });
});

describe('базы SQLite', () => {
  const SCHEMA = 'CREATE TABLE orders (item TEXT, price INTEGER);';
  const count = 'import sqlite3\nconnection = sqlite3.connect("shop.db")\nprint(connection.execute("SELECT COUNT(*) FROM orders").fetchone()[0])\nconnection.execute("INSERT INTO orders VALUES (\'x\', 1)")\nconnection.commit()\n';

  it('база создаётся SQL-скриптом перед каждым запуском; изменения программы не переживают запуск; тест заменяет базу', () => {
    const result = check({
      code: count,
      rules: [],
      databases: { 'shop.db': `${SCHEMA}\nINSERT INTO orders VALUES ('чай', 120), ('пирог', 250);` },
      tests: [
        test('t1', { expected: '2' }),
        test('t2', { expected: '2' }),
        test('t3', { databases: { 'shop.db': SCHEMA }, expected: '0' }),
      ],
    });
    expect(passed(result)).toEqual({ t1: true, t2: true, t3: true });
    // Программа изменила базу — она в «Файлах после запуска», без текста.
    expect(result.tests[0]?.files).toMatchObject([{ path: 'shop.db', status: 'modified', text: null }]);
  });

  it('служебный файл незавершённой транзакции SQLite в «Файлах после запуска» не показывается', () => {
    const code = 'import os, sqlite3\nconnection = sqlite3.connect("shop.db")\nconnection.execute("INSERT INTO orders VALUES (\'x\', 1)")\nprint(sorted(os.listdir(".")))\n';
    const result = run(code, { databases: { 'shop.db': SCHEMA } });
    expect(result.stdout).toContain('shop.db-journal');
    expect(result.files?.map((file) => file.path).filter((path) => path.includes('journal'))).toEqual([]);
  });

  it('ошибка в SQL-скрипте — сбой проверки с понятным сообщением, а не ошибка ученика', () => {
    expect(() => run('print(1)', { databases: { 'shop.db': 'CREATE TABLE (' } })).toThrow(/SQL-скрипт базы shop\.db не выполнился/);
    // После сбоя окружение восстановлено: следующий запуск работает.
    expect(run('print(2)').stdout).toBe('2\n');
  });
});

describe('seed', () => {
  const dice = 'import random\nprint(random.randint(1, 6), random.randint(1, 6))\n';

  it('одинаковые числа при каждом запуске; у теста может быть свой seed', () => {
    expect(run(dice, { seed: 7 }).stdout).toBe('3 2\n');
    expect(run(dice, { seed: 7 }).stdout).toBe('3 2\n');
    const result = check({ code: dice, rules: [], seed: 7, tests: [test('t1', { expected: '3 2' }), test('t2', { seed: 5, expected: '5 3' })] });
    expect(passed(result)).toEqual({ t1: true, t2: true });
  });
});

describe('учебная симуляция сети (requests)', () => {
  const WEATHER = 'https://api.example.com/weather';
  const http: RunEnvironment['http'] = [
    { url: `${WEATHER}?city=Казань&units=metric`, json: { temp: 12 }, headers: { 'X-Source': 'учебный' } },
    { url: 'https://api.example.com/missing', status: 404, json: { error: 'нет' } },
    { url: 'https://api.example.com/broken', status: 503, text: 'на обслуживании' },
    { url: 'https://api.example.com/slow', error: 'timeout' },
    { url: 'https://api.example.com/offline', error: 'connection' },
    { url: 'https://api.example.com/items', method: 'POST', status: 201, json: { id: 7 } },
    { url: 'https://api.example.com/page', text: '<html>' },
  ];

  it('успешный ответ: params дополняют query, порядок не важен; status_code, ok, reason, json, text, headers, url', () => {
    const code = [
      'import requests',
      `r = requests.get("${WEATHER}?units=metric", params={"city": "Казань"}, timeout=5)`,
      'print(r.status_code, r.ok, r.reason, bool(r), r.json()["temp"], r.text)',
      'print(r.headers["content-type"], r.headers["x-source"], "X-SOURCE" in r.headers)',
      'print(r.url)',
      'p = requests.post("https://api.example.com/items", json={"name": "чай"})',
      'print(p.status_code, p.json(), repr(p))',
      'print(requests.get("https://api.example.com/page").text)',
    ].join('\n');
    const result = run(code, { http });
    expect(result.error).toBeNull();
    expect(result.stdout).toBe(
      [
        '200 True OK True 12 {"temp": 12}',
        'application/json учебный True',
        `${WEATHER}?units=metric&city=%D0%9A%D0%B0%D0%B7%D0%B0%D0%BD%D1%8C`,
        "201 {'id': 7} <Response [201]>",
        '<html>',
        '',
      ].join('\n'),
    );
  });

  it('404 и 503: ok ложно, raise_for_status() бросает HTTPError, как requests', () => {
    const code = [
      'import requests',
      'for url in ("https://api.example.com/missing", "https://api.example.com/broken"):',
      '    r = requests.get(url, timeout=5)',
      '    try:',
      '        r.raise_for_status()',
      '    except requests.exceptions.HTTPError as e:',
      '        print(r.status_code, r.ok, isinstance(e, requests.RequestException), e.response is r, e)',
    ].join('\n');
    expect(run(code, { http }).stdout).toBe(
      [
        '404 False True True 404 Client Error: Not Found for url: https://api.example.com/missing',
        '503 False True True 503 Server Error: Service Unavailable for url: https://api.example.com/broken',
        '',
      ].join('\n'),
    );
  });

  it('error: timeout → requests.Timeout, error: connection → requests.ConnectionError', () => {
    const code = [
      'import requests',
      'try:',
      '    requests.get("https://api.example.com/slow", timeout=2)',
      'except requests.Timeout as e:',
      '    print("Timeout:", e)',
      'try:',
      '    requests.get("https://api.example.com/offline")',
      'except requests.exceptions.ConnectionError as e:',
      '    print("ConnectionError:", e)',
    ].join('\n');
    expect(run(code, { http }).stdout).toBe(
      [
        'Timeout: учебная симуляция: сервер не ответил вовремя (timeout=2) — GET https://api.example.com/slow',
        'ConnectionError: учебная симуляция: не удалось подключиться к серверу — GET https://api.example.com/offline',
        '',
      ].join('\n'),
    );
  });

  it('неизвестный адрес — ConnectionError «в учебной симуляции нет ответа для …» (не встроенный ConnectionError)', () => {
    const caught = run(
      'import requests\ntry:\n    requests.get("https://api.example.com/nope", params={"q": 1})\nexcept ConnectionError:\n    print("встроенный")\n',
      { http },
    );
    expect(caught.error).toMatchObject({ type: 'ConnectionError', line: 3 });
    expect(caught.error?.summary).toBe(
      'requests.exceptions.ConnectionError: в учебной симуляции нет ответа для GET https://api.example.com/nope?q=1',
    );
    // Метод тоже важен: POST на адрес, записанный для GET, — нет ответа.
    const post = run('import requests\nrequests.post("https://api.example.com/page")', { http });
    expect(post.error?.message).toBe('в учебной симуляции нет ответа для POST https://api.example.com/page');
    // Без поля http requests всё равно учебный: настоящей сети нет.
    expect(run('import requests\nrequests.get("https://example.com")').error?.message).toBe(
      'в учебной симуляции нет ответа для GET https://example.com',
    );
  });

  it('json() у ответа не в JSON — requests.exceptions.JSONDecodeError (он же ValueError); адрес без схемы — MissingSchema', () => {
    const code = [
      'import requests',
      'try:',
      '    requests.get("https://api.example.com/page").json()',
      'except ValueError as e:',
      '    print(type(e).__name__, isinstance(e, requests.RequestException), e)',
      'try:',
      '    requests.get("api.example.com/page")',
      'except requests.exceptions.MissingSchema as e:',
      '    print("MissingSchema")',
    ].join('\n');
    expect(run(code, { http }).stdout).toBe('JSONDecodeError True Expecting value: line 1 column 1 (char 0)\nMissingSchema\n');
  });

  it('журнал requests.calls: что передано в каждый запрос; у каждого запуска — свой', () => {
    const code = [
      'import requests',
      `requests.get("${WEATHER}", params={"units": "metric", "city": "Казань"}, headers={"Accept": "application/json"}, timeout=3)`,
      'requests.post("https://api.example.com/items", json={"name": "чай"})',
      'for c in requests.calls:',
      '    print(sorted(c.items()))',
    ].join('\n');
    const lines = run(code, { http }).stdout?.trim().split('\n');
    expect(lines).toEqual([
      `[('data', None), ('headers', {'Accept': 'application/json'}), ('json', None), ('method', 'GET'), ('params', {'units': 'metric', 'city': 'Казань'}), ('timeout', 3), ('url', '${WEATHER}')]`,
      "[('data', None), ('headers', None), ('json', {'name': 'чай'}), ('method', 'POST'), ('params', None), ('timeout', None), ('url', 'https://api.example.com/items')]",
    ]);
    expect(run('import requests\nprint(len(requests.calls))', { http }).stdout).toBe('0\n');
  });

  it('assert-тест проверяет журнал вызовов; ответ теста заменяет ответ задания с тем же методом и адресом', () => {
    const code = `import requests\n\ndef temp():\n    return requests.get("${WEATHER}?city=Казань&units=metric", timeout=5).json()["temp"]\n`;
    const result = check({
      code,
      rules: [],
      http,
      tests: [
        { id: 'c1', kind: 'call', call: 'temp()', expected: '12' },
        { id: 'c2', kind: 'call', call: 'temp()', expected: '-3', http: [{ url: `${WEATHER}?units=metric&city=Казань`, json: { temp: -3 } }] },
        { id: 'a1', kind: 'assert', code: 'import requests\ntemp()\nassert requests.calls[-1]["timeout"] == 5', message: 'm' },
      ],
    });
    expect(passed(result)).toEqual({ c1: true, c2: true, a1: true });
  });

  it('после запуска прежний sys.modules["requests"] возвращается на место', () => {
    py.runPython('import sys, types\nsys.modules["requests"] = types.ModuleType("requests_настоящий")');
    try {
      const inside = run('import requests\nprint(requests.__doc__.split(":")[0])', { http });
      expect(inside.stdout).toBe('Учебная симуляция requests\n');
      expect(python('__import__("sys").modules["requests"].__name__')).toBe('requests_настоящий');
      expect(python('"requests.exceptions" in __import__("sys").modules')).toBe(false);
    } finally {
      py.runPython('import sys\nsys.modules.pop("requests", None)');
    }
    run('import requests', { http });
    expect(python('[name for name in ("requests", "requests.exceptions") if name in __import__("sys").modules]')).toEqual([]);
  });
});
