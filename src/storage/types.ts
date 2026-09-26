// Данные ученика, которые хранятся локально (IndexedDB) и попадают в экспорт.
// Меняя эти типы, увеличь SCHEMA_VERSION и добавь миграцию в db.ts и import.ts.

export const SCHEMA_VERSION = 1;
export const EXPORT_FORMAT = 'praktika-progress';

/** Сколько помощи понадобилось: 0 — сам, 1–3 — уровень подсказки, 4 — смотрел решение. */
export type HelpLevel = 0 | 1 | 2 | 3 | 4;

export type ThemeSetting = 'system' | 'light' | 'dark';

export interface Settings {
  theme: ThemeSetting;
  /** Размер текста урока, px. */
  lessonFontSize: 16 | 17 | 18 | 20;
  /** Размер кода, px. */
  codeFontSize: 14 | 15 | 16 | 18;
  coach: {
    /** course — «Подсказки курса» (офлайн, заранее написанные); ai — серверный адаптер ИИ. */
    mode: 'course' | 'ai';
    /** Адрес серверного адаптера наставника (не ключ API!). */
    endpoint: string;
    /** Токен доступа к собственному удалённому адаптеру (не ключ провайдера ИИ). */
    accessToken: string;
  };
  market: {
    /** Страна или рынок для обзоров, например «Россия» или «Международный фриланс». */
    region: string | null;
    /** Код валюты, например RUB, USD, EUR. */
    currency: string | null;
  };
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  lessonFontSize: 16,
  codeFontSize: 14,
  coach: { mode: 'course', endpoint: 'http://127.0.0.1:8787', accessToken: '' },
  market: { region: null, currency: null },
};

export interface Meta {
  currentLessonId: string | null;
  lastOpenedAt: number | null;
  /** Когда ученик впервые что-то сделал (для экрана прогресса). */
  firstActivityAt: number | null;
}

export const DEFAULT_META: Meta = { currentLessonId: null, lastOpenedAt: null, firstActivityAt: null };

export type ExerciseStatus = 'new' | 'attempted' | 'passed';

export interface ExerciseRecord {
  exerciseId: string;
  lessonId: string;
  /** Черновик кода. null — ученик ещё не менял стартовый код. */
  draft: string | null;
  draftUpdatedAt: number | null;
  status: ExerciseStatus;
  /** Число проверок («Проверить»). */
  checks: number;
  /** Число запусков («Запустить»). */
  runs: number;
  /** Сколько уровней подсказки открыто (0–3). */
  hintsShown: 0 | 1 | 2 | 3;
  solutionViewed: boolean;
  firstPassedAt: number | null;
  /** Помощь на момент первого успешного решения. */
  firstPassHelp: HelpLevel | null;
  lastCheckAt: number | null;
  updatedAt: number;
}

export type SelfCheck = 'understood' | 'partly' | 'not-yet';

export interface LessonRecord {
  lessonId: string;
  /** Текущий шаг (индекс в lesson.steps). */
  stepIndex: number;
  completedSteps: string[];
  startedAt: number;
  completedAt: number | null;
  predictions: Record<string, { answer: string; matched: boolean | null }>;
  orders: Record<string, { attempts: number; solved: boolean }>;
  quizzes: Record<string, { choice: number; correct: boolean }>;
  checklists: Record<string, string[]>;
  recap: { answer: string; selfCheck: SelfCheck | null } | null;
  updatedAt: number;
}

export interface AttemptRecord {
  /** Уникальный ключ попытки: `${exerciseId}:${at}` — помогает не дублировать при слиянии. */
  key: string;
  exerciseId: string;
  lessonId: string;
  at: number;
  kind: 'run' | 'check';
  passed: boolean;
  /** Тип ошибки Python или timeout / limit / output / rule. null — без ошибки. */
  errorType: string | null;
  failed: number;
  total: number;
}

export interface ActivityRecord {
  /** Дата по местному времени, YYYY-MM-DD. */
  date: string;
  activeMs: number;
}

export interface InterestRecord {
  labId: string;
  status: 'curious' | 'tried';
  liked: string;
  tiring: string;
  continue: 'yes' | 'maybe' | 'no' | null;
  updatedAt: number;
}

export interface ReviewRecord {
  /** Навык или задание, которое нужно повторить. */
  key: string;
  lessonId: string;
  exerciseId: string | null;
  /** Ступень расписания 0..3 → через 1, 3, 7, 14 дней. */
  stage: number;
  dueAt: number;
  reason: string;
  createdAt: number;
  updatedAt: number;
  doneAt: number | null;
}

export interface ProjectRecord {
  projectId: string;
  stagesDone: string[];
  notes: string;
  updatedAt: number;
}

/** Проверенный набор данных о рынке труда, импортированный вручную. */
export interface MarketEntry {
  lab: string;
  /** salary — зарплата в найме; hourly — ставка фрилансера за час; project — бюджет заказа. */
  type: 'salary' | 'hourly' | 'project';
  title: string;
  amountMin: number | null;
  amountMax: number | null;
  currency: string;
  period: 'month' | 'year' | 'hour' | 'project';
  region: string;
  level: string;
  publishedAt: string | null;
  checkedAt: string;
  url: string;
  sourceType: 'vacancy' | 'order' | 'statistics' | 'survey' | 'platform';
  /** Объявление — не то же самое, что выполненный контракт. */
  isOffer: boolean;
  note: string;
}

export interface MarketDataset {
  id: string;
  title: string;
  region: string;
  currency: string;
  importedAt: number;
  checkedAt: string;
  entries: MarketEntry[];
}

export interface CoachDraft {
  id: string;
  exerciseId: string | null;
  lessonId: string | null;
  text: string;
  createdAt: number;
}

/** Всё содержимое базы — формат экспорта и импорта. */
export interface ProgressData {
  settings: Settings;
  meta: Meta;
  exercises: ExerciseRecord[];
  lessons: LessonRecord[];
  attempts: AttemptRecord[];
  activity: ActivityRecord[];
  interests: InterestRecord[];
  reviews: ReviewRecord[];
  projects: ProjectRecord[];
  market: MarketDataset[];
  coachDrafts: CoachDraft[];
}

export interface ExportFile {
  format: typeof EXPORT_FORMAT;
  schemaVersion: number;
  exportedAt: string;
  app: { version: string; contentVersion: string | null };
  data: ProgressData;
}

export interface ImportPreview {
  ok: true;
  file: ExportFile;
  counts: { exercises: number; passed: number; lessons: number; attempts: number; days: number };
}

export interface ImportProblem {
  ok: false;
  /** Понятное объяснение для ученика. */
  message: string;
  details?: string;
}

export type ImportStrategy = 'merge' | 'replace';
