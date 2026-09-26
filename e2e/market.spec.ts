// Готовый проверенный обзор рынка загружается одной кнопкой и показывается в «Работе и заказах».
import { expect, test } from '@playwright/test';

test('готовый обзор рынка загружается из настроек и виден в направлениях', async ({ page }) => {
  await page.goto('/#/settings/market');
  await page.getByRole('button', { name: 'Загрузить' }).click();
  await expect(page.getByText(/загружен: \d+ записей/)).toBeVisible();
  await expect(page.locator('#settings-market').getByText('Загружен', { exact: true })).toBeVisible();

  await page.goto('/#/directions/web');
  await expect(page.getByText('Рынок: Международный фриланс, USD')).toBeVisible();
  const rows = page.locator('.market-table tbody tr');
  await expect(rows.first()).toBeVisible();
  // У каждой суммы есть ссылка на источник и дата проверки.
  await expect(rows.first().getByRole('link')).toHaveAttribute('href', /^https?:\/\//);
  await expect(rows.first()).toContainText('проверено');
});
