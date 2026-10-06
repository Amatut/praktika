// Формат окружения запуска в материалах: files, databases, seed, http у задания, теста и шагов.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { exampleStepSchema, httpMockSchema, isSafeRelativePath, predictStepSchema, testSchema } from './schema.ts';

function problems(schema: z.ZodType, value: unknown): string {
  const result = schema.safeParse(value);
  return result.success ? '' : z.prettifyError(result.error);
}

describe('пути учебных файлов', () => {
  it('только относительные пути через «/», без «..», «.», пустых частей, «\\» и «:»', () => {
    for (const good of ['data.txt', 'data/prices.csv', 'a/b/c.py', 'отчёт 2026.txt']) expect(isSafeRelativePath(good)).toBe(true);
    for (const bad of ['', '/etc/passwd', '../x', 'a/../b', './a', 'a//b', 'a/', String.raw`a\b`, 'C:x', 'a\0b']) {
      expect(isSafeRelativePath(bad), bad).toBe(false);
    }
  });

  it('в ошибке видно, какой путь неверен и почему', () => {
    const text = problems(testSchema, { id: 't', kind: 'io', expected: '1', files: { '../secret.txt': 'x' } });
    expect(text).toContain('путь «../secret.txt»: нужен относительный путь через «/»');
    expect(text).toContain('files["../secret.txt"]');
  });

  it('у базы — имя .db; у теста null убирает файл или базу задания', () => {
    expect(problems(testSchema, { id: 't', kind: 'io', expected: '1', databases: { 'shop.sqlite': 'x' } })).toContain(
      'база «shop.sqlite»: имя файла оканчивается на .db',
    );
    const parsed = testSchema.parse({ id: 't', kind: 'io', expected: '1', files: { 'a.txt': null }, databases: { 'shop.db': null } });
    expect(parsed).toMatchObject({ files: { 'a.txt': null }, databases: { 'shop.db': null } });
    // У примера и прогноза null не бывает: у них нет «задания», из которого что-то убирать.
    expect(problems(exampleStepSchema, { id: 'e', type: 'example', title: 'П', code: 'x', notes: [{ line: 1, text: 'x' }], files: { 'a.txt': null } })).not.toBe('');
  });
});

describe('ответы учебной симуляции сети', () => {
  it('полный адрес, метод GET или POST, status 100–599, json — любое JSON-значение', () => {
    expect(httpMockSchema.safeParse({ url: 'https://api.example.com/weather?city=Казань', json: { temp: 12 } }).success).toBe(true);
    expect(httpMockSchema.safeParse({ url: 'http://localhost:8000/items', method: 'POST', status: 201, json: null }).success).toBe(true);
    expect(httpMockSchema.safeParse({ url: 'https://a.example', text: 'ok', headers: { 'X-Id': '1' } }).success).toBe(true);
    expect(problems(httpMockSchema, { url: 'api.example.com/weather' })).toContain('полный адрес с http:// или https://');
    expect(httpMockSchema.safeParse({ url: 'https://a.example', method: 'PUT' }).success).toBe(false);
    expect(httpMockSchema.safeParse({ url: 'https://a.example', status: 700 }).success).toBe(false);
  });

  it('json и text вместе нельзя; при error ответа нет', () => {
    expect(problems(httpMockSchema, { url: 'https://a.example', json: 1, text: 'x' })).toContain('или json, или text');
    expect(problems(httpMockSchema, { url: 'https://a.example', error: 'timeout', status: 504 })).toContain('при error ответа нет');
    expect(httpMockSchema.safeParse({ url: 'https://a.example', error: 'connection' }).success).toBe(true);
  });

  it('seed, files, databases и http есть у прогноза', () => {
    const step = predictStepSchema.parse({
      id: 'p',
      type: 'predict',
      title: 'Прогноз',
      prompt: 'Что выведет?',
      code: 'print(1)',
      answer: '1',
      explanation: 'Так.',
      seed: 7,
      files: { 'a.txt': 'x' },
      databases: { 'shop.db': 'CREATE TABLE t (a);' },
      http: [{ url: 'https://a.example' }],
    });
    expect(step).toMatchObject({ seed: 7, files: { 'a.txt': 'x' }, http: [{ url: 'https://a.example' }] });
    expect(predictStepSchema.safeParse({ ...step, seed: 1.5 }).success).toBe(false);
  });
});
