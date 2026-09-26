// Состояние шагов урока: ответы не теряются и не пересдаются после перезагрузки, показанный ответ
// не выдаётся за решение, повторение не затирает сохранённый код, фокус не падает на страницу.
import { expect, test, type Page } from '@playwright/test';
import { check, editorText, openExercise, setCode } from './helpers.ts';

/** Прочитать запись из IndexedDB приложения. */
function idbGet<T>(page: Page, store: string, key: string): Promise<T | null> {
  return page.evaluate(
    ([store, key]) =>
      new Promise<T | null>((resolve, reject) => {
        const open = indexedDB.open('praktika');
        open.onsuccess = () => {
          const request = open.result.transaction(store).objectStore(store).get(key);
          request.onsuccess = () => {
            resolve((request.result as T | undefined) ?? null);
            open.result.close();
          };
          request.onerror = () => reject(request.error);
        };
        open.onerror = () => reject(open.error);
      }),
    [store, key],
  );
}

test('итог и вопрос: после перезагрузки ответ на месте, пустое поле его не затирает', async ({ page }) => {
  await page.goto('/#/lesson/m0-l1/9');
  const answer = page.locator('.step-card textarea').first();
  await answer.fill('Сверху вниз');
  await page.locator('.step-title').click();
  await expect.poll(async () => (await idbGet<{ recap: { answer: string } | null }>(page, 'lessons', 'm0-l1'))?.recap?.answer).toBe('Сверху вниз');

  await page.reload();
  await expect(page.locator('.step-card textarea').first()).toHaveValue('Сверху вниз');
  await page.locator('.step-card textarea').first().focus();
  await page.locator('.step-title').click();
  await page.waitForTimeout(300);
  expect((await idbGet<{ recap: { answer: string } | null }>(page, 'lessons', 'm0-l1'))?.recap?.answer).toBe('Сверху вниз');

  // Вопрос: ответ сохраняется, после перезагрузки ответить заново нельзя; фокус — на результат.
  await page.goto('/#/lesson/m0-l1/2');
  await page.getByRole('radio').first().click();
  await page.getByRole('button', { name: 'Ответить' }).click();
  await expect(page.locator('.step-result')).toBeFocused();
  await page.reload();
  await expect(page.getByRole('radio').first()).toBeDisabled();
});

test('стрелки выбирают вариант, «Далее» переносит фокус на заголовок шага', async ({ page }) => {
  await page.goto('/#/lesson/m0-l1/2');
  const radios = page.getByRole('radio');
  await radios.first().focus();
  await page.keyboard.press('ArrowDown');
  await expect(radios.nth(1)).toHaveAttribute('aria-checked', 'true');
  await expect(radios.nth(1)).toBeFocused();

  await page.getByRole('button', { name: /Далее/ }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.lesson-main h2').first()).toBeFocused();
});

test('показанный порядок — не решение: нет «Порядок верный» и отметки шага', async ({ page }) => {
  await page.goto('/#/lesson/m0-l1/1');
  const checkOrder = page.getByRole('button', { name: 'Проверить порядок' });
  await checkOrder.click();
  // Верно или нет — видно словом, а не только цветом.
  await expect(page.locator('.order-item .verdict').first()).toBeVisible();
  await checkOrder.click();
  await page.getByRole('button', { name: 'Показать ответ' }).click();
  await expect(page.getByText('Ответ показан')).toBeVisible();
  await expect(page.getByText('Порядок верный')).toHaveCount(0);
  await expect(page.locator('.step-chip').nth(1)).not.toHaveAttribute('data-state', 'done');
  const record = await idbGet<{ orders: Record<string, { solved: boolean }> }>(page, 'lessons', 'm0-l1');
  expect(Object.values(record?.orders ?? {}).every((order) => !order.solved)).toBe(true);
  await page.getByRole('button', { name: 'Собрать заново' }).click();
  await expect(checkOrder).toBeFocused();
});

test('подстановка черновика не считается правкой, Ctrl+Z не возвращает стартовый код', async ({ page }) => {
  await openExercise(page, 'm0-l1', 7);
  await setCode(page, 'print("черновик")');
  await expect.poll(async () => (await idbGet<{ draft: string }>(page, 'exercises', 'm0-l1-e2'))?.draft).toBe('print("черновик")');
  const saved = await idbGet<{ draftUpdatedAt: number }>(page, 'exercises', 'm0-l1-e2');

  await page.goto('/#/lesson/m0-l1/0');
  await openExercise(page, 'm0-l1', 7);
  await expect.poll(() => editorText(page)).toContain('черновик');
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(800);
  expect(await editorText(page)).toContain('черновик');
  const after = await idbGet<{ draftUpdatedAt: number }>(page, 'exercises', 'm0-l1-e2');
  expect(after?.draftUpdatedAt).toBe(saved?.draftUpdatedAt);
});

test('«Решить заново» не затирает сохранённое решение', async ({ page }) => {
  const start = new Date('2026-09-26T10:00:00');
  await page.clock.setFixedTime(start);
  await openExercise(page, 'm0-l1', 6);
  await page.locator('.coach').getByRole('button', { name: 'Показать решение' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Показать', exact: true }).click();
  await setCode(page, 'print("Привет, Практика!")');
  await check(page);
  await expect(page.getByText('Все проверки пройдены: 1 из 1')).toBeVisible();

  await page.clock.setFixedTime(new Date(start.getTime() + 2 * 24 * 3600 * 1000));
  await page.reload();
  await page.getByRole('button', { name: 'Решить заново' }).click();
  await expect.poll(() => editorText(page)).not.toContain('Привет, Практика');
  await setCode(page, 'print(1)');
  await page.waitForTimeout(800);
  await page.reload();
  await expect.poll(() => editorText(page)).toContain('Привет, Практика!');
});
