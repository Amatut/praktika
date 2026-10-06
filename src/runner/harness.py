# Практика: учебная обвязка для запуска кода ученика в Pyodide.
#
# Файл выполняется один раз при старте Python (в браузере — в Web Worker,
# при проверке материалов — в Node.js, при быстрой самопроверке — в обычном CPython). Он:
#   * запускает код ученика в отдельном пространстве имён и в новой пустой рабочей папке
#     (учебные файлы и базы SQLite задания, код ученика под именем файла задания);
#   * перехватывает вывод и подставляет заранее заданный ввод (stdin);
#   * подставляет учебный модуль requests: ответы заранее записаны, настоящих запросов нет;
#   * ограничивает объём вывода;
#   * сравнивает результат с тестами и возвращает подробный JSON, в том числе файлы,
#     которые программа создала или изменила.
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
import os
import random
import re
import shutil
import sys
import tempfile
import time
import traceback
import types
import urllib.parse
from http import HTTPStatus

USER_FILENAME = "main.py"
DEFAULT_OUTPUT_LIMIT = 20_000
BLOCKED_MODULES = {"js", "pyodide", "pyodide_js", "_pyodide", "micropip"}
# «Файлы после запуска»: сколько файлов и сколько символов текста каждого возвращать.
CHANGED_FILES_LIMIT = 20
FILE_TEXT_LIMIT = 4_000

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


def _register_source(code, filename):
    linecache.cache[filename] = (len(code), None, code.splitlines(True), filename)


def _source_line(code, lineno):
    if not lineno:
        return None
    lines = code.splitlines()
    if 1 <= lineno <= len(lines):
        return lines[lineno - 1]
    return None


def _describe_syntax_error(e, code, filename=USER_FILENAME):
    raw = "".join(traceback.format_exception_only(type(e), e)).rstrip()
    lineno = e.lineno if e.filename == filename else None
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


def _is_user_frame(frame, filename, workdir):
    """Строка кода ученика: программа (скомпилирована под именем файла задания) или тот же файл,
    импортированный как модуль из рабочей папки (import main в assert-тесте)."""
    if frame.filename == filename:
        return True
    if not workdir:
        return False
    own = os.path.normcase(os.path.join(workdir, *filename.split("/")))
    return os.path.normcase(os.path.abspath(frame.filename)) == own


def _describe_exception(e, code, filename=USER_FILENAME, workdir=None):
    all_frames = traceback.extract_tb(e.__traceback__)
    frames = [f for f in all_frames if _is_user_frame(f, filename, workdir)]
    lineno = frames[-1].lineno if frames else None
    # Ошибка внутри самой проверки (например, функция с нужным именем не найдена).
    origin = "check" if all_frames and all_frames[-1].filename == "<проверка>" else "program"
    # from_exception учитывает traceback, поэтому Python добавляет «Did you mean: ...?».
    only = "".join(traceback.TracebackException.from_exception(e).format_exception_only()).rstrip()
    lines = []
    if frames:
        lines.append("Traceback (most recent call last):")
        for frame in frames:
            # Путь во временной папке ученику ничего не скажет — показываем имя файла задания.
            lines.append(f'  File "{filename}", line {frame.lineno}, in {frame.name}')
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


def _compile(code, filename=USER_FILENAME):
    _register_source(code, filename)
    return compile(code, filename, "exec", dont_inherit=True)


def _execute(compiled, code, stdin_text, limit, after=None, environment=None):
    """
    Выполняет программу в новой рабочей папке (см. _Workspace); after(ns) — дополнительная
    проверка в том же окружении и в той же папке.
    """
    environment = environment or {}
    workspace = _Workspace(environment, code)
    workspace.open()
    try:
        transcript = _Transcript(limit)
        stdin = io.StringIO(stdin_text or "")
        namespace = {
            "__name__": "__main__",
            "__file__": workspace.program_path,
            "__builtins__": _student_builtins(_make_input(stdin, transcript)),
        }
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
            outcome["error"] = _describe_exception(e, code, workspace.filename, workspace.path)
        finally:
            sys.stdout, sys.stderr, sys.stdin = saved
            _restore_builtins()
        outcome["durationMs"] = round((time.perf_counter() - started) * 1000, 1)
        outcome["transcript"] = transcript.parts
        outcome["stdout"] = transcript.stdout()
        outcome["truncated"] = transcript.truncated
        outcome["files"] = workspace.changed_files()
        return outcome
    finally:
        workspace.close()


