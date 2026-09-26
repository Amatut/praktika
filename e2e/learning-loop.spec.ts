// Главный учебный цикл: открыть урок → написать код → проверить → получить разбор →
// исправить → прогресс сохраняется. Всё выполняется настоящим Python (Pyodide).
import { expect, test } from '@playwright/test';
import { check, editorText, openExercise, setCode } from './helpers.ts';

const HELLO = 6; // шаг «Практика 1» урока 0.1 (0 — история)

test('верное решение проходит, неверное — нет, код и статус сохраняются после перезагрузки', async ({ page }) => {
  await openExercise(page, 'm0-l1', HELLO);

  await setCode(page, 'print("Привет, мир!")');
  await check(page);
  await expect(page.getByText('Пройдено 0 из 1')).toBeVisible();
  await expect(page.locator('.test-item[data-state="fail"]')).toHaveCount(1);
  // Видно ввод/ожидалось/получилось.
  await expect(page.locator('.test-detail').getByText('Ожидалось')).toBeVisible();
  await expect(page.locator('.test-detail').getByText('Привет, мир!')).toBeVisible();

  await setCode(page, 'print("Привет, Практика!")');
  await check(page);
  await expect(page.getByText('Все проверки пройдены: 1 из 1')).toBeVisible();
  await expect(page.getByText('Решено', { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.locator('.cm-content')).toBeVisible();
  await expect.poll(() => editorText(page)).toContain('print("Привет, Практика!")');
  await expect(page.getByText('Решено', { exact: true })).toBeVisible();
  await expect(page.getByText('Задание уже решено')).toBeVisible();
});

test('синтаксическая ошибка объясняется, исходное сообщение раскрывается', async ({ page }) => {
  await openExercise(page, 'm0-l1', HELLO);
  await setCode(page, 'print("Привет, Практика!)');
  await check(page);
  await expect(page.getByText(/Код не запустился: SyntaxError в строке 1/)).toBeVisible();
  const coach = page.locator('.coach');
  await expect(coach.locator('.feedback')).toBeVisible();
  await expect(coach.getByText('Почему', { exact: true })).toBeVisible();
  await coach.getByText('Исходное сообщение Python').click();
  await expect(coach.locator('pre.raw')).toContainText('unterminated string literal');
  // Строка с ошибкой подсвечена в редакторе.
  await expect(page.locator('.cm-error-line')).toHaveCount(1);
});

test('бесконечный цикл останавливается, интерфейс остаётся доступным', async ({ page }) => {
  await openExercise(page, 'm0-l1', HELLO);
  // Сначала дожидаемся готовности Python обычной (неудачной) проверкой —
  // задание остаётся нерешённым, и кнопка подсказки доступна.
  await setCode(page, 'print("Привет")');
  await check(page);

  await setCode(page, 'while True:\n    pass');
  await page.getByRole('button', { name: 'Проверить', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Остановить' })).toBeVisible();
  // Во время зависшей программы интерфейс отвечает: можно открыть подсказку.
  await page.getByRole('button', { name: /Подсказка 1 из 3/ }).click();
  await expect(page.locator('.hint-card')).toHaveCount(1);
  await expect(page.getByRole('tabpanel').getByText(/работала дольше 3 с и была остановлена/)).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.coach .feedback')).toContainText('слишком долго');

  // После перезапуска Python снова выполняет код.
  await setCode(page, 'print("Привет, Практика!")');
  await check(page);
  await expect(page.getByText('Все проверки пройдены: 1 из 1')).toBeVisible();
});

test('кнопка «Остановить» прерывает программу вручную', async ({ page }) => {
  await openExercise(page, 'm0-l1', HELLO);
  await setCode(page, 'print("Привет, Практика!")');
  await check(page);
  await setCode(page, 'while True:\n    pass');
  await page.getByRole('button', { name: 'Проверить', exact: true }).click();
  await page.getByRole('button', { name: 'Остановить' }).click();
  await expect(page.getByRole('tabpanel').getByText('Проверка остановлена.')).toBeVisible();
  await setCode(page, 'print("Привет, Практика!")');
  await check(page);
  await expect(page.getByText('Все проверки пройдены: 1 из 1')).toBeVisible();
});

test('«Запустить» показывает вывод программы без оценки', async ({ page }) => {
  await openExercise(page, 'm0-l1', HELLO);
  await setCode(page, 'print("раз")\nprint("два")');
  await page.getByRole('button', { name: 'Запустить', exact: true }).click();
  await expect(page.locator('.console')).toContainText('раз', { timeout: 90_000 });
  await expect(page.locator('.console')).toContainText('два');
});

test('режим наставника честно обозначен, без сервера ИИ не изображается', async ({ page }) => {
  await openExercise(page, 'm0-l1', HELLO);
  await expect(page.locator('.coach-mode')).toHaveText('Подсказки курса');

  await page.goto('/#/settings/coach');
  await page.getByRole('radio', { name: 'ИИ через сервер' }).click();
  await page.getByRole('button', { name: 'Проверить соединение' }).click();
  // Сервер наставника не запущен — показывается понятная ошибка, а не ответ «ИИ».
  await expect(page.locator('#settings-coach .notice')).toBeVisible({ timeout: 40_000 });
  await expect(page.locator('#settings-coach .notice')).not.toContainText('отвечает');
  await page.getByRole('radio', { name: 'Подсказки курса' }).click();
});

test('подсказки открываются по уровням, решение — после подтверждения', async ({ page }) => {
  await openExercise(page, 'm0-l1', 7);
  const coach = page.locator('.coach');
  await coach.getByRole('button', { name: /Подсказка 1 из 3/ }).click();
  await coach.getByRole('button', { name: /Подсказка 2 из 3/ }).click();
  // Открыта последняя подсказка, прежняя свёрнута.
  await expect(coach.locator('.hint-card')).toHaveCount(1);
  await expect(coach.locator('details.hint-old')).toHaveCount(1);
  await coach.getByRole('button', { name: 'Показать решение' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Открыто подсказок: 2 из 3');
  await dialog.getByRole('button', { name: 'Показать', exact: true }).click();
  await expect(coach.getByText('Решение', { exact: true })).toBeVisible();
});
