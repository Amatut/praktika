# Практика: учебная обвязка для запуска кода ученика в Pyodide.
#
# Файл выполняется один раз при старте Python (в браузере — в Web Worker,
# при проверке материалов — в Node.js). Он:
#   * запускает код ученика в отдельном пространстве имён;
#   * перехватывает вывод и подставляет заранее заданный ввод (stdin);
#   * ограничивает объём вывода;
#   * сравнивает результат с тестами и возвращает подробный JSON.
#
# Ограничение времени и остановка бесконечного цикла выполняются снаружи:
# поток с Python завершается и запускается заново.
# Это учебная среда, а не песочница. Запрет импорта js и pyodide ниже — учебная мера
# (чтобы код не зависел от браузера), а не защита: его обходит importlib и не только.
# Защита данных приложения — в python.worker.ts: до первого запуска кода ученика поток
# лишается доступа к хранилищам (IndexedDB, Cache Storage) и сети.

import ast
import builtins
import io
import json
import linecache
import math
import re
import sys
import time
import traceback

USER_FILENAME = "main.py"
DEFAULT_OUTPUT_LIMIT = 20_000
BLOCKED_MODULES = {"js", "pyodide", "pyodide_js", "_pyodide", "micropip"}

_BUILTINS_SNAPSHOT = dict(builtins.__dict__)
_REAL_IMPORT = builtins.__import__


class OutputLimitExceeded(BaseException):
    """Вывод программы превысил допустимый объём."""


class _Transcript:
    """Всё, что увидел бы человек в консоли, плюс отдельно «проверяемый» вывод print()."""

    def __init__(self, limit):
        self.limit = limit
        self.size = 0
        self.parts = []
        self.checked = []
        self.truncated = False

    def _add(self, kind, text):
        if not text:
            return
        if self.parts and self.parts[-1][0] == kind:
            self.parts[-1][1] += text
        else:
            self.parts.append([kind, text])

    def write(self, text, kind, checked):
        remaining = self.limit - self.size
        if len(text) > remaining:
            head = text[: max(remaining, 0)]
            self._add(kind, head)
            if checked:
                self.checked.append(head)
            self.size = self.limit
            self.truncated = True
            raise OutputLimitExceeded()
        self.size += len(text)
        self._add(kind, text)
        if checked:
            self.checked.append(text)

    def stdout(self):
        return "".join(self.checked)


class _Stream(io.TextIOBase):
    def __init__(self, transcript, kind, checked):
        super().__init__()
        self._transcript = transcript
        self._kind = kind
        self._checked = checked

    @property
    def encoding(self):
        return "utf-8"

    def writable(self):
        return True

    def isatty(self):
        return False

    def write(self, s):
        if not isinstance(s, str):
            raise TypeError(f"write() argument must be str, not {type(s).__name__}")
        self._transcript.write(s, self._kind, self._checked)
        return len(s)

    def flush(self):
        pass


def _make_input(stdin, transcript):
    def input(prompt=""):  # noqa: A001 - заменяем встроенную функцию для ученика
        if prompt != "":
            transcript.write(str(prompt), "prompt", False)
        line = stdin.readline()
        if line == "":
            raise EOFError("EOF when reading a line")
        value = line[:-1] if line.endswith("\n") else line
        transcript.write(value + "\n", "input", False)
        return value

    return input


def _guarded_import(name, globals=None, locals=None, fromlist=(), level=0):
    if level == 0 and name.split(".")[0] in BLOCKED_MODULES:
        raise ModuleNotFoundError(
            f"Модуль «{name.split('.')[0]}» недоступен в учебной среде", name=name
        )
    return _REAL_IMPORT(name, globals, locals, fromlist, level)


def _student_builtins(input_fn):
    namespace = dict(_BUILTINS_SNAPSHOT)
    namespace["input"] = input_fn
    namespace["__import__"] = _guarded_import
    return namespace


def _restore_builtins():
    current = builtins.__dict__
    for key in list(current):
        if key not in _BUILTINS_SNAPSHOT:
            del current[key]
    for key, value in _BUILTINS_SNAPSHOT.items():
        if current.get(key) is not value:
            current[key] = value


def _register_source(code):
    linecache.cache[USER_FILENAME] = (len(code), None, code.splitlines(True), USER_FILENAME)


