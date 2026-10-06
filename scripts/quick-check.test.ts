// Быстрая самопроверка на обычном Python (scripts/quick-check.py) понимает окружение запуска:
// урок-образец scripts/fixtures/engine (файлы, модули, база, seed, сеть) проходит без замечаний.
// Нужен установленный Python 3; если его нет, тест пропускается.

import { spawn, spawnSync } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { buildContent } from '../build/content-lib.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

function findPython(): string | null {
  for (const command of ['python', 'python3']) {
    const probe = spawnSync(command, ['-c', 'import sys; print(sys.version_info >= (3, 10))'], { encoding: 'utf8' });
    if (probe.status === 0 && probe.stdout.trim() === 'True') return command;
  }
  return null;
}

const python = findPython();
let tmp = '';

afterAll(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

describe.skipIf(python === null)('python scripts/quick-check.py', () => {
  it('проверяет урок-образец с окружением запуска без замечаний', async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'quick-check-'));
    await cp(path.join(here, 'fixtures', 'engine', 'content'), path.join(tmp, 'content'), { recursive: true });
    await buildContent(tmp);
    const output = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
      const child = spawn(python ?? 'python', [path.join(here, 'quick-check.py'), '--root', tmp], { env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
      let stdout = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout }));
    });
    expect(output.stdout).toContain('✓ прогноз guess-weather совпадает с выводом');
    expect(output.stdout).toContain('✓ прогноз guess-orders совпадает с выводом');
    expect(output.stdout).toContain('✓ fe-total: эталон проходит (4 тестов)');
    expect(output.stdout).toContain('Заданий проверено: 6. Проблем: 0.');
    expect(output.code).toBe(0);
  }, 180_000);
});
