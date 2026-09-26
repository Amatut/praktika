// Копирует ядро Pyodide из node_modules в public/pyodide, чтобы Python
// загружался с того же адреса, что и приложение (без CDN и с офлайн-кешем).

import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Plugin } from 'vite';

/** Файлы, без которых Python не запустится. Пакеты (numpy и т. п.) пока не нужны. */
export const PYODIDE_FILES = [
  'pyodide.mjs',
  'pyodide.asm.mjs',
  'pyodide.asm.wasm',
  'python_stdlib.zip',
  'pyodide-lock.json',
] as const;

export async function syncPyodide(root: string): Promise<string> {
  const source = path.join(root, 'node_modules', 'pyodide');
  const target = path.join(root, 'public', 'pyodide');
  await mkdir(target, { recursive: true });

  for (const file of PYODIDE_FILES) {
    const from = path.join(source, file);
    const to = path.join(target, file);
    const [original, copy] = await Promise.all([stat(from), stat(to).catch(() => null)]);
    if (!copy || copy.size !== original.size || copy.mtimeMs < original.mtimeMs) {
      await copyFile(from, to);
    }
  }

  const pkg = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8')) as { version: string };
  await writeFile(path.join(target, 'version.json'), JSON.stringify({ version: pkg.version }) + '\n');
  return pkg.version;
}

export function pyodideAssets(): Plugin {
  return {
    name: 'praktika:pyodide-assets',
    // Копируем до запуска сервера: Vite запоминает список файлов public/ при старте.
    async configResolved(config) {
      const version = await syncPyodide(config.root);
      config.logger.info(`Pyodide ${version}: файлы в public/pyodide`);
    },
  };
}