def _source_line(code, lineno):
    if not lineno:
        return None
    lines = code.splitlines()
    if 1 <= lineno <= len(lines):
        return lines[lineno - 1]
    return None


def _describe_syntax_error(e, code):
    raw = "".join(traceback.format_exception_only(type(e), e)).rstrip()
    lineno = e.lineno if e.filename == USER_FILENAME else None
    return {
        "phase": "compile",
        "type": type(e).__name__,
        "message": e.msg or str(e),
        "line": lineno,
        "col": e.offset,
        "endCol": getattr(e, "end_offset", None),
        "lineText": _source_line(code, lineno),
        "summary": raw.splitlines()[-1] if raw else type(e).__name__,
        "raw": raw,
    }


def _describe_exception(e, code):
    all_frames = traceback.extract_tb(e.__traceback__)
    frames = [f for f in all_frames if f.filename == USER_FILENAME]
    lineno = frames[-1].lineno if frames else None
    # Ошибка внутри самой проверки (например, функция с нужным именем не найдена).
    origin = "check" if all_frames and all_frames[-1].filename == "<проверка>" else "program"
    # from_exception учитывает traceback, поэтому Python добавляет «Did you mean: ...?».
    only = "".join(traceback.TracebackException.from_exception(e).format_exception_only()).rstrip()
    lines = []
    if frames:
        lines.append("Traceback (most recent call last):")
        for frame in frames:
            lines.append(f'  File "{frame.filename}", line {frame.lineno}, in {frame.name}')
            if frame.line:
                lines.append(f"    {frame.line.strip()}")
    lines.append(only)
    return {
        "phase": "runtime",
        "origin": origin,
        "type": type(e).__name__,
        "message": str(e),
        "line": lineno,
        "col": None,
        "endCol": None,
        "lineText": _source_line(code, lineno),
        "summary": only.splitlines()[-1] if only else type(e).__name__,
        "raw": "\n".join(lines),
    }


def _compile(code):
    _register_source(code)
    return compile(code, USER_FILENAME, "exec", dont_inherit=True)


def _execute(compiled, code, stdin_text, limit, after=None):
    """Выполняет программу; after(ns) — дополнительная проверка в том же окружении."""
    transcript = _Transcript(limit)
    stdin = io.StringIO(stdin_text or "")
    namespace = {"__name__": "__main__", "__builtins__": _student_builtins(_make_input(stdin, transcript))}
    saved = sys.stdout, sys.stderr, sys.stdin
    sys.stdout = _Stream(transcript, "out", True)
    sys.stderr = _Stream(transcript, "err", False)
    sys.stdin = stdin
    started = time.perf_counter()
    outcome = {"error": None, "limit": False, "exitCode": None, "extra": None, "extraError": None}
    try:
        try:
            exec(compiled, namespace)
        except SystemExit as e:
            outcome["exitCode"] = e.code if isinstance(e.code, int) or e.code is None else str(e.code)
        if after is not None:
            try:
                outcome["extra"] = after(namespace)
            except SystemExit as e:
                outcome["exitCode"] = e.code if isinstance(e.code, int) or e.code is None else str(e.code)
    except OutputLimitExceeded:
        outcome["limit"] = True
    except BaseException as e:  # noqa: BLE001 - любая ошибка ученика должна быть показана
        outcome["error"] = _describe_exception(e, code)
    finally:
        sys.stdout, sys.stderr, sys.stdin = saved
        _restore_builtins()
    outcome["durationMs"] = round((time.perf_counter() - started) * 1000, 1)
    outcome["transcript"] = transcript.parts
    outcome["stdout"] = transcript.stdout()
    outcome["truncated"] = transcript.truncated
    return outcome


# ---------------------------------------------------------------- сравнение


def _normalize_lines(text, options):
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    lines = [line.rstrip() for line in lines]
    if options.get("ignoreSpaces"):
        lines = [" ".join(line.split()) for line in lines]
    if options.get("ignoreCase"):
        lines = [line.casefold() for line in lines]
    if options.get("ignoreBlankLines"):
        lines = [line for line in lines if line.strip()]
    while lines and lines[-1] == "":
        lines.pop()
    return lines


def _as_number(text):
    try:
        return float(text.replace(",", "."))
    except ValueError:
        return None


