// После сборки составляет явный список файлов для офлайн-работы
// и создаёт dist/sw.js и dist/offline-manifest.json.

import { createHash } from 'node:crypto';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { PYODIDE_FILES } from './pyodide-assets.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

async function walk(dir: string, base = dir): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full, base)));
    else files.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return files;
}

export interface OfflineManifest {
  buildId: string;
  shell: { cache: string; files: number; bytes: number };
  python: { cache: string; version: string; bytes: number; files: { url: string; bytes: number }[] };
  modules: Record<string, { url: string; bytes: number }>;
}

export function serviceWorkerPlugin(): Plugin {
  let outDir = 'dist';
  let root = process.cwd();
  return {
    name: 'praktika:service-worker',
    apply: 'build',
    configResolved(config) {
      root = config.root;
      outDir = path.resolve(config.root, config.build.outDir);
    },
    async closeBundle() {
      const files = await walk(outDir);
      const isShell = (file: string) =>
        !file.startsWith('pyodide/') &&
        !file.startsWith('content/modules/') &&
        file !== 'sw.js' &&
        file !== 'offline-manifest.json' &&
        !file.endsWith('.map');
      const shell = files.filter(isShell).sort();

      // Версия (BUILD_ID) — хеш содержимого. Всё, что в неё входит, должно зависеть только от кода
      // и материалов: время сборки в файлах оболочки (как бывший builtAt в course.json) превращало бы
      // каждую сборку в «новую версию» с баннером «Обновить» и перекачкой оболочки.
      const digest = createHash('sha256');
      let shellBytes = 0;
      for (const file of shell) {
        const data = await readFile(path.join(outDir, file));
        shellBytes += data.byteLength;
        digest.update(file).update(data);
      }

      const pyodidePackage = JSON.parse(
        await readFile(path.join(root, 'node_modules', 'pyodide', 'package.json'), 'utf8'),
      ) as { version: string };
      const pythonFiles = await Promise.all(
        PYODIDE_FILES.map(async (file) => ({
          url: `pyodide/${file}`,
          bytes: (await stat(path.join(outDir, 'pyodide', file))).size,
        })),
      );

      const modules: OfflineManifest['modules'] = {};
      for (const file of files.filter((name) => name.startsWith('content/modules/'))) {
        const match = /^content\/modules\/([a-z0-9-]+)\.[0-9a-f]+\.json$/.exec(file);
        if (match) modules[match[1]] = { url: file, bytes: (await stat(path.join(outDir, file))).size };
      }

      digest.update(pyodidePackage.version).update(JSON.stringify(modules));
      const buildId = digest.digest('hex').slice(0, 12);
      const manifest: OfflineManifest = {
        buildId,
        shell: { cache: `praktika-shell-${buildId}`, files: shell.length + 1, bytes: shellBytes },
        python: {
          cache: `praktika-python-${pyodidePackage.version}`,
          version: pyodidePackage.version,
          bytes: pythonFiles.reduce((sum, file) => sum + file.bytes, 0),
          files: pythonFiles,
        },
        modules,
      };
      await writeFile(path.join(outDir, 'offline-manifest.json'), JSON.stringify(manifest, null, 2));

      const shellList = [...shell, 'offline-manifest.json'].map((file) => (file === 'index.html' ? './' : file));
      // index.html нужен и по собственному имени — его отдаёт навигация без сети.
      shellList.push('index.html');
      const template = await readFile(path.join(here, 'sw-template.js'), 'utf8');
      const sw = template
        .replace('__BUILD_ID__', buildId)
        .replace('__SHELL_FILES__', JSON.stringify(shellList, null, 2))
        .replace('__PYTHON_CACHE__', manifest.python.cache);
      await writeFile(path.join(outDir, 'sw.js'), sw);
      this.info?.(
        `Офлайн: оболочка ${shell.length} файлов (${(shellBytes / 1024).toFixed(0)} КБ), Python ${(manifest.python.bytes / 1048576).toFixed(1)} МБ, модулей ${Object.keys(modules).length}`,
      );
    },
  };
}