# ---------------------------------------------------------------- рабочая папка запуска
#
# Каждый запуск («Запустить», каждый тест, пример, прогноз) идёт в новой пустой папке: туда
# записываются учебные файлы (files), создаются базы SQLite (databases) и сохраняется код ученика
# под именем файла задания (по умолчанию main.py) — чтобы assert-тест мог сделать import main.
# На время запуска папка — текущая (os.chdir) и первая в sys.path, в sys.modules подставлен учебный
# requests. После запуска всё возвращается как было: модули из папки выгружаются (иначе import
# закешировался бы между тестами), папка удаляется. В Pyodide это виртуальная файловая система
# в памяти, в CPython (quick-check) — временная папка на диске.


def _safe_relative_path(path, what="файл"):
    """Путь внутри рабочей папки: относительный, через «/», без «..», «.» и пустых частей."""
    if not isinstance(path, str) or path == "" or path.startswith("/") or re.search(r"[\\:\0]", path):
        raise ValueError(f"Недопустимый путь ({what}): {path!r}")
    parts = path.split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise ValueError(f"Недопустимый путь ({what}): {path!r}")
    return parts


def _merge_named(base, extra):
    """Файлы или базы задания, дополненные тестом; значение None в тесте убирает запись задания."""
    merged = dict(base or {})
    merged.update(extra or {})
    return {name: value for name, value in merged.items() if value is not None}


def _merge_http(base, extra):
    """Ответы сети задания, дополненные тестом: запись теста заменяет запись с тем же методом и адресом."""
    merged = {}
    for route in list(base or []) + list(extra or []):
        merged[_route_key(route.get("method") or "GET", route["url"])] = route
    return list(merged.values())


def _test_environment(base, test):
    """Окружение одного теста: поля задания (payload), дополненные полями теста."""
    seed = test.get("seed")
    return {
        "filename": base.get("filename"),
        "files": _merge_named(base.get("files"), test.get("files")),
        "databases": _merge_named(base.get("databases"), test.get("databases")),
        "seed": seed if seed is not None else base.get("seed"),
        "http": _merge_http(base.get("http"), test.get("http")),
    }


def _write_text(root, relative, text):
    full = os.path.join(root, *_safe_relative_path(relative))
    os.makedirs(os.path.dirname(full), exist_ok=True)
    # newline="" — текст записывается как есть: на Windows (quick-check) без замены \n на \r\n.
    with open(full, "w", encoding="utf-8", newline="") as file:
        file.write(text)
    return full


def _create_database(root, relative, script):
    import sqlite3  # только когда базы действительно нужны: модуль не нужен большинству уроков

    if not relative.endswith(".db"):
        raise ValueError(f"Имя базы данных должно оканчиваться на .db: {relative!r}")
    full = os.path.join(root, *_safe_relative_path(relative, "база данных"))
    os.makedirs(os.path.dirname(full), exist_ok=True)
    connection = sqlite3.connect(full)
    try:
        connection.executescript(script)
        connection.commit()
    except sqlite3.Error as e:
        raise ValueError(f"SQL-скрипт базы {relative} не выполнился: {e}") from None
    finally:
        connection.close()


def _walk_files(root):
    """Относительные пути всех файлов папки (через «/»), без __pycache__."""
    found = []
    for directory, subdirs, names in os.walk(root):
        subdirs[:] = sorted(name for name in subdirs if name != "__pycache__")
        for name in sorted(names):
            full = os.path.join(directory, name)
            found.append(os.path.relpath(full, root).replace(os.sep, "/"))
    return found


def _read_bytes(path):
    with open(path, "rb") as file:
        return file.read()


