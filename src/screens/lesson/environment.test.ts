// Блоки окружения запуска в уроке: файлы и базы задания, пометка о симуляции сети, «Файлы после запуска».

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { RunFile } from '../../runner/types.ts';
import { ChangedFiles, EnvironmentInfo, describeHttpMock, hasEnvironment } from './environment.tsx';

/** Текст разметки без тегов — то, что прочитает человек или экранный диктор. <wbr> — место переноса, не пробел. */
function text(html: string): string {
  return html
    .replace(/<wbr\s*\/?>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('EnvironmentInfo', () => {
  it('без файлов, баз и сети ничего не показывает', () => {
    expect(renderToStaticMarkup(createElement(EnvironmentInfo, { source: {} }))).toBe('');
    expect(hasEnvironment({ files: {}, http: [] })).toBe(false);
    expect(hasEnvironment({ databases: { 'shop.db': 'CREATE TABLE t (a);' } })).toBe(true);
  });

  it('файлы и база — свёрнутые блоки с содержимым, сеть — честная пометка со списком адресов', () => {
    const html = renderToStaticMarkup(
      createElement(EnvironmentInfo, {
        source: {
          files: { 'prices.csv': 'name,price\nчай,120\n', 'empty.txt': '', 'gone.txt': null },
          databases: { 'shop.db': 'CREATE TABLE orders (item TEXT);' },
          http: [
            { url: 'https://api.example.com/weather?city=Казань', json: { temp: 12 } },
            { url: 'https://api.example.com/items', method: 'POST', status: 201 },
            { url: 'https://api.example.com/slow', error: 'timeout' },
          ],
        },
      }),
    );
    const shown = text(html);
    expect(shown).toContain('Сеть — учебная симуляция');
    expect(shown).toContain('Ответы заранее записаны, настоящих запросов нет.');
    expect(shown).toContain('GET https://api.example.com/weather?city=Казань → 200');
    expect(shown).toContain('POST https://api.example.com/items → 201');
    expect(shown).toContain('GET https://api.example.com/slow → сервер не отвечает вовремя');
    // Длинный адрес переносится только по частям: после «https://», пути и перед запросом — не внутри «https://»,
    // не посреди имени сервера и не посреди слова. «GET» не отрывается от адреса, «→» — от ответа.
    expect(html).toContain('https://<wbr/>api.example.com/<wbr/>weather<wbr/>?city=Казань');
    expect(html).toContain('GET\u00a0https://');
    expect(html).toContain('→\u00a0200');
    expect(shown).toContain('Файлы задания · 3');
    expect(shown).toContain('prices.csv');
    expect(shown).toContain('чай,120');
    expect(shown).toContain('Пустой файл.');
    expect(shown).toContain('В этом случае файла нет.');
    expect(shown).toContain('База данных: shop.db');
    expect(shown).toContain('CREATE TABLE orders (item TEXT);');
    // Файлы и SQL свёрнуты: условие остаётся коротким.
    expect(html.match(/<details/g)).toHaveLength(2);
    expect(html).not.toMatch(/<details[^>]*open/);
  });

  it('describeHttpMock: код ответа или ошибка сети', () => {
    expect(describeHttpMock({ url: 'https://a.example' })).toBe('200');
    expect(describeHttpMock({ url: 'https://a.example', status: 404 })).toBe('404');
    expect(describeHttpMock({ url: 'https://a.example', error: 'connection' })).toBe('нет соединения');
  });
});

describe('ChangedFiles', () => {
  const file = (fields: Partial<RunFile>): RunFile => ({ path: 'out.txt', status: 'created', size: 5, text: 'итог', truncated: false, ...fields });

  it('пустой список — ничего не показывает', () => {
    expect(renderToStaticMarkup(createElement(ChangedFiles, { files: [] }))).toBe('');
    expect(renderToStaticMarkup(createElement(ChangedFiles, { files: undefined }))).toBe('');
  });

  it('путь, новый или изменён, размер; текст, пометка об обрезке, двоичный файл без текста', () => {
    const html = renderToStaticMarkup(
      createElement(ChangedFiles, {
        files: [
          file({ path: 'report/total.txt', text: '370\n' }),
          file({ path: 'big.txt', status: 'modified', size: 20_480, text: 'я'.repeat(10), truncated: true }),
          file({ path: 'shop.db', status: 'modified', size: 8192, text: null }),
        ],
      }),
    );
    const shown = text(html);
    expect(shown).toContain('Файлы после запуска');
    expect(shown).toContain('report/total.txt новый · 5 Б');
    expect(shown).toContain('big.txt изменён · 20 КБ');
    expect(shown).toContain('Показано начало файла.');
    expect(shown).toContain('shop.db изменён · 8 КБ');
    expect(shown).toContain('Двоичный файл');
    expect(shown).toContain('370');
  });

  it('единственный файл раскрыт сразу', () => {
    const html = renderToStaticMarkup(createElement(ChangedFiles, { files: [file({})] }));
    expect(html).toMatch(/<details[^>]*open/);
  });
});
