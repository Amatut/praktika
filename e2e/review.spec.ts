// Повторение: задание, решённое после просмотра решения, возвращается через день;
// повторное самостоятельное решение засчитывается и переносит следующее повторение.
import { expect, test } from '@playwright/test';
import { check, openExercise, setCode } from './helpers.ts';

test('задание после подсмотренного решения возвращается на повторение и засчитывается', async ({ page }) => {
  const start = new Date('2026-09-26T10:00:00');
  // Подменяем только время (Date), таймеры страницы работают как обычно.
  await page.clock.setFixedTime(start);

  await openExercise(page, 'm0-l1', 6);
  await page.locator('.coach').getByRole('button', { name: 'Показать решение' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Показать', exact: true }).click();
  await setCode(page, 'print("Привет, Практика!")');
  await check(page);
  await expect(page.getByText('Все проверки пройдены: 1 из 1')).toBeVisible();

  // Сегодня повторять ещё рано — показана дата.
  await page.goto('/#/');
  await expect(page.getByText(/Ближайшее повторение/)).toBeVisible();

  // Через два дня задание в списке «На повторение».
  await page.clock.setFixedTime(new Date(start.getTime() + 2 * 24 * 3600 * 1000));
  await page.reload();
  const item = page.getByRole('link', { name: /Первое приветствие/ });
  await expect(item).toBeVisible();
  await expect(item).toContainText('Решено после просмотра решения');
  await item.click();

  await expect(page.getByText('Пора повторить')).toBeVisible();
  await page.getByRole('button', { name: 'Решить заново' }).click();
  await expect(page.locator('.cm-content')).not.toContainText('Привет, Практика');
  await setCode(page, 'print("Привет, Практика!")');
  await check(page);
  await expect(page.getByText(/Повторение засчитано/)).toBeVisible();

  // Повторение больше не «на сегодня».
  await page.goto('/#/');
  await expect(page.getByRole('link', { name: /Первое приветствие/ })).toHaveCount(0);
});
