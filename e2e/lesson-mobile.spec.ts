// Урок на телефоне: пример читается одной колонкой, длинные надписи кнопок переносятся,
// «Назад / Далее» стоят после наставника, а фокус после «Разбор у наставника» — на разборе.
import { expect, test, type Page } from '@playwright/test';
import { check, setCode } from './helpers.ts';

async function noHorizontalOverflow(page: Page) {
  const width = page.viewportSize()!.width;
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
}

test('пример на телефоне: пояснения, код и «Запустить» — одной колонкой', async ({ page }) => {
  await page.goto('/#/lesson/m0-l1/4');
  await expect(page.locator('.cm-content')).toBeVisible();
  await expect(page.locator('.pane-tabs')).toHaveCount(0);
  const tops = await page.evaluate(() => ({
    notes: document.querySelector('.notes-list')!.getBoundingClientRect().top,
    editor: document.querySelector('.cm-editor')!.getBoundingClientRect().top,
  }));
  expect(tops.notes).toBeLessThan(tops.editor);
  await expect(page.getByRole('button', { name: 'Запустить', exact: true })).toBeVisible();
  // Пояснение подсвечивает свою строку в редакторе.
  await page.locator('.note-btn').first().click();
  await expect(page.locator('.cm-note-line')).toHaveCount(1);
  await noHorizontalOverflow(page);
});

test('задание на телефоне: разбор у наставника, фокус и переход между шагами', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 760 });
  await page.goto('/#/lesson/m0-l1/7');
  await page.locator('.pane-tabs').getByRole('tab', { name: 'Код' }).click();
  await setCode(page, 'print("Меню дня")');
  await check(page);
  const jump = page.getByRole('button', { name: /Разбор у наставника/ });
  await expect(jump).toBeVisible();
  // Длинный заголовок разбора переносится, а не обрезается.
  expect(await jump.evaluate((button) => button.scrollWidth <= button.clientWidth + 1)).toBe(true);
  await noHorizontalOverflow(page);
  await jump.click();
  await expect(page.locator('.coach .feedback')).toBeFocused();
  const layout = await page.evaluate(() => {
    const coach = document.querySelector('.coach')!.getBoundingClientRect();
    const back = document.querySelector('.step-nav-back')!.getBoundingClientRect();
    const next = document.querySelector('.step-nav-next')!.getBoundingClientRect();
    return { afterCoach: back.top >= coach.bottom, sameRow: Math.abs(back.top - next.top) < 2 };
  });
  expect(layout).toEqual({ afterCoach: true, sameRow: true });
});
