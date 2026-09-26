// Экраны вокруг урока: повторения по календарным дням, карта интересов, настройки,
// недоступное хранилище и сбой загрузки экрана.
import { expect, test } from '@playwright/test';
import { check, openExercise, setCode } from './helpers.ts';

test('повторение «на завтра» не появляется сегодня вечером, а с утра — появляется', async ({ page }) => {
  const evening = new Date('2026-09-26T18:00:00');
  await page.clock.setFixedTime(evening);

  await openExercise(page, 'm0-l1', 6);
  await page.locator('.coach').getByRole('button', { name: 'Показать решение' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Показать', exact: true }).click();
  await setCode(page, 'print("Привет, Практика!")');
  await check(page);
  await expect(page.getByText('Все проверки пройдены: 1 из 1')).toBeVisible();

  // Вечером того же дня: не «на повторение», а дата ближайшего повторения; в задании — без «Пора повторить».
  await page.goto('/#/');
  await expect(page.getByText(/Ближайшее повторение/)).toBeVisible();
  await expect(page.getByRole('link', { name: /Первое приветствие/ })).toHaveCount(0);
  await openExercise(page, 'm0-l1', 6);
  await expect(page.getByText('Пора повторить')).toHaveCount(0);

  // Следующее утро: повторение наступило.
  await page.clock.setFixedTime(new Date('2026-09-27T07:00:00'));
  await page.goto('/#/');
  await page.reload();
  await expect(page.getByRole('link', { name: /Первое приветствие/ })).toBeVisible();
});

test('карта интересов: ответы видны после перезагрузки и не затираются следующим сохранением', async ({ page }) => {
  await page.goto('/#/directions/data');
  await page.getByLabel('Что понравилось?').fill('Искать закономерности');
  await page.getByLabel('Что утомило или показалось скучным?').fill('Чистить таблицы');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(page.getByText('Сохранено', { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByLabel('Что понравилось?')).toHaveValue('Искать закономерности');
  await page.getByLabel('Что утомило или показалось скучным?').fill('Долго ждать данных');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(page.getByText('Сохранено', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Что понравилось?')).toHaveValue('Искать закономерности');
  await expect(page.getByLabel('Что утомило или показалось скучным?')).toHaveValue('Долго ждать данных');
  // Ответы на вопросы — ещё не проба: направление остаётся «Интересно».
  await expect(page.locator('.lab-card[aria-current="true"]')).toContainText('Интересно');
});

test('адрес наставника сохраняется без проверки, сброс возвращает настройки сразу', async ({ page }) => {
  await page.goto('/#/settings/coach');
  await page.getByRole('radio', { name: 'ИИ через сервер' }).click();
  await page.getByLabel('Адрес сервера').fill('http://127.0.0.1:9999');
  await page.goto('/#/');
  await page.goto('/#/settings/coach');
  await expect(page.getByLabel('Адрес сервера')).toHaveValue('http://127.0.0.1:9999');

  await page.getByRole('radio', { name: 'Тёмная' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: 'Сбросить прогресс' }).click();
  const dialog = page.getByRole('dialog', { name: 'Сбросить прогресс?' });
  await expect(dialog).toContainText('Настройки тоже вернутся к исходным');
  await dialog.getByRole('button', { name: 'Сбросить', exact: true }).click();
  await expect(page.getByText(/Прогресс и настройки сброшены/)).toBeVisible();
  // Без перезагрузки: тема снова системная, режим наставника — подсказки курса.
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('radio', { name: 'Подсказки курса' })).toHaveAttribute('aria-checked', 'true');
});

test('без IndexedDB экраны объясняют причину вместо бесконечной загрузки', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'indexedDB', { value: undefined, configurable: true });
  });
  await page.goto('/#/');
  await expect(page.locator('main')).toContainText('Прогресс не загрузился');
  await expect(page.locator('main')).toContainText('IndexedDB');
  await page.goto('/#/progress');
  await expect(page.locator('main')).toContainText('Прогресс не загрузился');
  // Карта курса открывается, а о несохраняемом прогрессе предупреждает баннер.
  await page.goto('/#/course');
  await expect(page.locator('main h1')).toHaveText('Карта курса');
  await expect(page.getByRole('alert').filter({ hasText: 'Прогресс не сохраняется' })).toBeVisible();
});

test.describe('сбой загрузки экрана', () => {
  // В собранной версии файлы отдаёт service worker, а page.route видит только запросы страницы.
  test.use({ serviceWorkers: 'block' });

test('если часть экрана не загрузилась, видно сообщение и можно уйти в другой раздел', async ({ page }) => {
  await page.goto('/#/');
  await expect(page.locator('main h1')).toBeVisible();
  // Имитируем удалённый из кеша чанк: и в сборке, и в режиме разработки файл экрана «Прогресс» не приходит.
  await page.route(/ProgressScreen/, (route) => route.abort());
  await page.locator('.sidebar').getByRole('link', { name: 'Прогресс' }).click();
  await expect(page.getByText('Не получилось открыть экран')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Обновить страницу' })).toBeVisible();
  await page.unroute(/ProgressScreen/);
  await page.locator('.sidebar').getByRole('link', { name: 'Курс' }).click();
  await expect(page.locator('main h1')).toHaveText('Карта курса');
});
});

test.describe('телефон', () => {
  test.use({ viewport: { width: 390, height: 800 }, hasTouch: true });

  test('выбранная лаборатория и проект видны сразу, а не под верхней строкой', async ({ page }) => {
    await page.goto('/#/directions/web');
    await page.locator('.lab-card').nth(6).click();
    await expect(page.locator('#lab-title')).toBeFocused();
    await expect
      .poll(async () => {
        const top = await page.locator('#lab-detail').evaluate((element) => element.getBoundingClientRect().top);
        const bar = await page.locator('.topbar').evaluate((element) => element.getBoundingClientRect().bottom);
        return top >= bar && top < bar + 40;
      })
      .toBe(true);

    await page.goto('/#/projects');
    await page.locator('.lesson-row').nth(2).click();
    await expect(page.locator('#project-title')).toBeInViewport();
  });

  test('на 320 px переключатели в настройках не вылезают за карточку', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto('/#/settings');
    const card = await page.locator('#settings-appearance').boundingBox();
    const buttons = await page.locator('#settings-appearance .segmented button').evaluateAll((items) =>
      items.map((item) => item.getBoundingClientRect().right),
    );
    expect(card).not.toBeNull();
    for (const right of buttons) expect(right).toBeLessThanOrEqual(card!.x + card!.width);
  });
});
