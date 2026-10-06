// Этапы конвейера шагов: до первого задания — «Понять», задания и всё между ними — «Сделать», итог — «Закрепить».
import { describe, expect, it } from 'vitest';
import { flowGroups } from './FlowSteps.tsx';

const steps = (...types: string[]) => types.map((type) => ({ type }));

describe('flowGroups', () => {
  it('делит урок на три этапа', () => {
    expect(flowGroups(steps('intro', 'theory', 'example', 'predict', 'exercise', 'theory', 'exercise', 'recap'))).toEqual([
      'understand',
      'understand',
      'understand',
      'understand',
      'do',
      'do',
      'do',
      'reinforce',
    ]);
  });

  it('урок без заданий: всё до итога — «Понять»', () => {
    expect(flowGroups(steps('intro', 'theory', 'checklist', 'quiz', 'recap'))).toEqual([
      'understand',
      'understand',
      'understand',
      'understand',
      'reinforce',
    ]);
  });
});
