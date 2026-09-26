// Тесты обратной связи «Подсказки курса».
// CHECKS и RUNS получены запуском src/runner/harness.py (CPython 3.14.7, runpy.run_path:
// check_program / run_program) и затем сокращены: durationMs везде заменён на 0.1, а в a_limit,
// a_rule_and_limit и run_limit вывод урезан до нескольких строк (настоящий — до 20 000 символов).
// Таблица explainError: сообщения Python — из таких же запусков, но PyError собран помощниками
// compileError / runtimeError в формате harness.py; REAL_ERRORS — ошибки целиком, как их вернул
// harness.py (CPython 3.14.7, а для модулей — Pyodide 314.0.7 в Node). Отдельные тесты меняют
// настоящие результаты (structuredClone + правка поля) или собирают результат вручную в формате
// harness.py, чтобы проверить редкие сочетания, — это видно в самих тестах.

import { describe, expect, it } from 'vitest';
import { exerciseSchema, type ContentTest, type Exercise } from '../content/schema.ts';
import type { CheckOutcome, RunOutcome } from '../runner/runner.ts';
import type { CheckResult, OutputDiff, PyError, RunResult } from '../runner/types.ts';
import { errorCategory, explainError, type ErrorExplanation } from './errors-ru.ts';
import { buildCheckFeedback, buildRunFeedback, matchMistake, normalizeOutput, testLabel } from './feedback.ts';
import type { Feedback } from './types.ts';

// Настоящие результаты harness.py: A — удвоение числа, B — приветствие, C — числа 1..3,
// D — функция is_even, E — assert, F — вывод по шаблону (regex).
const TESTS = {"A": [{"id": "ex-1", "kind": "io", "example": true, "stdin": "3\n", "expected": "6"}, {"id": "ex-2", "kind": "io", "example": true, "stdin": "7\n", "expected": "14"}, {"id": "edge-zero", "kind": "io", "edge": true, "stdin": "0\n", "expected": "0"}, {"id": "big", "kind": "io", "stdin": "100\n", "expected": "200"}], "B": [{"id": "ex-1", "kind": "io", "example": true, "stdin": "Аня\n", "expected": "Привет, Аня!"}], "C": [{"id": "ex-1", "kind": "io", "example": true, "expected": "1\n2\n3"}], "D": [{"id": "ex-1", "kind": "call", "example": true, "call": "is_even(4)", "expected": "True"}, {"id": "ex-2", "kind": "call", "example": true, "call": "is_even(7)", "expected": "False"}], "E": [{"id": "a-1", "kind": "assert", "code": "assert total == 10", "message": "Переменная total должна быть равна 10."}], "F": [{"id": "ex-1", "kind": "io", "example": true, "expected": "\\d+ руб\\.", "expectedLabel": "число и «руб.», например 150 руб.", "compare": {"mode": "regex"}}], "G": [{"id": "t1", "kind": "io", "example": true, "expected": "Меню дня\nКапучино\nКакао"}], "N": [{"id": "ex-1", "kind": "io", "example": true, "stdin": "5\n", "expected": "5"}], "N2": [{"id": "ex-1", "kind": "io", "example": true, "stdin": "5\n", "expected": "5.0"}], "AGE": [{"id": "ex-1", "kind": "io", "example": true, "stdin": "Аня\n15\n", "expected": "Привет, Аня! Тебе 15 лет, через год будет 16"}], "QUOTE": [{"id": "ex-1", "kind": "io", "example": true, "expected": "Он сказал \"да\""}], "GREET": [{"id": "ex-1", "kind": "call", "example": true, "call": "greet('Аня')", "expected": "'Привет, Аня! Рады видеть тебя в нашей кофейне сегодня утром'"}]} satisfies Record<string, ContentTest[]>;

