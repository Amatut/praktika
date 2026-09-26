import { expect, type Page } from '@playwright/test';

/** Заменить весь код в редакторе. */
export async function setCode(page: Page, code: string) {
  const editor = page.locator('.cm-content').first();
  await editor.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  // Вставка через буфер обмена не зависит от автозакрытия скобок и автоотступов.
  await editor.evaluate((element, text) => {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, code);
  await expect.poll(async () => (await editorText(page)).trim()).toBe(code.trim());
}

export async function editorText(page: Page): Promise<string> {
  return page.locator('.cm-line').evaluateAll((lines) => lines.map((line) => line.textContent ?? '').join('\n'));
}

/** Нажать «Проверить» и дождаться результата (первый запуск загружает Python). */
export async function check(page: Page) {
  await page.getByRole('button', { name: 'Проверить', exact: true }).click();
  await expect(page.locator('.results-summary, .results-body .status-line').first()).toBeVisible({ timeout: 90_000 });
}

export async function openExercise(page: Page, lessonId: string, step: number) {
  await page.goto(`/#/lesson/${lessonId}/${step}`);
  await expect(page.locator('.cm-content').first()).toBeVisible();
}
