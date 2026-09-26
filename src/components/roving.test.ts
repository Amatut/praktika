import { describe, expect, it } from 'vitest';
import { rovingTabIndex, rovingTarget } from './roving.ts';

describe('клавиатура в группах вариантов и вкладок', () => {
  it('стрелки переводят фокус по кругу, Home и End — к краям', () => {
    expect(rovingTarget('ArrowDown', 0, 3)).toBe(1);
    expect(rovingTarget('ArrowRight', 2, 3)).toBe(0);
    expect(rovingTarget('ArrowUp', 0, 3)).toBe(2);
    expect(rovingTarget('ArrowLeft', 1, 3)).toBe(0);
    expect(rovingTarget('Home', 2, 3)).toBe(0);
    expect(rovingTarget('End', 0, 3)).toBe(2);
  });

  it('другие клавиши и пустая группа не переводят фокус', () => {
    expect(rovingTarget('Tab', 0, 3)).toBeNull();
    expect(rovingTarget('Enter', 0, 3)).toBeNull();
    expect(rovingTarget('ArrowDown', 0, 0)).toBeNull();
  });

  it('в Tab попадает выбранная кнопка, без выбора — первая', () => {
    expect([rovingTabIndex(false, 0, true), rovingTabIndex(true, 1, true), rovingTabIndex(false, 2, true)]).toEqual([-1, 0, -1]);
    expect([rovingTabIndex(false, 0, false), rovingTabIndex(false, 1, false)]).toEqual([0, -1]);
  });
});
