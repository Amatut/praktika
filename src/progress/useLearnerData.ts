// Все данные ученика и готовые модули в одном месте — для экранов «Сегодня», «Курс», «Прогресс».

import { useEffect, useState } from 'react';
import { useDataVersion } from '../app/hooks.ts';
import { loadModule } from '../content/loader.ts';
import type { Course, ModuleFile } from '../content/schema.ts';
import {
  getActivity,
  getAllExercises,
  getAllLessons,
  getAllProjects,
  getAllReviews,
  getAttempts,
  getInterests,
  getMarketDatasets,
  getMeta,
} from '../storage/repo.ts';
import type {
  ActivityRecord,
  AttemptRecord,
  ExerciseRecord,
  InterestRecord,
  LessonRecord,
  MarketDataset,
  Meta,
  ProjectRecord,
  ReviewRecord,
} from '../storage/types.ts';

export interface LearnerData {
  files: Map<string, ModuleFile>;
  /** Модули, которые не удалось загрузить (например, нет сети и они не скачаны). */
  unavailable: string[];
  lessons: Map<string, LessonRecord>;
  exercises: Map<string, ExerciseRecord>;
  reviews: ReviewRecord[];
  attempts: AttemptRecord[];
  activity: ActivityRecord[];
  interests: Map<string, InterestRecord>;
  projects: Map<string, ProjectRecord>;
  /** Импортированные обзоры рынка, новые сверху. */
  market: MarketDataset[];
  meta: Meta;
}

/**
 * Данные ученика. Если хранилище недоступно, error объясняет почему (StorageUnavailableError),
 * а экран показывает сообщение вместо бесконечного «Загружаю…».
 */
export function useLearnerData(course: Course | null): { data: LearnerData | null; error: Error | null } {
  const version = useDataVersion();
  const [data, setData] = useState<LearnerData | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!course) return;
    let alive = true;
    (async () => {
      const files = new Map<string, ModuleFile>();
      const unavailable: string[] = [];
      await Promise.all(
        course.modules
          .filter((module) => module.file)
          .map(async (module) => {
            try {
              files.set(module.id, await loadModule(module));
            } catch {
              unavailable.push(module.id);
            }
          }),
      );
      const [lessons, exercises, reviews, attempts, activity, interests, projects, market, meta] = await Promise.all([
        getAllLessons(),
        getAllExercises(),
        getAllReviews(),
        getAttempts({}),
        getActivity(28),
        getInterests(),
        getAllProjects(),
        getMarketDatasets(),
        getMeta(),
      ]);
      if (!alive) return;
      setError(null);
      setData({
        files,
        unavailable,
        lessons: new Map(lessons.map((record) => [record.lessonId, record])),
        exercises: new Map(exercises.map((record) => [record.exerciseId, record])),
        reviews,
        attempts,
        activity,
        interests: new Map(interests.map((record) => [record.labId, record])),
        projects: new Map(projects.map((record) => [record.projectId, record])),
        market,
        meta,
      });
    })().catch((reason: unknown) => {
      if (alive) setError(reason instanceof Error ? reason : new Error(String(reason)));
    });
    return () => {
      alive = false;
    };
  }, [course, version]);

  return { data, error };
}
