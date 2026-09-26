// Поток с Python и данные приложения: код ученика не видит хранилища и сеть,
// а «Остановить», пока Python ещё загружается, отменяет проверку.
import { expect, test } from '@playwright/test';
import { check, openExercise, setCode } from './helpers.ts';

const HELLO = 6; // шаг «Практика 1» урока 0.1 (0 — история)

// Перехват загрузки Python (второй тест) не видит запросы, которые обслуживает service worker.
test.use({ serviceWorkers: 'block' });

test('код ученика не видит IndexedDB, Cache Storage и сеть приложения', async ({ page }) => {
  await openExercise(page, 'm0-l1', HELLO);
  await setCode(
    page,
    [
      'import importlib',
      'js = importlib.import_module("js")',
      'print("хранилища:", hasattr(js, "indexedDB"), hasattr(js, "caches"))',
      'print("сеть:", hasattr(js, "fetch"), hasattr(js, "XMLHttpRequest"), hasattr(js, "Worker"))',
      'print("через Function:", js.Function("return typeof indexedDB")())',
    ].join('\n'),
  );
  await page.getByRole('button', { name: 'Запустить', exact: true }).click();
  const output = page.locator('.console');
  await expect(output).toContainText('хранилища: False False', { timeout: 90_000 });
  await expect(output).toContainText('сеть: False False False');
  await expect(output).toContainText('через Function: undefined');
});

test('«Остановить», пока Python загружается, отменяет проверку, и следующая проверка работает', async ({ context, page }) => {
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Держим загрузку Python, пока не нажата «Остановить».
  await context.route('**/pyodide/pyodide.asm.wasm', async (route) => {
    await released;
    await route.continue();
  });
  await openExercise(page, 'm0-l1', HELLO);
  await setCode(page, 'print("Привет, Практика!")');
  await page.getByRole('button', { name: 'Проверить', exact: true }).click();
  await page.getByRole('button', { name: 'Остановить' }).click();
  await expect(page.getByRole('tabpanel').getByText('Проверка остановлена.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Проверить', exact: true })).toBeEnabled();

  release();
  await check(page);
  await expect(page.getByText('Все проверки пройдены: 1 из 1')).toBeVisible();
});
