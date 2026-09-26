"""Быстрая проверка заданий на обычном Python (CPython) той же обвязкой harness.py.

Запуск (сначала node scripts/build-content.ts):
    python scripts/quick-check.py m0-l2 m0-l3      # отдельные уроки
    python scripts/quick-check.py m1               # весь модуль
    python scripts/quick-check.py                  # все готовые уроки

Проверяет: эталон и другие верные решения (altSolutions) проходят все тесты и правила,
стартовый код не проходит, каждое неверное решение проваливает хотя бы одну проверку, прогнозы совпадают
с настоящим выводом, примеры выполняются без ошибок.
Главная проверка материалов — npm run verify:content (настоящий Pyodide);
этот скрипт нужен для быстрой самопроверки при написании уроков.
"""

import json
import multiprocessing as mp
import runpy
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HARNESS = ROOT / "src" / "runner" / "harness.py"
TIMEOUT = 8


def _worker(kind, payload, queue):
    harness = runpy.run_path(str(HARNESS))
    if kind == "check":
        queue.put(harness["check_program"](json.dumps(payload)))
    else:
        queue.put(harness["run_program"](payload["code"], payload.get("stdin", "")))


def execute(kind, payload):
    queue = mp.Queue()
    process = mp.Process(target=_worker, args=(kind, payload, queue))
    process.start()
    process.join(TIMEOUT)
    if process.is_alive():
        process.terminate()
        process.join()
        return None
    return json.loads(queue.get()) if not queue.empty() else None


def passed(result):
    if result is None or result.get("compileError"):
        return False
    return all(rule["passed"] for rule in result["rules"]) and all(test["passed"] for test in result["tests"])


def describe(result):
    if result is None:
        return "не завершилось за {} с".format(TIMEOUT)
    if result.get("compileError"):
        return "ошибка компиляции: " + result["compileError"]["summary"]
    parts = []
    for rule in result["rules"]:
        if not rule["passed"]:
            parts.append("правило {}".format(rule["id"]))
    for test in result["tests"]:
        if not test["passed"]:
            detail = test["error"]["summary"] if test.get("error") else (
                "вывод {!r}".format(test.get("output", "")[:120]) if test["kind"] == "io"
                else "получено {}".format(test.get("actual"))
            )
            parts.append("тест {}: {}".format(test["id"], detail))
    return "; ".join(parts) or "всё прошло"


def normalize(text):
    lines = [line.rstrip() for line in text.replace("\r\n", "\n").split("\n")]
    while lines and lines[-1] == "":
        lines.pop()
    while lines and lines[0] == "":
        lines.pop(0)
    return "\n".join(lines)


def main():
    course = json.loads((ROOT / "public" / "content" / "course.json").read_text(encoding="utf-8"))
    wanted = set(sys.argv[1:])
    problems = 0
    checked = 0
    for module in course["modules"]:
        if not module.get("file"):
            continue
        data = json.loads((ROOT / "public" / module["file"]).read_text(encoding="utf-8"))
        for lesson in data["lessons"]:
            if wanted and lesson["id"] not in wanted and module["id"] not in wanted:
                continue
            print("\n== {} {}".format(lesson["id"], lesson["title"]))
            for step in lesson["steps"]:
                if step["type"] == "exercise":
                    exercise = step["exercise"]
                    base = {"tests": exercise["tests"], "rules": exercise.get("rules", [])}
                    checked += 1
                    solution = execute("check", dict(base, code=exercise["solution"]["code"]))
                    if not passed(solution):
                        problems += 1
                        print("  ✗ {}: эталон НЕ проходит — {}".format(exercise["id"], describe(solution)))
                    else:
                        print("  ✓ {}: эталон проходит ({} тестов)".format(exercise["id"], len(exercise["tests"])))
                    starter = execute("check", dict(base, code=exercise["starterCode"]))
                    if passed(starter):
                        problems += 1
                        print("  ✗ {}: стартовый код уже проходит все тесты".format(exercise["id"]))
                    for index, alt in enumerate(exercise.get("altSolutions") or [], 1):
                        result = execute("check", dict(base, code=alt["code"]))
                        if not passed(result):
                            problems += 1
                            print("  ✗ {}: другое верное решение {} ({}) НЕ проходит — {}".format(exercise["id"], index, alt["note"], describe(result)))
                    for index, wrong in enumerate(exercise["wrongSolutions"], 1):
                        result = execute("check", dict(base, code=wrong["code"]))
                        if passed(result):
                            problems += 1
                            print("  ✗ {}: неверное решение {} ({}) проходит проверку".format(exercise["id"], index, wrong["note"]))
                        else:
                            print("    · неверное {} ({}): {}".format(index, wrong["note"], describe(result)))
                elif step["type"] == "predict":
                    result = execute("run", {"code": step["code"], "stdin": step.get("stdin", "")})
                    if result is None:
                        problems += 1
                        print("  ✗ прогноз {}: код не завершился".format(step["id"]))
                    elif not step.get("answerIsNotOutput"):
                        actual = normalize(result.get("stdout", ""))
                        if actual != normalize(step["answer"]):
                            problems += 1
                            print("  ✗ прогноз {}: ответ {!r}, настоящий вывод {!r}".format(step["id"], step["answer"], actual))
                        else:
                            print("  ✓ прогноз {} совпадает с выводом".format(step["id"]))
                    else:
                        error = (result.get("compileError") or result.get("error") or {}).get("summary")
                        print("  · прогноз {} (не вывод): {}".format(step["id"], error or normalize(result.get("stdout", ""))))
                elif step["type"] == "example":
                    result = execute("run", {"code": step["code"], "stdin": step.get("stdin", "")})
                    if result is None or result.get("compileError") or result.get("error"):
                        problems += 1
                        print("  ✗ пример {} падает: {}".format(step["id"], describe(result) if result and result.get("compileError") else (result or {}).get("error")))
                    else:
                        print("  ✓ пример {} выполняется".format(step["id"]))
    print("\nЗаданий проверено: {}. Проблем: {}.".format(checked, problems))
    sys.exit(1 if problems else 0)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