def _file_preview(full, relative, status):
    """Файл для «Файлов после запуска»: размер и начало текста (у двоичного файла текста нет)."""
    size = os.path.getsize(full)
    with open(full, "rb") as file:
        # В UTF-8 символ занимает до 4 байт.
        head = file.read(FILE_TEXT_LIMIT * 4 + 4)
    text = None
    if b"\0" not in head:
        try:
            text = head.decode("utf-8")
        except UnicodeDecodeError as e:
            # Начало файла оборвалось посреди символа — это не признак двоичного файла.
            if len(head) < size and e.start >= len(head) - 4:
                text = head[: e.start].decode("utf-8", errors="replace")
    truncated = text is not None and (len(text) > FILE_TEXT_LIMIT or len(head) < size)
    return {
        "path": relative,
        "status": status,
        "size": size,
        "text": text[:FILE_TEXT_LIMIT] if text is not None else None,
        "truncated": truncated,
    }


_MISSING = object()
_SQLITE_TEMP_SUFFIXES = ("-journal", "-wal", "-shm")


class _Workspace:
    def __init__(self, environment, code):
        self.environment = environment
        self.code = code
        filename = environment.get("filename") or USER_FILENAME
        _safe_relative_path(filename, "файл задания")
        self.filename = filename
        self.path = None
        self.program_path = None
        self._snapshot = {}
        self._saved = None

    def open(self):
        self._saved = {
            "cwd": os.getcwd(),
            "bytecode": sys.dont_write_bytecode,
            "modules": {name: sys.modules.get(name, _MISSING) for name in _REQUESTS_MODULES},
        }
        self.path = tempfile.mkdtemp(prefix="praktika-")
        try:
            env = self.environment
            for relative, text in (env.get("files") or {}).items():
                if text is not None:
                    _write_text(self.path, relative, text)
            for relative, script in (env.get("databases") or {}).items():
                if script is not None:
                    _create_database(self.path, relative, script)
            # Код ученика — последним: его не заменит учебный файл с тем же именем.
            self.program_path = _write_text(self.path, self.filename, self.code)
            # Что лежало в папке до запуска — чтобы потом показать созданное и изменённое программой.
            for relative in _walk_files(self.path):
                full = os.path.join(self.path, *relative.split("/"))
                self._snapshot[relative] = _read_bytes(full)
            os.chdir(self.path)
            sys.path.insert(0, self.path)
            # Без .pyc: папка всё равно удаляется, а __pycache__ мешал бы списку изменённых файлов.
            sys.dont_write_bytecode = True
            simulation = _make_requests(env.get("http") or [])
            sys.modules["requests"] = simulation
            sys.modules["requests.exceptions"] = simulation.exceptions
            if env.get("seed") is not None:
                random.seed(env["seed"])
        except BaseException:
            self.close()
            raise

    def changed_files(self):
        """Файлы, которые программа создала или изменила (без удалённых), по алфавиту."""
        changed = []
        if not self.path or not os.path.isdir(self.path):
            return changed
        for relative in _walk_files(self.path):
            # Служебные файлы SQLite (незавершённая транзакция) — не результат программы.
            if relative.endswith(_SQLITE_TEMP_SUFFIXES):
                continue
            full = os.path.join(self.path, *relative.split("/"))
            before = self._snapshot.get(relative)
            try:
                if before is None:
                    status = "created"
                elif os.path.getsize(full) != len(before) or _read_bytes(full) != before:
                    status = "modified"
                else:
                    continue
                changed.append(_file_preview(full, relative, status))
            except OSError:
                continue
            if len(changed) >= CHANGED_FILES_LIMIT:
                break
        return changed

    def close(self):
        saved = self._saved
        if saved is None:
            return
        self._saved = None
        sys.dont_write_bytecode = saved["bytecode"]
        for name, module in saved["modules"].items():
            if module is _MISSING:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module
        try:
            os.chdir(saved["cwd"])
        except OSError:
            pass
        if self.path:
            sys.path[:] = [entry for entry in sys.path if entry != self.path]
            _unload_modules_from(self.path)
            shutil.rmtree(self.path, ignore_errors=True)


def _inside(path, root):
    if not isinstance(path, str) or not path:
        return False
    full = os.path.normcase(os.path.abspath(path))
    base = os.path.normcase(os.path.abspath(root))
    return full == base or full.startswith(base + os.sep)