# Число внутри строки: «269», «269.7», «3,5», «-5». Минус — только в начале или после пробела,
# чтобы «10-5» читалось как два числа, а не «10» и «-5».
_NUMBER_IN_TEXT = re.compile(r"(?:(?<![^\s(])-)?\d+(?:[.,]\d+)?")


def _differing_numbers(expected, actual):
    """
    Если строки отличаются только числами («Итого: 269.7» и «Итого: 269»), возвращает первую
    пару различающихся чисел — ожидаемое и полученное. Иначе None.
    """
    exp_numbers = _NUMBER_IN_TEXT.findall(expected)
    act_numbers = _NUMBER_IN_TEXT.findall(actual)
    if not exp_numbers or len(exp_numbers) != len(act_numbers):
        return None
    if _NUMBER_IN_TEXT.split(expected) != _NUMBER_IN_TEXT.split(actual):
        return None
    for exp, act in zip(exp_numbers, act_numbers):
        if exp != act:
            return exp, act
    return None


def _line_hint(expected, actual):
    """
    Уточняет, чем похожи строки, чтобы объяснение было конкретным.
    Возвращает (подсказка, числа): числа — (ожидаемое, полученное), если строки
    различаются только числом, иначе None.
    """
    if expected.casefold() == actual.casefold():
        return "case", None
    if " ".join(expected.split()) == " ".join(actual.split()):
        return "spaces", None
    if expected.replace(" ", "") == actual.replace(" ", ""):
        return "spaces", None
    quotes = str.maketrans({"'": "", '"': "", "«": "", "»": "", "“": "", "”": ""})
    if expected.translate(quotes) == actual.translate(quotes):
        return "quotes", None
    exp_num, act_num = _as_number(expected), _as_number(actual)
    if exp_num is not None and act_num is not None:
        return ("number-format" if exp_num == act_num else "number"), (expected.strip(), actual.strip())
    # Число с подписью: «Итого: 269» вместо «Итого: 269.7» — это другое число, а не обрезанная строка.
    numbers = _differing_numbers(expected, actual)
    if numbers is not None:
        same = _as_number(numbers[0]) == _as_number(numbers[1])
        return ("number-format" if same else "number"), numbers
    if actual and expected.startswith(actual):
        return "cut", None
    if expected and actual.startswith(expected):
        return "extra-text", None
    return None, None


def _diff(expected_lines, actual_lines):
    if not actual_lines and expected_lines:
        return {"kind": "empty", "line": 1, "expectedLine": expected_lines[0], "actualLine": None}
    for index, (exp, act) in enumerate(zip(expected_lines, actual_lines)):
        if exp != act:
            hint, numbers = _line_hint(exp, act)
            difference = {
                "kind": "mismatch",
                "line": index + 1,
                "expectedLine": exp,
                "actualLine": act,
                "hint": hint,
            }
            if numbers is not None:
                difference["expectedNumber"], difference["actualNumber"] = numbers
            return difference
    if len(actual_lines) < len(expected_lines):
        index = len(actual_lines)
        return {"kind": "missing", "line": index + 1, "expectedLine": expected_lines[index], "actualLine": None,
                "count": len(expected_lines) - len(actual_lines)}
    if len(actual_lines) > len(expected_lines):
        index = len(expected_lines)
        return {"kind": "extra", "line": index + 1, "expectedLine": None, "actualLine": actual_lines[index],
                "count": len(actual_lines) - len(expected_lines)}
    return None


def _compare_output(actual, test):
    options = test.get("compare") or {}
    mode = options.get("mode", "lines")
    if mode == "regex":
        normalized = "\n".join(_normalize_lines(actual, options))
        flags = re.IGNORECASE if options.get("ignoreCase") else 0
        passed = re.fullmatch(test["expected"], normalized, flags | re.DOTALL) is not None
        return passed, None if passed else {"kind": "pattern", "line": None, "expectedLine": None,
                                             "actualLine": normalized.split("\n")[0] if normalized else None}
    if mode == "contains":
        haystack = "\n".join(_normalize_lines(actual, options))
        needles = _normalize_lines(test["expected"], options)
        for needle in needles:
            if needle and needle not in haystack:
                return False, {"kind": "missing", "line": None, "expectedLine": needle, "actualLine": None, "count": 1}
        return True, None
    expected_lines = _normalize_lines(test["expected"], options)
    actual_lines = _normalize_lines(actual, options)
    difference = _diff(expected_lines, actual_lines)
    return difference is None, difference


