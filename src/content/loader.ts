// Загрузка карты курса и уроков модулей. Файлы модулей имеют хеш в имени,
// поэтому их можно безопасно хранить в офлайн-кеше.

import { useEffect, useState } from 'react';
import type { Course, Lesson, ModuleFile, ModuleSummary } from './schema.ts';

const base = import.meta.env.BASE_URL;

let coursePromise: Promise<Course> | null = null;
const modulePromises = new Map<string, Promise<ModuleFile>>();

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(response.status === 503 ? 'offline' : `HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

export function loadCourse(): Promise<Course> {
  if (!coursePromise) {
    coursePromise = fetchJson<Course>(`${base}content/course.json`).catch((error: unknown) => {
      coursePromise = null;
      throw error;
    });
  }
  return coursePromise;
}

export function loadModule(module: ModuleSummary): Promise<ModuleFile> {
  if (!module.file) return Promise.reject(new Error('Материалы модуля ещё не готовы'));
  let promise = modulePromises.get(module.file);
  if (!promise) {
    promise = fetchJson<ModuleFile>(`${base}${module.file}`).catch((error: unknown) => {
      modulePromises.delete(module.file!);
      throw error;
    });
    modulePromises.set(module.file, promise);
  }
  return promise;
}

export function findLessonSummary(course: Course, lessonId: string) {
  for (const module of course.modules) {
    const index = module.lessons.findIndex((lesson) => lesson.id === lessonId);
    if (index >= 0) return { module, lesson: module.lessons[index], index };
  }
  return null;
}

export async function loadLesson(course: Course, lessonId: string): Promise<{ module: ModuleSummary; lesson: Lesson }> {
  const found = findLessonSummary(course, lessonId);
  if (!found) throw new Error('not-found');
  if (!found.lesson.ready) throw new Error('not-ready');
  const file = await loadModule(found.module);
  const lesson = file.lessons.find((item) => item.id === lessonId);
  if (!lesson) throw new Error('not-found');
  return { module: found.module, lesson };
}

/** Все готовые уроки курса по порядку. */
export function readyLessons(course: Course) {
  return course.modules.flatMap((module) =>
    module.lessons.filter((lesson) => lesson.ready).map((lesson) => ({ module, lesson })),
  );
}

export function nextLessonId(course: Course, lessonId: string): string | null {
  const all = readyLessons(course);
  const index = all.findIndex((item) => item.lesson.id === lessonId);
  return index >= 0 && index + 1 < all.length ? all[index + 1].lesson.id : null;
}

type Loadable<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; error: Error };

export function useLoadable<T>(load: () => Promise<T>, deps: unknown[]): Loadable<T> {
  const [state, setState] = useState<Loadable<T>>({ status: 'loading' });
  useEffect(() => {
    let alive = true;
    setState({ status: 'loading' });
    load().then(
      (value) => alive && setState({ status: 'ready', value }),
      (error: unknown) => alive && setState({ status: 'error', error: error instanceof Error ? error : new Error(String(error)) }),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}