def _unload_modules_from(root):
    """Выгружает модули, загруженные из папки: следующий запуск импортирует их заново."""
    for name, module in list(sys.modules.items()):
        locations = [getattr(module, "__file__", None)]
        locations.extend(list(getattr(module, "__path__", None) or []))
        if any(_inside(location, root) for location in locations):
            del sys.modules[name]
    for key in list(sys.path_importer_cache):
        if _inside(key, root):
            del sys.path_importer_cache[key]


# ---------------------------------------------------------------- учебная симуляция сети
#
# Учебный модуль requests: тот же интерфейс, что у настоящей библиотеки (get, post, Response,
# raise_for_status, исключения), но ответы берутся из поля http задания или теста. Настоящих
# запросов модуль не делает никогда — и в браузере, и в CPython, даже если там установлен
# настоящий requests. Каждый запуск получает новый модуль с пустым журналом вызовов requests.calls.

_REQUESTS_MODULES = ("requests", "requests.exceptions")
# Параметры настоящего requests, которые учебный модуль принимает и пропускает.
_IGNORED_REQUEST_OPTIONS = {"cookies", "files", "auth", "allow_redirects", "proxies", "verify", "stream", "cert"}


# Имена в harness — с подчёркиванием (чтобы не заслонять встроенный ConnectionError), а ученик
# видит их как в requests: requests.exceptions.ConnectionError.
class _RequestException(IOError):
    """Общая ошибка запроса, как в requests."""

    def __init__(self, *args, response=None, request=None):
        self.response = response
        self.request = request
        super().__init__(*args)


class _HTTPError(_RequestException):
    """Ответ 4xx или 5xx (raise_for_status)."""


class _ConnectionError(_RequestException):
    """Не удалось подключиться — или в симуляции нет ответа для этого адреса."""


class _Timeout(_RequestException):
    """Сервер не ответил за отведённое время."""


class _InvalidURL(_RequestException, ValueError):
    """Неверный адрес."""


class _MissingSchema(_RequestException, ValueError):
    """В адресе нет http:// или https://."""


class _InvalidJSONError(_RequestException):
    """Ответ не удалось разобрать как JSON."""


class _JSONDecodeError(_InvalidJSONError, json.JSONDecodeError):
    """Как в requests: и RequestException, и json.JSONDecodeError (наследник ValueError)."""

    def __init__(self, msg, doc="", pos=0):
        json.JSONDecodeError.__init__(self, msg, doc, pos)
        _InvalidJSONError.__init__(self, self.args[0])

    def __str__(self):
        return str(self.args[0]) if self.args else ""


_REQUEST_ERRORS = {
    "RequestException": _RequestException,
    "HTTPError": _HTTPError,
    "ConnectionError": _ConnectionError,
    "Timeout": _Timeout,
    "InvalidURL": _InvalidURL,
    "MissingSchema": _MissingSchema,
    "InvalidJSONError": _InvalidJSONError,
    "JSONDecodeError": _JSONDecodeError,
}
for _name, _error in _REQUEST_ERRORS.items():
    _error.__name__ = _error.__qualname__ = _name
    _error.__module__ = "requests.exceptions"
del _name, _error


class CaseInsensitiveDict(dict):
    """Заголовки ответа: headers["content-type"] и headers["Content-Type"] — одно и то же."""

    def _key(self, key):
        if isinstance(key, str):
            for existing in dict.keys(self):
                if isinstance(existing, str) and existing.lower() == key.lower():
                    return existing
        return key

    def __getitem__(self, key):
        return dict.__getitem__(self, self._key(key))

    def __setitem__(self, key, value):
        existing = self._key(key)
        if existing != key:
            dict.__delitem__(self, existing)
        dict.__setitem__(self, key, value)

    def __delitem__(self, key):
        dict.__delitem__(self, self._key(key))

    def __contains__(self, key):
        return dict.__contains__(self, self._key(key))

    def get(self, key, default=None):
        return self[key] if key in self else default


CaseInsensitiveDict.__module__ = "requests.structures"


def _reason(status):
    try:
        return HTTPStatus(status).phrase
    except ValueError:
        return ""


