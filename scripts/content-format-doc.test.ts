// Справочник docs/content-format.md не расходится с форматом и с проверенным уроком-образцом:
//   * каждый пример ```yaml взят дословно из урока-образца scripts/fixtures/engine (его проверяет
//     настоящим Python тест «принимает урок-образец…» в scripts/verify-content.test.ts);
//   * каждое поле схемы материалов упомянуто в справочнике как `поле`.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  assertTestSchema,
  callTestSchema,
  checklistStepSchema,
  compareOptionsSchema,
  exampleStepSchema,
  exerciseSchema,
  httpMockSchema,
  ioTestSchema,
  lessonSchema,
  matcherSchema,
  mistakeSchema,
  orderStepSchema,
  predictStepSchema,
  quizStepSchema,
  recapStepSchema,
  ruleSchema,
  theoryStepSchema,
} from '../src/content/schema.ts';

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
const doc = read('../docs/content-format.md');
const fixtures = [read('./fixtures/engine/content/lessons/fe/fe-l1.yaml'), read('./fixtures/engine/content/course.yaml')];

function yamlBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/```yaml\n([\s\S]*?)```/g)].map((match) => match[1] ?? '');
}

/** Блок есть в файле с каким-нибудь одинаковым отступом у всех строк. */
function foundIn(text: string, block: string): boolean {
  const lines = block.replace(/\n+$/, '').split('\n');
  const indent = Math.min(...lines.filter((line) => line.trim()).map((line) => line.length - line.trimStart().length));
  const bare = lines.map((line) => line.slice(indent));
  for (let shift = 0; shift <= 16; shift++) {
    const candidate = bare.map((line) => (line ? ' '.repeat(shift) + line : line)).join('\n');
    if (text.includes(`${candidate}\n`)) return true;
  }
  return false;
}

function keysOf(schema: z.ZodType): string[] {
  return Object.keys((schema as unknown as { shape: Record<string, unknown> }).shape);
}

describe('docs/content-format.md', () => {
  it('каждый пример YAML дословно взят из проверенного урока-образца', () => {
    const blocks = yamlBlocks(doc);
    expect(blocks.length).toBeGreaterThan(15);
    const missing = blocks.filter((block) => !fixtures.some((text) => foundIn(text, block)));
    expect(missing).toEqual([]);
  });

  it('упоминает каждое поле формата', () => {
    const schemas = [
      lessonSchema,
      theoryStepSchema,
      exampleStepSchema,
      predictStepSchema,
      orderStepSchema,
      checklistStepSchema,
      quizStepSchema,
      recapStepSchema,
      exerciseSchema,
      ioTestSchema,
      callTestSchema,
      assertTestSchema,
      compareOptionsSchema,
      ruleSchema,
      matcherSchema,
      mistakeSchema,
      httpMockSchema,
    ];
    const fields = new Set(schemas.flatMap(keysOf));
    for (const extra of ['wrongSolutions', 'expectMistake', 'altSolutions', 'noHintsBeforeAttempt']) fields.add(extra);
    const undocumented = [...fields].filter((field) => !doc.includes(`\`${field}\``));
    expect(undocumented).toEqual([]);
  });

  it('называет все виды шагов, заданий, тестов и сравнения', () => {
    for (const name of ['theory', 'example', 'predict', 'order', 'exercise', 'checklist', 'quiz', 'recap']) expect(doc).toContain(`\`${name}\``);
    for (const name of ['repeat', 'modify', 'write', 'fix', 'read']) expect(doc).toContain(`\`${name}\``);
    for (const name of ['io', 'call', 'assert', 'lines', 'regex', 'contains']) expect(doc).toContain(`\`${name}\``);
  });
});