const CHECKS: Record<string, { code: string; result: CheckResult }> = {
  a_correct: {"code": "n = int(input())\nprint(n * 2)\n", "result": {"compileError": null, "rules": [{"id": "no-if", "passed": true, "message": "Реши без if: одна формула подходит для любого числа."}], "tests": [{"id": "ex-1", "kind": "io", "passed": true, "stdin": "3\n", "expected": "6", "diff": null, "output": "6\n", "transcript": [["input", "3\n"], ["out", "6\n"]], "error": null, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}, {"id": "ex-2", "kind": "io", "passed": true, "stdin": "7\n", "expected": "14", "diff": null, "output": "14\n", "transcript": [["input", "7\n"], ["out", "14\n"]], "error": null, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}, {"id": "edge-zero", "kind": "io", "passed": true, "stdin": "0\n", "expected": "0", "diff": null, "output": "0\n", "transcript": [["input", "0\n"], ["out", "0\n"]], "error": null, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}, {"id": "big", "kind": "io", "passed": true, "stdin": "100\n", "expected": "200", "diff": null, "output": "200\n", "transcript": [["input", "100\n"], ["out", "200\n"]], "error": null, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}]}},
  a_compile: {"code": "n = int(input())\nprint(n * 2\n", "result": {"compileError": {"phase": "compile", "type": "SyntaxError", "message": "'(' was never closed", "line": 2, "col": 6, "endCol": 0, "lineText": "print(n * 2", "summary": "SyntaxError: '(' was never closed", "raw": "  File \"main.py\", line 2\n    print(n * 2\n         ^\nSyntaxError: '(' was never closed"}, "rules": [], "tests": []}},
  a_plus: {"code": "n = int(input())\nprint(n + 2)\n", "result": {"compileError": null, "rules": [{"id": "no-if", "passed": true, "message": "Реши без if: одна формула подходит для любого числа."}], "tests": [{"id": "ex-1", "kind": "io", "passed": false, "stdin": "3\n", "expected": "6", "diff": {"kind": "mismatch", "line": 1, "expectedLine": "6", "actualLine": "5", "hint": "number"}, "output": "5\n", "transcript": [["input", "3\n"], ["out", "5\n"]], "error": null, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}, {"id": "ex-2", "kind": "io", "passed": false, "stdin": "7\n", "expected": "14", "diff": {"kind": "mismatch", "line": 1, "expectedLine": "14", "actualLine": "9", "hint": "number"}, "output": "9\n", "transcript": [["input", "7\n"], ["out", "9\n"]], "error": null, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}, {"id": "edge-zero", "kind": "io", "passed": false, "stdin": "0\n", "expected": "0", "diff": {"kind": "mismatch", "line": 1, "expectedLine": "0", "actualLine": "2", "hint": "number"}, "output": "2\n", "transcript": [["input", "0\n"], ["out", "2\n"]], "error": null, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}, {"id": "big", "kind": "io", "passed": false, "stdin": "100\n", "expected": "200", "diff": {"kind": "mismatch", "line": 1, "expectedLine": "200", "actualLine": "102", "hint": "number"}, "output": "102\n", "transcript": [["input", "100\n"], ["out", "102\n"]], "error": null, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}]}},
  a_no_int: {"code": "n = input()\nprint(n * 2)\n", "result": {"compileError": null, "rules": [{"id": "no-if", "passed": true, "message": "Реши без if: одна формула подходит для любого числа."}], "tests": [{"id": "ex-1", "kind": "io", "passed": false, "stdin": "3\n", "expected": "6", "diff": {"kind": "mismatch", "line": 1, "expectedLine": "6", "actualLine": "33", "hint": "number"}, "output": "33\n", "transcript": [["input", "3\n"], ["out", "33\n"]], "error": null, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}, {"id": "ex-2", "kind": "io", "passed": false, "stdin": "7\n", "expected": "14", "diff": {"kind": "mismatch", "line": 1, "expectedLine": "14", "actualLine": "77", "hint": "number"}, "output": "77\n", "transcript": [["input", "7\n"], ["out", "77\n"]], "error": null, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}, {"id": "edge-zero", "kind": "io", "passed": false, "stdin": "0\n", "expected": "0", "diff": {"kind": "mismatch", "line": 1, "expectedLine": "0", "actualLine": "00", "hint": "number-format"}, "output": "00\n", "transcript": [["input", "0\n"], ["out", "00\n"]], "error": null, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}, {"id": "big", "kind": "io", "passed": false, "stdin": "100\n", "expected": "200", "diff": {"kind": "mismatch", "line": 1, "expectedLine": "200", "actualLine": "100100", "hint": "number"}, "output": "100100\n", "transcript": [["input", "100\n"], ["out", "100100\n"]], "error": null, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}]}},
  a_div: {"code": "n = int(input())\nprint(n * 4 / 2)\n", "result": {"compileError": null, "rules": [{"id": "no-if", "passed": true, "message": "Реши без if: одна формула подходит для любого числа."}], "tests": [{"id": "ex-1", "kind": "io", "passed": false, "stdin": "3\n", "expected": "6", "diff": {"kind": "mismatch", "line": 1, "expectedLine": "6", "actualLine": "6.0", "hint": "number-format"}, "output": "6.0\n", "transcript": [["input", "3\n"], ["out", "6.0\n"]], "error": null, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}, {"id": "ex-2", "kind": "io", "passed": false, "stdin": "7\n", "expected": "14", "diff": {"kind": "mismatch", "line": 1, "expectedLine": "14", "actualLine": "14.0", "hint": "number-format"}, "output": "14.0\n", "transcript": [["input", "7\n"], ["out", "14.0\n"]], "error": null, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}, {"id": "edge-zero", "kind": "io", "passed": false, "stdin": "0\n", "expected": "0", "diff": {"kind": "mismatch", "line": 1, "expectedLine": "0", "actualLine": "0.0", "hint": "number-format"}, "output": "0.0\n", "transcript": [["input", "0\n"], ["out", "0.0\n"]], "error": null, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}, {"id": "big", "kind": "io", "passed": false, "stdin": "100\n", "expected": "200", "diff": {"kind": "mismatch", "line": 1, "expectedLine": "200", "actualLine": "200.0", "hint": "number-format"}, "output": "200.0\n", "transcript": [["input", "100\n"], ["out", "200.0\n"]], "error": null, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}]}},
  a_eof: {"code": "n = int(input())\nm = int(input())\nprint(n * 2)\n", "result": {"compileError": null, "rules": [{"id": "no-if", "passed": true, "message": "Реши без if: одна формула подходит для любого числа."}], "tests": [{"id": "ex-1", "kind": "io", "passed": false, "stdin": "3\n", "expected": "6", "output": "", "transcript": [["input", "3\n"]], "error": {"phase": "runtime", "origin": "program", "type": "EOFError", "message": "EOF when reading a line", "line": 2, "col": null, "endCol": null, "lineText": "m = int(input())", "summary": "EOFError: EOF when reading a line", "raw": "Traceback (most recent call last):\n  File \"main.py\", line 2, in <module>\n    m = int(input())\nEOFError: EOF when reading a line"}, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}, {"id": "ex-2", "kind": "io", "passed": false, "stdin": "7\n", "expected": "14", "output": "", "transcript": [["input", "7\n"]], "error": {"phase": "runtime", "origin": "program", "type": "EOFError", "message": "EOF when reading a line", "line": 2, "col": null, "endCol": null, "lineText": "m = int(input())", "summary": "EOFError: EOF when reading a line", "raw": "Traceback (most recent call last):\n  File \"main.py\", line 2, in <module>\n    m = int(input())\nEOFError: EOF when reading a line"}, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}, {"id": "edge-zero", "kind": "io", "passed": false, "stdin": "0\n", "expected": "0", "output": "", "transcript": [["input", "0\n"]], "error": {"phase": "runtime", "origin": "program", "type": "EOFError", "message": "EOF when reading a line", "line": 2, "col": null, "endCol": null, "lineText": "m = int(input())", "summary": "EOFError: EOF when reading a line", "raw": "Traceback (most recent call last):\n  File \"main.py\", line 2, in <module>\n    m = int(input())\nEOFError: EOF when reading a line"}, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}, {"id": "big", "kind": "io", "passed": false, "stdin": "100\n", "expected": "200", "output": "", "transcript": [["input", "100\n"]], "error": {"phase": "runtime", "origin": "program", "type": "EOFError", "message": "EOF when reading a line", "line": 2, "col": null, "endCol": null, "lineText": "m = int(input())", "summary": "EOFError: EOF when reading a line", "raw": "Traceback (most recent call last):\n  File \"main.py\", line 2, in <module>\n    m = int(input())\nEOFError: EOF when reading a line"}, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}]}},
  a_limit: {"code": "n = int(input())\nwhile True:\n    print(n * 2)\n", "result": {"compileError": null, "rules": [{"id": "no-if", "passed": true, "message": "Реши без if: одна формула подходит для любого числа."}], "tests": [{"id": "ex-1", "kind": "io", "passed": false, "stdin": "3\n", "expected": "6", "output": "6\n6\n6\n6\n6\n6\n6\n6\n6\n6\n6\n6\n6\n6\n6\n6\n6\n6\n6\n", "transcript": [["input", "3\n"], ["out", "6\n6\n6\n6\n6\n6\n6\n6\n6\n6\n6\n6\n6\n6\n6\n6\n6\n6\n6\n"]], "error": null, "limit": true, "truncated": true, "exitCode": null, "durationMs": 0.1}, {"id": "ex-2", "kind": "io", "passed": false, "stdin": "7\n", "expected": "14", "output": "14\n14\n14\n14\n14\n14\n14\n14\n14\n14\n14\n14\n14", "transcript": [["input", "7\n"], ["out", "14\n14\n14\n14\n14\n14\n14\n14\n14\n14\n14\n14\n14"]], "error": null, "limit": true, "truncated": true, "exitCode": null, "durationMs": 0.1}, {"id": "edge-zero", "kind": "io", "passed": false, "stdin": "0\n", "expected": "0", "output": "0\n0\n0\n0\n0\n0\n0\n0\n0\n0\n0\n0\n0\n0\n0\n0\n0\n0\n0\n", "transcript": [["input", "0\n"], ["out", "0\n0\n0\n0\n0\n0\n0\n0\n0\n0\n0\n0\n0\n0\n0\n0\n0\n0\n0\n"]], "error": null, "limit": true, "truncated": true, "exitCode": null, "durationMs": 0.1}, {"id": "big", "kind": "io", "passed": false, "stdin": "100\n", "expected": "200", "output": "200\n200\n200\n200\n200\n200\n200\n200\n200\n", "transcript": [["input", "100\n"], ["out", "200\n200\n200\n200\n200\n200\n200\n200\n200\n"]], "error": null, "limit": true, "truncated": true, "exitCode": null, "durationMs": 0.1}]}},
  a_rule: {"code": "n = int(input())\nif n == 3:\n    print(6)\nelse:\n    print(n * 2)\n", "result": {"compileError": null, "rules": [{"id": "no-if", "passed": false, "message": "Реши без if: одна формула подходит для любого числа."}], "tests": [{"id": "ex-1", "kind": "io", "passed": true, "stdin": "3\n", "expected": "6", "diff": null, "output": "6\n", "transcript": [["input", "3\n"], ["out", "6\n"]], "error": null, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}, {"id": "ex-2", "kind": "io", "passed": true, "stdin": "7\n", "expected": "14", "diff": null, "output": "14\n", "transcript": [["input", "7\n"], ["out", "14\n"]], "error": null, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}, {"id": "edge-zero", "kind": "io", "passed": true, "stdin": "0\n", "expected": "0", "diff": null, "output": "0\n", "transcript": [["input", "0\n"], ["out", "0\n"]], "error": null, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}, {"id": "big", "kind": "io", "passed": true, "stdin": "100\n", "expected": "200", "diff": null, "output": "200\n", "transcript": [["input", "100\n"], ["out", "200\n"]], "error": null, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}]}},
  a_zero: {"code": "n = int(input())\nprint(100 // (n - 7) * 0 + n * 2)\n", "result": {"compileError": null, "rules": [{"id": "no-if", "passed": true, "message": "Реши без if: одна формула подходит для любого числа."}], "tests": [{"id": "ex-1", "kind": "io", "passed": true, "stdin": "3\n", "expected": "6", "diff": null, "output": "6\n", "transcript": [["input", "3\n"], ["out", "6\n"]], "error": null, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}, {"id": "ex-2", "kind": "io", "passed": false, "stdin": "7\n", "expected": "14", "output": "", "transcript": [["input", "7\n"]], "error": {"phase": "runtime", "origin": "program", "type": "ZeroDivisionError", "message": "division by zero", "line": 2, "col": null, "endCol": null, "lineText": "print(100 // (n - 7) * 0 + n * 2)", "summary": "ZeroDivisionError: division by zero", "raw": "Traceback (most recent call last):\n  File \"main.py\", line 2, in <module>\n    print(100 // (n - 7) * 0 + n * 2)\nZeroDivisionError: division by zero"}, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}, {"id": "edge-zero", "kind": "io", "passed": true, "stdin": "0\n", "expected": "0", "diff": null, "output": "0\n", "transcript": [["input", "0\n"], ["out", "0\n"]], "error": null, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}, {"id": "big", "kind": "io", "passed": true, "stdin": "100\n", "expected": "200", "diff": null, "output": "200\n", "transcript": [["input", "100\n"], ["out", "200\n"]], "error": null, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}]}},
  a_js: {"code": "import js\nn = int(input())\nprint(n * 2)\n", "result": {"compileError": null, "rules": [{"id": "no-if", "passed": true, "message": "Реши без if: одна формула подходит для любого числа."}], "tests": [{"id": "ex-1", "kind": "io", "passed": false, "stdin": "3\n", "expected": "6", "output": "", "transcript": [], "error": {"phase": "runtime", "origin": "program", "type": "ModuleNotFoundError", "message": "Модуль «js» недоступен в учебной среде", "line": 1, "col": null, "endCol": null, "lineText": "import js", "summary": "ModuleNotFoundError: Модуль «js» недоступен в учебной среде", "raw": "Traceback (most recent call last):\n  File \"main.py\", line 1, in <module>\n    import js\nModuleNotFoundError: Модуль «js» недоступен в учебной среде"}, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}, {"id": "ex-2", "kind": "io", "passed": false, "stdin": "7\n", "expected": "14", "output": "", "transcript": [], "error": {"phase": "runtime", "origin": "program", "type": "ModuleNotFoundError", "message": "Модуль «js» недоступен в учебной среде", "line": 1, "col": null, "endCol": null, "lineText": "import js", "summary": "ModuleNotFoundError: Модуль «js» недоступен в учебной среде", "raw": "Traceback (most recent call last):\n  File \"main.py\", line 1, in <module>\n    import js\nModuleNotFoundError: Модуль «js» недоступен в учебной среде"}, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}, {"id": "edge-zero", "kind": "io", "passed": false, "stdin": "0\n", "expected": "0", "output": "", "transcript": [], "error": {"phase": "runtime", "origin": "program", "type": "ModuleNotFoundError", "message": "Модуль «js» недоступен в учебной среде", "line": 1, "col": null, "endCol": null, "lineText": "import js", "summary": "ModuleNotFoundError: Модуль «js» недоступен в учебной среде", "raw": "Traceback (most recent call last):\n  File \"main.py\", line 1, in <module>\n    import js\nModuleNotFoundError: Модуль «js» недоступен в учебной среде"}, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}, {"id": "big", "kind": "io", "passed": false, "stdin": "100\n", "expected": "200", "output": "", "transcript": [], "error": {"phase": "runtime", "origin": "program", "type": "ModuleNotFoundError", "message": "Модуль «js» недоступен в учебной среде", "line": 1, "col": null, "endCol": null, "lineText": "import js", "summary": "ModuleNotFoundError: Модуль «js» недоступен в учебной среде", "raw": "Traceback (most recent call last):\n  File \"main.py\", line 1, in <module>\n    import js\nModuleNotFoundError: Модуль «js» недоступен в учебной среде"}, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}]}},
  a_rule_and_limit: {"code": "n = int(input())\nif n == 3:\n    while True:\n        print(6)\nprint(n * 2)\n", "result": {"compileError": null, "rules": [{"id": "no-if", "passed": false, "message": "Реши без if: одна формула подходит для любого числа."}], "tests": [{"id": "ex-1", "kind": "io", "passed": false, "stdin": "3\n", "expected": "6", "output": "6\n6\n6\n6\n6\n6\n6\n6\n6\n6\n6\n6\n6\n6\n6\n6\n6\n6\n6\n", "transcript": [["input", "3\n"], ["out", "6\n6\n6\n6\n6\n6\n6\n6\n6\n6\n6\n6\n6\n6\n6\n6\n6\n6\n6\n"]], "error": null, "limit": true, "truncated": true, "exitCode": null, "durationMs": 0.1}, {"id": "ex-2", "kind": "io", "passed": true, "stdin": "7\n", "expected": "14", "diff": null, "output": "14\n", "transcript": [["input", "7\n"], ["out", "14\n"]], "error": null, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}, {"id": "edge-zero", "kind": "io", "passed": true, "stdin": "0\n", "expected": "0", "diff": null, "output": "0\n", "transcript": [["input", "0\n"], ["out", "0\n"]], "error": null, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}, {"id": "big", "kind": "io", "passed": true, "stdin": "100\n", "expected": "200", "diff": null, "output": "200\n", "transcript": [["input", "100\n"], ["out", "200\n"]], "error": null, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}]}},
  b_case: {"code": "name = input()\nprint(\"привет, \" + name + \"!\")\n", "result": {"compileError": null, "rules": [], "tests": [{"id": "ex-1", "kind": "io", "passed": false, "stdin": "Аня\n", "expected": "Привет, Аня!", "diff": {"kind": "mismatch", "line": 1, "expectedLine": "Привет, Аня!", "actualLine": "привет, Аня!", "hint": "case"}, "output": "привет, Аня!\n", "transcript": [["input", "Аня\n"], ["out", "привет, Аня!\n"]], "error": null, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}]}},
  b_spaces: {"code": "name = input()\nprint(\"Привет,\", name, \"!\")\n", "result": {"compileError": null, "rules": [], "tests": [{"id": "ex-1", "kind": "io", "passed": false, "stdin": "Аня\n", "expected": "Привет, Аня!", "diff": {"kind": "mismatch", "line": 1, "expectedLine": "Привет, Аня!", "actualLine": "Привет, Аня !", "hint": "spaces"}, "output": "Привет, Аня !\n", "transcript": [["input", "Аня\n"], ["out", "Привет, Аня !\n"]], "error": null, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}]}},
  b_quotes: {"code": "name = input()\nprint(\"Привет, '\" + name + \"'!\")\n", "result": {"compileError": null, "rules": [], "tests": [{"id": "ex-1", "kind": "io", "passed": false, "stdin": "Аня\n", "expected": "Привет, Аня!", "diff": {"kind": "mismatch", "line": 1, "expectedLine": "Привет, Аня!", "actualLine": "Привет, 'Аня'!", "hint": "quotes"}, "output": "Привет, 'Аня'!\n", "transcript": [["input", "Аня\n"], ["out", "Привет, 'Аня'!\n"]], "error": null, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}]}},
  b_cut: {"code": "name = input()\nprint(\"Привет, \" + name)\n", "result": {"compileError": null, "rules": [], "tests": [{"id": "ex-1", "kind": "io", "passed": false, "stdin": "Аня\n", "expected": "Привет, Аня!", "diff": {"kind": "mismatch", "line": 1, "expectedLine": "Привет, Аня!", "actualLine": "Привет, Аня", "hint": "cut"}, "output": "Привет, Аня\n", "transcript": [["input", "Аня\n"], ["out", "Привет, Аня\n"]], "error": null, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}]}},
  b_extra_text: {"code": "name = input()\nprint(\"Привет, \" + name + \"!!\")\n", "result": {"compileError": null, "rules": [], "tests": [{"id": "ex-1", "kind": "io", "passed": false, "stdin": "Аня\n", "expected": "Привет, Аня!", "diff": {"kind": "mismatch", "line": 1, "expectedLine": "Привет, Аня!", "actualLine": "Привет, Аня!!", "hint": "extra-text"}, "output": "Привет, Аня!!\n", "transcript": [["input", "Аня\n"], ["out", "Привет, Аня!!\n"]], "error": null, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}]}},
  b_empty: {"code": "name = input()\n", "result": {"compileError": null, "rules": [], "tests": [{"id": "ex-1", "kind": "io", "passed": false, "stdin": "Аня\n", "expected": "Привет, Аня!", "diff": {"kind": "empty", "line": 1, "expectedLine": "Привет, Аня!", "actualLine": null}, "output": "", "transcript": [["input", "Аня\n"]], "error": null, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}]}},
  b_uncalled: {"code": "def greet():\n    name = input()\n    print(\"Привет, \" + name + \"!\")\n", "result": {"compileError": null, "rules": [], "tests": [{"id": "ex-1", "kind": "io", "passed": false, "stdin": "Аня\n", "expected": "Привет, Аня!", "diff": {"kind": "empty", "line": 1, "expectedLine": "Привет, Аня!", "actualLine": null}, "output": "", "transcript": [], "error": null, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}]}},
  b_name: {"code": "name = input()\nprint(Привет, name)\n", "result": {"compileError": null, "rules": [], "tests": [{"id": "ex-1", "kind": "io", "passed": false, "stdin": "Аня\n", "expected": "Привет, Аня!", "output": "", "transcript": [["input", "Аня\n"]], "error": {"phase": "runtime", "origin": "program", "type": "NameError", "message": "name 'Привет' is not defined", "line": 2, "col": null, "endCol": null, "lineText": "print(Привет, name)", "summary": "NameError: name 'Привет' is not defined", "raw": "Traceback (most recent call last):\n  File \"main.py\", line 2, in <module>\n    print(Привет, name)\nNameError: name 'Привет' is not defined"}, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}]}},
  c_missing: {"code": "for i in range(1, 3):\n    print(i)\n", "result": {"compileError": null, "rules": [], "tests": [{"id": "ex-1", "kind": "io", "passed": false, "stdin": "", "expected": "1\n2\n3", "diff": {"kind": "missing", "line": 3, "expectedLine": "3", "actualLine": null, "count": 1}, "output": "1\n2\n", "transcript": [["out", "1\n2\n"]], "error": null, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}]}},
  c_line3: {"code": "print(1)\nprint(2)\nprint(4)\n", "result": {"compileError": null, "rules": [], "tests": [{"id": "ex-1", "kind": "io", "passed": false, "stdin": "", "expected": "1\n2\n3", "diff": {"kind": "mismatch", "line": 3, "expectedLine": "3", "actualLine": "4", "hint": "number"}, "output": "1\n2\n4\n", "transcript": [["out", "1\n2\n4\n"]], "error": null, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}]}},
  c_extra: {"code": "for i in range(1, 5):\n    print(i)\n", "result": {"compileError": null, "rules": [], "tests": [{"id": "ex-1", "kind": "io", "passed": false, "stdin": "", "expected": "1\n2\n3", "diff": {"kind": "extra", "line": 4, "expectedLine": null, "actualLine": "4", "count": 1}, "output": "1\n2\n3\n4\n", "transcript": [["out", "1\n2\n3\n4\n"]], "error": null, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}]}},
  d_missing_func: {"code": "def is_evn(n):\n    return n % 2 == 0\n", "result": {"compileError": null, "rules": [], "tests": [{"id": "ex-1", "kind": "call", "passed": false, "stdin": "", "call": "is_even(4)", "expected": "True", "output": "", "transcript": [], "error": {"phase": "runtime", "origin": "check", "type": "NameError", "message": "name 'is_even' is not defined", "line": null, "col": null, "endCol": null, "lineText": null, "summary": "NameError: name 'is_even' is not defined. Did you mean: 'is_evn'?", "raw": "NameError: name 'is_even' is not defined. Did you mean: 'is_evn'?"}, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}, {"id": "ex-2", "kind": "call", "passed": false, "stdin": "", "call": "is_even(7)", "expected": "False", "output": "", "transcript": [], "error": {"phase": "runtime", "origin": "check", "type": "NameError", "message": "name 'is_even' is not defined", "line": null, "col": null, "endCol": null, "lineText": null, "summary": "NameError: name 'is_even' is not defined. Did you mean: 'is_evn'?", "raw": "NameError: name 'is_even' is not defined. Did you mean: 'is_evn'?"}, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}]}},
  d_print: {"code": "def is_even(n):\n    print(n % 2 == 0)\n", "result": {"compileError": null, "rules": [], "tests": [{"id": "ex-1", "kind": "call", "passed": false, "stdin": "", "call": "is_even(4)", "expected": "True", "actual": "None", "actualType": "NoneType", "expectedType": "bool", "output": "True\n", "transcript": [["out", "True\n"]], "error": null, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}, {"id": "ex-2", "kind": "call", "passed": false, "stdin": "", "call": "is_even(7)", "expected": "False", "actual": "None", "actualType": "NoneType", "expectedType": "bool", "output": "False\n", "transcript": [["out", "False\n"]], "error": null, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}]}},
  d_inverted: {"code": "def is_even(n):\n    return n % 2 == 1\n", "result": {"compileError": null, "rules": [], "tests": [{"id": "ex-1", "kind": "call", "passed": false, "stdin": "", "call": "is_even(4)", "expected": "True", "actual": "False", "actualType": "bool", "expectedType": "bool", "output": "", "transcript": [], "error": null, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}, {"id": "ex-2", "kind": "call", "passed": false, "stdin": "", "call": "is_even(7)", "expected": "False", "actual": "True", "actualType": "bool", "expectedType": "bool", "output": "", "transcript": [], "error": null, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}]}},
  d_str: {"code": "def is_even(n):\n    return \"True\"\n", "result": {"compileError": null, "rules": [], "tests": [{"id": "ex-1", "kind": "call", "passed": false, "stdin": "", "call": "is_even(4)", "expected": "True", "actual": "'True'", "actualType": "str", "expectedType": "bool", "output": "", "transcript": [], "error": null, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}, {"id": "ex-2", "kind": "call", "passed": false, "stdin": "", "call": "is_even(7)", "expected": "False", "actual": "'True'", "actualType": "str", "expectedType": "bool", "output": "", "transcript": [], "error": null, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}]}},
  d_input: {"code": "def is_even(n):\n    n = int(input())\n    return n % 2 == 0\n", "result": {"compileError": null, "rules": [], "tests": [{"id": "ex-1", "kind": "call", "passed": false, "stdin": "", "call": "is_even(4)", "expected": "True", "output": "", "transcript": [], "error": {"phase": "runtime", "origin": "program", "type": "EOFError", "message": "EOF when reading a line", "line": 2, "col": null, "endCol": null, "lineText": "    n = int(input())", "summary": "EOFError: EOF when reading a line", "raw": "Traceback (most recent call last):\n  File \"main.py\", line 2, in is_even\n    n = int(input())\nEOFError: EOF when reading a line"}, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}, {"id": "ex-2", "kind": "call", "passed": false, "stdin": "", "call": "is_even(7)", "expected": "False", "output": "", "transcript": [], "error": {"phase": "runtime", "origin": "program", "type": "EOFError", "message": "EOF when reading a line", "line": 2, "col": null, "endCol": null, "lineText": "    n = int(input())", "summary": "EOFError: EOF when reading a line", "raw": "Traceback (most recent call last):\n  File \"main.py\", line 2, in is_even\n    n = int(input())\nEOFError: EOF when reading a line"}, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}]}},
  d_params: {"code": "def is_even():\n    return True\n", "result": {"compileError": null, "rules": [], "tests": [{"id": "ex-1", "kind": "call", "passed": false, "stdin": "", "call": "is_even(4)", "expected": "True", "output": "", "transcript": [], "error": {"phase": "runtime", "origin": "check", "type": "TypeError", "message": "is_even() takes 0 positional arguments but 1 was given", "line": null, "col": null, "endCol": null, "lineText": null, "summary": "TypeError: is_even() takes 0 positional arguments but 1 was given", "raw": "TypeError: is_even() takes 0 positional arguments but 1 was given"}, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}, {"id": "ex-2", "kind": "call", "passed": false, "stdin": "", "call": "is_even(7)", "expected": "False", "output": "", "transcript": [], "error": {"phase": "runtime", "origin": "check", "type": "TypeError", "message": "is_even() takes 0 positional arguments but 1 was given", "line": null, "col": null, "endCol": null, "lineText": null, "summary": "TypeError: is_even() takes 0 positional arguments but 1 was given", "raw": "TypeError: is_even() takes 0 positional arguments but 1 was given"}, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}]}},
  d_nested: {"code": "def main():\n    def is_even(n):\n        return n % 2 == 0\n", "result": {"compileError": null, "rules": [], "tests": [{"id": "ex-1", "kind": "call", "passed": false, "stdin": "", "call": "is_even(4)", "expected": "True", "output": "", "transcript": [], "error": {"phase": "runtime", "origin": "check", "type": "NameError", "message": "name 'is_even' is not defined", "line": null, "col": null, "endCol": null, "lineText": null, "summary": "NameError: name 'is_even' is not defined", "raw": "NameError: name 'is_even' is not defined"}, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}, {"id": "ex-2", "kind": "call", "passed": false, "stdin": "", "call": "is_even(7)", "expected": "False", "output": "", "transcript": [], "error": {"phase": "runtime", "origin": "check", "type": "NameError", "message": "name 'is_even' is not defined", "line": null, "col": null, "endCol": null, "lineText": null, "summary": "NameError: name 'is_even' is not defined", "raw": "NameError: name 'is_even' is not defined"}, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}]}},
  e_assert: {"code": "total = 9\n", "result": {"compileError": null, "rules": [], "tests": [{"id": "a-1", "kind": "assert", "passed": false, "stdin": "", "message": "Переменная total должна быть равна 10.", "output": "", "transcript": [], "error": null, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}]}},
  f_pattern: {"code": "print(\"сто рублей\")\n", "result": {"compileError": null, "rules": [], "tests": [{"id": "ex-1", "kind": "io", "passed": false, "stdin": "", "expected": "\\d+ руб\\.", "diff": {"kind": "pattern", "line": null, "expectedLine": null, "actualLine": "сто рублей"}, "output": "сто рублей\n", "transcript": [["out", "сто рублей\n"]], "error": null, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}]}},
  // G — меню из трёх строк, N — число с вводом 5, AGE — длинная строка приветствия, QUOTE — кавычки,
  // GREET — функция с длинной строкой; d_exit и c_missing2 — к заданиям D и C.
  g_crash_after_output: {"code": "print(\"Меню дня\")\nprint(\"Капучино\")\nPrint(\"x\")\n", "result": {"compileError": null, "rules": [], "tests": [{"id": "t1", "kind": "io", "passed": false, "stdin": "", "expected": "Меню дня\nКапучино\nКакао", "output": "Меню дня\nКапучино\n", "transcript": [["out", "Меню дня\nКапучино\n"]], "error": {"phase": "runtime", "origin": "program", "type": "NameError", "message": "name 'Print' is not defined", "line": 3, "col": null, "endCol": null, "lineText": "Print(\"x\")", "summary": "NameError: name 'Print' is not defined. Did you mean: 'print'?", "raw": "Traceback (most recent call last):\n  File \"main.py\", line 3, in <module>\n    Print(\"x\")\nNameError: name 'Print' is not defined. Did you mean: 'print'?"}, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}]}},
  g_missing: {"code": "print(\"Меню дня\")\nprint(\"Капучино\")\n", "result": {"compileError": null, "rules": [], "tests": [{"id": "t1", "kind": "io", "passed": false, "stdin": "", "expected": "Меню дня\nКапучино\nКакао", "diff": {"kind": "missing", "line": 3, "expectedLine": "Какао", "actualLine": null, "count": 1}, "output": "Меню дня\nКапучино\n", "transcript": [["out", "Меню дня\nКапучино\n"]], "error": null, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}]}},
  n_plus: {"code": "n = int(input())\nprint(f\"{n:+}\")\n", "result": {"compileError": null, "rules": [], "tests": [{"id": "ex-1", "kind": "io", "passed": false, "stdin": "5\n", "expected": "5", "diff": {"kind": "mismatch", "line": 1, "expectedLine": "5", "actualLine": "+5", "hint": "number-format"}, "output": "+5\n", "transcript": [["input", "5\n"], ["out", "+5\n"]], "error": null, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}]}},
  n_zeros: {"code": "n = int(input())\nprint(f\"{n:03}\")\n", "result": {"compileError": null, "rules": [], "tests": [{"id": "ex-1", "kind": "io", "passed": false, "stdin": "5\n", "expected": "5", "diff": {"kind": "mismatch", "line": 1, "expectedLine": "5", "actualLine": "005", "hint": "number-format"}, "output": "005\n", "transcript": [["input", "5\n"], ["out", "005\n"]], "error": null, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}]}},
  n_digits: {"code": "n = int(input())\nprint(f\"{n:.2f}\")\n", "result": {"compileError": null, "rules": [], "tests": [{"id": "ex-1", "kind": "io", "passed": false, "stdin": "5\n", "expected": "5.0", "diff": {"kind": "mismatch", "line": 1, "expectedLine": "5.0", "actualLine": "5.00", "hint": "number-format"}, "output": "5.00\n", "transcript": [["input", "5\n"], ["out", "5.00\n"]], "error": null, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}]}},
  age_long: {"code": "name = input()\nage = int(input())\nprint(f\"Привет, {name}! Тебе {age} лет, через год будет {age + 2}\")\n", "result": {"compileError": null, "rules": [], "tests": [{"id": "ex-1", "kind": "io", "passed": false, "stdin": "Аня\n15\n", "expected": "Привет, Аня! Тебе 15 лет, через год будет 16", "diff": {"kind": "mismatch", "line": 1, "expectedLine": "Привет, Аня! Тебе 15 лет, через год будет 16", "actualLine": "Привет, Аня! Тебе 15 лет, через год будет 17", "hint": null}, "output": "Привет, Аня! Тебе 15 лет, через год будет 17\n", "transcript": [["input", "Аня\n15\n"], ["out", "Привет, Аня! Тебе 15 лет, через год будет 17\n"]], "error": null, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}]}},
  quote_kind: {"code": "print(\"Он сказал 'да'\")\n", "result": {"compileError": null, "rules": [], "tests": [{"id": "ex-1", "kind": "io", "passed": false, "stdin": "", "expected": "Он сказал \"да\"", "diff": {"kind": "mismatch", "line": 1, "expectedLine": "Он сказал \"да\"", "actualLine": "Он сказал 'да'", "hint": "quotes"}, "output": "Он сказал 'да'\n", "transcript": [["out", "Он сказал 'да'\n"]], "error": null, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}]}},
  // quote_place — harness.py в Pyodide 314.0.7 (Python 3.14.2), durationMs тоже заменён на 0.1.
  quote_place: {"code": "print('\"Он сказал да\"')\n", "result": {"compileError": null, "rules": [], "tests": [{"id": "ex-1", "kind": "io", "passed": false, "stdin": "", "expected": "Он сказал \"да\"", "diff": {"kind": "mismatch", "line": 1, "expectedLine": "Он сказал \"да\"", "actualLine": "\"Он сказал да\"", "hint": "quotes"}, "output": "\"Он сказал да\"\n", "transcript": [["out", "\"Он сказал да\"\n"]], "error": null, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}]}},
  d_exit:{"code": "exit()\ndef is_even(n):\n    return n % 2 == 0\n", "result": {"compileError": null, "rules": [], "tests": [{"id": "ex-1", "kind": "call", "passed": false, "stdin": "", "call": "is_even(4)", "expected": "True", "output": "", "transcript": [], "error": {"phase": "runtime", "origin": "check", "type": "NameError", "message": "name 'is_even' is not defined", "line": null, "col": null, "endCol": null, "lineText": null, "summary": "NameError: name 'is_even' is not defined", "raw": "NameError: name 'is_even' is not defined"}, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}, {"id": "ex-2", "kind": "call", "passed": false, "stdin": "", "call": "is_even(7)", "expected": "False", "output": "", "transcript": [], "error": {"phase": "runtime", "origin": "check", "type": "NameError", "message": "name 'is_even' is not defined", "line": null, "col": null, "endCol": null, "lineText": null, "summary": "NameError: name 'is_even' is not defined", "raw": "NameError: name 'is_even' is not defined"}, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}]}},
  greet_long: {"code": "def greet(name):\n    return \"Привет, \" + name + \"! Рады видеть тебя в нашей кофейне сегодня вечером\"\n", "result": {"compileError": null, "rules": [], "tests": [{"id": "ex-1", "kind": "call", "passed": false, "stdin": "", "call": "greet('Аня')", "expected": "'Привет, Аня! Рады видеть тебя в нашей кофейне сегодня утром'", "actual": "'Привет, Аня! Рады видеть тебя в нашей кофейне сегодня вечером'", "actualType": "str", "expectedType": "str", "output": "", "transcript": [], "error": null, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}]}},
  c_missing2: {"code": "print(1)\n", "result": {"compileError": null, "rules": [], "tests": [{"id": "ex-1", "kind": "io", "passed": false, "stdin": "", "expected": "1\n2\n3", "diff": {"kind": "missing", "line": 2, "expectedLine": "2", "actualLine": null, "count": 2}, "output": "1\n", "transcript": [["out", "1\n"]], "error": null, "limit": false, "truncated": false, "exitCode": null, "durationMs": 0.1}]}},
};

