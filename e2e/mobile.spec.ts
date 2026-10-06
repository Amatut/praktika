// Телефон: вкладки «Задание / Код / Наставник», содержимое сохраняется между вкладками,
// кнопки не перекрываются, нет горизонтальной прокрутки.
import { expect, test, type Page } from '@playwright/test';
import { check, setCode } from './helpers.ts';

async function noHorizontalOverflow(page: Page) {
  // На телефоне браузер расширяет страницу под самый широкий элемент, поэтому сравниваем
  // с заданной шириной экрана, а не с clientWidth.
  const width = page.viewportSize()!.width;
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(width);
}

test('урок на телефоне: вкладки и проверка кода', async ({ page }) => {
  await page.goto('/#/lesson/m0-l1/6');
  const tabs = page.locator('.pane-tabs');
  await expect(tabs).toBeVisible();
  await tabs.getByRole('tab', { name: 'Код' }).click();
  await setCode(page, 'print("Привет, мир!")');
  await check(page);
  await expect(page.getByRole('button', { name: /Разбор у наставника/ })).toBeVisible();
  await page.getByRole('button', { name: /Разбор у наставника/ }).click();
  await expect(page.locator('.coach .feedback')).toBeVisible();
  // Код не потерялся при переключении вкладок.
  await tabs.getByRole('tab', { name: 'Код' }).click();
  await expect(page.locator('.cm-content')).toContainText('Привет, мир!');
  await noHorizontalOverflow(page);

  // Кнопки действий не перекрывают друг друга.
  const boxes = await page.locator('.wb-actions .btn').evaluateAll((buttons) =>
    buttons.map((button) => {
      const rect = button.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    }),
  );
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i];
      const b = boxes[j];
      const overlap = a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
      expect(overlap).toBe(false);
    }
  }
});

for (const width of [390, 320]) {
  test(`основные экраны без горизонтальной прокрутки на ширине ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 760 });
    for (const hash of ['#/', '#/course', '#/course/m0', '#/lesson/m0-l1/0', '#/lesson/m0-l1/6', '#/directions/web', '#/projects', '#/progress', '#/settings']) {
      await page.goto(`/${hash}`);
      await page.waitForTimeout(300);
      await noHorizontalOverflow(page);
    }
  });
}
