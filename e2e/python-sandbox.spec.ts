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

test('учебные файлы, база, seed и сеть: блоки в условии, «Запустить» с окружением задания, «Файлы после запуска»', async ({
  page,
}) => {
  // Готовых уроков с окружением в курсе пока нет — добавляем его заданию «Практика 1» урока 0.1 в JSON модуля.
  await page.route('**/content/modules/m0.*.json', async (route) => {
    const response = await route.fetch();
    const data = (await response.json()) as { lessons: { id: string; steps: { id: string; exercise?: Record<string, unknown> }[] }[] };
    const exercise = data.lessons.find((lesson) => lesson.id === 'm0-l1')?.steps.find((step) => step.id === 'practice-hello')?.exercise;
    if (!exercise) throw new Error('В модуле m0 нет задания practice-hello');
    Object.assign(exercise, {
      files: { 'menu.txt': 'чай\nкофе\n' },
      databases: { 'shop.db': "CREATE TABLE orders (item TEXT, price INTEGER);\nINSERT INTO orders VALUES ('чай', 120), ('пирог', 250);" },
      seed: 7,
      http: [{ url: 'https://api.example.com/weather?city=Казань', json: { temp: 12 } }],
    });
    await route.fulfill({ response, json: data });
  });
  await openExercise(page, 'm0-l1', HELLO);

  // В условии: честная пометка о сети со списком адресов, свёрнутые файлы и база.
  const task = page.locator('.exercise-card');
  await expect(task.getByText('Сеть — учебная симуляция')).toBeVisible();
  await expect(task.getByText('Ответы заранее записаны, настоящих запросов нет.', { exact: false })).toBeVisible();
  await expect(task.getByText('GET https://api.example.com/weather?city=Казань')).toBeVisible();
  await expect(task.getByLabel('Файл menu.txt')).toBeHidden();
  await task.getByText('Файлы задания · 1').click();
  await expect(task.getByLabel('Файл menu.txt')).toContainText('кофе');
  await task.getByText('База данных: shop.db').click();
  await expect(task.getByLabel('SQL-скрипт базы shop.db')).toContainText('INSERT INTO orders');

  // «Запустить» — с файлами, базой, seed и ответами сети задания; sqlite3 работает после lockDown потока.
  await setCode(
    page,
    [
      'import random, requests, sqlite3',
      'print(open("menu.txt", encoding="utf-8").read().split())',
      'print("сумма", sqlite3.connect("shop.db").execute("SELECT SUM(price) FROM orders").fetchone()[0])',
      'print("кубики", random.randint(1, 6), random.randint(1, 6))',
      'print("погода", requests.get("https://api.example.com/weather", params={"city": "Казань"}, timeout=5).json()["temp"])',
      'open("report.txt", "w", encoding="utf-8").write("итог: 370")',
      'try:',
      '    requests.get("https://example.com")',
      'except requests.ConnectionError as error:',
      '    print(error)',
    ].join('\n'),
  );
  await page.getByRole('button', { name: 'Запустить', exact: true }).click();
  const output = page.locator('.console');
  await expect(output).toContainText("['чай', 'кофе']", { timeout: 90_000 });
  await expect(output).toContainText('сумма 370');
  await expect(output).toContainText('кубики 3 2');
  await expect(output).toContainText('погода 12');
  await expect(output).toContainText('в учебной симуляции нет ответа для GET https://example.com');
  const files = page.getByRole('list', { name: 'Файлы после запуска' });
  await expect(files).toContainText('report.txt');
  await expect(files).toContainText('новый');
  await expect(files).toContainText('итог: 370');

  // Проверка задания с окружением работает как раньше.
  await setCode(page, 'print("Привет, Практика!")');
  await check(page);
  await expect(page.getByText('Все проверки пройдены: 1 из 1')).toBeVisible();
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
  await expect(page.getByRole('tabpanel').getByText('Проверка остановлена', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Проверить', exact: true })).toBeEnabled();

  release();
  await check(page);
  await expect(page.getByText('Все проверки пройдены: 1 из 1')).toBeVisible();
});