class Response:
    """Ответ из записанных заранее: status_code, ok, reason, text, headers, url, json(), raise_for_status()."""

    def __init__(self, route, url):
        self.status_code = int(route.get("status") or 200)
        self.reason = _reason(self.status_code)
        self.url = url
        self.encoding = "utf-8"
        headers = CaseInsensitiveDict()
        if "json" in route:
            self.text = json.dumps(route["json"], ensure_ascii=False)
            headers["Content-Type"] = "application/json"
        elif "text" in route:
            self.text = route["text"]
            headers["Content-Type"] = "text/plain; charset=utf-8"
        else:
            self.text = ""
        for name, value in (route.get("headers") or {}).items():
            headers[name] = str(value)
        self.headers = headers
        self.content = self.text.encode("utf-8")

    @property
    def ok(self):
        return self.status_code < 400

    def json(self, **kwargs):
        try:
            return json.loads(self.text, **kwargs)
        except json.JSONDecodeError as e:
            raise _JSONDecodeError(e.msg, e.doc, e.pos) from None

    def raise_for_status(self):
        if 400 <= self.status_code < 500:
            kind = "Client Error"
        elif 500 <= self.status_code < 600:
            kind = "Server Error"
        else:
            return
        raise _HTTPError(f"{self.status_code} {kind}: {self.reason} for url: {self.url}", response=self)

    def __bool__(self):
        return self.ok

    def __repr__(self):
        return f"<Response [{self.status_code}]>"


Response.__module__ = "requests.models"


def _split_url(url):
    """Адрес без query (схема и сервер — в нижнем регистре, пустой путь — «/») и строка query."""
    parts = urllib.parse.urlsplit(url)
    base = urllib.parse.urlunsplit((parts.scheme.lower(), parts.netloc.lower(), parts.path or "/", "", ""))
    return base, parts.query


def _params_pairs(params):
    """params из вызова — пары (имя, значение) строками, как их отправил бы requests."""
    if params is None:
        return []
    if isinstance(params, (str, bytes)):
        text = params.decode() if isinstance(params, bytes) else params
        return urllib.parse.parse_qsl(text, keep_blank_values=True)
    items = params.items() if isinstance(params, dict) else params
    pairs = []
    for key, value in items:
        for item in value if isinstance(value, (list, tuple)) else [value]:
            if item is None:
                continue
            pairs.append((str(key), item.decode() if isinstance(item, bytes) else str(item)))
    return pairs


def _route_key(method, url, extra_pairs=()):
    """Метод, адрес без query и query-параметры без учёта порядка."""
    base, query = _split_url(url)
    pairs = urllib.parse.parse_qsl(query, keep_blank_values=True) + list(extra_pairs)
    return method.upper(), base, tuple(sorted(pairs))


def _make_requests(routes):
    """Новый учебный модуль requests с ответами routes и пустым журналом calls."""
    table = {_route_key(route.get("method") or "GET", route["url"]): route for route in routes}
    module = types.ModuleType("requests", "Учебная симуляция requests: ответы заранее записаны, настоящих запросов нет.")
    exceptions = types.ModuleType("requests.exceptions")
    calls = []

    def request(method, url, params=None, data=None, json=None, headers=None, timeout=None, **options):  # noqa: A002
        unknown = sorted(set(options) - _IGNORED_REQUEST_OPTIONS)
        if unknown:
            raise TypeError(f"request() got an unexpected keyword argument '{unknown[0]}'")
        method = str(method).upper()
        url = str(url)
        calls.append({
            "method": method,
            "url": url,
            "params": params,
            "json": json,
            "data": data,
            "headers": dict(headers) if isinstance(headers, dict) else headers,
            "timeout": timeout,
        })
        if "://" not in url:
            raise _MissingSchema(f"Invalid URL {url!r}: No scheme supplied. Perhaps you meant https://{url}?")
        pairs = _params_pairs(params)
        full_url = url
        if pairs:
            full_url += ("&" if "?" in url else "?") + urllib.parse.urlencode(pairs)
        # В сообщении — адрес без %-кодов: «city=Казань», а не «city=%D0%9A…».
        shown = f"{method} {urllib.parse.unquote(full_url)}"
        route = table.get(_route_key(method, url, pairs))
        if route is None:
            raise _ConnectionError(f"в учебной симуляции нет ответа для {shown}")
        waited = f" (timeout={timeout})" if timeout is not None else ""
        if route.get("error") == "timeout":
            raise _Timeout(f"учебная симуляция: сервер не ответил вовремя{waited} — {shown}")
        if route.get("error") == "connection":
            raise _ConnectionError(f"учебная симуляция: не удалось подключиться к серверу — {shown}")
        return Response(route, full_url)

    def get(url, params=None, headers=None, timeout=None, data=None, json=None, **options):  # noqa: A002
        return request("GET", url, params=params, data=data, json=json, headers=headers, timeout=timeout, **options)

    def post(url, data=None, json=None, params=None, headers=None, timeout=None, **options):  # noqa: A002
        return request("POST", url, params=params, data=data, json=json, headers=headers, timeout=timeout, **options)

    for name, value in _REQUEST_ERRORS.items():
        setattr(exceptions, name, value)
        setattr(module, name, value)
    module.exceptions = exceptions
    module.request = request
    module.get = get
    module.post = post
    module.Response = Response
    module.calls = calls
    return module


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


