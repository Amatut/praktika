// Контраст пар токенов из tokens.css в обеих темах — правило «текст не сливается с фоном»:
// основной текст ≥ 10:1, вторичный ≥ 7:1, третичный (номера строк, короткие метки) ≥ 4.5:1,
// цветные статусы и текст на цветных подложках ≥ 6:1, подсветка кода ≥ 6:1, комментарии в коде ≥ 4.5:1,
// не-текст (рамки контролов, кольцо фокуса, каретка) ≥ 3:1 (WCAG 1.4.11). Формула — WCAG 2.x.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');

/** Цветовые токены (#rrggbb) из первого блока, который начинается с selector. */
function tokens(selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`Нет блока ${selector}`);
  const open = css.indexOf('{', start);
  const body = css.slice(open + 1, css.indexOf('}', open));
  const result: Record<string, string> = {};
  for (const match of body.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)) result[match[1]] = match[2].toLowerCase();
  return result;
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255);
  const [r, g, b] = channels.map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

const light = tokens(':root {');
const darkMedia = tokens(":root:not([data-theme='light'])");
const dark = { ...light, ...tokens(":root[data-theme='dark']") };

/** Нейтральные фоны, на которых стоит текст интерфейса. */
const SURFACES = ['bg-chrome', 'bg-panel', 'bg-editor', 'bg-raised', 'bg-sunken', 'bg-line'];
/** Код никогда не стоит на --bg-chrome (заголовок окна, полосы) — эти пары не проверяются. */
const CODE_SURFACES = ['bg-panel', 'bg-editor', 'bg-raised', 'bg-sunken', 'bg-line', 'err-line-bg'];

type Pair = [fg: string, bg: string, min: number];

const PAIRS: Pair[] = [
  // Текст интерфейса и цветные статусы на нейтральных фонах
  ...SURFACES.flatMap((bg): Pair[] => [
    ['text', bg, 10],
    ['text-2', bg, 7],
    ['text-3', bg, 4.5],
    ['err', bg, 6],
    ['ok', bg, 6],
    ['warn', bg, 6],
    ['accent-text', bg, 6],
  ]),
  // Подсветка кода
  ...CODE_SURFACES.flatMap((bg): Pair[] => [
    ['syn-fn', bg, 6],
    ['syn-str', bg, 6],
    ['syn-num', bg, 6],
    ['syn-kw', bg, 6],
    ['syn-op', bg, 6],
    ['syn-com', bg, 4.5],
    ['text', bg, 10],
  ]),
  // Цветные подложки: тон подложки и обычный текст на ней
  ['accent-ink', 'accent', 7],
  ['accent-ink', 'accent-hover', 7],
  ['err', 'err-soft', 6],
  ['ok', 'ok-soft', 6],
  ['warn', 'warn-soft', 6],
  ['accent-text', 'accent-soft', 6],
  ['text', 'accent-soft', 10],
  ['text', 'err-soft', 10],
  ['text', 'ok-soft', 10],
  ['text', 'warn-soft', 10],
  ['text-2', 'accent-soft', 7],
  ['text-2', 'err-soft', 7],
  ['text-2', 'ok-soft', 7],
  ['text-2', 'warn-soft', 7],
  ['text', 'selection', 7],
];

/** Не-текст: рамки контролов и узлов, кольцо фокуса, каретка и черта активного — ≥ 3:1 к любому фону. */
const NON_TEXT: Pair[] = SURFACES.flatMap((bg): Pair[] => [
  ['line-control', bg, 3],
  ['focus', bg, 3],
  ['accent-edge', bg, 3],
]);

describe.each([
  ['светлая', light],
  ['тёмная', dark],
])('тема %s', (_name, theme) => {
  it.each(PAIRS)('текст --%s на --%s — не ниже %s:1', (fg, bg, min) => {
    expect(theme[fg], fg).toBeDefined();
    expect(theme[bg], bg).toBeDefined();
    expect(contrast(theme[fg], theme[bg])).toBeGreaterThanOrEqual(min);
  });

  it.each(NON_TEXT)('--%s на --%s — не ниже %s:1', (fg, bg, min) => {
    expect(theme[fg], fg).toBeDefined();
    expect(theme[bg], bg).toBeDefined();
    expect(contrast(theme[fg], theme[bg])).toBeGreaterThanOrEqual(min);
  });

  it('поверхности различимы: хром, панель и редактор — разные цвета', () => {
    const surfaces = new Set(['bg-chrome', 'bg-panel', 'bg-editor', 'bg-sunken'].map((name) => theme[name]));
    expect(surfaces.size).toBe(4);
  });
});

it('тёмная тема одинакова для системной настройки и явного выбора', () => {
  expect(darkMedia).toEqual(tokens(":root[data-theme='dark']"));
  expect(Object.keys(darkMedia).length).toBeGreaterThan(30);
});

it('у каждого цветового токена дневной темы есть значение в тёмной', () => {
  const missing = Object.keys(light).filter((name) => !(name in darkMedia));
  expect(missing).toEqual([]);
});