const RUNS: Record<string, { code: string; result: RunResult }> = {
  run_ok: {"code": "print(\"Привет\")\n", "result": {"error": null, "limit": false, "exitCode": null, "durationMs": 0.1, "transcript": [["out", "Привет\n"]], "stdout": "Привет\n", "truncated": false}},
  run_compile: {"code": "print(\"Привет)\n", "result": {"compileError": {"phase": "compile", "type": "SyntaxError", "message": "unterminated string literal (detected at line 1)", "line": 1, "col": 7, "endCol": 7, "lineText": "print(\"Привет)", "summary": "SyntaxError: unterminated string literal (detected at line 1)", "raw": "  File \"main.py\", line 1\n    print(\"Привет)\n          ^\nSyntaxError: unterminated string literal (detected at line 1)"}}},
  run_eof: {"code": "a = input()\nb = input()\n", "result": {"error": {"phase": "runtime", "origin": "program", "type": "EOFError", "message": "EOF when reading a line", "line": 2, "col": null, "endCol": null, "lineText": "b = input()", "summary": "EOFError: EOF when reading a line", "raw": "Traceback (most recent call last):\n  File \"main.py\", line 2, in <module>\n    b = input()\nEOFError: EOF when reading a line"}, "limit": false, "exitCode": null, "durationMs": 0.1, "transcript": [["input", "1\n"]], "stdout": "", "truncated": false}},
  run_limit: {"code": "while True:\n    print(\"a\")\n", "result": {"error": null, "limit": true, "exitCode": null, "durationMs": 0.1, "transcript": [["out", "a\na\na\na\na\na\na\na\na\na\na\na\na\na\na\na\na\na\na\na\n"]], "stdout": "a\na\na\na\na\na\na\na\na\na\na\na\na\na\na\na\na\na\na\na\n", "truncated": true}},
  run_name: {"code": "prnt(\"a\")\n", "result": {"error": {"phase": "runtime", "origin": "program", "type": "NameError", "message": "name 'prnt' is not defined", "line": 1, "col": null, "endCol": null, "lineText": "prnt(\"a\")", "summary": "NameError: name 'prnt' is not defined. Did you mean: 'print'?", "raw": "Traceback (most recent call last):\n  File \"main.py\", line 1, in <module>\n    prnt(\"a\")\nNameError: name 'prnt' is not defined. Did you mean: 'print'?"}, "limit": false, "exitCode": null, "durationMs": 0.1, "transcript": [], "stdout": "", "truncated": false}},
};

// Ошибки целиком, как их вернул harness.py (run_program): CPython 3.14.7; dbm и packaging — Pyodide 314.0.7.
const REAL_ERRORS = {
  scope: {"phase": "runtime", "origin": "program", "type": "NameError", "message": "name 'result' is not defined", "line": 4, "col": null, "endCol": null, "lineText": "print(result)", "summary": "NameError: name 'result' is not defined", "raw": "Traceback (most recent call last):\n  File \"main.py\", line 4, in <module>\n    print(result)\nNameError: name 'result' is not defined"},
  apostrophe: {"phase": "compile", "type": "SyntaxError", "message": "unterminated string literal (detected at line 1)", "line": 1, "col": 7, "endCol": 7, "lineText": "print(\"It's)", "summary": "SyntaxError: unterminated string literal (detected at line 1)", "raw": "  File \"main.py\", line 1\n    print(\"It's)\n          ^\nSyntaxError: unterminated string literal (detected at line 1)"},
  dont: {"phase": "compile", "type": "SyntaxError", "message": "unterminated string literal (detected at line 1)", "line": 1, "col": 7, "endCol": 7, "lineText": "print(\"Don't)", "summary": "SyntaxError: unterminated string literal (detected at line 1)", "raw": "  File \"main.py\", line 1\n    print(\"Don't)\n          ^\nSyntaxError: unterminated string literal (detected at line 1)"},
  mixed: {"phase": "compile", "type": "SyntaxError", "message": "unterminated string literal (detected at line 1)", "line": 1, "col": 7, "endCol": 7, "lineText": "print(\"Привет')", "summary": "SyntaxError: unterminated string literal (detected at line 1)", "raw": "  File \"main.py\", line 1\n    print(\"Привет')\n          ^\nSyntaxError: unterminated string literal (detected at line 1)"},
  set_remove: {"phase": "runtime", "origin": "program", "type": "KeyError", "message": "2", "line": 2, "col": null, "endCol": null, "lineText": "s.remove(2)", "summary": "KeyError: 2", "raw": "Traceback (most recent call last):\n  File \"main.py\", line 2, in <module>\n    s.remove(2)\nKeyError: 2"},
  set_pop: {"phase": "runtime", "origin": "program", "type": "KeyError", "message": "'pop from an empty set'", "line": 2, "col": null, "endCol": null, "lineText": "s.pop()", "summary": "KeyError: 'pop from an empty set'", "raw": "Traceback (most recent call last):\n  File \"main.py\", line 2, in <module>\n    s.pop()\nKeyError: 'pop from an empty set'"},
  keyerror_dict: {"phase": "runtime", "origin": "program", "type": "KeyError", "message": "'b'", "line": 2, "col": null, "endCol": null, "lineText": "print(d[\"b\"])", "summary": "KeyError: 'b'", "raw": "Traceback (most recent call last):\n  File \"main.py\", line 2, in <module>\n    print(d[\"b\"])\nKeyError: 'b'"},
  int_comma: {"phase": "runtime", "origin": "program", "type": "ValueError", "message": "invalid literal for int() with base 10: '3,5'", "line": 1, "col": null, "endCol": null, "lineText": "x = int(\"3,5\")", "summary": "ValueError: invalid literal for int() with base 10: '3,5'", "raw": "Traceback (most recent call last):\n  File \"main.py\", line 1, in <module>\n    x = int(\"3,5\")\nValueError: invalid literal for int() with base 10: '3,5'"},
  int_apostrophe: {"phase": "runtime", "origin": "program", "type": "ValueError", "message": "invalid literal for int() with base 10: \"it's\"", "line": 1, "col": null, "endCol": null, "lineText": "x = int(\"it's\")", "summary": "ValueError: invalid literal for int() with base 10: \"it's\"", "raw": "Traceback (most recent call last):\n  File \"main.py\", line 1, in <module>\n    x = int(\"it's\")\nValueError: invalid literal for int() with base 10: \"it's\""},
  float_apostrophe: {"phase": "runtime", "origin": "program", "type": "ValueError", "message": "could not convert string to float: \"it's\"", "line": 1, "col": null, "endCol": null, "lineText": "x = float(\"it's\")", "summary": "ValueError: could not convert string to float: \"it's\"", "raw": "Traceback (most recent call last):\n  File \"main.py\", line 1, in <module>\n    x = float(\"it's\")\nValueError: could not convert string to float: \"it's\""},
  log0: {"phase": "runtime", "origin": "program", "type": "ValueError", "message": "expected a positive input", "line": 2, "col": null, "endCol": null, "lineText": "print(math.log(0))", "summary": "ValueError: expected a positive input", "raw": "Traceback (most recent call last):\n  File \"main.py\", line 2, in <module>\n    print(math.log(0))\nValueError: expected a positive input"},
  sqrt_neg: {"phase": "runtime", "origin": "program", "type": "ValueError", "message": "expected a nonnegative input, got -1.0", "line": 2, "col": null, "endCol": null, "lineText": "print(math.sqrt(-1))", "summary": "ValueError: expected a nonnegative input, got -1.0", "raw": "Traceback (most recent call last):\n  File \"main.py\", line 2, in <module>\n    print(math.sqrt(-1))\nValueError: expected a nonnegative input, got -1.0"},
  bare_ru: {"phase": "compile", "type": "SyntaxError", "message": "invalid syntax. Perhaps you forgot a comma?", "line": 1, "col": 7, "endCol": 17, "lineText": "print(Привет мир)", "summary": "SyntaxError: invalid syntax. Perhaps you forgot a comma?", "raw": "  File \"main.py\", line 1\n    print(Привет мир)\n          ^^^^^^^^^^\nSyntaxError: invalid syntax. Perhaps you forgot a comma?"},
  dbm: {"phase": "runtime", "origin": "program", "type": "ModuleNotFoundError", "message": "No module named 'dbm'", "line": 1, "col": null, "endCol": null, "lineText": "import dbm", "summary": "ModuleNotFoundError: No module named 'dbm'", "raw": "Traceback (most recent call last):\n  File \"main.py\", line 1, in <module>\n    import dbm\nModuleNotFoundError: No module named 'dbm'"},
  packaging: {"phase": "runtime", "origin": "program", "type": "ModuleNotFoundError", "message": "No module named 'packaging'", "line": 1, "col": null, "endCol": null, "lineText": "import packaging", "summary": "ModuleNotFoundError: No module named 'packaging'", "raw": "Traceback (most recent call last):\n  File \"main.py\", line 1, in <module>\n    import packaging\nModuleNotFoundError: No module named 'packaging'"},
} satisfies Record<string, PyError>;

