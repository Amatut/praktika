// Состояния навыков, уроков и модулей считаются только из реальных попыток.
// Открытый урок или показанное решение не делают навык освоенным.

import type { Course, Exercise, Lesson, ModuleFile, ModuleSummary } from '../content/schema.ts';
import { isDue } from '../storage/schedule.ts';
import type { ExerciseRecord, HelpLevel, LessonRecord, ReviewRecord, SelfCheck } from '../storage/types.ts';

export type LearningState = 'not-started' | 'learning' | 'practice' | 'mastered';

export const STATE_LABEL: Record<LearningState, string> = {
  'not-started': 'Не начат',
  learning: 'Изучаю',
  practice: 'Нужна практика',
  mastered: 'Освоен',
};

export const STATE_TONE: Record<LearningState, 'muted' | 'accent' | 'warn' | 'good'> = {
  'not-started': 'muted',
  learning: 'accent',
  practice: 'warn',
  mastered: 'good',
};

export const HELP_LABEL: Record<HelpLevel, string> = {
  0: 'сам',
  1: 'с подсказкой 1',
  2: 'с подсказкой 2',
  3: 'с подсказкой 3',
  4: 'после просмотра решения',
};

export const SELF_CHECK_LABEL: Record<SelfCheck, string> = {
  understood: 'понимаю',
  partly: 'частично',
  'not-yet': 'пока нет',
};

/** Сколько самостоятельных решений нужно, чтобы считать навык освоенным. */
export const MASTERY_PASSES = 2;
/** Решение с такой помощью (не больше первой подсказки) ещё считается самостоятельным. */
export const INDEPENDENT_HELP = 1;

export interface Evidence {
  exerciseId: string;
  exerciseTitle: string;
  lessonId: string;
  help: HelpLevel;
  at: number;
}

/** Фактические отметки ученика в уроке без автопроверки: пункты чек-листов и самооценка в итоге. */
export interface SelfMarks {
  lessonId: string;
  lessonTitle: string;
  checklistDone: number;
  checklistTotal: number;
  selfCheck: SelfCheck | null;
  completedAt: number | null;
}

export interface SkillProgress {
  skillId: string;
  state: LearningState;
  evidence: Evidence[];
  attemptedExercises: number;
  totalExercises: number;
  /** Навык без заданий (например, установка на компьютере) — отмечается учеником. */
  selfReported: boolean;
  /** Отметки в уроках самоотмеченного навыка — его единственное доказательство (у навыка с заданиями пусто). */
  selfMarks?: SelfMarks[];
  dueReview: boolean;
}

export function exercisesOf(lesson: Lesson): Exercise[] {
  return lesson.steps.flatMap((step) => (step.type === 'exercise' ? [step.exercise] : []));
}

/** Ключ повторения темы урока (ставится по самооценке в итоге урока). */
export function lessonReviewKey(lessonId: string): string {
  return `lesson:${lessonId}`;
}

export function selfMarks(lesson: Lesson, record: LessonRecord | undefined): SelfMarks {
  const items = lesson.steps.flatMap((step) =>
    step.type === 'checklist' ? step.items.map((item) => ({ stepId: step.id, itemId: item.id })) : [],
  );
  const done = items.filter(({ stepId, itemId }) => record?.checklists[stepId]?.includes(itemId)).length;
  return {
    lessonId: lesson.id,
    lessonTitle: lesson.title,
    checklistDone: done,
    checklistTotal: items.length,
    selfCheck: record?.recap?.selfCheck ?? null,
    completedAt: record?.completedAt ?? null,
  };
}

/**
 * Открытые повторения: наступившие (по календарным дням, как isDue) и ближайшие — оба списка по возрастанию срока.
 * Повторение «на завтра» не попадает в сегодняшние, в какое бы время дня ни был открыт экран.
 */
export function splitReviews(reviews: ReviewRecord[], now = Date.now()): { due: ReviewRecord[]; upcoming: ReviewRecord[] } {
  const open = reviews.filter((review) => review.doneAt === null).sort((a, b) => a.dueAt - b.dueAt);
  return {
    due: open.filter((review) => isDue(review.dueAt, now)),
    upcoming: open.filter((review) => !isDue(review.dueAt, now)),
  };
}

/**
 * Состояние урока — по тем же порогам, что и у навыка: «Освоен», когда все задания решены сам или с первой
 * подсказкой, в итоге не выбрано «Частично» или «Пока нет» и повторения урока не наступили.
 * Урок без заданий освоен только по фактическим отметкам: все пункты чек-листов и самооценка в итоге.
 * Одно нажатие «Завершить урок» без отметок оставляет его в состоянии «Изучаю».
 */
export function lessonState(
  lesson: Lesson,
  record: LessonRecord | undefined,
  exercises: Map<string, ExerciseRecord>,
  reviews: ReviewRecord[] = [],
  now = Date.now(),
): LearningState {
  const items = exercisesOf(lesson);
  const touched = Boolean(record) || items.some((exercise) => exercises.has(exercise.id));
  if (!touched) return 'not-started';
  const allPassed = items.every((exercise) => exercises.get(exercise.id)?.status === 'passed');
  if (!record?.completedAt || !allPassed) return 'learning';
  const selfCheck = record.recap?.selfCheck ?? null;
  if (items.length === 0) {
    const marks = selfMarks(lesson, record);
    if (marks.checklistDone < marks.checklistTotal || selfCheck === null) return 'learning';
  }
  const helped = items.some((exercise) => (exercises.get(exercise.id)?.firstPassHelp ?? 0) > INDEPENDENT_HELP);
  const reviewDue = reviews.some((review) => review.doneAt === null && review.lessonId === lesson.id && isDue(review.dueAt, now));
  if (helped || selfCheck === 'partly' || selfCheck === 'not-yet' || reviewDue) return 'practice';
  return 'mastered';
}

