// Клавиатура для групп с одним выбранным элементом (role="radiogroup" и role="tablist"):
// в группе одна остановка Tab, стрелки, Home и End переводят фокус между кнопками.

import type { KeyboardEvent } from 'react';

/** Номер кнопки, на которую переходит фокус, или null, если клавиша не для перехода. По краям — по кругу. */
export function rovingTarget(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return (index + 1) % count;
    case 'ArrowLeft':
    case 'ArrowUp':
      return (index - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

/** tabIndex кнопки группы: в Tab попадает выбранная кнопка, а если выбора ещё нет — первая. */
export function rovingTabIndex(selected: boolean, index: number, hasSelection: boolean): 0 | -1 {
  return selected || (!hasSelection && index === 0) ? 0 : -1;
}

/**
 * onKeyDown для контейнера группы. select — нажать кнопку, на которую перешёл фокус
 * (как у обычных радиокнопок и вкладок). Без select стрелки только переводят фокус,
 * а выбор — пробелом или Enter: так делают группы, где выбор что-то сохраняет.
 */
export function rovingKeyDown(event: KeyboardEvent<HTMLElement>, { select = true }: { select?: boolean } = {}) {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const items = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]:not(:disabled), [role="tab"]:not(:disabled)'),
  );
  const index = items.indexOf(event.target as HTMLButtonElement);
  if (index < 0) return;
  const target = rovingTarget(event.key, index, items.length);
  if (target === null) return;
  event.preventDefault();
  items[target].focus();
  if (select) items[target].click();
}
