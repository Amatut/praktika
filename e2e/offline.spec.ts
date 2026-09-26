// Работа без сети: после скачивания Python и модуля урок открывается и проверяется офлайн.
import { expect, test } from '@playwright/test';
import { check, openExercise, setCode } from './helpers.ts';

test('после подготовки кеша упражнение проходит проверку без сети', async ({ page, context }) => {
  await page.goto('/');
  // Дожидаемся, пока service worker возьмёт страницу под управление.
  await page.waitForFunction(async () => {
    await navigator.serviceWorker.ready;
    return Boolean(navigator.serviceWorker.controller);
  }, undefined, { timeout: 60_000 });

  await page.goto('/#/settings/offline');
  const offline = page.locator('#settings-offline');
  const pythonRow = offline.locator('.bundle-row').first();
  const download = pythonRow.getByRole('button', { name: /Скачать/ });
  // Раздел сначала проверяет, что уже лежит в кеше, — ждём кнопку или отметку «Скачан».
  await download.or(pythonRow.getByText('Скачан')).first().waitFor({ timeout: 30_000 });
  if (await download.isVisible()) await download.click();
  await expect(pythonRow.getByText('Скачан')).toBeVisible({ timeout: 120_000 });

  const moduleRow = offline.locator('.bundle-row').nth(1);
  const moduleDownload = moduleRow.getByRole('button', { name: /Скачать модуль/ });
  await moduleDownload.or(moduleRow.getByText('Доступен без сети')).first().waitFor({ timeout: 30_000 });
  if (await moduleDownload.isVisible()) await moduleDownload.click();
  await expect(moduleRow.getByText('Доступен без сети')).toBeVisible({ timeout: 60_000 });

  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('.bottombar, .sidebar').first()).toBeAttached();
  await openExercise(page, 'm0-l1', 6);
  await setCode(page, 'print("Привет, Практика!")');
  await check(page);
  await expect(page.getByText('Все проверки пройдены: 1 из 1')).toBeVisible();

  // Облачный наставник без сети честно недоступен, подсказки курса работают.
  await expect(page.locator('.coach-mode')).toHaveText('Подсказки курса');
  await context.setOffline(false);
});
