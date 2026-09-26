import { defineConfig } from 'vitest/config';

// Отдельная конфигурация без плагинов сборки: модульные тесты не трогают public/.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts', 'server/**/*.test.ts', 'build/**/*.test.ts'],
    environment: 'node',
  },
});