// ------------------------------------------------------------------ помощники

function makeExercise(tests: ContentTest[], mistakes: unknown[] = [], rules: unknown[] = []): Exercise {
  return exerciseSchema.parse({
    id: 'sample',
    kind: 'write',
    title: 'Учебное задание',
    statement: 'Условие задания.',
    starterCode: '# напиши код здесь\n',
    tests,
    rules,
    criteria: ['Программа проходит тесты'],
    hints: ['Подсказка 1', 'Подсказка 2', 'Подсказка 3'],
    solution: { code: 'print(1)', explanation: 'Объяснение.' },
    wrongSolutions: [{ code: 'print(2)', note: 'Неверно' }],
    mistakes,
    skills: ['sample-skill'],
  });
}

const RULE_NO_IF = { id: 'no-if', avoid: ['If'], message: 'Реши без if: одна формула подходит для любого числа.' };
const exA = (mistakes: unknown[] = []) => makeExercise(TESTS.A, mistakes, [RULE_NO_IF]);
const exB = () => makeExercise(TESTS.B);
const exC = () => makeExercise(TESTS.C);
const exD = () => makeExercise(TESTS.D);
const exE = () => makeExercise(TESTS.E);
const exF = () => makeExercise(TESTS.F);

function done(key: string): CheckOutcome {
  return { status: 'done', result: structuredClone(CHECKS[key].result) };
}

const BANNED = /молодец|отлично|очевидно|элементарно|неправильно|глуп|стыдно|ты ошиб|легко же|просто же/i;

