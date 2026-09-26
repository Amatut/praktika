// Тестовый провайдер (COACH_PROVIDER=mock): проверяет связь приложения с адаптером
// без обращения к ИИ и без платы. Ответ детерминированный и явно помечен как не-ИИ.

import { CoachProviderError } from './types.ts';
import type { CoachCompletion, CoachCompletionRequest, CoachProvider } from './types.ts';

export const MOCK_MARK = '[тестовый режим — это не ИИ]';

const SECTIONS: [tag: string, label: string][] = [
  ['exercise', 'условие'],
  ['student_code', 'код'],
  ['check_results', 'результаты проверки'],
  ['skills', 'карточка навыков'],
  ['history', 'история'],
  ['student_question', 'вопрос'],
];

/** Грубая оценка токенов — только чтобы поле usage было заполнено. */
function roughTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function createMockProvider(): CoachProvider {
  async function complete({ system, messages, signal }: CoachCompletionRequest): Promise<CoachCompletion> {
    if (signal.aborted) throw new CoachProviderError('aborted', 'Запрос отменён.', 499);
    const last = messages.at(-1)?.content ?? '';
    const action = /^Действие ученика: ([a-z-]+)/m.exec(last)?.[1] ?? 'неизвестно';
    const present = SECTIONS.filter(([tag]) => last.includes(`<${tag}>`)).map(([, label]) => label);
    const text = [
      MOCK_MARK,
      `Адаптер получил запрос «${action}» и ответил сам, без обращения к модели.`,
      `Передано: урок${present.length > 0 ? `, ${present.join(', ')}` : ''}.`,
      'Здесь был бы короткий ответ наставника: где → почему → попробуй → проверь.',
    ].join('\n');
    const input = roughTokens(system) + messages.reduce((sum, message) => sum + roughTokens(message.content), 0);
    return { text, model: 'mock', usage: { input, output: roughTokens(text) } };
  }

  return { name: 'mock', model: 'mock', configured: true, complete };
}