export function skillProgress(
  skillId: string,
  lessons: Lesson[],
  lessonRecords: Map<string, LessonRecord>,
  exercises: Map<string, ExerciseRecord>,
  reviews: ReviewRecord[],
  now = Date.now(),
): SkillProgress {
  const related = lessons.flatMap((lesson) =>
    exercisesOf(lesson)
      .filter((exercise) => exercise.skills.includes(skillId))
      .map((exercise) => ({ lesson, exercise })),
  );
  const skillLessons = lessons.filter((lesson) => lesson.skills.includes(skillId));
  // Повторение задания относится к навыкам задания, повторение темы урока — к навыкам урока.
  const dueReview = reviews.some(
    (review) =>
      review.doneAt === null &&
      isDue(review.dueAt, now) &&
      (related.some(({ exercise }) => exercise.id === review.exerciseId) ||
        skillLessons.some((lesson) => review.key === lessonReviewKey(lesson.id))),
  );

  if (related.length === 0) {
    // Навык без заданий: состояние складывается из уроков навыка, то есть из фактических отметок в них.
    const states = skillLessons.map((lesson) => lessonState(lesson, lessonRecords.get(lesson.id), exercises, reviews, now));
    let state: LearningState;
    if (states.every((value) => value === 'not-started')) state = 'not-started';
    else if (states.every((value) => value === 'mastered') && !dueReview) state = 'mastered';
    else if (states.every((value) => value === 'mastered' || value === 'practice')) state = 'practice';
    else state = 'learning';
    return {
      skillId,
      state,
      evidence: [],
      attemptedExercises: 0,
      totalExercises: 0,
      selfReported: true,
      selfMarks: skillLessons.map((lesson) => selfMarks(lesson, lessonRecords.get(lesson.id))),
      dueReview,
    };
  }

  const evidence: Evidence[] = [];
  let attempted = 0;
  for (const { lesson, exercise } of related) {
    const record = exercises.get(exercise.id);
    if (!record || (record.checks === 0 && record.runs === 0)) continue;
    attempted += 1;
    if (record.status === 'passed' && record.firstPassedAt !== null) {
      evidence.push({
        exerciseId: exercise.id,
        exerciseTitle: exercise.title,
        lessonId: lesson.id,
        help: record.firstPassHelp ?? 0,
        at: record.firstPassedAt,
      });
    }
  }
  const independent = evidence.filter((item) => item.help <= INDEPENDENT_HELP).length;
  let state: LearningState;
  if (attempted === 0) state = 'not-started';
  else if (independent >= Math.min(MASTERY_PASSES, related.length) && !dueReview) state = 'mastered';
  else if (evidence.length > 0 && (evidence.some((item) => item.help > INDEPENDENT_HELP) || dueReview)) state = 'practice';
  else state = 'learning';

  return {
    skillId,
    state,
    evidence: evidence.sort((a, b) => a.at - b.at),
    attemptedExercises: attempted,
    totalExercises: related.length,
    selfReported: false,
    selfMarks: [],
    dueReview,
  };
}

export function moduleState(
  module: ModuleSummary,
  file: ModuleFile | undefined,
  lessonRecords: Map<string, LessonRecord>,
  exercises: Map<string, ExerciseRecord>,
  reviews: ReviewRecord[] = [],
  now = Date.now(),
): LearningState {
  if (!file) return 'not-started';
  const states = file.lessons.map((lesson) => lessonState(lesson, lessonRecords.get(lesson.id), exercises, reviews, now));
  if (states.every((state) => state === 'not-started')) return 'not-started';
  const allLessonsReady = module.status === 'ready';
  if (states.every((state) => state === 'mastered') && allLessonsReady) return 'mastered';
  if (states.every((state) => state === 'mastered' || state === 'practice') && allLessonsReady) return 'practice';
  return 'learning';
}

/**
 * Первый незавершённый урок курса — «что делать дальше». Урок, который ученик сам завершил, сюда не попадает,
 * даже если он ещё не освоен (например, установка на компьютере отложена): его честное состояние видно в «Курсе».
 */
export function suggestNextLesson(
  course: Course,
  files: Map<string, ModuleFile>,
  lessonRecords: Map<string, LessonRecord>,
  exercises: Map<string, ExerciseRecord>,
): { module: ModuleSummary; lesson: Lesson } | null {
  for (const module of course.modules) {
    const file = files.get(module.id);
    if (!file) continue;
    for (const lesson of file.lessons) {
      const record = lessonRecords.get(lesson.id);
      if (record?.completedAt) continue;
      const state = lessonState(lesson, record, exercises);
      if (state === 'not-started' || state === 'learning') return { module, lesson };
    }
  }
  return null;
}