function sentences(text: string): number {
  return text.split(/(?<=[.!?…])\s+(?=[А-ЯЁA-Z„«"])/u).filter((part) => part.trim()).length;
}

function words(...texts: (string | null)[]): number {
  return texts
    .filter((text): text is string => !!text)
    .join(' ')
    .split(/\s+/)
    .filter(Boolean).length;
}

/** Короткий разбор: до ~100 слов, 1–2 предложения на поле, без упрёков и пустой похвалы. */
function expectShort(feedback: Feedback) {
  expect(feedback.title.length).toBeGreaterThan(0);
  expect(feedback.why.length).toBeGreaterThan(0);
  expect(feedback.tryThis.length).toBeGreaterThan(0);
  expect(sentences(feedback.why)).toBeLessThanOrEqual(2);
  expect(sentences(feedback.tryThis)).toBeLessThanOrEqual(2);
  if (feedback.verify) expect(sentences(feedback.verify)).toBeLessThanOrEqual(2);
  expect(words(feedback.where, feedback.why, feedback.tryThis, feedback.verify)).toBeLessThanOrEqual(100);
  for (const text of [feedback.title, feedback.why, feedback.tryThis, feedback.verify ?? '']) {
    expect(text).not.toMatch(BANNED);
  }
}

function check(exercise: Exercise, key: string): Feedback {
  const feedback = buildCheckFeedback(exercise, CHECKS[key].code, done(key));
  expect(feedback).not.toBeNull();
  expectShort(feedback!);
  return feedback!;
}

function checkWith(exercise: Exercise, code: string, result: CheckResult): Feedback {
  const feedback = buildCheckFeedback(exercise, code, { status: 'done', result });
  expect(feedback).not.toBeNull();
  expectShort(feedback!);
  return feedback!;
}

function run(key: string): Feedback | null {
  const feedback = buildRunFeedback(RUNS[key].code, { status: 'done', result: structuredClone(RUNS[key].result) });
  if (feedback) expectShort(feedback);
  return feedback;
}

// Ошибки в том виде, в каком их формирует harness.py (_describe_syntax_error / _describe_exception).
function compileError(type: string, message: string, line: number, lineText: string, col = 1): PyError {
  const summary = `${type}: ${message}`;
  return {
    phase: 'compile',
    type,
    message,
    line,
    col,
    endCol: col,
    lineText,
    summary,
    raw: `  File "main.py", line ${line}\n    ${lineText.trim()}\n    ${' '.repeat(Math.max(0, col - 1))}^\n${summary}`,
  };
}

function runtimeError(
  type: string,
  message: string,
  line: number | null,
  lineText: string | null,
  options: { summary?: string; origin?: 'program' | 'check'; raw?: string } = {},
): PyError {
  const summary = options.summary ?? (message ? `${type}: ${message}` : type);
  const raw =
    options.raw ??
    (line
      ? `Traceback (most recent call last):\n  File "main.py", line ${line}, in <module>\n    ${lineText?.trim()}\n${summary}`
      : summary);
  return {
    phase: 'runtime',
    origin: options.origin ?? 'program',
    type,
    message,
    line,
    col: null,
    endCol: null,
    lineText,
    summary,
    raw,
  };
}

// ------------------------------------------------------------------ explainError

interface Case {
  name: string;
  error: PyError;
  code?: string;
  title: string | RegExp;
  environment?: boolean;
  why?: string;
  tryThis?: string;
}

const CASES: Case[] = [
  // --- SyntaxError
  {
    name: 'незакрытая строка',
    error: compileError('SyntaxError', 'unterminated string literal (detected at line 1)', 1, 'print("Привет)', 7),
    title: 'Незакрытая строка',
    tryThis: 'кавычку',
  },
  {
    name: 'строка с разными кавычками',
    error: compileError('SyntaxError', 'unterminated string literal (detected at line 1)', 1, 'print("Привет\')', 7),
    title: 'Разные кавычки у строки',
  },
  {
    name: 'незакрытая f-строка',
    error: compileError('SyntaxError', 'unterminated f-string literal (detected at line 1)', 1, 'x = f"abc', 5),
    title: 'Незакрытая строка',
  },
  {
    name: 'незакрытая многострочная строка',
    error: compileError('SyntaxError', 'unterminated triple-quoted string literal (detected at line 1)', 1, 'x = """abc', 5),
    title: 'Незакрытая многострочная строка',
  },
  {
    name: 'незакрытая скобка',
    error: compileError('SyntaxError', "'(' was never closed", 1, 'print("a"', 6),
    title: 'Незакрытая скобка',
    tryThis: '„)“',
  },
  {
    name: 'лишняя скобка',
    error: compileError('SyntaxError', "unmatched ')'", 1, 'print("a"))', 11),
    title: 'Лишняя скобка',
  },
  {
    name: 'скобки не совпадают',
    error: compileError('SyntaxError', "closing parenthesis ')' does not match opening parenthesis '['", 1, 'x = [1, 2)', 10),
    title: 'Скобки не совпадают',
    tryThis: '„]“',
  },
  {
    name: 'f-строка без }',
    error: compileError('SyntaxError', "f-string: expecting '}'", 1, 'x = f"{a"', 8),
    title: 'Ошибка в f-строке',
  },
  {
    name: 'нет двоеточия после if',
    error: compileError('SyntaxError', "expected ':'", 1, 'if x > 1', 9),
    title: 'Не хватает двоеточия',
    why: '„if“',
  },
  {
    name: 'нет двоеточия после else',
    error: compileError('SyntaxError', "expected ':'", 3, 'else', 5),
    title: 'Не хватает двоеточия',
    why: '„else“',
  },
  {
    name: 'ёлочки',
    error: compileError('SyntaxError', "invalid character '«' (U+00AB)", 1, 'print(«Привет»)', 7),
    title: 'Неподходящие кавычки',
    why: 'Ёлочки и типографские кавычки не подходят',
  },
  {
    name: 'типографские кавычки',
    error: compileError('SyntaxError', "invalid character '“' (U+201C)", 1, 'print(“Привет”)', 7),
    title: 'Неподходящие кавычки',
    why: 'прямые " или \'',
  },
  {
    name: 'закрывающая типографская кавычка',
    error: compileError('SyntaxError', "invalid character '”' (U+201D)", 1, 'print("Привет”)', 14),
    title: 'Неподходящие кавычки',
  },
  {
    name: 'тире вместо минуса',
    error: compileError('SyntaxError', "invalid character '—' (U+2014)", 1, 'x = 5 — 3', 7),
    title: 'Тире вместо минуса',
  },
  {
    name: 'другой недопустимый символ',
    error: compileError('SyntaxError', "invalid character '№' (U+2116)", 1, 'x = №1', 5),
    title: 'Недопустимый символ',
  },
  {
    name: 'невидимый символ',
    error: compileError('SyntaxError', 'invalid non-printable character U+00A0', 1, 'x = 1', 2),
    title: 'Невидимый символ',
  },
  {
    name: 'print без скобок',
    error: compileError('SyntaxError', "Missing parentheses in call to 'print'. Did you mean print(...)?", 1, 'print "hi"', 1),
    title: 'Нужны скобки после print',
    tryThis: 'print("Привет")',
  },
  {
    name: 'пропущена запятая',
    error: compileError('SyntaxError', 'invalid syntax. Perhaps you forgot a comma?', 1, 'print("a" "b" x)', 7),
    title: 'Пропущена запятая?',
  },
  {
    name: 'цифры и буквы слитно',
    error: compileError('SyntaxError', 'invalid decimal literal', 1, 'x = 1abc', 5),
    title: 'Цифры и буквы слитно',
  },
  {
    name: 'ведущий ноль',
    error: compileError(
      'SyntaxError',
      'leading zeros in decimal integer literals are not permitted; use an 0o prefix for octal integers',
      1,
      'x = 05',
      5,
    ),
    title: 'Число с ведущим нулём',
  },
  {
    name: 'присваивание выражению',
    error: compileError('SyntaxError', "cannot assign to expression here. Maybe you meant '==' instead of '='?", 1, 'x + 1 = 5'),
    title: 'Перепутаны = и ==',
  },
  {
    name: 'присваивание литералу',
    error: compileError('SyntaxError', "cannot assign to literal here. Maybe you meant '==' instead of '='?", 1, '5 = x'),
    title: 'Перепутаны = и ==',
    tryThis: '==',
  },
  {
    name: '= в условии',
    error: compileError('SyntaxError', "invalid syntax. Maybe you meant '==' or ':=' instead of '='?", 1, 'if x = 5:', 4),
    title: 'Перепутаны = и ==',
  },
  {
    name: '= внутри вызова',
    error: compileError('SyntaxError', 'expression cannot contain assignment, perhaps you meant "=="?', 1, 'print("a" = 5)', 7),
    title: 'Перепутаны = и ==',
  },
  {
    name: 'присваивание сравнению',
    error: compileError('SyntaxError', 'cannot assign to comparison', 1, 'x == 5 = 3'),
    title: 'Слева от = должно быть имя',
  },
  {
    name: 'опечатка в ключевом слове',
    error: {
      ...compileError('SyntaxError', 'invalid syntax', 1, 'fro i in range(3):'),
      summary: "SyntaxError: invalid syntax. Did you mean 'for'?",
    },
    title: 'Опечатка в ключевом слове?',
    tryThis: '„for“',
  },
  {
    name: 'служебное слово как имя',
    error: compileError('SyntaxError', 'invalid syntax', 1, 'class = 5', 7),
    title: 'Служебное слово вместо имени',
  },
  {
    name: 'else без if',
    error: compileError('SyntaxError', 'invalid syntax', 1, 'else:', 1),
    title: 'else без if',
  },
  {
    name: '=> вместо >=',
    error: compileError('SyntaxError', 'invalid syntax', 1, 'if x => 5:', 6),
    title: 'Неверный знак сравнения',
  },
  {
    name: 'invalid syntax в общем виде',
    error: compileError('SyntaxError', 'invalid syntax', 1, 'x = = 5', 5),
    title: 'Python не понял строку',
  },
  {
    name: 'return вне функции',
    error: compileError('SyntaxError', "'return' outside function", 1, 'return 5'),
    title: 'return вне функции',
  },
  {
    name: 'break вне цикла',
    error: compileError('SyntaxError', "'break' outside loop", 1, 'break'),
    title: 'break вне цикла',
  },
  {
    name: 'def без скобок',
    error: compileError('SyntaxError', "expected '('", 1, 'def f:', 6),
    title: 'Не хватает скобок после имени функции',
  },
  {
    name: 'try без except',
    error: compileError('SyntaxError', "expected 'except' or 'finally' block", 3, 'print(x)'),
    title: 'После try нужен except',
  },
  {
    name: 'символ после \\',
    error: compileError('SyntaxError', 'unexpected character after line continuation character', 1, 'x = 1 \\ 2', 7),
    title: 'Лишний символ после \\',
  },
  {
    name: 'неизвестная синтаксическая ошибка',
    error: compileError('SyntaxError', 'something new in Python 3.15', 1, 'x'),
    title: 'Синтаксическая ошибка',
  },
  // --- IndentationError / TabError
  {
    name: 'лишний отступ',
    error: compileError('IndentationError', 'unexpected indent', 2, '    y = 2', 4),
    title: 'Лишний отступ',
  },
  {
    name: 'нет отступа после for',
    error: compileError('IndentationError', "expected an indented block after 'for' statement on line 1", 2, 'print(i)'),
    title: 'Нет отступа',
    why: 'После строки 1 с „for“',
  },
  {
    name: 'нет отступа после def',
    error: compileError('IndentationError', 'expected an indented block after function definition on line 1', 2, 'return 1'),
    title: 'Нет отступа',
    why: '„def“',
  },
  {
    name: 'отступ не совпадает',
    error: compileError('IndentationError', 'unindent does not match any outer indentation level', 3, '    y = 2', 10),
    title: 'Отступ не совпадает',
  },
  {
    name: 'табуляция',
    error: compileError('TabError', 'inconsistent use of tabs and spaces in indentation', 3, '        y = 2'),
    title: 'Табуляция и пробелы вперемешку',
  },
  // --- NameError
  {
    name: 'опечатка в имени',
    error: runtimeError('NameError', "name 'prnt' is not defined", 1, 'prnt("a")', {
      summary: "NameError: name 'prnt' is not defined. Did you mean: 'print'?",
    }),
    title: 'Неизвестное имя „prnt“',
    tryThis: '„print“',
  },
  {
    name: 'регистр букв',
    error: runtimeError('NameError', "name 'Print' is not defined", 1, 'Print("a")', {
      summary: "NameError: name 'Print' is not defined. Did you mean: 'print'?",
    }),
    title: 'Большая или маленькая буква',
    tryThis: '„print“',
  },
  {
    name: 'имя до создания',
    error: runtimeError('NameError', "name 'total' is not defined", 1, 'print(total)'),
    code: 'print(total)\ntotal = 5\n',
    title: '„total“ используется до создания',
    why: 'в строке 2',
  },
  {
    name: 'русское слово без кавычек',
    error: runtimeError('NameError', "name 'Привет' is not defined", 1, 'print(Привет)'),
    code: 'print(Привет)\n',
    title: 'Текст без кавычек?',
    tryThis: '"Привет"',
  },
  {
    name: 'забыт import',
    error: runtimeError('NameError', "name 'math' is not defined", 1, 'print(math.pi)', {
      summary: "NameError: name 'math' is not defined. Did you forget to import 'math'?",
    }),
    title: 'Модуль не подключён',
    tryThis: 'import math',
  },
  {
    name: 'неизвестное имя',
    error: runtimeError('NameError', "name 'total' is not defined", 3, 'print(total)'),
    code: 'x = 1\ny = 2\nprint(total)\n',
    title: 'Неизвестное имя „total“',
  },
  // --- TypeError
  {
    name: 'строка + число',
    error: runtimeError('TypeError', 'can only concatenate str (not "int") to str', 1, 'x = "a" + 5'),
    title: 'Текст и число через +',
    tryThis: 'str(x)',
  },
  {
    name: "int + str",
    error: runtimeError('TypeError', "unsupported operand type(s) for +: 'int' and 'str'", 1, 'x = 5 + "a"'),
    title: 'Число и строка через +',
  },
  {
    name: "str - int",
    error: runtimeError('TypeError', "unsupported operand type(s) for -: 'str' and 'int'", 1, 'x = "a" - 5'),
    title: 'Число и строка в одном вычислении',
    tryThis: 'int(input())',
  },
  {
    name: "int - str",
    error: runtimeError('TypeError', "unsupported operand type(s) for -: 'int' and 'str'", 1, 'x = 5 - "a"'),
    title: 'Число и строка в одном вычислении',
  },
  {
    name: 'None в вычислении',
    error: runtimeError('TypeError', "unsupported operand type(s) for +: 'NoneType' and 'int'", 3, 'x = f() + 1'),
    title: 'None в вычислении',
  },
  {
    name: 'range от строки',
    error: runtimeError('TypeError', "'str' object cannot be interpreted as an integer", 1, 'for i in range("5"):'),
    title: 'Нужно целое число',
    tryThis: 'int(input())',
  },
  {
    name: 'range от дробного',
    error: runtimeError('TypeError', "'float' object cannot be interpreted as an integer", 1, 'range(2.5)'),
    title: 'Нужно целое число',
    tryThis: '//',
  },
  {
    name: 'лишний аргумент',
    error: runtimeError('TypeError', 'f() takes 1 positional argument but 2 were given', 3, 'f(1, 2)'),
    title: 'Лишние аргументы',
    why: 'f() принимает 1 аргумент, а при вызове передано 2',
  },
  {
    name: 'лишний аргумент (диапазон)',
    error: runtimeError('TypeError', 'f() takes from 1 to 2 positional arguments but 3 were given', 3, 'f(1, 2, 3)'),
    title: 'Лишние аргументы',
    why: 'от 1 до 2 аргументов',
  },
  {
    name: 'лишний аргумент метода',
    error: runtimeError('TypeError', 'C.m() takes 1 positional argument but 2 were given', 4, 'C().m(1)'),
    title: 'Лишние аргументы',
    why: 'self',
  },
  {
    name: 'не хватает аргумента',
    error: runtimeError('TypeError', "f() missing 1 required positional argument: 'b'", 3, 'f(1)'),
    title: 'Не хватает аргументов',
    why: '„b“',
  },
  {
    name: 'не хватает двух аргументов',
    error: runtimeError('TypeError', "f() missing 2 required positional arguments: 'b' and 'c'", 3, 'f(1)'),
    title: 'Не хватает аргументов',
    why: '„b“ и „c“',
  },
  {
    name: 'неизвестный именованный аргумент',
    error: runtimeError(
      'TypeError',
      "print() got an unexpected keyword argument 'sepp'. Did you mean 'sep'?",
      1,
      'print("a", sepp="")',
    ),
    title: 'Неизвестный параметр',
    tryThis: '„sep“',
  },
  {
    name: 'имя print занято переменной',
    error: runtimeError('TypeError', "'int' object is not callable", 2, 'print("a")'),
    code: 'print = 5\nprint("a")\n',
    title: 'Имя функции занято переменной',
    why: 'В строке 1',
  },
  {
    name: 'пропущено умножение',
    error: runtimeError('TypeError', "'int' object is not callable", 2, 'y = 2(x + 1)'),
    code: 'x = 2\ny = 2(x + 1)\n',
    title: 'Пропущен знак умножения?',
  },
  {
    name: 'значение вызвано как функция',
    error: runtimeError('TypeError', "'int' object is not callable", 2, 'x()'),
    code: 'x = 5\nx()\n',
    title: 'Значение вызвано как функция',
  },
  {
    name: 'len от числа',
    error: runtimeError('TypeError', "object of type 'int' has no len()", 1, 'len(5)'),
    title: 'У значения нет длины',
    tryThis: 'len(str(n))',
  },
  {
    name: 'квадратные скобки у функции',
    error: runtimeError('TypeError', "'builtin_function_or_method' object is not subscriptable", 1, 'len[1]'),
    title: 'Квадратные скобки вместо круглых',
  },
  {
    name: 'индекс у числа',
    error: runtimeError('TypeError', "'int' object is not subscriptable", 2, 'x[0]'),
    title: 'Индекс у значения, где его нет',
  },
  {
    name: 'перебор числа',
    error: runtimeError('TypeError', "'int' object is not iterable", 1, 'for i in 5:'),
    title: 'Значение нельзя перебрать',
    tryThis: 'range(n)',
  },
  {
    name: 'изменение строки по индексу',
    error: runtimeError('TypeError', "'str' object does not support item assignment", 2, 's[0] = "x"'),
    title: 'Строку нельзя изменить по индексу',
  },
  {
    name: 'индекс списка строкой',
    error: runtimeError('TypeError', 'list indices must be integers or slices, not str', 2, 'a["0"]'),
    title: 'Индекс должен быть целым числом',
  },
  {
    name: 'индекс строки строкой',
    error: runtimeError('TypeError', "string indices must be integers, not 'str'", 2, 'a["0"]'),
    title: 'Индекс должен быть целым числом',
  },
  {
    name: 'сравнение числа и строки',
    error: runtimeError('TypeError', "'<' not supported between instances of 'int' and 'str'", 1, '5 < "a"'),
    title: 'Сравнение разных типов',
  },
  {
    name: 'join с числами',
    error: runtimeError('TypeError', 'sequence item 0: expected str instance, int found', 1, '", ".join([1, 2])'),
    title: 'join соединяет только строки',
  },
  {
    name: 'строка * дробное',
    error: runtimeError('TypeError', "can't multiply sequence by non-int of type 'float'", 1, 'x = "a" * 2.5'),
    title: 'Строку умножают не на целое число',
  },
  {
    name: 'int(None)',
    error: runtimeError(
      'TypeError',
      "int() argument must be a string, a bytes-like object or a real number, not 'NoneType'",
      1,
      'int(None)',
    ),
    title: 'Значение None',
  },
  // --- ValueError
  {
    name: 'int от текста',
    error: runtimeError('ValueError', "invalid literal for int() with base 10: 'abc'", 1, 'x = int(input())'),
    title: 'Текст вместо числа',
    why: '„abc“',
  },
  {
    name: 'int от пустой строки',
    error: runtimeError('ValueError', "invalid literal for int() with base 10: ''", 1, 'int("")'),
    title: 'Пустая строка вместо числа',
  },
  {
    name: 'int от дробного',
    error: runtimeError('ValueError', "invalid literal for int() with base 10: '3.5'", 1, 'int("3.5")'),
    title: 'Дробное число в int()',
    tryThis: 'float',
  },
  {
    name: 'int от двух чисел',
    error: runtimeError('ValueError', "invalid literal for int() with base 10: '3 5'", 1, 'int(input())'),
    title: 'Несколько значений в одной строке',
    tryThis: 'split()',
  },
  {
    name: 'float с запятой',
    error: runtimeError('ValueError', "could not convert string to float: '3,5'", 1, 'float("3,5")'),
    title: 'Запятая вместо точки',
  },
  {
    name: 'float от текста',
    error: runtimeError('ValueError', "could not convert string to float: 'abc'", 1, 'float("abc")'),
    title: 'Текст вместо числа',
  },
  {
    name: 'не хватает значений для распаковки',
    error: runtimeError('ValueError', 'not enough values to unpack (expected 2, got 1)', 1, 'a, b = "1".split()'),
    title: 'Не хватает значений',
    why: 'Слева 2 переменные, а значений справа только 1',
  },
  {
    name: 'лишние значения при распаковке',
    error: runtimeError('ValueError', 'too many values to unpack (expected 2, got 3)', 1, 'a, b = "1 2 3".split()'),
    title: 'Лишние значения',
  },
  {
    name: 'корень из отрицательного',
    error: runtimeError('ValueError', 'expected a nonnegative input, got -1.0', 2, 'math.sqrt(-1)'),
    title: 'Недопустимое значение для math',
  },
  {
    name: 'remove несуществующего',
    error: runtimeError('ValueError', 'list.remove(x): x not in list', 1, '[1].remove(2)'),
    title: 'Такого элемента нет в списке',
  },
  {
    name: 'index несуществующей подстроки',
    error: runtimeError('ValueError', 'substring not found', 1, '"abc".index("z")'),
    title: 'Фрагмент не найден',
  },
  // --- прочие ошибки выполнения
  {
    name: 'деление на ноль',
    error: runtimeError('ZeroDivisionError', 'division by zero', 1, 'print(1/0)'),
    title: 'Деление на ноль',
  },
  {
    name: 'индекс списка',
    error: runtimeError('IndexError', 'list index out of range', 2, 'print(a[3])'),
    title: 'Индекс за пределами списка',
  },
  {
    name: 'индекс строки',
    error: runtimeError('IndexError', 'string index out of range', 2, 'print(a[3])'),
    title: 'Индекс за пределами строки',
  },
  {
    name: 'pop из пустого списка',
    error: runtimeError('IndexError', 'pop from empty list', 1, '[].pop()'),
    title: 'Список пуст',
  },
  {
    name: 'нет ключа',
    error: runtimeError('KeyError', "'b'", 2, 'print(d["b"])'),
    title: 'Нет такого ключа',
    why: "нет ключа 'b'",
    tryThis: "d.get('b')",
  },
  {
    name: 'опечатка в методе',
    error: runtimeError('AttributeError', "'str' object has no attribute 'uper'", 2, 'x.uper()', {
      summary: "AttributeError: 'str' object has no attribute 'uper'. Did you mean: 'upper'?",
    }),
    title: 'Нет такого метода',
    tryThis: '„upper“',
  },
  {
    name: 'метод не того типа',
    error: runtimeError('AttributeError', "'int' object has no attribute 'append'", 2, 'x.append(1)'),
    title: 'Нет такого метода',
    why: 'У целого числа (int) нет метода',
  },
  {
    name: 'метод у None',
    error: runtimeError('AttributeError', "'NoneType' object has no attribute 'append'", 2, 'a.append(1)'),
    title: 'Метод у None',
  },
  {
    name: 'нет функции в модуле',
    error: runtimeError('AttributeError', "module 'math' has no attribute 'sqr'", 2, 'math.sqr(4)', {
      summary: "AttributeError: module 'math' has no attribute 'sqr'. Did you mean: 'sqrt'?",
    }),
    title: 'В модуле math нет „sqr“',
    tryThis: '„sqrt“',
  },
  {
    name: 'UnboundLocalError',
    error: runtimeError(
      'UnboundLocalError',
      "cannot access local variable 'count' where it is not associated with a value",
      3,
      '    count += 1',
    ),
    title: 'Переменная функции ещё без значения',
    why: '„count“',
  },
  {
    name: 'RecursionError',
    error: runtimeError('RecursionError', 'maximum recursion depth exceeded', 2, '    return f(n+1)'),
    title: 'Бесконечная рекурсия',
  },
  {
    name: 'EOFError',
    error: runtimeError('EOFError', 'EOF when reading a line', 2, 'b = input()'),
    title: 'Не хватило строк ввода',
    why: 'больше строк ввода, чем есть в тесте',
    tryThis: 'сколько раз вызывается input()',
  },
  {
    name: 'KeyboardInterrupt',
    error: runtimeError('KeyboardInterrupt', '', 1, 'raise KeyboardInterrupt'),
    title: 'Выполнение прервано',
    environment: false,
  },
  {
    name: 'AssertionError',
    error: runtimeError('AssertionError', 'плохо', 1, 'assert 1 == 2, "плохо"'),
    title: 'Не выполнилось условие assert',
  },
  {
    name: 'OverflowError',
    error: runtimeError('OverflowError', "(34, 'Result too large')", 1, '2.0 ** 10000'),
    title: 'Слишком большое число',
  },
  {
    name: 'прочая ошибка',
    error: runtimeError('RuntimeError', 'boom', 1, 'raise RuntimeError("boom")'),
    title: 'Ошибка RuntimeError',
    environment: false,
  },
  // --- модули и среда
  {
    name: 'заблокированный модуль',
    error: runtimeError('ModuleNotFoundError', 'Модуль «js» недоступен в учебной среде', 1, 'import js'),
    title: 'Модуль недоступен в браузере',
    environment: true,
    why: 'ограничение среды',
  },
  {
    name: 'tkinter',
    error: runtimeError('ModuleNotFoundError', "No module named 'tkinter'", 1, 'import tkinter'),
    title: 'Модуль недоступен в браузере',
    environment: true,
  },
  {
    name: 'requests',
    error: runtimeError('ModuleNotFoundError', "No module named 'requests'", 1, 'import requests'),
    title: 'Модуль недоступен в браузере',
    environment: true,
  },
  {
    // Pyodide убрал dbm из стандартной библиотеки, но его примечание до harness.py не доходит.
    name: 'модуль, убранный из Pyodide (настоящее сообщение Pyodide 314)',
    error: REAL_ERRORS.dbm,
    title: 'Модуль недоступен в браузере',
    environment: true,
  },
  {
    name: 'pytest — библиотека из курса, которой нет в браузере',
    error: runtimeError('ModuleNotFoundError', "No module named 'pytest'", 1, 'import pytest'),
    title: 'Модуль недоступен в браузере',
    environment: true,
    tryThis: 'в редакторе на компьютере',
  },
  {
    name: 'незнакомый модуль без похожего имени — не утверждаем, что это опечатка',
    error: REAL_ERRORS.packaging,
    title: 'Нет модуля „packaging“',
    environment: false,
    why: 'либо в названии опечатка, либо это библиотека, которой нет в учебной среде браузера',
    tryThis: 'в редакторе на компьютере',
  },
  {
    name: 'опечатка в имени модуля',
    error: runtimeError('ModuleNotFoundError', "No module named 'mathh'", 1, 'import mathh'),
    title: 'Нет модуля „mathh“',
    environment: false,
    tryThis: '„math“',
  },
  {
    name: 'ImportError с подсказкой',
    error: runtimeError('ImportError', "cannot import name 'sqr' from 'math' (unknown location)", 1, 'from math import sqr', {
      summary: "ImportError: cannot import name 'sqr' from 'math' (unknown location). Did you mean: 'sqrt'?",
    }),
    title: 'В модуле math нет „sqr“',
    tryThis: '„sqrt“',
  },
  {
    name: 'файл не найден',
    error: runtimeError('FileNotFoundError', "[Errno 2] No such file or directory: 'nofile.txt'", 1, 'open("nofile.txt")'),
    title: 'Файл не найден',
    environment: true,
    why: '„nofile.txt“',
  },
  {
    name: 'сеть',
    error: runtimeError('ConnectionRefusedError', '[Errno 111] Connection refused', 3, 's.connect(("example.org", 80))'),
    title: 'Сеть недоступна',
    environment: true,
  },
  {
    name: 'OSError',
    error: runtimeError('OSError', '[Errno 38] Function not implemented', 2, 'os.system("dir")'),
    title: 'Ограничение среды',
    environment: true,
  },
  // --- настоящие ошибки harness.py целиком (REAL_ERRORS)
  {
    name: 'переменная создана внутри функции, а используется снаружи',
    error: REAL_ERRORS.scope,
    code: 'def f():\n    result = 5\nf()\nprint(result)\n',
    title: '„result“ видна только внутри функции',
    why: 'создаётся внутри функции „f“ (строка 2)',
    tryThis: 'result = f()',
  },
  {
    name: 'апостроф в незакрытой строке — не «разные кавычки»',
    error: REAL_ERRORS.apostrophe,
    title: 'Незакрытая строка',
  },
  {
    name: 'апостроф в незакрытой строке (Don\'t)',
    error: REAL_ERRORS.dont,
    title: 'Незакрытая строка',
  },
  {
    name: 'строка открыта " и закрыта \'',
    error: REAL_ERRORS.mixed,
    title: 'Разные кавычки у строки',
  },
  {
    name: 'remove у множества',
    error: REAL_ERRORS.set_remove,
    title: 'Такого элемента нет в множестве',
    why: 'элемент 2',
    tryThis: 's.discard(2)',
  },
  {
    name: 'pop из пустого множества',
    error: REAL_ERRORS.set_pop,
    title: 'Множество пустое',
  },
  {
    name: 'нет ключа в словаре (настоящая ошибка)',
    error: REAL_ERRORS.keyerror_dict,
    title: 'Нет такого ключа',
    tryThis: "d.get('b')",
  },
  {
    name: 'int от числа с запятой — совет не ведёт к новой ошибке float("3,5")',
    error: REAL_ERRORS.int_comma,
    title: 'Дробное число с запятой',
    tryThis: 'float(s.replace(",", "."))',
  },
  {
    name: 'int от текста с апострофом (значение в двойных кавычках)',
    error: REAL_ERRORS.int_apostrophe,
    title: 'Текст вместо числа',
    why: "„it's“",
  },
  {
    name: 'float от текста с апострофом (значение в двойных кавычках)',
    error: REAL_ERRORS.float_apostrophe,
    title: 'Текст вместо числа',
    why: "„it's“",
  },
  {
    name: 'логарифм нуля',
    error: REAL_ERRORS.log0,
    title: 'Недопустимое значение для math',
    tryThis: 'if x > 0',
  },
  {
    name: 'корень из отрицательного (настоящая ошибка)',
    error: REAL_ERRORS.sqrt_neg,
    title: 'Недопустимое значение для math',
    tryThis: 'if x >= 0',
  },
  {
    name: 'русский текст без кавычек — не «пропущена запятая»',
    error: REAL_ERRORS.bare_ru,
    code: 'print(Привет мир)\n',
    title: 'Текст без кавычек?',
  },
];

describe('explainError', () => {
  it.each(CASES.map((item) => [item.name, item] as const))('%s', (_name, item) => {
    const result: ErrorExplanation = explainError(item.error, item.code);
    if (typeof item.title === 'string') expect(result.title).toBe(item.title);
    else expect(result.title).toMatch(item.title);
    expect(result.environment).toBe(item.environment ?? false);
    if (item.why) expect(result.why).toContain(item.why);
    if (item.tryThis) expect(result.tryThis).toContain(item.tryThis);
    // Коротко и спокойно: 1–2 предложения на поле, без упрёков и пустой похвалы.
    expect(sentences(result.why)).toBeLessThanOrEqual(2);
    expect(sentences(result.tryThis)).toBeLessThanOrEqual(2);
    expect(words(result.why, result.tryThis)).toBeLessThanOrEqual(60);
    expect(`${result.title} ${result.why} ${result.tryThis}`).not.toMatch(BANNED);
  });

  it('без подсказки Python не выдумывает имя для замены', () => {
    const result = explainError(runtimeError('NameError', "name 'resultat' is not defined", 1, 'print(resultat)'));
    expect(result.tryThis).not.toContain('здесь должно быть');
  });

  it('распознаёт ошибку отступа по типу, даже если phase не compile', () => {
    const error = { ...compileError('IndentationError', 'unexpected indent', 2, '    y = 2'), phase: 'runtime' as const };
    expect(explainError(error).title).toBe('Лишний отступ');
  });
});

// ------------------------------------------------------------------ errorCategory

describe('errorCategory', () => {
  it('даёт метки для повторяющихся ошибок', () => {
    expect(errorCategory('NameError')).toEqual({ key: 'NameError', label: 'Неизвестное имя (NameError)' });
    expect(errorCategory('SyntaxError').label).toBe('Синтаксис (SyntaxError)');
    expect(errorCategory('IndentationError').label).toBe('Отступы (IndentationError)');
    expect(errorCategory('TypeError').label).toContain('TypeError');
    expect(errorCategory('EOFError').label).toBe('Не хватило ввода (EOFError)');
    expect(errorCategory('timeout')).toEqual({ key: 'timeout', label: 'Слишком долгая работа' });
    expect(errorCategory('limit').label).toBe('Слишком много вывода');
    expect(errorCategory('output').label).toBe('Неверный вывод');
    expect(errorCategory('rule').label).toBe('Не выполнено требование к коду');
    expect(errorCategory(null)).toEqual({ key: 'none', label: 'Без ошибки' });
  });

  it('для незнакомого типа — аккуратная общая метка', () => {
    expect(errorCategory('StopIteration')).toEqual({ key: 'StopIteration', label: 'Ошибка StopIteration' });
  });

  it('имя класса ученика вроде constructor или __proto__ даёт строку, а не свойство Object.prototype', () => {
    expect(errorCategory('constructor')).toEqual({ key: 'constructor', label: 'Ошибка constructor' });
    expect(errorCategory('__proto__')).toEqual({ key: '__proto__', label: 'Ошибка __proto__' });
    expect(errorCategory('toString').label).toBe('Ошибка toString');
  });
});

// ------------------------------------------------------------------ testLabel

describe('testLabel', () => {
  it('берёт title, иначе называет тест по виду и номеру', () => {
    expect(testLabel({ id: 't', kind: 'io', expected: '1', title: 'Граничный случай: ноль' }, 0)).toBe('Граничный случай: ноль');
    expect(testLabel({ id: 't', kind: 'io', expected: '1', example: true }, 1)).toBe('Пример 2');
    expect(testLabel({ id: 't', kind: 'io', expected: '1', edge: true }, 2)).toBe('Граничный случай 3');
    expect(testLabel({ id: 't', kind: 'call', call: 'f()', expected: '1' }, 3)).toBe('Проверка 4');
  });
});

describe('normalizeOutput', () => {
  it('убирает пробелы в конце строк, \\r\\n и пустые строки в конце', () => {
    expect(normalizeOutput('a  \r\nb\t\r\n\r\n\n')).toBe('a\nb');
    expect(normalizeOutput('\n\na')).toBe('\n\na');
  });
});

// ------------------------------------------------------------------ matchMistake

function mistake(id: string, when: Record<string, string>) {
  return { id, when, why: `Почему (${id}).`, try: `Попробуй (${id}).` };
}

describe('matchMistake', () => {
  it('возвращает null, если проверка полностью прошла', () => {
    const exercise = exA([mistake('any', { codeIncludes: 'print' })]);
    expect(matchMistake(exercise, CHECKS.a_correct.code, CHECKS.a_correct.result)).toBeNull();
  });

  it('errorType и errorIncludes — по ошибке компиляции', () => {
    const exercise = exA([mistake('paren', { errorType: 'SyntaxError', errorIncludes: 'was never closed' })]);
    expect(matchMistake(exercise, CHECKS.a_compile.code, CHECKS.a_compile.result)?.id).toBe('paren');
    const other = exA([mistake('paren', { errorType: 'IndentationError' })]);
    expect(matchMistake(other, CHECKS.a_compile.code, CHECKS.a_compile.result)).toBeNull();
  });

  it('errorType и errorIncludes — по ошибке в непрошедшем тесте (summary или message)', () => {
    const exercise = exA([mistake('eof', { errorType: 'EOFError', errorIncludes: 'EOF when reading' })]);
    expect(matchMistake(exercise, CHECKS.a_eof.code, CHECKS.a_eof.result)?.id).toBe('eof');
    const bySummary = makeExercise(TESTS.D, [mistake('name', { errorIncludes: "NameError: name 'is_even'" })]);
    expect(matchMistake(bySummary, CHECKS.d_missing_func.code, CHECKS.d_missing_func.result)?.id).toBe('name');
  });

  it('ошибка берётся из первого теста, где она есть, даже если раньше упал тест без ошибки', () => {
    const result = structuredClone(CHECKS.a_zero.result);
    result.tests[0] = { ...result.tests[0], passed: false, diff: { kind: 'mismatch', line: 1, expectedLine: '6', actualLine: '7', hint: 'number' } };
    const exercise = exA([mistake('zero', { errorType: 'ZeroDivisionError' })]);
    expect(matchMistake(exercise, CHECKS.a_zero.code, result)?.id).toBe('zero');
  });

  it('outputEquals сравнивает нормализованный вывод первого непрошедшего теста', () => {
    const hit = exA([mistake('plus', { outputEquals: '5  \r\n\r\n' })]);
    expect(matchMistake(hit, CHECKS.a_plus.code, CHECKS.a_plus.result)?.id).toBe('plus');
    const miss = exA([mistake('plus', { outputEquals: '9' })]); // 9 — вывод второго теста, а не первого
    expect(matchMistake(miss, CHECKS.a_plus.code, CHECKS.a_plus.result)).toBeNull();
  });

  it('outputIncludes — подстрока вывода', () => {
    const exercise = exA([mistake('str-mul', { outputIncludes: '33' })]);
    expect(matchMistake(exercise, CHECKS.a_no_int.code, CHECKS.a_no_int.result)?.id).toBe('str-mul');
    const miss = exA([mistake('str-mul', { outputIncludes: '77' })]);
    expect(matchMistake(miss, CHECKS.a_no_int.code, CHECKS.a_no_int.result)).toBeNull();
  });

  it('codeIncludes и codeRegex (флаг m: ^ и $ — границы строк)', () => {
    const include = exA([mistake('no-int', { codeIncludes: 'n = input()' })]);
    expect(matchMistake(include, CHECKS.a_no_int.code, CHECKS.a_no_int.result)?.id).toBe('no-int');
    const regex = exA([mistake('no-int', { codeRegex: '^n = input\\(\\)$' })]);
    expect(matchMistake(regex, CHECKS.a_no_int.code, CHECKS.a_no_int.result)?.id).toBe('no-int');
    const missing = exA([mistake('no-int', { codeRegex: '^print\\(n \\+ 2\\)$' })]);
    expect(matchMistake(missing, CHECKS.a_no_int.code, CHECKS.a_no_int.result)).toBeNull();
  });

  it('неверное регулярное выражение не ломает разбор', () => {
    const exercise = exA([mistake('bad', { codeRegex: '([' }), mistake('good', { codeIncludes: 'input' })]);
    expect(matchMistake(exercise, CHECKS.a_plus.code, CHECKS.a_plus.result)?.id).toBe('good');
  });

  it('failedTest — тест с этим id не прошёл', () => {
    const hit = exA([mistake('seven', { failedTest: 'ex-2' })]);
    expect(matchMistake(hit, CHECKS.a_zero.code, CHECKS.a_zero.result)?.id).toBe('seven');
    const miss = exA([mistake('seven', { failedTest: 'ex-1' })]);
    expect(matchMistake(miss, CHECKS.a_zero.code, CHECKS.a_zero.result)).toBeNull();
  });

  it('failedRule — правило с этим id не выполнено', () => {
    const exercise = exA([mistake('if', { failedRule: 'no-if' })]);
    expect(matchMistake(exercise, CHECKS.a_rule.code, CHECKS.a_rule.result)?.id).toBe('if');
    expect(matchMistake(exercise, CHECKS.a_plus.code, CHECKS.a_plus.result)).toBeNull();
  });

  it('условия на вывод не срабатывают, если в первом непрошедшем тесте программа упала с ошибкой', () => {
    // print("Меню дня"); print("Капучино"); Print("x"): вывод до NameError совпадает с «не хватает строки».
    const exercise = makeExercise(TESTS.G, [
      mistake('missing-line', { outputEquals: 'Меню дня\nКапучино' }),
      mistake('has-menu', { outputIncludes: 'Меню дня' }),
    ]);
    expect(matchMistake(exercise, CHECKS.g_crash_after_output.code, CHECKS.g_crash_after_output.result)).toBeNull();
    // Та же строка без ошибки — разбор срабатывает.
    expect(matchMistake(exercise, CHECKS.g_missing.code, CHECKS.g_missing.result)?.id).toBe('missing-line');
  });

  it('условия на вывод не срабатывают после остановки по лимиту вывода', () => {
    const exercise = exA([mistake('six', { outputIncludes: '6' }), mistake('empty', { outputEquals: '' })]);
    expect(matchMistake(exercise, CHECKS.a_limit.code, CHECKS.a_limit.result)).toBeNull();
  });

  it('вывод при ошибке учитывается, если в том же разборе есть errorType или errorIncludes', () => {
    const byType = makeExercise(TESTS.G, [mistake('typo', { errorType: 'NameError', outputEquals: 'Меню дня\nКапучино' })]);
    expect(matchMistake(byType, CHECKS.g_crash_after_output.code, CHECKS.g_crash_after_output.result)?.id).toBe('typo');
    const byText = makeExercise(TESTS.G, [mistake('typo', { errorIncludes: "'Print'", outputIncludes: 'Капучино' })]);
    expect(matchMistake(byText, CHECKS.g_crash_after_output.code, CHECKS.g_crash_after_output.result)?.id).toBe('typo');
  });

  it('ошибка и вывод из одного разбора проверяются по одному и тому же тесту', () => {
    // Правка настоящего результата: тест 1 не прошёл по выводу «7», тест 2 упал с ZeroDivisionError без вывода.
    const result = structuredClone(CHECKS.a_zero.result);
    result.tests[0] = {
      ...result.tests[0],
      passed: false,
      output: '7\n',
      diff: { kind: 'mismatch', line: 1, expectedLine: '6', actualLine: '7', hint: 'number' },
    };
    const sameTest = exA([mistake('zero', { errorType: 'ZeroDivisionError', outputEquals: '' })]);
    expect(matchMistake(sameTest, CHECKS.a_zero.code, result)?.id).toBe('zero');
    const otherTest = exA([mistake('zero', { errorType: 'ZeroDivisionError', outputEquals: '7' })]);
    expect(matchMistake(otherTest, CHECKS.a_zero.code, result)).toBeNull();
    // Без условия на ошибку вывод берётся из первого непрошедшего теста.
    const outputOnly = exA([mistake('seven', { outputEquals: '7' })]);
    expect(matchMistake(outputOnly, CHECKS.a_zero.code, result)?.id).toBe('seven');
  });

  it('нужны все условия сразу; побеждает первый подходящий разбор', () => {
    const exercise = exA([
      mistake('both', { codeIncludes: 'input()', failedTest: 'ex-1' }), // ex-1 прошёл → не подходит
      mistake('first', { failedTest: 'ex-2' }),
      mistake('second', { errorType: 'ZeroDivisionError' }),
    ]);
    expect(matchMistake(exercise, CHECKS.a_zero.code, CHECKS.a_zero.result)?.id).toBe('first');
  });
});

// ------------------------------------------------------------------ buildCheckFeedback

describe('buildCheckFeedback: приоритеты и состояния', () => {
  it('сбой запуска Python — честно: это не ошибка ученика', () => {
    const feedback = buildCheckFeedback(exA(), 'print(1)', { status: 'failed', message: 'Python не запустился: worker crashed' })!;
    expectShort(feedback);
    expect(feedback.source).toBe('environment');
    expect(feedback.why).toContain('не ошибка в твоём коде');
    expect(feedback.raw).toBe('Python не запустился: worker crashed');
    expect(feedback.tryThis).toContain('„Проверить“');

    const offline = buildCheckFeedback(exA(), 'print(1)', {
      status: 'failed',
      message: 'Не удалось загрузить Python. Нужен интернет для первой загрузки или заранее скачанный Python (Настройки → Офлайн).',
    })!;
    expect(offline.tryThis).toContain('интернет');
  });

  it('сбой Python во время выполнения — не утверждаем, что код ни при чём', () => {
    // Настоящее сообщение Pyodide 314 (RangeError) при sys.setrecursionlimit(100000) и бесконечной рекурсии.
    const message = 'Maximum call stack size exceeded';
    const feedback = buildCheckFeedback(exA(), 'print(1)', { status: 'failed', message })!;
    expectShort(feedback);
    expect(feedback.source).toBe('environment');
    expect(feedback.title).toBe('Python аварийно остановился');
    expect(feedback.why).not.toContain('не ошибка в твоём коде');
    expect(feedback.tryThis).toContain('рекурсию');
    expect(feedback.raw).toBe(message);

    const run = buildRunFeedback('print(1)', { status: 'failed', message })!;
    expectShort(run);
    expect(run.why).not.toContain('не ошибка в твоём коде');
    expect(run.tryThis).toContain('„Запустить“');
  });

  it('тайм-аут: где — тест, почему — N секунд и цикл', () => {
    const code = 'n = int(input())\nwhile n > 0:\n    print(n)\n';
    const feedback = buildCheckFeedback(exA(), code, { status: 'timeout', limitMs: 3000, testIndex: 1 })!;
    expectShort(feedback);
    expect(feedback.source).toBe('timeout');
    expect(feedback.where).toBe('Тест „Пример 2“ (ввод: 7)');
    expect(feedback.why).toBe('Тест не завершился за 3 с — похоже, цикл не останавливается.');
    expect(feedback.tryThis).toContain('while');
    expect(feedback.verify).toContain('„Пример 2“');
    expect(feedback.testId).toBe('ex-2');
    expect(feedback.line).toBeNull();
  });

  it('тайм-аут в граничном тесте и дробные секунды', () => {
    const feedback = buildCheckFeedback(exA(), 'for i in range(10**9):\n    pass\n', {
      status: 'timeout',
      limitMs: 2500,
      testIndex: 2,
    })!;
    expect(feedback.where).toBe('Тест „Граничный случай 3“ (ввод: 0)');
    expect(feedback.why).toContain('за 2,5 с');
  });

  it('остановлено вручную — без разбора', () => {
    expect(buildCheckFeedback(exA(), 'while True: pass', { status: 'stopped', testIndex: 0 })).toBeNull();
  });

  it('всё прошло — null', () => {
    expect(buildCheckFeedback(exA(), CHECKS.a_correct.code, done('a_correct'))).toBeNull();
  });

  it('синтаксическая ошибка без разбора из материалов → explainError', () => {
    const feedback = check(exA(), 'a_compile');
    expect(feedback.source).toBe('compile');
    expect(feedback.title).toBe('Незакрытая скобка');
    expect(feedback.where).toBe('Строка 2: print(n * 2');
    expect(feedback.line).toBe(2);
    expect(feedback.raw).toBe(CHECKS.a_compile.result.compileError!.raw);
    expect(feedback.mistakeId).toBeNull();
    // «Проверь» называет конкретный тест — так же, как разбор из материалов.
    expect(feedback.verify).toBe('Нажми „Проверить“: тест „Пример 1“ должен пройти.');
  });

  it('синтаксическая ошибка: сначала разбор из материалов', () => {
    const exercise = exA([mistake('paren', { errorType: 'SyntaxError', errorIncludes: 'never closed' })]);
    const feedback = check(exercise, 'a_compile');
    expect(feedback.source).toBe('mistake');
    expect(feedback.mistakeId).toBe('paren');
    expect(feedback.title).toBe('Незакрытая скобка');
    expect(feedback.why).toBe('Почему (paren).');
    expect(feedback.tryThis).toBe('Попробуй (paren).');
    expect(feedback.where).toBe('Строка 2: print(n * 2');
    expect(feedback.line).toBe(2);
    expect(feedback.raw).toBe(CHECKS.a_compile.result.compileError!.raw);
    expect(feedback.verify).toBe('Нажми „Проверить“: тест „Пример 1“ должен пройти.');
  });

  it('разбор из материалов важнее ошибки выполнения; where и verify из Mistake', () => {
    const exercise = exA([
      { ...mistake('two-inputs', { errorType: 'EOFError' }), where: 'Вторая строка с input()', verify: 'Запусти пример 1.' },
    ]);
    const feedback = check(exercise, 'a_eof');
    expect(feedback.source).toBe('mistake');
    expect(feedback.where).toBe('Вторая строка с input()');
    expect(feedback.verify).toBe('Запусти пример 1.');
    expect(feedback.line).toBe(2);
    expect(feedback.testId).toBe('ex-1');
  });

  it('разбор из материалов без where: место формируется автоматически, verify — нужный тест', () => {
    const exercise = exA([mistake('seven', { failedTest: 'ex-2' })]);
    const feedback = check(exercise, 'a_zero');
    expect(feedback.where).toBe('Строка 2: print(100 // (n - 7) * 0 + n * 2) — тест „Пример 2“ (ввод: 7)');
    expect(feedback.verify).toBe('Нажми „Проверить“: тест „Пример 2“ должен пройти.');
    // Разбор не говорит об ошибке, поэтому заголовок — про тест, а не «Деление на ноль».
    expect(feedback.title).toBe('Не прошёл тест „Пример 2“');
  });

  it('ошибка после части вывода: разбор «не хватает строки» не подменяет NameError', () => {
    const exercise = makeExercise(TESTS.G, [mistake('missing-line', { outputEquals: 'Меню дня\nКапучино' })]);
    const feedback = check(exercise, 'g_crash_after_output');
    expect(feedback.source).toBe('runtime');
    expect(feedback.mistakeId).toBeNull();
    expect(feedback.title).toBe('Большая или маленькая буква');
    expect(feedback.where).toBe('Строка 3: Print("x") — тест „Пример 1“');
    expect(feedback.line).toBe(3);
  });

  it('заголовок разбора по выводу — нейтральный', () => {
    const exercise = makeExercise(TESTS.G, [mistake('missing-line', { outputEquals: 'Меню дня\nКапучино' })]);
    const feedback = check(exercise, 'g_missing');
    expect(feedback.source).toBe('mistake');
    expect(feedback.mistakeId).toBe('missing-line');
    expect(feedback.title).toBe('Вывод не совпал');
    expect(feedback.why).toBe('Почему (missing-line).');
    expect(feedback.where).toBe('Тест „Пример 1“');
  });

  it('заголовок разбора с условием на ошибку — заголовок этой самой ошибки', () => {
    const exercise = makeExercise(TESTS.G, [mistake('capital', { errorType: 'NameError', codeIncludes: 'Print' })]);
    const feedback = check(exercise, 'g_crash_after_output');
    expect(feedback.mistakeId).toBe('capital');
    expect(feedback.title).toBe('Большая или маленькая буква');
    expect(feedback.line).toBe(3);
  });

  it('заголовок разбора только по коду — нейтральный, без заголовка ошибки', () => {
    const exercise = makeExercise(TESTS.G, [mistake('capital', { codeIncludes: 'Print' })]);
    const feedback = check(exercise, 'g_crash_after_output');
    expect(feedback.mistakeId).toBe('capital');
    expect(feedback.title).toBe('Разбор типичной ошибки');
  });

  it('заголовок разбора по failedTest: тест прошёл до конца, но результат другой', () => {
    expect(check(exA([mistake('plus', { failedTest: 'ex-1' })]), 'a_plus').title).toBe('Вывод не совпал');
    expect(check(makeExercise(TESTS.D, [mistake('inv', { failedTest: 'ex-1' })]), 'd_inverted').title).toBe(
      'Функция вернула другое значение',
    );
  });

  it('разбор по коду подсвечивает найденную строку', () => {
    const exercise = exA([mistake('no-int', { codeRegex: '^n = input\\(\\)$' })]);
    const feedback = check(exercise, 'a_no_int');
    expect(feedback.line).toBe(1);
    expect(feedback.where).toBe('Тест „Пример 1“ (ввод: 3)');
    expect(feedback.verify).toBe('Нажми „Проверить“: тест „Пример 1“ должен пройти.');
  });

  it('разбор по правилу: заголовок и «проверь» — про требование', () => {
    const feedback = check(exA([mistake('if', { failedRule: 'no-if' })]), 'a_rule');
    expect(feedback.source).toBe('mistake');
    expect(feedback.title).toBe('Не выполнено требование к коду');
    expect(feedback.verify).toContain('требование');
  });

  it('ошибка выполнения в первом тесте с ошибкой (origin program)', () => {
    const feedback = check(exA(), 'a_zero');
    expect(feedback.source).toBe('runtime');
    expect(feedback.title).toBe('Деление на ноль');
    expect(feedback.where).toBe('Строка 2: print(100 // (n - 7) * 0 + n * 2) — тест „Пример 2“ (ввод: 7)');
    expect(feedback.line).toBe(2);
    expect(feedback.testId).toBe('ex-2');
    expect(feedback.raw).toContain('ZeroDivisionError: division by zero');
    expect(feedback.verify).toBe('Нажми „Проверить“: тест „Пример 2“ должен пройти.');
  });

  it('EOFError в тесте с вводом: сколько строк есть в тесте', () => {
    const feedback = check(exA(), 'a_eof');
    expect(feedback.title).toBe('Не хватило строк ввода');
    expect(feedback.why).toContain('в нём 1 строка');
    expect(feedback.tryThis).toContain('input()');
  });

  it('EOFError в задании с функцией: данные приходят через параметры', () => {
    const feedback = check(exD(), 'd_input');
    expect(feedback.title).toBe('input() в задании с функцией');
    expect(feedback.where).toBe('Строка 2: n = int(input()) — тест „Пример 1“: is_even(4)');
  });

  it('текст без кавычек в тесте', () => {
    const feedback = check(exB(), 'b_name');
    expect(feedback.title).toBe('Текст без кавычек?');
    expect(feedback.where).toBe('Строка 2: print(Привет, name) — тест „Пример 1“ (ввод: Аня)');
  });

  it('ошибка в самой проверке: функции с нужным именем нет', () => {
    const feedback = check(exD(), 'd_missing_func');
    expect(feedback.source).toBe('check');
    expect(feedback.title).toBe('Нет функции „is_even“');
    expect(feedback.why).toBe('Проверка вызывает is_even(4), но функции „is_even“ в программе нет.');
    expect(feedback.tryThis).toContain('„is_evn“');
    expect(feedback.where).toBe('Тест „Пример 1“: is_even(4)');
    expect(feedback.line).toBeNull();
  });

  it('ошибка в самой проверке: функция спрятана внутри другой', () => {
    const feedback = check(exD(), 'd_nested');
    expect(feedback.source).toBe('check');
    expect(feedback.title).toBe('Проверка не видит „is_even“');
    expect(feedback.why).toContain('внутри другого блока');
  });

  it('ошибка в самой проверке: def на верхнем уровне, но программа завершилась раньше', () => {
    const feedback = check(exD(), 'd_exit');
    expect(feedback.source).toBe('check');
    expect(feedback.title).toBe('Проверка не видит „is_even“');
    expect(feedback.why).not.toContain('внутри другого блока');
    expect(feedback.why).toContain('программа завершилась раньше');
    expect(feedback.tryThis).toContain('exit()');
  });

  it('ошибка в самой проверке: другое число параметров', () => {
    const feedback = check(exD(), 'd_params');
    expect(feedback.source).toBe('check');
    expect(feedback.title).toBe('Другое число параметров');
  });

  it('ограничение браузерной среды в тесте', () => {
    const feedback = check(exA(), 'a_js');
    expect(feedback.source).toBe('environment');
    expect(feedback.title).toBe('Модуль недоступен в браузере');
    expect(feedback.why).toContain('не ошибка в твоём коде');
  });

  it('слишком много вывода', () => {
    const feedback = check(exA(), 'a_limit');
    expect(feedback.source).toBe('limit');
    expect(feedback.where).toBe('Тест „Пример 1“ (ввод: 3)');
    expect(feedback.verify).toBe('Нажми „Проверить“: тест „Пример 1“ должен пройти.');
  });

  it('лимит вывода важнее невыполненного правила', () => {
    expect(check(exA(), 'a_rule_and_limit').source).toBe('limit');
  });

  it('ошибка выполнения важнее лимита вывода', () => {
    const result = structuredClone(CHECKS.a_zero.result);
    result.tests[0] = { ...result.tests[0], passed: false, limit: true };
    expect(checkWith(exA(), CHECKS.a_zero.code, result).source).toBe('runtime');
  });

  it('невыполненное правило (тесты при этом прошли)', () => {
    const feedback = check(exA(), 'a_rule');
    expect(feedback.source).toBe('rule');
    expect(feedback.tryThis).toBe(RULE_NO_IF.message);
    expect(feedback.why).toContain('Вывод верный');
  });

  it('расхождение вывода важнее правила: пока вывод неверный, разбор о нём', () => {
    const result = structuredClone(CHECKS.a_plus.result);
    result.rules = [{ id: 'no-if', passed: false, message: RULE_NO_IF.message }];
    const feedback = checkWith(exA(), CHECKS.a_plus.code, result);
    expect(feedback.source).toBe('output');
    expect(feedback.title).toBe('Другое число');
    expect(feedback.testId).toBe('ex-1');
  });

  it('стартовый код с пустым выводом: «ничего не вывела», а не требование к коду', () => {
    const result = structuredClone(CHECKS.b_empty.result);
    result.rules = [{ id: 'calc', passed: false, message: 'Посчитай сумму выражением.' }];
    const feedback = checkWith(exB(), CHECKS.b_empty.code, result);
    expect(feedback.source).toBe('output');
    expect(feedback.title).toBe('Программа ничего не вывела');
  });

  it('тест, прерванный по времени (отметка интерфейса), разбирается как тайм-аут', () => {
    const result = structuredClone(CHECKS.a_plus.result);
    result.tests[0] = { ...result.tests[0], interrupted: 'timeout', diff: null };
    const feedback = checkWith(exA(), CHECKS.a_plus.code, result);
    expect(feedback.source).toBe('timeout');
    expect(feedback.where).toBe('Тест „Пример 1“ (ввод: 3)');
  });
});

describe('buildCheckFeedback: расхождения вывода', () => {
  it('другое число в строке 3', () => {
    const feedback = check(exC(), 'c_line3');
    expect(feedback.source).toBe('output');
    expect(feedback.why).toBe('В строке 3 ожидалось „3“, получилось „4“.');
    expect(feedback.where).toBe('Тест „Пример 1“');
    expect(feedback.verify).toBe('Нажми „Проверить“: тест „Пример 1“ должен пройти.');
  });

  it('другое число: без range и сравнений совет про границы не даётся', () => {
    const feedback = check(exA(), 'a_plus');
    expect(feedback.title).toBe('Другое число');
    expect(feedback.why).toBe('В строке 1 ожидалось „6“, получилось „5“.');
    expect(feedback.tryThis).toContain('Посчитай вручную');
    expect(feedback.testId).toBe('ex-1');
  });

  it('разница на 1 при range — совет проверить границы', () => {
    const code = 'for i in range(1, 3):\n    print(i)\nprint(4)\n';
    const feedback = checkWith(exC(), code, structuredClone(CHECKS.c_line3.result));
    expect(feedback.why).toBe('В строке 3 ожидалось „3“, получилось „4“. Разница ровно на 1.');
    expect(feedback.tryThis).toContain('range(a, b) не включает b');
  });

  it('число из input() осталось строкой: „3“ * 2 = „33“', () => {
    const feedback = check(exA(), 'a_no_int');
    expect(feedback.title).toBe('Число осталось строкой');
    expect(feedback.why).toBe(
      'В строке 1 ожидалось „6“, получилось „33“. „33“ — это строка „3“, повторённая 2 раза: значение из input() осталось текстом.',
    );
    expect(feedback.tryThis).toContain('int(input())');
  });

  it('строки ввода склеились через +', () => {
    const exercise = makeExercise([{ id: 'sum', kind: 'io', example: true, stdin: '3\n4\n', expected: '7' }]);
    // Как вернул бы harness.py для print(a + b) при вводе 3 и 4.
    const result: CheckResult = {
      compileError: null,
      rules: [],
      tests: [
        {
          id: 'sum',
          kind: 'io',
          passed: false,
          stdin: '3\n4\n',
          expected: '7',
          diff: { kind: 'mismatch', line: 1, expectedLine: '7', actualLine: '34', hint: 'number' },
          output: '34\n',
          transcript: [
            ['input', '3\n4\n'],
            ['out', '34\n'],
          ],
          error: null,
          limit: false,
          truncated: false,
          exitCode: null,
          durationMs: 0.1,
        },
      ],
    };
    const feedback = checkWith(exercise, 'a = input()\nb = input()\nprint(a + b)\n', result);
    expect(feedback.title).toBe('Число осталось строкой');
    expect(feedback.why).toContain('„34“ — это склеенные строки ввода');
    expect(feedback.where).toBe('Тест „Пример 1“ (ввод: 3; 4)');
  });

  describe('число с подписью («Итого: 269.7»)', () => {
    // Результаты в формате harness.py: для строк, которые отличаются только числом, он добавляет
    // expectedNumber и actualNumber (проверено на настоящем Python в scripts/verify-content.test.ts).
    function labelled(expected: string, actual: string, diff: Partial<OutputDiff>, stdin = ''): CheckResult {
      return {
        compileError: null,
        rules: [],
        tests: [
          {
            id: 'total',
            kind: 'io',
            passed: false,
            stdin,
            expected,
            diff: { kind: 'mismatch', line: 1, expectedLine: expected, actualLine: actual, ...diff },
            output: `${actual}\n`,
            transcript: [['out', `${actual}\n`]],
            error: null,
            limit: false,
            truncated: false,
            exitCode: null,
            durationMs: 0.1,
          },
        ],
      };
    }
    const exTotal = (stdin?: string) => makeExercise([{ id: 'total', kind: 'io', example: true, stdin, expected: 'Итого: 269.7' }]);

    it('другое число без ввода: не «допиши окончание» и не «для ввода из теста»', () => {
      const result = labelled('Итого: 269.7', 'Итого: 269', { hint: 'number', expectedNumber: '269.7', actualNumber: '269' });
      const feedback = checkWith(exTotal(), 'price = 29.97\nprint("Итого:", int(price * 9))\n', result);
      expect(feedback.title).toBe('Другое число');
      expect(feedback.why).toBe('В строке 1 ожидалось „Итого: 269.7“, получилось „Итого: 269“. Текст совпал, отличается только число.');
      expect(feedback.tryThis).not.toContain('для ввода из теста');
      expect(feedback.tryThis).not.toContain('Допиши');
      expect(feedback.tryThis).toContain('число должна посчитать программа');
    });

    it('то же число с лишним нулём — про нули от формата, а не только «ровно 1 знак»', () => {
      // В m1-l6-e2 итог — round(…, 2): совет «ровно 1 знак» сломал бы тест с 199.98.
      const result = labelled('Итого: 269.7', 'Итого: 269.70', { hint: 'number-format', expectedNumber: '269.7', actualNumber: '269.70' });
      const feedback = checkWith(exTotal(), 'print(f"Итого: {269.7:.2f}")\n', result);
      expect(feedback.title).toBe('Лишние нули после точки');
      expect(feedback.why).toBe('„269.70“ и „269.7“ — одно число, но у тебя в конце дробной части лишние нули.');
      expect(feedback.tryThis).toContain('Нули в конце дописывает формат вроде f"{x:.2f}"');
      expect(feedback.tryThis).toContain('round(...) без формата');
      expect(feedback.tryThis).toContain('f"{x:.1f}"');
    });

    it('целое вместо дробного — совет сделать результат дробным', () => {
      const result = labelled('Итого: 269.7', 'Итого: 270', { hint: 'number', expectedNumber: '269.7', actualNumber: '270' });
      expect(checkWith(exTotal(), 'print("Итого:", round(269.7))\n', result).title).toBe('Другое число');
      const same = labelled('Итого: 270.0', 'Итого: 270', { hint: 'number-format', expectedNumber: '270.0', actualNumber: '270' });
      const feedback = checkWith(exTotal(), 'print("Итого:", 270)\n', same);
      expect(feedback.why).toBe('Ожидалось дробное „270.0“, а получилось целое „270“.');
    });

    it('строка ввода с названием не мешает узнать склеенные числа', () => {
      const result = labelled('Итого: 6', 'Итого: 33', { hint: 'number', expectedNumber: '6', actualNumber: '33' }, 'Кофе\n3\n3\n');
      const feedback = checkWith(exTotal('Кофе\n3\n3\n'), 'name = input()\na = input()\nb = input()\nprint("Итого:", a + b)\n', result);
      expect(feedback.title).toBe('Число осталось строкой');
      expect(feedback.why).toContain('„33“ — это склеенные строки ввода');
    });

    it('обрезанная строка без числа: не советует вписать цифры ответа в print', () => {
      const result = labelled('Итого: 269.7', 'Итого:', { hint: 'cut' });
      const feedback = checkWith(exTotal(), 'print("Итого:")\n', result);
      expect(feedback.why).toContain('Не хватает окончания „ 269.7“.');
      expect(feedback.tryThis).not.toContain('Допиши');
      expect(feedback.tryThis).toContain('само число вручную не пиши');
    });
  });

  it('регистр букв', () => {
    const feedback = check(exB(), 'b_case');
    expect(feedback.why).toBe('В строке 1 ожидалось „Привет, Аня!“, получилось „привет, Аня!“. Отличие только в регистре букв.');
  });

  it('5.0 и 5: деление / даёт дробное', () => {
    const feedback = check(exA(), 'a_div');
    expect(feedback.why).toBe('„6.0“ и „6“ — одно число, но в разном виде: деление / всегда даёт дробное.');
    expect(feedback.tryThis).toContain('//');
  });

  it('пробелы', () => {
    const feedback = check(exB(), 'b_spaces');
    expect(feedback.why).toContain('Отличие только в пробелах.');
    expect(feedback.tryThis).toContain('print(a, b) сам ставит пробел');
  });

  it('кавычки', () => {
    const feedback = check(exB(), 'b_quotes');
    expect(feedback.title).toBe('Лишние кавычки');
  });

  it('строка обрезана', () => {
    expect(check(exB(), 'b_cut').why).toContain('Не хватает окончания „!“.');
  });

  it('лишний текст в строке', () => {
    expect(check(exB(), 'b_extra_text').why).toContain('Лишнее — „!“.');
  });

  it('пустой вывод: в программе нет print', () => {
    const feedback = check(exB(), 'b_empty');
    expect(feedback.title).toBe('Программа ничего не вывела');
    expect(feedback.why).toContain('нет print');
  });

  it('пустой вывод: функция не вызвана', () => {
    expect(check(exB(), 'b_uncalled').why).toContain('Функция „greet“ объявлена, но нигде не вызывается');
  });

  it('не хватает строк', () => {
    const feedback = check(exC(), 'c_missing');
    expect(feedback.why).toBe('Программа вывела 2 строки, а нужно 3: не хватает строки „3“.');
    expect(feedback.tryThis).toContain('range(a, b)');
  });

  it('не хватает двух строк', () => {
    const feedback = check(exC(), 'c_missing2');
    expect(feedback.why).toBe('Программа вывела 1 строку, а нужно 3: не хватает 2 строк, первая из них — „2“.');
  });

  it('лишняя строка', () => {
    const feedback = check(exC(), 'c_extra');
    expect(feedback.why).toBe('После ожидаемого вывода программа напечатала ещё одну строку: „4“.');
  });

  it('длинная строка: показывается место первого отличия', () => {
    const feedback = check(makeExercise(TESTS.AGE), 'age_long');
    // Раньше обе строки обрезались до 40 символов с начала и выглядели одинаково.
    expect(feedback.why).toBe('В строке 1 ожидалось „…через год будет 16“, получилось „…через год будет 17“.');
  });

  it('длинное значение функции: показывается место первого отличия', () => {
    const feedback = check(makeExercise(TESTS.GREET), 'greet_long');
    expect(feedback.why).toBe("Вызов greet('Аня') вернул …кофейне сегодня вечером', а ожидалось …кофейне сегодня утром'.");
  });

  it('то же число с нулями в начале — не «знаки после точки»', () => {
    const feedback = check(makeExercise(TESTS.N), 'n_zeros');
    expect(feedback.title).toBe('Число в другом виде');
    expect(feedback.why).toBe('„005“ и „5“ — одно и то же число, но записанное по-другому.');
    expect(feedback.why).not.toContain('после точки');
    expect(feedback.tryThis).toContain('нули в начале');
  });

  it('то же число со знаком + — не «знаки после точки»', () => {
    const feedback = check(makeExercise(TESTS.N), 'n_plus');
    expect(feedback.why).toBe('„+5“ и „5“ — одно и то же число, но записанное по-другому.');
    expect(feedback.tryThis).toContain('„+“');
  });

  it('«00» при вводе «0»: значение из input() осталось строкой', () => {
    // Настоящий результат a_no_int, оставлен только тест «Граничный случай 3» (hint number-format).
    const result = structuredClone(CHECKS.a_no_int.result);
    result.tests = result.tests.filter((test) => test.id === 'edge-zero');
    const feedback = checkWith(exA(), CHECKS.a_no_int.code, result);
    expect(feedback.title).toBe('Число осталось строкой');
    expect(feedback.why).toContain('„00“ — это строка „0“, повторённая 2 раза');
  });

  it('разное число знаков после точки — совет с нужным числом знаков', () => {
    const feedback = check(makeExercise(TESTS.N2), 'n_digits');
    expect(feedback.title).toBe('Другое число знаков после точки');
    expect(feedback.tryThis).toBe('Выведи ровно 1 знак после точки, например f"{x:.1f}".');
  });

  it('кавычки другого вида — не «не хватает кавычек»', () => {
    const feedback = check(makeExercise(TESTS.QUOTE), 'quote_kind');
    expect(feedback.title).toBe('Кавычки другого вида');
    expect(feedback.why).toContain('Нужны кавычки „"“, а в выводе — „\'“.');
    expect(feedback.why).not.toContain('не хватает');
  });

  it('кавычки того же вида, но вокруг другого текста — не «кавычки другого вида»', () => {
    const feedback = check(makeExercise(TESTS.QUOTE), 'quote_place');
    expect(feedback.title).toBe('Кавычки не на своём месте');
    expect(feedback.why).toContain('Кавычки те же, но стоят вокруг другого текста.');
    expect(feedback.why).not.toContain('Нужны кавычки');
  });

  it('вывод не подходит под шаблон: показывает expectedLabel', () => {
    const feedback = check(exF(), 'f_pattern');
    expect(feedback.why).toBe('Ожидался вывод в виде: число и «руб.», например 150 руб. Первая строка вывода: „сто рублей“.');
  });

  it('в выводе нет обязательного фрагмента (режим contains)', () => {
    const result: CheckResult = {
      compileError: null,
      rules: [],
      tests: [
        {
          ...CHECKS.f_pattern.result.tests[0],
          diff: { kind: 'missing', line: null, expectedLine: 'Итого', actualLine: null, count: 1 },
        },
      ],
    };
    expect(checkWith(exF(), 'print("сто рублей")', result).why).toBe('В выводе должен быть фрагмент „Итого“, а его нет.');
  });

  it('функция печатает, но не возвращает', () => {
    const feedback = check(exD(), 'd_print');
    expect(feedback.title).toBe('Функция ничего не вернула');
    expect(feedback.why).toBe('Вызов is_even(4) вернул None: результат печатается через print, но не возвращается.');
    expect(feedback.where).toBe('Тест „Пример 1“: is_even(4)');
  });

  it('функция вернула противоположное логическое значение', () => {
    const feedback = check(exD(), 'd_inverted');
    expect(feedback.why).toBe('Вызов is_even(4) вернул False, а ожидалось True.');
    expect(feedback.tryThis).toContain('противоположный');
  });

  it('функция вернула значение другого типа', () => {
    const feedback = check(exD(), 'd_str');
    expect(feedback.title).toBe('Значение другого типа');
    expect(feedback.why).toBe("Вызов is_even(4) вернул 'True' — это строка (str), а ожидалось True — логическое значение (bool).");
  });

  it('значение другого типа: совет без ошибки в падеже', () => {
    // Правка настоящего результата d_str: ожидалась строка, а функция вернула список.
    const result = structuredClone(CHECKS.d_str.result);
    result.tests[0] = { ...result.tests[0], expected: "'4'", actual: '[4]', actualType: 'list', expectedType: 'str' };
    const feedback = checkWith(exD(), CHECKS.d_str.code, result);
    expect(feedback.tryThis).toBe('Проверь, что функция возвращает значение нужного типа — строка (str).');
  });

  it('проверка assert', () => {
    const feedback = check(exE(), 'e_assert');
    expect(feedback.why).toBe('Переменная total должна быть равна 10.');
    expect(feedback.where).toBe('Тест „Проверка 1“');
  });
});

// ------------------------------------------------------------------ buildRunFeedback

describe('buildRunFeedback', () => {
  it('успешный запуск — null', () => {
    expect(run('run_ok')).toBeNull();
  });

  it('синтаксическая ошибка', () => {
    const feedback = run('run_compile')!;
    expect(feedback.source).toBe('compile');
    expect(feedback.title).toBe('Незакрытая строка');
    expect(feedback.where).toBe('Строка 1: print("Привет)');
    expect(feedback.line).toBe(1);
    expect(feedback.raw).toContain('SyntaxError: unterminated string literal');
    expect(feedback.verify).toContain('„Запустить“');
  });

  it('ошибка выполнения с подсказкой Python', () => {
    const feedback = run('run_name')!;
    expect(feedback.source).toBe('runtime');
    expect(feedback.title).toBe('Неизвестное имя „prnt“');
    expect(feedback.tryThis).toContain('„print“');
  });

  it('EOFError при обычном запуске — про ввод перед запуском', () => {
    const feedback = run('run_eof')!;
    expect(feedback.why).toBe('Программа попросила больше строк ввода, чем ей дали перед запуском.');
  });

  it('слишком много вывода', () => {
    const feedback = run('run_limit')!;
    expect(feedback.source).toBe('limit');
    expect(feedback.where).toBeNull();
  });

  it('тайм-аут, остановка и сбой среды', () => {
    const timeout: RunOutcome = { status: 'timeout', limitMs: 5000 };
    const feedback = buildRunFeedback('while True:\n    pass\n', timeout)!;
    expectShort(feedback);
    expect(feedback.source).toBe('timeout');
    expect(feedback.why).toBe('Программа не завершилась за 5 с — похоже, цикл не останавливается.');
    expect(feedback.verify).toContain('„Запустить“');

    expect(buildRunFeedback('print(1)', { status: 'stopped' })).toBeNull();

    const failed = buildRunFeedback('print(1)', { status: 'failed', message: 'Python не запущен' })!;
    expectShort(failed);
    expect(failed.source).toBe('environment');
    expect(failed.why).toContain('не ошибка в твоём коде');
  });

  it('ограничение среды при обычном запуске', () => {
    const result: RunResult = {
      error: runtimeError('ModuleNotFoundError', "No module named 'turtle'", 1, 'import turtle'),
      limit: false,
      exitCode: null,
      durationMs: 1,
      transcript: [],
      stdout: '',
      truncated: false,
    };
    const feedback = buildRunFeedback('import turtle\n', { status: 'done', result })!;
    expect(feedback.source).toBe('environment');
  });
});
