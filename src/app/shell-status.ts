// Данные экрана для строки состояния и заголовка окна: счётчик проверки, курсор в редакторе,
// статус черновика, время урока. Экран публикует их хуком useShellStatus, оболочка читает useShellStatusValue.
// При размонтировании экрана его данные исчезают сами.

import { useEffect, useRef, useSyncExternalStore } from 'react';

export interface ShellStatus {
  /** Счётчик последней проверки в уроке: кнопка «✕ 3 ✓ 1», открывает «Проверку». */
  tests?: { failed: number; passed: number; open: () => void } | null;
  /** Курсор в редакторе: «main.py:4». */
  cursor?: { file: string; line: number } | null;
  /** Черновик: 'saving' → «Сохраняю…», 'saved' → «Черновик сохранён», 'failed' → «Не сохранено». */
  save?: 'saving' | 'saved' | 'failed' | null;
  /** Время урока, [20, 30]. */
  minutes?: [number, number] | null;
}

const EMPTY: ShellStatus = {};

/** Данные каждого экрана, опубликовавшего статус, по порядку публикации: у поздних приоритет. */
const sources = new Map<symbol, ShellStatus>();
let snapshot: ShellStatus = EMPTY;
const listeners = new Set<() => void>();

function recompute() {
  snapshot = sources.size === 0 ? EMPTY : Object.assign({}, ...sources.values()) as ShellStatus;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Экран публикует свой статус; при размонтировании он очищается. */
export function useShellStatus(status: ShellStatus): void {
  const key = useRef<symbol>(null);
  key.current ??= Symbol('shell-status');
  // Функция open меняется на каждой отрисовке — строка состояния вызывает всегда последнюю.
  const open = useRef<(() => void) | null>(null);
  open.current = status.tests?.open ?? null;

  const failed = status.tests ? status.tests.failed : null;
  const passed = status.tests ? status.tests.passed : null;
  const file = status.cursor?.file ?? null;
  const line = status.cursor?.line ?? null;
  const save = status.save ?? null;
  const from = status.minutes?.[0] ?? null;
  const to = status.minutes?.[1] ?? null;

  useEffect(() => {
    const id = key.current!;
    sources.set(id, {
      tests: failed === null || passed === null ? null : { failed, passed, open: () => open.current?.() },
      cursor: file === null || line === null ? null : { file, line },
      save,
      minutes: from === null || to === null ? null : [from, to],
    });
    recompute();
  }, [failed, passed, file, line, save, from, to]);

  useEffect(
    () => () => {
      if (key.current && sources.delete(key.current)) recompute();
    },
    [],
  );
}

export function useShellStatusValue(): ShellStatus {
  return useSyncExternalStore(subscribe, () => snapshot, () => EMPTY);
}
