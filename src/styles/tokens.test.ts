// Контраст пар токенов из tokens.css в обеих темах: текст — не ниже 4.5:1 (WCAG 1.4.3),
// границы полей ввода, кружки вариантов и акцент выбранного элемента — не ниже 3:1 (WCAG 1.4.11).
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

const TEXT_PAIRS: [string, string][] = [
  ...['text', 'muted', 'accent-text', 'good', 'error', 'warn'].flatMap((fg): [string, string][] =>
    ['surface', 'surface-2', 'bg'].map((bg): [string, string] => [fg, bg]),
  ),
  ['accent-text', 'accent-soft'],
  ['good', 'good-soft'],
  ['error', 'error-soft'],
  ['warn', 'warn-soft'],
  ['on-accent', 'accent'],
  ['text', 'surface-hover'],
];

const CONTROL_PAIRS: [string, string][] = [
  ['border-control', 'surface'],
  ['border-control', 'surface-2'],
  ['border-control', 'bg'],
  ['accent', 'surface'],
];

describe.each([
  ['светлая', light],
  ['тёмная', dark],
])('тема %s', (_name, theme) => {
  it.each(TEXT_PAIRS)('текст --%s на --%s — не ниже 4.5:1', (fg, bg) => {
    expect(theme[fg], fg).toBeDefined();
    expect(theme[bg], bg).toBeDefined();
    expect(contrast(theme[fg], theme[bg])).toBeGreaterThanOrEqual(4.5);
  });

  it.each(CONTROL_PAIRS)('граница --%s на --%s — не ниже 3:1', (fg, bg) => {
    expect(theme[fg], fg).toBeDefined();
    expect(contrast(theme[fg], theme[bg])).toBeGreaterThanOrEqual(3);
  });
});

it('тёмная тема одинакова для системной настройки и явного выбора', () => {
  expect(darkMedia).toEqual(tokens(":root[data-theme='dark']"));
});