def _filename_of(environment):
    return (environment or {}).get("filename") or USER_FILENAME


def run_program(code, stdin_text="", limit=DEFAULT_OUTPUT_LIMIT, environment_json=None):
    """
    Обычный запуск: показать, что выведет программа. environment_json — окружение запуска
    в JSON: {"filename", "files", "databases", "seed", "http"} (всё необязательно).
    """
    environment = json.loads(environment_json) if environment_json else {}
    filename = _filename_of(environment)
    try:
        compiled = _compile(code, filename)
    except SyntaxError as e:
        return json.dumps({"compileError": _describe_syntax_error(e, code, filename)}, ensure_ascii=False)
    outcome = _execute(compiled, code, stdin_text, int(limit), environment=environment)
    outcome.pop("extra", None)
    outcome.pop("extraError", None)
    return json.dumps(outcome, ensure_ascii=False)


def _run_test(compiled, code, test, limit, environment):
    kind = test["kind"]
    result = {"id": test["id"], "kind": kind, "passed": False, "stdin": test.get("stdin", "")}
    stdin = test.get("stdin", "")

    if kind == "io":
        outcome = _execute(compiled, code, stdin, limit, environment=environment)
        result["expected"] = test["expected"]
        if not outcome["error"] and not outcome["limit"]:
            passed, difference = _compare_output(outcome["stdout"], test)
            result["passed"] = passed
            result["diff"] = difference

    elif kind == "call":
        def after(namespace):
            value = eval(compile(test["call"], "<проверка>", "eval", dont_inherit=True), namespace)  # noqa: S307
            return value

        outcome = _execute(compiled, code, stdin, limit, after, environment)
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

        outcome = _execute(compiled, code, stdin, limit, after, environment)
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
    result["files"] = outcome["files"]
    return result


def check_program(payload_json, notify=None):
    """
    Проверка по тестам. payload: {"code", "tests", "rules", "limit"} и окружение задания —
    {"filename", "files", "databases", "seed", "http"}; у теста могут быть свои files, databases,
    seed и http, они дополняют и заменяют поля задания (см. _test_environment).
    """
    payload = json.loads(payload_json)
    code = payload["code"]
    limit = int(payload.get("limit") or DEFAULT_OUTPUT_LIMIT)
    filename = _filename_of(payload)
    try:
        compiled = _compile(code, filename)
    except SyntaxError as e:
        return json.dumps({"compileError": _describe_syntax_error(e, code, filename), "rules": [], "tests": []},
                          ensure_ascii=False)

    rules = _check_rules(code, payload.get("rules") or [])
    tests = []
    for index, test in enumerate(payload.get("tests") or []):
        if notify is not None:
            notify(index)
        tests.append(_run_test(compiled, code, test, limit, _test_environment(payload, test)))
    return json.dumps({"compileError": None, "rules": rules, "tests": tests}, ensure_ascii=False)
