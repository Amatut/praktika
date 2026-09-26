import { defineConfig, devices } from '@playwright/test';

// Сквозные тесты идут на собранной версии (как у ученика): npm run test:e2e
// Браузер — установленный Microsoft Edge (отдельно скачивать браузеры не нужно).
const port = 4173;
// E2E_URL=http://127.0.0.1:5173 — прогон на уже запущенном сервере разработки (без офлайн-теста).
const externalUrl = process.env.E2E_URL;

export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: externalUrl ?? `http://127.0.0.1:${port}`,
    channel: process.env.PW_CHANNEL ?? 'msedge',
    locale: 'ru-RU',
    trace: 'retain-on-failure',
  },
  webServer: externalUrl
    ? undefined
    : {
        command: 'npm run build && npm run preview',
        url: `http://127.0.0.1:${port}`,
        reuseExistingServer: true,
        timeout: 240_000,
      },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Edge'], channel: process.env.PW_CHANNEL ?? 'msedge', viewport: { width: 1440, height: 900 } },
      testIgnore: /mobile\.spec\.ts/,
    },
    {
      name: 'mobile',
      use: {
        channel: process.env.PW_CHANNEL ?? 'msedge',
        viewport: { width: 390, height: 800 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 2,
      },
      testMatch: /mobile\.spec\.ts/,
    },
  ],
});
