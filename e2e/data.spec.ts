// Экспорт и импорт прогресса: восстановление данных, отказ от повреждённого файла.
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { check, openExercise, setCode } from './helpers.ts';

test('экспорт → сброс → импорт восстанавливает прогресс; повреждённый файл ничего не портит', async ({ page }, testInfo) => {
  await openExercise(page, 'm0-l1', 6);
  await setCode(page, 'print("Привет, Практика!")');
  await check(page);
  await expect(page.getByText('Все проверки пройдены: 1 из 1')).toBeVisible();

  await page.goto('/#/settings/data');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Сохранить в файл' }).click();
  const download = await downloadPromise;
  const exportPath = testInfo.outputPath('progress.json');
  await download.saveAs(exportPath);
  const exported = JSON.parse(await readFile(exportPath, 'utf8'));
  expect(exported.format).toBe('praktika-progress');
  expect(exported.data.exercises.some((item: { exerciseId: string; status: string }) => item.exerciseId === 'm0-l1-e1' && item.status === 'passed')).toBe(true);
  // В файле нет ключей API.
  expect(JSON.stringify(exported)).not.toMatch(/sk-ant|ANTHROPIC_API_KEY/);

  // Повреждённый файл: сообщение и никаких изменений.
  await page.locator('#settings-data input[type="file"]').first().setInputFiles({
    name: 'broken.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{"format": "praktika-progress", "data": '),
  });
  await expect(page.getByText('Файл не импортирован')).toBeVisible();

  // Сброс (с резервной копией).
  await page.getByRole('button', { name: 'Сбросить прогресс' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Сбросить', exact: true }).click();
  await expect(page.getByText(/сброшены\. Резервная копия сохранена/)).toBeVisible();
  await openExercise(page, 'm0-l1', 6);
  await expect(page.getByText('Новое', { exact: true })).toBeVisible();

  // Импорт с заменой возвращает решённое задание.
  await page.goto('/#/settings/data');
  await page.locator('#settings-data input[type="file"]').first().setInputFiles(exportPath);
  await page.getByRole('radio', { name: 'Заменить текущий' }).click();
  await page.getByRole('button', { name: 'Заменить', exact: true }).click();
  await expect(page.getByText(/Прогресс импортирован/)).toBeVisible();
  await openExercise(page, 'm0-l1', 6);
  await expect(page.getByText('Решено', { exact: true })).toBeVisible();
});
