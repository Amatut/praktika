// Окружение запуска из материалов: учебные файлы, базы SQLite, seed и ответы сети задания или шага.
// Одинаково для приложения («Запустить», «Проверить», примеры, прогнозы) и для проверки материалов.

import type { ExampleStep, Exercise, PredictStep } from '../content/schema.ts';
import type { RunEnvironment } from './types.ts';

type EnvironmentSource = Pick<Exercise, 'files' | 'databases' | 'seed' | 'http'>;

function compact(source: EnvironmentSource, filename?: string): RunEnvironment {
  const environment: RunEnvironment = {};
  if (filename) environment.filename = filename;
  if (source.files && Object.keys(source.files).length > 0) environment.files = source.files;
  if (source.databases && Object.keys(source.databases).length > 0) environment.databases = source.databases;
  if (source.seed !== undefined) environment.seed = source.seed;
  if (source.http && source.http.length > 0) environment.http = source.http;
  return environment;
}

/** Окружение задания: для «Запустить» и как основа проверки (тесты дополняют его своими полями). */
export function exerciseEnvironment(exercise: Exercise): RunEnvironment {
  return compact(exercise, exercise.filename);
}

/** Окружение примера или прогноза; undefined — у шага ничего такого нет. */
export function stepEnvironment(step: ExampleStep | PredictStep): RunEnvironment | undefined {
  const environment = compact(step);
  return Object.keys(environment).length > 0 ? environment : undefined;
}