def _values_equal(actual, expected, tolerance):
    if isinstance(expected, bool) or isinstance(actual, bool):
        return type(actual) is type(expected) and actual == expected
    if isinstance(expected, float) or isinstance(actual, float):
        if isinstance(actual, (int, float)) and isinstance(expected, (int, float)):
            return math.isclose(actual, expected, rel_tol=tolerance or 1e-9, abs_tol=tolerance or 1e-9)
        return False
    if isinstance(expected, (list, tuple)) and isinstance(actual, (list, tuple)):
        if type(actual) is not type(expected) or len(actual) != len(expected):
            return False
        return all(_values_equal(a, b, tolerance) for a, b in zip(actual, expected))
    if isinstance(expected, dict) and isinstance(actual, dict):
        if actual.keys() != expected.keys():
            return False
        return all(_values_equal(actual[k], expected[k], tolerance) for k in expected)
    return type(actual) is type(expected) and actual == expected


def _safe_repr(value, limit=400):
    try:
        text = repr(value)
    except Exception:  # noqa: BLE001
        text = f"<{type(value).__name__}>"
    return text if len(text) <= limit else text[: limit - 1] + "…"


# ---------------------------------------------------------------- правила по коду


def _token_counts(tree):
    counts = {}
    for node in ast.walk(tree):
        name = type(node).__name__
        counts[name] = counts.get(name, 0) + 1
        if isinstance(node, ast.Call):
            func = node.func
            key = None
            if isinstance(func, ast.Name):
                key = "call:" + func.id
            elif isinstance(func, ast.Attribute):
                key = "call:." + func.attr
            if key:
                counts[key] = counts.get(key, 0) + 1
    return counts


# Правила по смыслу (dependsOn, fromNumbers) смотрят, откуда берутся значения, а не сколько
# в коде узлов: так «greeting = "Привет, " + name + "!"» и «print(greeting + "\n" + "-" * 14)»
# принимаются одинаково. Разбирается код верхнего уровня, условия и циклы (ветки объединяются);
# тела функций не разбираются.
#
# Значение переменной описывается так: (источники, есть ли готовые числа в формулах).
# Источник — переменная, которой присвоено готовое значение (x = 540, name = "Марат", n = int(input())),
# вместе с этим значением, если это число: ("pizza_price", 540).


def _number_constant(node):
    """Число, записанное прямо в коде (и -5), иначе None."""
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.UAdd)):
        value = _number_constant(node.operand)
        if value is None:
            return None
        return -value if isinstance(node.op, ast.USub) else value
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)) and not isinstance(node.value, bool):
        return node.value
    return None


def _has_bare_number(node):
    """Готовое число участвует в вычислении: 540 * 3, total / 5."""
    for child in ast.walk(node):
        if isinstance(child, ast.BinOp):
            if _number_constant(child.left) is not None or _number_constant(child.right) is not None:
                return True
    return False


def _expression_value(node, env):
    sources = set()
    bare = _has_bare_number(node)
    for child in ast.walk(node):
        if isinstance(child, ast.Name) and isinstance(child.ctx, ast.Load) and child.id in env:
            known_sources, known_bare = env[child.id]
            sources |= known_sources
            bare = bare or known_bare
    return sources, bare


def _assign_name(name, value_node, env):
    number = _number_constant(value_node)
    if number is not None:
        env[name] = ({(name, number)}, False)
        return
    sources, bare = _expression_value(value_node, env)
    # Значение ни из чего не посчитано (текст, input(), 540 * 3) — переменная сама стала источником.
    env[name] = (sources or {(name, None)}, bare)


def _assign_target(target, value_node, env):
    if isinstance(target, ast.Name):
        _assign_name(target.id, value_node, env)
    elif isinstance(target, (ast.Tuple, ast.List)):
        pairs = isinstance(value_node, (ast.Tuple, ast.List)) and len(value_node.elts) == len(target.elts)
        for index, element in enumerate(target.elts):
            element = element.value if isinstance(element, ast.Starred) else element
            _assign_target(element, value_node.elts[index] if pairs else value_node, env)


