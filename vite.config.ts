import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import { contentPlugin } from './build/content-plugin.ts';
import { pyodideAssets } from './build/pyodide-assets.ts';
import { serviceWorkerPlugin } from './build/service-worker-plugin.ts';

// Базовый путь можно изменить для размещения в подпапке (например, GitHub Pages: BASE_PATH=/praktika/).
const base = process.env.BASE_PATH ?? '/';
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  base,
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [react(), pyodideAssets(), contentPlugin(), serviceWorkerPlugin()],
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
    // Отдельные чанки для редактора, чтобы первый экран открывался быстрее.
    chunkSizeWarningLimit: 900,
  },
  server: {
    // Локальный сервер доступен только с этого компьютера.
    host: '127.0.0.1',
  },
  preview: {
    host: '127.0.0.1',
  },
});
