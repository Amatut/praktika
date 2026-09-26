// Основной сценарий с клавиатуры: дойти до урока, открыть задание, написать код и проверить.
import { expect, test } from '@playwright/test';

test('урок проходится с клавиатуры', async ({ page }) => {
  await page.goto('/');
  // Переходим к кнопке «Начать урок» клавишей Tab.
  let found = false;
  for (let i = 0; i < 40 && !found; i += 1) {
    await page.keyboard.press('Tab');
    found = await page.evaluate(() => document.activeElement?.textContent?.includes('Начать урок') ?? false);
  }
  expect(found).toBe(true);
  // Фокус виден.
  const outline = await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle);
  expect(outline).not.toBe('none');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Программа — это точная инструкция');

  // До шага «Практика 1» — через шаги урока.
  await page.getByRole('button', { name: /^Практика 1/ }).focus();
  await page.keyboard.press('Enter');
  const editor = page.locator('.cm-content');
  await editor.focus();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('print("Привет, Практика!');
  await page.keyboard.press('Control+Enter');
  await expect(page.getByText('Все проверки пройдены: 1 из 1')).toBeVisible({ timeout: 90_000 });

  // Выход из редактора: Esc, затем Tab переводит фокус дальше, а не вставляет отступ.
  await editor.focus();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Tab');
  const inEditor = await page.evaluate(() => document.activeElement?.classList.contains('cm-content'));
  expect(inEditor).toBe(false);
});