def _merge(*envs):
    merged = {}
    for env in envs:
        for name, (sources, bare) in env.items():
            if name in merged:
                merged[name] = (merged[name][0] | sources, merged[name][1] or bare)
            else:
                merged[name] = (set(sources), bare)
    return merged


def _record_prints(node, env, printed):
    """Запоминает, из чего собрано то, что печатают вызовы print внутри node."""
    for child in ast.walk(node):
        if isinstance(child, ast.Call) and isinstance(child.func, ast.Name) and child.func.id == "print":
            for argument in child.args:
                printed |= _expression_value(argument, env)[0]


def _flow(statements, env, printed):
    for statement in statements:
        if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            env[statement.name] = ({(statement.name, None)}, False)
        elif isinstance(statement, ast.If):
            _record_prints(statement.test, env, printed)
            body, orelse = dict(env), dict(env)
            _flow(statement.body, body, printed)
            _flow(statement.orelse, orelse, printed)
            env.clear()
            env.update(_merge(body, orelse))
        elif isinstance(statement, (ast.For, ast.AsyncFor, ast.While)):
            header = statement.iter if isinstance(statement, (ast.For, ast.AsyncFor)) else statement.test
            _record_prints(header, env, printed)
            body = dict(env)
            if isinstance(statement, (ast.For, ast.AsyncFor)):
                _assign_target(statement.target, statement.iter, body)
            # Тело может выполниться несколько раз: второй проход видит значения после первого.
            for _ in range(2):
                _flow(statement.body, body, printed)
                body = _merge(env, body)
            orelse = dict(body)
            _flow(statement.orelse, orelse, printed)
            env.clear()
            env.update(_merge(body, orelse))
        elif isinstance(statement, (ast.Try, getattr(ast, "TryStar", ast.Try))):
            branches = []
            for block in [statement.body, *[handler.body for handler in statement.handlers], statement.orelse]:
                branch = dict(env)
                _flow(block, branch, printed)
                branches.append(branch)
            env.clear()
            env.update(_merge(*branches))
            _flow(statement.finalbody, env, printed)
        elif isinstance(statement, (ast.With, ast.AsyncWith)):
            for item in statement.items:
                _record_prints(item.context_expr, env, printed)
            _flow(statement.body, env, printed)
        elif isinstance(statement, ast.Assign):
            _record_prints(statement.value, env, printed)
            for target in statement.targets:
                _assign_target(target, statement.value, env)
        elif isinstance(statement, ast.AnnAssign) and statement.value is not None:
            _record_prints(statement.value, env, printed)
            _assign_target(statement.target, statement.value, env)
        elif isinstance(statement, ast.AugAssign) and isinstance(statement.target, ast.Name):
            _record_prints(statement.value, env, printed)
            name = statement.target.id
            sources, bare = _expression_value(statement.value, env)
            old_sources, old_bare = env.get(name, ({(name, None)}, False))
            number = _number_constant(statement.value) is not None
            env[name] = (old_sources | sources, old_bare or bare or number)
        else:
            _record_prints(statement, env, printed)


def _value_flow(tree):
    env, printed = {}, set()
    _flow(tree.body, env, printed)
    return env, printed


def _depends_on(flow, target, names):
    """target (переменная или print — то, что печатается) посчитан из каждой переменной names."""
    env, printed = flow
    if target == "print":
        sources = printed
    elif target in env:
        sources = env[target][0]
    else:
        return False
    found = {name for name, _ in sources}
    return all(name in found for name in names)


def _from_numbers(flow, target, numbers):
    """
    target посчитан формулой: готовых чисел в формулах нет, а среди переменных, из которых он
    посчитан, есть переменные с каждым из чисел numbers.
    """
    env, _ = flow
    if target not in env:
        return False
    sources, bare = env[target]
    if bare or all(name == target for name, _ in sources):
        return False
    values = [value for _, value in sources if value is not None]
    return all(any(value == number for value in values) for number in numbers)


