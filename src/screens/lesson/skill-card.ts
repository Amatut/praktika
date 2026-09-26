// Краткая карточка навыков для ИИ-наставника: несколько строк о навыках задания и урока
// из настоящих попыток (состояние, самостоятельные решения, повторение). Без личных данных.

import type { Exercise, Lesson, Skill } from '../../content/schema.ts';
import { STATE_LABEL, type SkillProgress } from '../../progress/model.ts';

/** Сколько строк навыков отправлять наставнику. */
export const SKILL_CARD_LINES = 6;

/** Навыки задания, затем остальные навыки урока — без повторов. */
export function skillIdsFor(lesson: Pick<Lesson, 'skills'>, exercise: Pick<Exercise, 'skills'> | null): string[] {
  return [...new Set([...(exercise?.skills ?? []), ...lesson.skills])];
}

/** Строки карточки: «Вывод на экран: нужна практика; решено заданий 2 из 4, сам или с одной подсказкой — 1». */
export function skillCardLines(skills: Pick<Skill, 'id' | 'title'>[], progress: Map<string, SkillProgress>, limit = SKILL_CARD_LINES): string[] {
  return skills.slice(0, limit).map((skill) => {
    const item = progress.get(skill.id);
    if (!item) return `${skill.title}: ${STATE_LABEL['not-started'].toLowerCase()}`;
    const parts = [STATE_LABEL[item.state].toLowerCase()];
    if (!item.selfReported && item.totalExercises > 0) {
      const independent = item.evidence.filter((evidence) => evidence.help <= 1).length;
      parts.push(`решено заданий ${item.evidence.length} из ${item.totalExercises}, сам или с одной подсказкой — ${independent}`);
    }
    if (item.dueReview) parts.push('ждёт повторения');
    return `${skill.title}: ${parts.join('; ')}`;
  });
}
