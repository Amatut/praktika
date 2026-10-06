// Проверки окружения запуска при чтении материалов (build/content-lib.ts): на копии урока-образца
// scripts/fixtures/engine с внесёнными ошибками.

import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { httpKey, loadContent } from './content-lib.ts';

const engineRoot = fileURLToPath(new URL('../scripts/fixtures/engine', import.meta.url));
const LESSON = path.join('content', 'lessons', 'fe', 'fe-l1.yaml');

let tmp = '';

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'content-lib-'));
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** Копия урока-образца, в котором каждая пара [было, стало] заменена один раз. */
async function patched(name: string, replacements: [string, string][]): Promise<string> {
  const root = path.join(tmp, name);
  await cp(engineRoot, root, { recursive: true });
  const file = path.join(root, LESSON);
  let text = (await readFile(file, 'utf8')).replace(/\r\n/g, '\n');
  for (const [from, to] of replacements) {
    expect(text.includes(from), from).toBe(true);
    text = text.replace(from, to);
  }
  await writeFile(file, text);
  return root;
}

async function loadError(root: string): Promise<string> {
  return loadContent(root).then(
    () => '',
    (error: unknown) => (error as Error).message,
  );
}

describe('окружение запуска в материалах', () => {
  it('урок-образец читается без ошибок и замечаний', async () => {
    const content = await loadContent(engineRoot);
    expect(content.lessons.map((lesson) => lesson.id)).toEqual(['fe-l1']);
    expect(content.warnings).toEqual([]);
  });

  it('находит конфликты файлов, повтор ответа сети и null для несуществующего файла задания', async () => {
    const root = await patched('conflicts', [
      // Учебный файл с именем файла кода: код ученика записывается под этим же именем.
      ['      files:\n        prices.csv: |\n', '      files:\n        main.py: print(1)\n        prices.csv: |\n'],
      // money.py — файл, а в нём «лежит» другой файл, как в папке.
      ['      files:\n        money.py: |\n', '      files:\n        money.py/extra.txt: x\n        money.py: |\n'],
      // Второй ответ на тот же GET того же адреса.
      ['      http:\n        - url: https://api.example.com/weather?city=Казань\n', '      http:\n        - url: https://api.example.com/weather?city=Казань\n          text: дубль\n        - url: https://api.example.com/weather?city=Казань\n'],
      // null убирает файл задания, но у задания fe-orders файлов нет.
      ['          title: Заказов нет\n', '          title: Заказов нет\n          files:\n            nope.txt: null\n'],
      // У прогноза код тоже лежит в main.py.
      ['    seed: 7\n    answer: "3 2"\n', '    seed: 7\n    files:\n      main.py: x\n    answer: "3 2"\n'],
    ]);
    const message = await loadError(root);
    expect(message).toContain(
      'Урок fe-l1, задание fe-total: учебный файл main.py совпадает с файлом кода (main.py) — код ученика записывается под этим именем',
    );
    expect(message).toContain('Урок fe-l1, задание fe-module: money.py — файл, а money.py/extra.txt лежит в нём, как в папке');
    expect(message).toContain('Урок fe-l1, задание fe-weather: два ответа сети на GET https://api.example.com/weather?city=');
    expect(message).toContain('Урок fe-l1, задание fe-orders, тест t3: files.nope.txt: null убирает файл задания, но у задания такого нет');
    expect(message).toContain('Урок fe-l1, шаг guess-dice: учебный файл main.py совпадает с файлом кода (main.py)');
  });

  it('ключ ответа сети не зависит от порядка query-параметров и записи метода по умолчанию', () => {
    const a = httpKey({ url: 'https://api.example.com/weather?units=metric&city=Kazan' });
    const b = httpKey({ url: 'https://API.example.com/weather?city=Kazan&units=metric', method: 'GET' });
    expect(a).toBe(b);
    expect(httpKey({ url: 'https://api.example.com/weather?city=Kazan&units=metric', method: 'POST' })).not.toBe(a);
  });
});