def _check_rules(code, rules):
    if not rules:
        return []
    tree = ast.parse(code, USER_FILENAME)
    counts = _token_counts(tree)
    flow = None
    results = []
    for rule in rules:
        passed = True
        for token in rule.get("use", []):
            if counts.get(token, 0) < 1:
                passed = False
        for token in rule.get("avoid", []):
            if counts.get(token, 0) > 0:
                passed = False
        for token, minimum in (rule.get("min") or {}).items():
            if counts.get(token, 0) < minimum:
                passed = False
        for token, maximum in (rule.get("max") or {}).items():
            if counts.get(token, 0) > maximum:
                passed = False
        if rule.get("dependsOn") or rule.get("fromNumbers"):
            if flow is None:
                try:
                    flow = _value_flow(tree)
                except Exception:  # noqa: BLE001 - сбой разбора не должен срывать проверку ученика
                    flow = False
            if flow is False:
                results.append({"id": rule["id"], "passed": passed, "message": rule["message"]})
                continue
            for target, names in (rule.get("dependsOn") or {}).items():
                if not _depends_on(flow, target, names):
                    passed = False
            for target, numbers in (rule.get("fromNumbers") or {}).items():
                if not _from_numbers(flow, target, numbers):
                    passed = False
        results.append({"id": rule["id"], "passed": passed, "message": rule["message"]})
    return results


# ---------------------------------------------------------------- публичные функции


def run_program(code, stdin_text="", limit=DEFAULT_OUTPUT_LIMIT):
    """Обычный запуск: показать, что выведет программа."""
    try:
        compiled = _compile(code)
    except SyntaxError as e:
        return json.dumps({"compileError": _describe_syntax_error(e, code)}, ensure_ascii=False)
    outcome = _execute(compiled, code, stdin_text, int(limit))
    outcome.pop("extra", None)
    outcome.pop("extraError", None)
    return json.dumps(outcome, ensure_ascii=False)


def _run_test(compiled, code, test, limit):
    kind = test["kind"]
    result = {"id": test["id"], "kind": kind, "passed": False, "stdin": test.get("stdin", "")}

    if kind == "io":
        outcome = _execute(compiled, code, test.get("stdin", ""), limit)
        result["expected"] = test["expected"]
        if not outcome["error"] and not outcome["limit"]:
            passed, difference = _compare_output(outcome["stdout"], test)
            result["passed"] = passed
            result["diff"] = difference

    elif kind == "call":
        def after(namespace):
            value = eval(compile(test["call"], "<проверка>", "eval", dont_inherit=True), namespace)  # noqa: S307
            return value

        outcome = _execute(compiled, code, test.get("stdin", ""), limit, after)
        result["call"] = test["call"]
        result["expected"] = test["expected"]
        if not outcome["error"] and not outcome["limit"]:
            expected_value = ast.literal_eval(test["expected"])
            actual_value = outcome["extra"]
            result["actual"] = _safe_repr(actual_value)
            result["actualType"] = type(actual_value).__name__
            result["expectedType"] = type(expected_value).__name__
            result["passed"] = _values_equal(actual_value, expected_value, test.get("floatTolerance"))

    elif kind == "assert":
        def after(namespace):
            try:
                exec(compile(test["code"], "<проверка>", "exec", dont_inherit=True), namespace)  # noqa: S102
            except AssertionError:
                return False
            return True

        outcome = _execute(compiled, code, test.get("stdin", ""), limit, after)
        result["message"] = test["message"]
        if not outcome["error"] and not outcome["limit"]:
            result["passed"] = outcome["extra"] is True

    else:
        raise ValueError(f"Неизвестный вид теста: {kind}")

    result["output"] = outcome["stdout"]
    result["transcript"] = outcome["transcript"]
    result["error"] = outcome["error"]
    result["limit"] = outcome["limit"]
    result["truncated"] = outcome["truncated"]
    result["exitCode"] = outcome["exitCode"]
    result["durationMs"] = outcome["durationMs"]
    return result


def check_program(payload_json, notify=None):
    """Проверка по тестам. payload: {"code", "tests", "rules", "limit"}."""
    payload = json.loads(payload_json)
    code = payload["code"]
    limit = int(payload.get("limit") or DEFAULT_OUTPUT_LIMIT)
    try:
        compiled = _compile(code)
    except SyntaxError as e:
        return json.dumps({"compileError": _describe_syntax_error(e, code), "rules": [], "tests": []},
                          ensure_ascii=False)

    rules = _check_rules(code, payload.get("rules") or [])
    tests = []
    for index, test in enumerate(payload.get("tests") or []):
        if notify is not None:
            notify(index)
        tests.append(_run_test(compiled, code, test, limit))
    return json.dumps({"compileError": None, "rules": rules, "tests": tests}, ensure_ascii=False)
