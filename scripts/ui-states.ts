// Общий список экранов и состояний для снимков (scripts/screenshots.ts) и аудита читаемости (scripts/ui-audit.ts).
// Шаги уроков ищутся по типу в материалах, которые отдаёт сервер, — номера шагов не зашиты.
// Порядок важен: состояния, меняющие прогресс, — в конце общей последовательности. Состояния с особым окружением
// (часы, офлайн, без IndexedDB, перехват запросов) идут каждое в своём контексте браузера (isolated).
import type { Browser, BrowserContext, Page } from '@playwright/test';

export type Theme = 'light' | 'dark';

interface MaterialStep {
  id: string;
  type: string;
  simpler?: unknown;
  exercise?: { id: string; noHintsBeforeAttempt?: boolean; solution: { code: string } };
}

export interface Materials {
  /** Шаги урока по порядку (без истории: в адресе история — 0, шаги идут с 1). */
  lessons: Map<string, MaterialStep[]>;
}

export interface StateContext {
  baseUrl: string;
  /** Узкая раскладка (< 900 px): у задания вкладки «Задание / Код / Наставник». */
  panes: boolean;
  width: number;
  materials: Materials;
}

export interface State {
  name: string;
  hash: string | ((materials: Materials) => string);
  prepare?: (page: Page, ctx: StateContext) => Promise<void>;
  /** Вкладки, которые во вкладочном режиме снимаются отдельно. */
  panes?: string[];
  /** Своё окружение: новый контекст браузера, init — до открытия страницы. */
  isolated?: boolean;
  init?: (context: BrowserContext, page: Page, ctx: StateContext) => Promise<void>;
  /** Не ждать загрузки сети (состояние «Загружаю курс…»). */
  fast?: boolean;
}

/** Размер окна для ширины: 1440 × 900, 1024 × 768, 768 × 1024, 390 × 844, 320 × 640. */
export function viewportFor(width: number): { width: number; height: number } {
  const heights: Record<number, number> = { 1440: 900, 1280: 800, 1024: 768, 768: 1024, 390: 844, 360: 780, 320: 640 };
  return { width, height: heights[width] ?? (width >= 900 ? 900 : 800) };
}

export const DEFAULT_WIDTHS = [1440, 1024, 768, 390, 320];
export const DEFAULT_THEMES: Theme[] = ['light', 'dark'];

// ------------------------------------------------------------ материалы уроков

export async function loadMaterials(baseUrl: string): Promise<Materials> {
  const course = (await (await fetch(`${baseUrl}/content/course.json`)).json()) as {
    modules: { id: string; file: string | null }[];
  };
  const lessons = new Map<string, MaterialStep[]>();
  for (const module of course.modules.slice(0, 3)) {
    if (!module.file) continue;
    const file = (await (await fetch(`${baseUrl}/${module.file}`)).json()) as { lessons: { id: string; steps: MaterialStep[] }[] };
    for (const lesson of file.lessons) lessons.set(lesson.id, lesson.steps);
  }
  return { lessons };
}

const LESSON = 'm0-l1';

/** Адрес n-го шага этого типа (с 0) в уроке; без урока — первый урок, где такой шаг есть. */
function stepHash(materials: Materials, type: string, n = 0, lessonId: string | null = LESSON): string {
  const candidates = lessonId ? [lessonId, ...[...materials.lessons.keys()].filter((id) => id !== lessonId)] : [...materials.lessons.keys()];
  for (const id of candidates) {
    const steps = materials.lessons.get(id) ?? [];
    const indexes = steps.flatMap((step, index) => (step.type === type ? [index] : []));
    if (indexes[n] !== undefined) return `#/lesson/${id}/${indexes[n] + 1}`;
  }
  throw new Error(`Нет шага ${type} №${n + 1}`);
}

/** Адрес задания по условию (например, самостоятельная работа). */
function exerciseHash(materials: Materials, test: (step: MaterialStep) => boolean): string {
  for (const [id, steps] of materials.lessons) {
    const index = steps.findIndex((step) => step.type === 'exercise' && test(step));
    if (index >= 0) return `#/lesson/${id}/${index + 1}`;
  }
  throw new Error('Нет подходящего задания');
}

function exerciseStep(materials: Materials, n: number): MaterialStep {
  const steps = materials.lessons.get(LESSON) ?? [];
  const step = steps.filter((item) => item.type === 'exercise')[n];
  if (!step?.exercise) throw new Error(`В уроке ${LESSON} нет задания №${n + 1}`);
  return step;
}

// ------------------------------------------------------------ действия

/** Вкладка части шага на телефоне (у задания): «Задание», «Код», «Наставник». */
export async function openPane(page: Page, pane: string): Promise<boolean> {
  // Вкладки появляются после загрузки урока: сразу после перехода их ещё может не быть.
  await page.getByRole('tab').first().waitFor({ timeout: 10_000 }).catch(() => {});
  const tab = page.getByRole('tab', { name: pane, exact: false });
  if ((await tab.count()) > 0 && (await tab.first().isVisible())) {
    await tab.first().click();
    await page.waitForTimeout(150);
    return true;
  }
  return false;
}

async function paste(page: Page, code: string) {
  const editor = page.locator('.cm-content').first();
  await editor.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  // Вставка через буфер обмена не зависит от автозакрытия скобок и автоотступов.
  await editor.evaluate((element, text) => {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, code);
}

async function setCode(page: Page, ctx: StateContext, code: string) {
  if (ctx.panes) await openPane(page, 'Код');
  await page.locator('.cm-content').first().waitFor({ timeout: 20_000 });
  await paste(page, code);
}

async function waitResults(page: Page) {
  await page.locator('.results-summary, .results-body .status-line, .test-list, .feedback').first().waitFor({ timeout: 90_000 });
  await page.waitForTimeout(300);
}

async function clickCheck(page: Page) {
  await page.getByRole('button', { name: 'Проверить', exact: true }).first().click();
}

async function clickRun(page: Page) {
  await page.getByRole('button', { name: 'Запустить', exact: true }).first().click();
}

async function failCheck(page: Page, ctx: StateContext) {
  await setCode(page, ctx, 'Print("Привет, Практика!")');
  await clickCheck(page);
  await waitResults(page);
}

async function openCoach(page: Page, ctx: StateContext) {
  // На 900–1199 у задания тоже вкладки «Задание | Наставник» (код справа): наставник открывается вкладкой.
  if (ctx.panes || ctx.width < 1200) await openPane(page, 'Наставник');
}

/** Открыть подсказки по одной, пока не открыто upTo. */
async function showHints(page: Page, ctx: StateContext, upTo: number) {
  await openCoach(page, ctx);
  for (let guard = 0; guard < 4; guard++) {
    const button = page.getByRole('button', { name: /Подсказка \d из 3/ }).first();
    if ((await button.count()) === 0) break;
    const text = (await button.textContent()) ?? '';
    const next = Number(/Подсказка (\d)/.exec(text)?.[1] ?? 9);
    if (next > upTo || !(await button.isEnabled())) break;
    await button.click();
    await page.waitForTimeout(150);
  }
}

async function showSolution(page: Page, ctx: StateContext) {
  await openCoach(page, ctx);
  await page.getByRole('button', { name: /Показать решение|^Решение$/ }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Показать', exact: true }).click();
  await page.waitForTimeout(300);
}

async function checkOrder(page: Page) {
  await page.getByRole('button', { name: 'Проверить порядок' }).click();
  await page.waitForTimeout(200);
}

async function answerPredict(page: Page) {
  await page.locator('.step-card [role="radio"], .step-card textarea').first().waitFor();
  const option = page.getByRole('radio').first();
  if ((await option.count()) > 0) await option.click();
  else await page.locator('.step-card textarea').first().fill('Шаг 1');
  await page.getByRole('button', { name: /Проверить прогноз|Не знаю — покажи/ }).click();
  await page.locator('.step-result').first().waitFor({ timeout: 90_000 });
  await page.waitForTimeout(300);
}

async function answerQuiz(page: Page) {
  await page.getByRole('radio').first().click();
  await page.getByRole('button', { name: 'Ответить' }).click();
  await page.locator('.step-result').first().waitFor({ timeout: 10_000 });
}

/** Решает все задания урока эталонами: без этого «Завершить урок» недоступно. */
async function solveExercises(page: Page, ctx: StateContext) {
  const steps = ctx.materials.lessons.get(LESSON) ?? [];
  for (const [index, step] of steps.entries()) {
    if (!step.exercise) continue;
    await page.goto(`${ctx.baseUrl}/#/lesson/${LESSON}/${index + 1}`);
    await setCode(page, ctx, step.exercise.solution.code);
    await clickCheck(page);
    await page.getByText(/Все проверки пройдены/).first().waitFor({ timeout: 90_000 });
  }
}

async function finishLesson(page: Page, ctx: StateContext) {
  await solveExercises(page, ctx);
  await page.goto(`${ctx.baseUrl}/${stepHash(ctx.materials, 'recap')}`);
  await page.locator('.step-card textarea').first().fill('Python выполняет строки сверху вниз, а цифры в кавычках — просто текст.');
  await page.getByRole('button', { name: 'Сравнить с ответом наставника' }).click();
  const self = page.locator('[aria-labelledby$="-self"] button').first();
  if ((await self.count()) > 0) await self.click();
  await page.getByRole('button', { name: 'Завершить урок' }).click();
  await page.waitForTimeout(400);
}

/** Учебное окружение заданию «Практика 1» урока 0.1 — как в e2e python-sandbox. */
async function withEnvironment(context: BrowserContext) {
  await context.route('**/content/modules/m0.*.json', async (route) => {
    const response = await route.fetch();
    const data = (await response.json()) as { lessons: { id: string; steps: { id: string; exercise?: Record<string, unknown> }[] }[] };
    const exercise = data.lessons.find((lesson) => lesson.id === 'm0-l1')?.steps.find((step) => step.id === 'practice-hello')?.exercise;
    if (exercise) {
      Object.assign(exercise, {
        files: { 'menu.txt': 'чай\nкофе\n' },
        databases: { 'shop.db': "CREATE TABLE orders (item TEXT, price INTEGER);\nINSERT INTO orders VALUES ('чай', 120), ('пирог', 250);" },
        seed: 7,
        http: [{ url: 'https://api.example.com/weather?city=Казань', json: { temp: 12 } }],
      });
    }
    await route.fulfill({ response, json: data });
  });
}

/**
 * Прогресс в модуле 0 прямо в IndexedDB (для «Курса» и «Модуля»): урок 0.1 освоен, 0.2 начат и открыт (текущий),
 * 0.3 пройден после просмотра решения («Нужна практика»). Задания берутся из материалов.
 */
async function seedModuleProgress(page: Page, ctx: StateContext) {
  await page.locator('main h1').first().waitFor({ timeout: 20_000 });
  const exercises = (lessonId: string) => (ctx.materials.lessons.get(lessonId) ?? []).flatMap((step) => (step.exercise ? [step.exercise.id] : []));
  await page.evaluate(
    async ({ l1, l3 }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('praktika');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const now = Date.now();
      const lesson = (lessonId: string, completed: boolean) => ({
        lessonId,
        stepIndex: completed ? 0 : 2,
        completedSteps: [],
        startedAt: now,
        completedAt: completed ? now : null,
        predictions: {},
        orders: {},
        quizzes: {},
        checklists: {},
        recap: completed ? { answer: 'Строки выполняются сверху вниз.', selfCheck: 'understood' } : null,
        updatedAt: now,
      });
      const passed = (exerciseId: string, lessonId: string, help: number) => ({
        exerciseId,
        lessonId,
        draft: null,
        draftUpdatedAt: null,
        status: 'passed',
        checks: 1,
        runs: 0,
        hintsShown: 0,
        solutionViewed: help === 4,
        firstPassedAt: now,
        firstPassHelp: help,
        lastCheckAt: now,
        updatedAt: now,
      });
      const tx = db.transaction(['lessons', 'exercises', 'kv'], 'readwrite');
      tx.objectStore('lessons').put(lesson('m0-l1', true));
      tx.objectStore('lessons').put(lesson('m0-l2', false));
      tx.objectStore('lessons').put(lesson('m0-l3', true));
      for (const id of l1) tx.objectStore('exercises').put(passed(id, 'm0-l1', 0));
      l3.forEach((id, index) => tx.objectStore('exercises').put(passed(id, 'm0-l3', index === 0 ? 4 : 0)));
      tx.objectStore('kv').put({ currentLessonId: 'm0-l2', lastOpenedAt: now, firstActivityAt: now }, 'meta');
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    { l1: exercises('m0-l1'), l3: exercises('m0-l3') },
  );
  await page.reload();
  await page.locator('main h1').first().waitFor({ timeout: 20_000 });
  await page.waitForTimeout(400);
}

/**
 * Прогресс ученика для экрана «Прогресс» прямо в IndexedDB: уроки 0.1 и 0.3 пройдены (0.3 — с решением и подсказкой),
 * 0.2 начат с неудачными попытками; повторяющиеся ошибки, повторение сегодня и через 3 дня, минуты за 6 дней из 14,
 * три отметки интересов. Задания берутся из материалов.
 */
async function seedLearnerData(page: Page, ctx: StateContext) {
  await page.locator('main h1').first().waitFor({ timeout: 20_000 });
  const exercises = (lessonId: string) => (ctx.materials.lessons.get(lessonId) ?? []).flatMap((step) => (step.exercise ? [step.exercise.id] : []));
  await page.evaluate(
    async ({ l1, l2, l3 }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('praktika');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const now = Date.now();
      const day = 24 * 3600 * 1000;
      const lesson = (lessonId: string, completed: boolean, at: number) => ({
        lessonId,
        stepIndex: completed ? 0 : 2,
        completedSteps: [],
        startedAt: at,
        completedAt: completed ? at : null,
        predictions: {},
        orders: {},
        quizzes: {},
        checklists: {},
        recap: completed ? { answer: 'Строки выполняются сверху вниз.', selfCheck: 'understood' } : null,
        updatedAt: at,
      });
      const exercise = (exerciseId: string, lessonId: string, help: number | null, at: number) => ({
        exerciseId,
        lessonId,
        draft: null,
        draftUpdatedAt: null,
        status: help === null ? 'attempted' : 'passed',
        checks: help === null ? 3 : 1 + help,
        runs: 1,
        hintsShown: help === null ? 1 : Math.min(help, 3),
        solutionViewed: help === 4,
        firstPassedAt: help === null ? null : at,
        firstPassHelp: help,
        lastCheckAt: at,
        updatedAt: at,
      });
      const attempt = (exerciseId: string, lessonId: string, errorType: string, at: number) => ({
        key: `${exerciseId}:${at}`,
        exerciseId,
        lessonId,
        at,
        kind: 'check',
        passed: false,
        errorType,
        failed: 1,
        total: 2,
      });
      const review = (key: string, lessonId: string, exerciseId: string | null, dueAt: number, reason: string) => ({
        key,
        lessonId,
        exerciseId,
        stage: 0,
        dueAt,
        reason,
        createdAt: now - 3 * day,
        updatedAt: now - 3 * day,
        doneAt: null,
      });
      const dateKey = (offset: number) => {
        const d = new Date(now - offset * day);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      };
      const tx = db.transaction(['lessons', 'exercises', 'attempts', 'reviews', 'activity', 'interests', 'kv'], 'readwrite');
      tx.objectStore('lessons').put(lesson('m0-l1', true, now - 6 * day));
      tx.objectStore('lessons').put(lesson('m0-l2', false, now - day));
      tx.objectStore('lessons').put(lesson('m0-l3', true, now - 2 * day));
      for (const id of l1) tx.objectStore('exercises').put(exercise(id, 'm0-l1', 0, now - 6 * day));
      if (l2[0]) tx.objectStore('exercises').put(exercise(l2[0], 'm0-l2', null, now - day));
      l3.forEach((id, index) => tx.objectStore('exercises').put(exercise(id, 'm0-l3', index === 0 ? 4 : 2, now - 2 * day)));
      const failed = l2[0] ?? l1[0];
      ['NameError', 'NameError', 'NameError', 'SyntaxError', 'SyntaxError', 'output'].forEach((type, index) =>
        tx.objectStore('attempts').put(attempt(failed, 'm0-l2', type, now - day - index * 60_000)),
      );
      if (l3[0]) tx.objectStore('reviews').put(review(`ex:${l3[0]}`, 'm0-l3', l3[0], now - 3600_000, 'Решено после просмотра решения'));
      tx.objectStore('reviews').put(review('lesson:m0-l1', 'm0-l1', null, now + 3 * day, 'Повторить тему урока'));
      [
        [13, 22],
        [10, 31],
        [6, 12],
        [2, 26],
        [1, 45],
        [0, 18],
      ].forEach(([offset, minutes]) => tx.objectStore('activity').put({ date: dateKey(offset), activeMs: minutes * 60_000 }));
      tx.objectStore('interests').put({ labId: 'automation', status: 'tried', liked: 'Боты, которые экономят время', tiring: 'Долго настраивать доступы', continue: 'yes', updatedAt: now });
      tx.objectStore('interests').put({ labId: 'data', status: 'curious', liked: '', tiring: '', continue: 'maybe', updatedAt: now });
      tx.objectStore('interests').put({ labId: 'games', status: 'curious', liked: '', tiring: '', continue: null, updatedAt: now });
      tx.objectStore('kv').put({ currentLessonId: 'm0-l2', lastOpenedAt: now, firstActivityAt: now - 13 * day }, 'meta');
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    { l1: exercises('m0-l1'), l2: exercises('m0-l2'), l3: exercises('m0-l3') },
  );
  await page.reload();
  await page.locator('main h1').first().waitFor({ timeout: 20_000 });
  await page.waitForTimeout(400);
}

/** Материалы пишутся: модуль 0 — «Готова часть» (урок 0.4 «Скоро», урок 0.3 «Не скачан»), последний модуль — «Пишется». */
async function withPlannedMaterials(context: BrowserContext) {
  await context.route('**/content/course.json', async (route) => {
    const response = await route.fetch();
    const data = (await response.json()) as { modules: { id: string; status: string; lessons: { id: string; ready: boolean }[] }[] };
    const first = data.modules[0];
    const last = data.modules[data.modules.length - 1];
    first.status = 'partial';
    const lastLesson = first.lessons[first.lessons.length - 1];
    if (lastLesson) lastLesson.ready = false;
    last.status = 'planned';
    for (const lesson of last.lessons) lesson.ready = false;
    await route.fulfill({ response, json: data });
  });
  await context.route('**/content/modules/m0.*.json', async (route) => {
    const response = await route.fetch();
    const data = (await response.json()) as { lessons: { id: string }[] };
    data.lessons = data.lessons.filter((lesson) => lesson.id !== 'm0-l3');
    await route.fulfill({ response, json: data });
  });
}

/** Настройки → «Сохранить в файл» → этот же файл в «Выбрать файл»: предпросмотр резервной копии. */
async function chooseBackup(page: Page) {
  const saved = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Сохранить в файл' }).click();
  const file = await (await saved).path();
  await page.locator('#settings-data input[type="file"]').setInputFiles(file);
  await page.locator('#settings-data .import-preview').waitFor({ timeout: 10_000 });
}

interface FakeOfflineManifest {
  python: { cache: string; files: { url: string }[] };
  modules: Record<string, { url: string }>;
}

/**
 * «Работа без сети» как в собранной версии. В режиме разработки offlineSupported() — false, поэтому модуль
 * src/pwa/offline.ts подменяется (PROD → true), а манифест собирается из course.json (объёмы — примерные).
 */
async function withOfflineBuild(context: BrowserContext, ctx: StateContext): Promise<FakeOfflineManifest> {
  await context.route(/\/src\/pwa\/offline\.ts(\?.*)?$/, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replaceAll('import.meta.env.PROD', 'true') });
  });
  const course = (await (await fetch(`${ctx.baseUrl}/content/course.json`)).json()) as { modules: { id: string; file: string | null }[] };
  const modules = Object.fromEntries(
    course.modules.filter((module) => module.file).map((module, index) => [module.id, { url: module.file!, bytes: 184_000 + index * 37_000 }]),
  );
  const manifest = {
    buildId: 'shots',
    shell: { cache: 'praktika-shell-shots', files: 48, bytes: 2_400_000 },
    python: {
      cache: 'praktika-python-shots',
      version: '314.0.7',
      bytes: 13_002_000,
      files: [
        { url: 'pyodide/pyodide.asm.wasm', bytes: 9_800_000 },
        { url: 'pyodide/pyodide.asm.js', bytes: 1_100_000 },
        { url: 'pyodide/python_stdlib.zip', bytes: 2_102_000 },
      ],
    },
    modules,
  };
  await context.route('**/offline-manifest.json', (route) => route.fulfill({ json: manifest }));
  return manifest;
}

/**
 * Положить «скачанное» прямо в Cache Storage и открыть раздел заново: python — Python целиком,
 * modules — уроки модулей (по порядку в курсе), stale — прежняя версия уроков модуля («Модуль обновился»).
 */
async function fillOfflineCache(page: Page, manifest: FakeOfflineManifest, fill: { python: boolean; modules: number[]; stale: number[] }) {
  await page.evaluate(
    async ({ manifest, fill }) => {
      const put = async (cache: string, url: string) => (await caches.open(cache)).put(new URL(`/${url}`, location.origin).href, new Response('x'));
      const ids = Object.keys(manifest.modules);
      if (fill.python) for (const file of manifest.python.files) await put(manifest.python.cache, file.url);
      for (const index of fill.modules) await put('praktika-content', manifest.modules[ids[index]].url);
      for (const index of fill.stale) await put('praktika-content', `content/modules/${ids[index]}.0ld0ld.json`);
    },
    { manifest, fill },
  );
  await page.reload();
  await page.locator('#settings-offline .bundle-row').first().waitFor({ timeout: 10_000 });
  await page.waitForTimeout(300);
}

async function clickIfPresent(page: Page, text: string | RegExp) {
  const target = page.getByText(text).first();
  if ((await target.count()) > 0 && (await target.isVisible())) await target.click();
}

const EXERCISE_PANES = ['Задание', 'Код', 'Наставник'];
const HELLO = (m: Materials) => stepHash(m, 'exercise', 0);

// ------------------------------------------------------------ состояния

export const states: State[] = [
  // Новый ученик, без прогресса.
  { name: 'today', hash: '#/' },
  { name: 'course', hash: '#/course' },
  { name: 'module', hash: '#/course/m0' },
  { name: 'module-missing', hash: '#/course/nope' },
  { name: 'projects', hash: '#/projects' },
  {
    name: 'projects-selected',
    hash: '#/projects',
    prepare: async (page) => {
      await page.locator('.lesson-row').nth(2).click();
      await page.waitForTimeout(300);
    },
  },
  { name: 'directions', hash: '#/directions/automation' },
  {
    name: 'directions-search-empty',
    hash: '#/directions/automation',
    prepare: async (page) => {
      await page.locator('input[type="search"]').first().fill('zzz');
      await page.waitForTimeout(200);
    },
  },
  { name: 'not-found', hash: '#/nope' },
  { name: 'lesson-missing', hash: '#/lesson/nope' },
  { name: 'settings', hash: '#/settings' },
  {
    name: 'settings-import-error',
    hash: '#/settings/data',
    prepare: async (page) => {
      await page.locator('#settings-data input[type="file"]').setInputFiles({
        name: 'broken.json',
        mimeType: 'application/json',
        buffer: Buffer.from('{ это не JSON'),
      });
      await page.getByText('Файл не импортирован').first().waitFor({ timeout: 5_000 });
    },
  },
  {
    name: 'settings-reset-dialog',
    hash: '#/settings/data',
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Сбросить прогресс' }).click();
      await page.getByRole('dialog').waitFor();
    },
  },

  // Урок: шаги до заданий.
  { name: 'lesson-intro', hash: `#/lesson/${LESSON}/0` },
  {
    name: 'lesson-intro-demo',
    hash: `#/lesson/${LESSON}/0`,
    prepare: async (page) => {
      const next = page.getByRole('button', { name: 'Следующая строка' });
      await next.click();
      await next.click();
      // Нажатие прокрутило панель к модели, и иллюстрация наполовину ушла под шапку урока. Аудит не учитывает,
      // что панель обрезает картинку, и видит в этом текст поверх картинки, — поэтому кадр снова с начала шага
      // (модель целиком видна в кадре «-full» и в проверке режима «страницей»).
      await page.evaluate(() => {
        for (const element of document.querySelectorAll('.workspace, .workspace .pane, .lesson-main')) element.scrollTop = 0;
      });
      await page.waitForTimeout(200);
    },
  },
  // Наглядные модели «Попробуй» в историях других уроков и шаги с особым видом. Свой контекст: прогресс
  // общего прогона (текущий урок, начатые уроки) они не меняют.
  { name: 'lesson-intro-debug', hash: '#/lesson/m0-l3/0', isolated: true },
  { name: 'lesson-intro-boxes', hash: '#/lesson/m1-l1/0', isolated: true },
  { name: 'lesson-intro-budget', hash: '#/lesson/m1-l2/0', isolated: true },
  { name: 'lesson-intro-message', hash: '#/lesson/m1-l3/0', isolated: true },
  { name: 'lesson-intro-sticker', hash: '#/lesson/m1-l4/0', isolated: true },
  { name: 'lesson-intro-types', hash: '#/lesson/m1-l5/0', isolated: true },
  { name: 'lesson-intro-receipt', hash: '#/lesson/m1-l6/0', isolated: true },
  { name: 'lesson-example-stdin', hash: (m) => stepHash(m, 'example', 0, 'm1-l4'), isolated: true },
  { name: 'lesson-predict-text', hash: (m) => stepHash(m, 'predict', 1, 'm1-l1'), isolated: true },
  { name: 'lesson-predict-text-answered', hash: (m) => stepHash(m, 'predict', 1, 'm1-l1'), isolated: true, prepare: answerPredict },
  { name: 'lesson-theory', hash: (m) => stepHash(m, 'theory') },
  {
    name: 'lesson-theory-simpler',
    hash: (m) => stepHash(m, 'theory'),
    prepare: async (page, ctx) => {
      await openCoach(page, ctx);
      await clickIfPresent(page, 'Объясни проще');
      await page.waitForTimeout(200);
    },
  },
  { name: 'lesson-example', hash: (m) => stepHash(m, 'example') },
  {
    name: 'lesson-example-run',
    hash: (m) => stepHash(m, 'example'),
    prepare: async (page) => {
      await clickRun(page);
      await page.locator('.console').first().waitFor({ timeout: 90_000 });
      await page.waitForTimeout(300);
    },
  },
  {
    name: 'lesson-example-note',
    hash: (m) => stepHash(m, 'example'),
    prepare: async (page) => {
      await page.locator('.note-btn').first().click();
      await page.waitForTimeout(200);
    },
  },
  { name: 'lesson-predict', hash: (m) => stepHash(m, 'predict') },
  { name: 'lesson-order', hash: (m) => stepHash(m, 'order') },
  { name: 'lesson-order-checked', hash: (m) => stepHash(m, 'order'), prepare: checkOrder },
  { name: 'lesson-quiz', hash: (m) => stepHash(m, 'quiz') },
  { name: 'lesson-checklist', hash: (m) => stepHash(m, 'checklist', 0, 'm0-l4') },

  // Задание.
  { name: 'lesson-exercise', hash: (m) => stepHash(m, 'exercise', 1), panes: EXERCISE_PANES },
  {
    name: 'lesson-exercise-selfstudy',
    hash: (m) => exerciseHash(m, (step) => step.exercise?.noHintsBeforeAttempt === true),
    panes: EXERCISE_PANES,
  },
  {
    name: 'lesson-exercise-output',
    hash: (m) => stepHash(m, 'exercise', 1),
    panes: EXERCISE_PANES,
    prepare: async (page, ctx) => {
      await setCode(page, ctx, 'print("Меню")\nprint("чай", 120)');
      await clickRun(page);
      await page.locator('.console').first().waitFor({ timeout: 90_000 });
      await page.waitForTimeout(300);
    },
  },
  { name: 'lesson-exercise-failed', hash: (m) => stepHash(m, 'exercise', 1), panes: EXERCISE_PANES, prepare: failCheck },
  // Ученик в середине урока: после неудачной проверки.
  { name: 'today-returning', hash: '#/' },
  {
    name: 'lesson-exercise-syntax',
    hash: (m) => stepHash(m, 'exercise', 1),
    panes: EXERCISE_PANES,
    prepare: async (page, ctx) => {
      await setCode(page, ctx, 'print("Меню)');
      await clickCheck(page);
      await waitResults(page);
      await openCoach(page, ctx);
      await clickIfPresent(page, 'Исходное сообщение Python');
    },
  },
  {
    name: 'lesson-exercise-timeout',
    hash: (m) => stepHash(m, 'exercise', 1),
    panes: EXERCISE_PANES,
    prepare: async (page, ctx) => {
      await setCode(page, ctx, 'while True:\n    pass');
      await clickCheck(page);
      await page.getByText(/дольше|остановлен/).first().waitFor({ timeout: 90_000 });
      await page.waitForTimeout(300);
    },
  },
  {
    name: 'lesson-exercise-hint1',
    hash: (m) => stepHash(m, 'exercise', 2),
    panes: EXERCISE_PANES,
    prepare: (page, ctx) => showHints(page, ctx, 1),
  },
  {
    name: 'lesson-exercise-hint2',
    hash: (m) => stepHash(m, 'exercise', 2),
    panes: EXERCISE_PANES,
    prepare: (page, ctx) => showHints(page, ctx, 2),
  },
  {
    name: 'lesson-exercise-hint3',
    hash: (m) => stepHash(m, 'exercise', 2),
    panes: EXERCISE_PANES,
    prepare: (page, ctx) => showHints(page, ctx, 3),
  },
  { name: 'lesson-exercise-solution', hash: (m) => stepHash(m, 'exercise', 2), panes: EXERCISE_PANES, prepare: showSolution },
  {
    name: 'lesson-exercise-passed',
    hash: HELLO,
    panes: EXERCISE_PANES,
    prepare: async (page, ctx) => {
      await setCode(page, ctx, exerciseStep(ctx.materials, 0).exercise!.solution.code);
      await clickCheck(page);
      await page.getByText(/Все проверки пройдены/).first().waitFor({ timeout: 90_000 });
      await page.waitForTimeout(300);
    },
  },

  // Шаги, которые меняют прогресс.
  {
    name: 'lesson-order-revealed',
    hash: (m) => stepHash(m, 'order'),
    prepare: async (page) => {
      await checkOrder(page);
      await checkOrder(page);
      await page.getByRole('button', { name: 'Показать ответ' }).click();
      await page.waitForTimeout(200);
    },
  },
  { name: 'lesson-quiz-answered', hash: (m) => stepHash(m, 'quiz'), prepare: answerQuiz },
  { name: 'lesson-predict-answered', hash: (m) => stepHash(m, 'predict'), prepare: answerPredict },
  { name: 'lesson-recap', hash: (m) => stepHash(m, 'recap') },
  { name: 'lesson-recap-finished', hash: (m) => stepHash(m, 'recap'), prepare: finishLesson },
  {
    // Самооценка «Пока нет»: под сегментом — «Тема — в повторении». Идёт после завершения урока (ответ уже сравнён).
    name: 'lesson-recap-selfcheck',
    hash: (m) => stepHash(m, 'recap'),
    prepare: async (page) => {
      await page.getByRole('radio', { name: 'Пока нет' }).click();
      await page.waitForTimeout(300);
    },
  },
  {
    // Иллюстрация истории крупно — диалог. Свой контекст: открытый диалог не переходит в следующее состояние.
    name: 'lesson-intro-zoom',
    hash: `#/lesson/${LESSON}/0`,
    isolated: true,
    prepare: async (page) => {
      await page.getByRole('button', { name: /^Увеличить иллюстрацию/ }).click();
      await page.getByRole('dialog').waitFor();
      await page.waitForTimeout(300);
    },
  },
  {
    // Итог в день повторения темы: «Пора повторить тему», ответ наставника закрыт. Тема попала в повторение через «Пока нет».
    name: 'lesson-recap-review',
    hash: (m) => stepHash(m, 'recap'),
    isolated: true,
    init: async (_context, page) => {
      await page.clock.setFixedTime(new Date('2026-09-26T10:00:00'));
    },
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Сравнить с ответом наставника' }).click();
      await page.getByRole('radio', { name: 'Пока нет' }).click();
      await page.waitForTimeout(300);
      await page.clock.setFixedTime(new Date('2026-09-28T10:00:00'));
      await page.reload();
      await page.getByText('Пора повторить тему').first().waitFor({ timeout: 20_000 });
    },
  },
  {
    // То же после «Сравнить с ответом наставника»: ответ наставника и два ответа повторения на месте самооценки.
    name: 'lesson-recap-review-answer',
    hash: (m) => stepHash(m, 'recap'),
    isolated: true,
    init: async (_context, page) => {
      await page.clock.setFixedTime(new Date('2026-09-26T10:00:00'));
    },
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Сравнить с ответом наставника' }).click();
      await page.getByRole('radio', { name: 'Пока нет' }).click();
      await page.waitForTimeout(300);
      await page.clock.setFixedTime(new Date('2026-09-28T10:00:00'));
      await page.reload();
      await page.getByText('Пора повторить тему').first().waitFor({ timeout: 20_000 });
      await page.getByRole('button', { name: 'Сравнить с ответом наставника' }).click();
      await page.getByRole('button', { name: 'Повторил — понимаю' }).waitFor();
      await page.waitForTimeout(200);
    },
  },
  {
    name: 'directions-market',
    hash: '#/directions/automation',
    prepare: async (page, ctx) => {
      await page.goto(`${ctx.baseUrl}/#/settings/market`);
      const load = page.locator('#settings-market').getByRole('button', { name: 'Загрузить' }).first();
      await load.waitFor({ timeout: 10_000 });
      await load.click();
      await page.getByText(/загружен: \d+ записей/).first().waitFor({ timeout: 20_000 });
      await page.goto(`${ctx.baseUrl}/#/directions/automation`);
      await page.waitForTimeout(400);
      await page.locator('#market-title').scrollIntoViewIfNeeded().catch(() => {});
    },
  },
  {
    name: 'directions-interest',
    hash: '#/directions/automation',
    prepare: async (page) => {
      // После directions-search-empty в поиске может остаться «zzz»: на телефоне документ тогда скрыт.
      const search = page.locator('input[type="search"]').first();
      if ((await search.count()) > 0 && (await search.inputValue()) !== '') await search.fill('');
      const interested = page.getByRole('button', { name: /Интересно, хочу попробовать/ });
      if ((await interested.count()) > 0) await interested.first().click();
      await page.getByLabel('Что понравилось?').fill('Боты, которые экономят время');
      await page.getByLabel('Что утомило или показалось скучным?').fill('Долго настраивать доступы');
      await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
      await page.getByText('Сохранено', { exact: true }).first().waitFor({ timeout: 5_000 });
      await page.locator('#interest-title').scrollIntoViewIfNeeded().catch(() => {});
    },
  },
  { name: 'progress', hash: '#/progress' },
  {
    name: 'settings-ai',
    hash: '#/settings/coach',
    prepare: async (page) => {
      // Диалог сброса из settings-reset-dialog (тот же экран, сменился только раздел) закрывает страницу.
      if (await page.getByRole('dialog').isVisible()) await page.keyboard.press('Escape');
      await page.getByRole('radio', { name: 'ИИ через сервер' }).click();
      await page.waitForTimeout(300);
    },
  },
  // Настройки с данными — каждое в своём контексте (меняют прогресс, рынок или режим наставника).
  {
    // Выбран файл резервной копии: предпросмотр, «Заменить текущий» и предупреждение.
    name: 'settings-import-preview',
    hash: '#/settings/data',
    isolated: true,
    prepare: async (page) => {
      await chooseBackup(page);
      await page.getByRole('radio', { name: 'Заменить текущий' }).click();
      await page.locator('#settings-data').scrollIntoViewIfNeeded();
    },
  },
  {
    // Импорт выполнен: сообщение и строка резервной копии «перед импортом».
    name: 'settings-import-done',
    hash: '#/settings/data',
    isolated: true,
    prepare: async (page) => {
      // Первый импорт в чистый профиль копию не создаёт (сохранять нечего), второй — создаёт.
      for (let round = 0; round < 2; round++) {
        await chooseBackup(page);
        await page.getByRole('button', { name: 'Объединить', exact: true }).click();
        await page.getByText(/Прогресс импортирован/).first().waitFor({ timeout: 10_000 });
      }
      await page.getByRole('button', { name: 'Восстановить' }).first().waitFor({ timeout: 10_000 });
      await page.locator('#settings-data').scrollIntoViewIfNeeded();
    },
  },
  {
    // Готовый обзор рынка загружен: сообщение со ссылкой, «Загружен», строка загруженного обзора.
    name: 'settings-market-loaded',
    hash: '#/settings/market',
    isolated: true,
    prepare: async (page) => {
      await page.locator('#settings-market').getByRole('button', { name: 'Загрузить' }).first().click();
      await page.getByText(/загружен: \d+ записей/).first().waitFor({ timeout: 15_000 });
      await page.locator('#settings-market').scrollIntoViewIfNeeded();
    },
  },
  {
    // Режим ИИ, сервер не запущен: «Проверить соединение» → ошибка.
    name: 'settings-ai-checked',
    hash: '#/settings/coach',
    isolated: true,
    prepare: async (page) => {
      await page.getByRole('radio', { name: 'ИИ через сервер' }).click();
      await page.getByRole('button', { name: 'Проверить соединение' }).click();
      await page.locator('#settings-coach .notice').first().waitFor({ timeout: 45_000 });
      await page.locator('#settings-coach').scrollIntoViewIfNeeded();
    },
  },
  (() => {
    // «Работа без сети» собранной версии: Python не скачан, у модуля 0 уроки есть (нужен только Python),
    // у модуля 1 — прежняя версия уроков, остальные не скачаны («включая Python»).
    let manifest: FakeOfflineManifest | null = null;
    return {
      name: 'settings-offline',
      hash: '#/settings/offline',
      isolated: true,
      init: async (context: BrowserContext, _page: Page, ctx: StateContext) => {
        manifest = await withOfflineBuild(context, ctx);
      },
      prepare: async (page: Page) => {
        if (manifest) await fillOfflineCache(page, manifest, { python: false, modules: [0], stale: [1] });
      },
    } satisfies State;
  })(),
  (() => {
    // То же, когда Python и модуль 0 скачаны: «Скачан», «Доступен без сети», «Удалить уроки».
    let manifest: FakeOfflineManifest | null = null;
    return {
      name: 'settings-offline-ready',
      hash: '#/settings/offline',
      isolated: true,
      init: async (context: BrowserContext, _page: Page, ctx: StateContext) => {
        manifest = await withOfflineBuild(context, ctx);
      },
      prepare: async (page: Page) => {
        if (manifest) await fillOfflineCache(page, manifest, { python: true, modules: [0], stale: [] });
      },
    } satisfies State;
  })(),

  // Особое окружение — каждое в своём контексте.
  {
    name: 'loading',
    hash: '#/',
    isolated: true,
    fast: true,
    init: async (context) => {
      // Метка для settle(): «Загружаю курс…» здесь — снимаемое состояние, а не медленная загрузка.
      await context.addInitScript(() => {
        (window as unknown as { __keepCourseLoading?: boolean }).__keepCourseLoading = true;
      });
      // Курс приходит через 20 с: под нагрузкой (параллельные прогоны) приложение успевает смонтироваться, а кадры
      // «окно» и «страницей» — сняться, пока курс ещё грузится.
      await context.route('**/content/course.json', async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 20_000));
        await route.continue().catch(() => {});
      });
    },
    // Кадр — когда оболочка уже на месте и пишет «Загружаю курс…», а не пустая страница до монтирования приложения.
    prepare: async (page) => {
      await page.getByText('Загружаю курс').first().waitFor({ timeout: 15_000 });
    },
  },
  {
    name: 'no-storage',
    hash: '#/',
    isolated: true,
    init: async (context) => {
      await context.addInitScript(() => {
        Object.defineProperty(window, 'indexedDB', { value: undefined, configurable: true });
      });
    },
  },
  {
    name: 'offline',
    hash: '#/',
    isolated: true,
    prepare: async (page) => {
      await page.context().setOffline(true);
      await page.waitForTimeout(300);
    },
  },
  {
    name: 'screen-error',
    hash: '#/',
    isolated: true,
    prepare: async (page, ctx) => {
      await page.route(/ProgressScreen/, (route) => route.abort());
      await page.goto(`${ctx.baseUrl}/#/progress`);
      await page.getByText('Не получилось открыть экран').first().waitFor({ timeout: 10_000 });
    },
  },
  {
    // Экран загрузился, но упал при отрисовке: «На этом экране что-то пошло не так» и «Подробности для разработчика».
    name: 'screen-error-crash',
    hash: '#/',
    isolated: true,
    prepare: async (page, ctx) => {
      await page.route(/\/src\/screens\/ProgressScreen\.tsx(\?.*)?$/, (route) =>
        route.fulfill({
          contentType: 'text/javascript',
          body: "export function ProgressScreen() { throw new TypeError(\"Cannot read properties of undefined (reading 'skills')\"); }",
        }),
      );
      await page.goto(`${ctx.baseUrl}/#/progress`);
      await page.getByText('На этом экране что-то пошло не так').first().waitFor({ timeout: 10_000 });
      await page.getByText('Подробности для разработчика').first().click();
    },
  },
  {
    name: 'lesson-exercise-loading',
    hash: (m) => stepHash(m, 'exercise', 1),
    panes: EXERCISE_PANES,
    isolated: true,
    init: async (context) => {
      // Загрузка Python не завершается до конца снимка.
      await context.route('**/pyodide/pyodide.asm.wasm', () => new Promise(() => {}));
    },
    prepare: async (page, ctx) => {
      await setCode(page, ctx, 'print("Меню")');
      await clickCheck(page);
      await page.waitForTimeout(1_000);
    },
  },
  {
    name: 'lesson-exercise-env',
    hash: HELLO,
    panes: EXERCISE_PANES,
    isolated: true,
    init: (context) => withEnvironment(context),
    prepare: async (page, ctx) => {
      if (ctx.panes) await openPane(page, 'Задание');
      await clickIfPresent(page, /Файлы задания/);
      await clickIfPresent(page, /База данных: shop\.db/);
      await page.waitForTimeout(200);
    },
  },
  {
    name: 'lesson-exercise-files',
    hash: HELLO,
    panes: EXERCISE_PANES,
    isolated: true,
    init: (context) => withEnvironment(context),
    prepare: async (page, ctx) => {
      await setCode(page, ctx, 'print(open("menu.txt", encoding="utf-8").read().split())\nopen("report.txt", "w", encoding="utf-8").write("итог: 370")');
      await clickRun(page);
      await page.locator('.console').first().waitFor({ timeout: 90_000 });
      await page.waitForTimeout(400);
    },
  },
  {
    name: 'lesson-exercise-ai',
    hash: (m) => stepHash(m, 'exercise', 1),
    panes: EXERCISE_PANES,
    isolated: true,
    prepare: async (page, ctx) => {
      await page.goto(`${ctx.baseUrl}/#/settings/coach`);
      await page.getByRole('radio', { name: 'ИИ через сервер' }).click();
      await page.waitForTimeout(300);
      await page.goto(`${ctx.baseUrl}/${stepHash(ctx.materials, 'exercise', 1)}`);
      await failCheck(page, ctx);
      await openCoach(page, ctx);
    },
  },
  {
    // «Остановить» во время проверки: «Проверка остановлена.», тест прерван.
    name: 'lesson-exercise-stopped',
    hash: (m) => stepHash(m, 'exercise', 1),
    panes: EXERCISE_PANES,
    isolated: true,
    prepare: async (page, ctx) => {
      await setCode(page, ctx, 'while True:\n    pass');
      await clickCheck(page);
      await page.getByRole('button', { name: 'Остановить', exact: true }).first().click({ timeout: 90_000 });
      await page.getByText('Проверка остановлена.').first().waitFor({ timeout: 30_000 });
      await page.waitForTimeout(300);
    },
  },
  {
    // Повторение начато («Решить заново»): стартовый код, «Повторение» и «Вернуть прежний код».
    name: 'lesson-exercise-review-mode',
    hash: HELLO,
    panes: EXERCISE_PANES,
    isolated: true,
    init: async (_context, page) => {
      await page.clock.setFixedTime(new Date('2026-09-26T10:00:00'));
    },
    prepare: async (page, ctx) => {
      await showSolution(page, ctx);
      await setCode(page, ctx, exerciseStep(ctx.materials, 0).exercise!.solution.code);
      await clickCheck(page);
      await page.getByText(/Все проверки пройдены/).first().waitFor({ timeout: 90_000 });
      await page.clock.setFixedTime(new Date('2026-09-28T10:00:00'));
      await page.reload();
      if (ctx.panes) await openPane(page, 'Задание');
      await page.getByRole('button', { name: 'Решить заново' }).first().click({ timeout: 20_000 });
      await page.waitForTimeout(300);
    },
  },
  {
    // Задание с input() (урок 1.5 «Выручка за день»): «Ввод для „Запустить“» раскрыт, несколько тестов не прошли.
    name: 'lesson-exercise-stdin',
    hash: (m) => exerciseHash(m, (step) => step.id === 'practice-revenue'),
    panes: EXERCISE_PANES,
    isolated: true,
    prepare: async (page, ctx) => {
      await setCode(page, ctx, 'morning = input("Выручка за утро: ")\nevening = input("Выручка за вечер: ")\nprint(int(morning + evening))');
      await clickCheck(page);
      await waitResults(page);
      const stdin = page.locator('details.stdin > summary').first();
      if ((await stdin.count()) > 0) await stdin.click();
      await page.waitForTimeout(200);
    },
  },
  // «Сегодня» в разных состояниях ученика — каждое в своём контексте (в общей последовательности today — новый ученик).
  {
    // Урок в процессе, текущий шаг — не задание (адрес «0.1 · Идея», цель урока и кнопка).
    name: 'today-step',
    hash: (m) => stepHash(m, 'theory'),
    isolated: true,
    prepare: async (page, ctx) => {
      await page.locator('main h1').first().waitFor({ timeout: 20_000 });
      await page.waitForTimeout(600);
      await page.goto(`${ctx.baseUrl}/#/`);
      await page.locator('.today-resume').waitFor({ timeout: 20_000 });
    },
  },
  {
    // Урок в процессе на задании: черновик, проверка не прошла — превью кода и бейдж проверки.
    name: 'today-exercise',
    hash: (m) => stepHash(m, 'exercise', 1),
    isolated: true,
    prepare: async (page, ctx) => {
      await failCheck(page, ctx);
      await page.goto(`${ctx.baseUrl}/#/`);
      await page.locator('.today-resume').waitFor({ timeout: 20_000 });
    },
  },
  {
    // Всё повторено: повторение назначено на завтра — «Ближайшее повторение — …».
    name: 'today-review',
    hash: HELLO,
    isolated: true,
    init: async (_context, page) => {
      await page.clock.setFixedTime(new Date('2026-09-26T10:00:00'));
    },
    prepare: async (page, ctx) => {
      await showSolution(page, ctx);
      await setCode(page, ctx, exerciseStep(ctx.materials, 0).exercise!.solution.code);
      await clickCheck(page);
      await page.getByText(/Все проверки пройдены/).first().waitFor({ timeout: 90_000 });
      await page.goto(`${ctx.baseUrl}/#/`);
      await page.getByText(/Ближайшее повторение/).first().waitFor({ timeout: 20_000 });
    },
  },
  {
    // Пора повторить: через два дня задание в списке «На повторение».
    name: 'today-review-due',
    hash: HELLO,
    isolated: true,
    init: async (_context, page) => {
      await page.clock.setFixedTime(new Date('2026-09-26T10:00:00'));
    },
    prepare: async (page, ctx) => {
      await showSolution(page, ctx);
      await setCode(page, ctx, exerciseStep(ctx.materials, 0).exercise!.solution.code);
      await clickCheck(page);
      await page.getByText(/Все проверки пройдены/).first().waitFor({ timeout: 90_000 });
      await page.clock.setFixedTime(new Date('2026-09-28T10:00:00'));
      await page.goto(`${ctx.baseUrl}/#/`);
      await page.reload();
      await page.locator('.today-review .rows a.row').first().waitFor({ timeout: 20_000 });
    },
  },
  {
    // Все готовые уроки пройдены; 24 минуты сегодня; отмечен интерес к направлению. Записи — прямо в IndexedDB.
    name: 'today-done',
    hash: '#/',
    isolated: true,
    prepare: async (page) => {
      await page.locator('.today-resume').waitFor({ timeout: 20_000 });
      await page.evaluate(async () => {
        const course = (await (await fetch('content/course.json')).json()) as { modules: { lessons: { id: string; ready: boolean }[] }[] };
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('praktika');
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const now = Date.now();
        const tx = db.transaction(['lessons', 'activity', 'interests'], 'readwrite');
        for (const lesson of course.modules.flatMap((module) => module.lessons).filter((item) => item.ready)) {
          tx.objectStore('lessons').put({
            lessonId: lesson.id,
            stepIndex: 0,
            completedSteps: [],
            startedAt: now,
            completedAt: now,
            predictions: {},
            orders: {},
            quizzes: {},
            checklists: {},
            recap: null,
            updatedAt: now,
          });
        }
        const d = new Date();
        const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        tx.objectStore('activity').put({ date, activeMs: 24 * 60_000 });
        tx.objectStore('interests').put({ labId: 'data', status: 'curious', liked: '', tiring: '', continue: null, updatedAt: now });
        await new Promise((resolve, reject) => {
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
        });
        db.close();
      });
      await page.reload();
      await page.getByText('Готовые уроки пройдены').first().waitFor({ timeout: 20_000 });
    },
  },
  // «Курс», «Модуль», «Проекты» с прогрессом и с неготовыми материалами — каждое в своём контексте.
  // «Прогресс» с данными: навыки с доказательствами, ошибки, повторение, минуты, интересы.
  { name: 'progress-data', hash: '#/progress', isolated: true, prepare: seedLearnerData },
  { name: 'course-progress', hash: '#/course', isolated: true, prepare: seedModuleProgress },
  { name: 'module-progress', hash: '#/course/m0', isolated: true, prepare: seedModuleProgress },
  { name: 'course-planned', hash: '#/course', isolated: true, init: (context) => withPlannedMaterials(context) },
  { name: 'module-planned', hash: '#/course/m0', isolated: true, init: (context) => withPlannedMaterials(context) },
  {
    // Отмечены этапы: у проекта 1 — два, у проекта 2 — все (галочка в лестнице); записи «Мои решения» сохранены.
    name: 'projects-progress',
    hash: '#/projects',
    isolated: true,
    prepare: async (page) => {
      await page.locator('#project-title').waitFor({ timeout: 20_000 });
      await page.evaluate(async () => {
        const course = (await (await fetch('content/course.json')).json()) as { projects: { id: string; stages: { id: string }[] }[] };
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('praktika');
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const now = Date.now();
        const [first, second] = course.projects;
        const tx = db.transaction(['projects'], 'readwrite');
        tx.objectStore('projects').put({ projectId: first.id, stagesDone: first.stages.slice(0, 2).map((stage) => stage.id), notes: '', updatedAt: now });
        tx.objectStore('projects').put({ projectId: second.id, stagesDone: second.stages.map((stage) => stage.id), notes: '', updatedAt: now });
        await new Promise((resolve, reject) => {
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
        });
        db.close();
      });
      await page.reload();
      await page.locator('#project-notes').fill('План: меню, ввод, проверка ответа. Пришлось разделить подсчёт очков на функцию.');
      await page.getByText('Сохранено', { exact: true }).first().waitFor({ timeout: 5_000 });
    },
  },
  {
    name: 'lesson-exercise-review',
    hash: HELLO,
    panes: EXERCISE_PANES,
    isolated: true,
    init: async (_context, page) => {
      await page.clock.setFixedTime(new Date('2026-09-26T10:00:00'));
    },
    prepare: async (page, ctx) => {
      await showSolution(page, ctx);
      await setCode(page, ctx, exerciseStep(ctx.materials, 0).exercise!.solution.code);
      await clickCheck(page);
      await page.getByText(/Все проверки пройдены/).first().waitFor({ timeout: 90_000 });
      await page.clock.setFixedTime(new Date('2026-09-28T10:00:00'));
      await page.reload();
      await page.getByText('Пора повторить').first().waitFor({ timeout: 20_000 });
      if (ctx.panes) await openPane(page, 'Задание');
    },
  },
];

// ------------------------------------------------------------ прогон

/** Выбор состояний: имена через запятую, допускается префикс со звёздочкой (lesson-exercise*). */
export function selectStates(only: string[]): State[] {
  if (only.length === 0) return states;
  return states.filter((state) =>
    only.some((pattern) => (pattern.endsWith('*') ? state.name.startsWith(pattern.slice(0, -1)) : state.name === pattern)),
  );
}

export interface Frame {
  page: Page;
  state: State;
  theme: Theme;
  width: number;
  /** Вкладка части шага (телефон), null — без выбора вкладки. */
  pane: string | null;
  ctx: StateContext;
}

async function openState(page: Page, state: State, ctx: StateContext) {
  const hash = typeof state.hash === 'function' ? state.hash(ctx.materials) : state.hash;
  await page.goto(`${ctx.baseUrl}/${hash}`, { waitUntil: state.fast ? 'commit' : 'load' });
  if (state.fast) {
    await page.waitForTimeout(700);
    return;
  }
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(400);
  await scrollToStart(page);
}

/** Прокрутить все прокручиваемые области к началу: каждое состояние начинается с верха экрана. */
async function scrollToStart(page: Page) {
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    for (const element of document.querySelectorAll<HTMLElement>('*')) {
      if (element.scrollTop > 0 || element.scrollLeft > 0) element.scrollTo(0, 0);
    }
  });
}

/**
 * Проходит выбранные состояния для каждой темы и ширины и вызывает onFrame в каждом кадре:
 * состояние целиком и (на телефоне) каждая вкладка задания. Ошибки подготовки — предупреждение, кадр всё равно снимается.
 */
export async function runStates(options: {
  browser: Browser;
  baseUrl: string;
  widths: number[];
  themes: Theme[];
  only: string[];
  onFrame: (frame: Frame) => Promise<void>;
  onWarning?: (message: string) => void;
}) {
  const { browser, baseUrl, widths, themes, onFrame } = options;
  const warn = options.onWarning ?? ((message: string) => console.warn(`  ⚠ ${message}`));
  const materials = await loadMaterials(baseUrl);
  const selected = selectStates(options.only);

  for (const theme of themes) {
    for (const width of widths) {
      const ctx: StateContext = { baseUrl, panes: width < 900, width, materials };
      const newContext = () =>
        browser.newContext({
          viewport: viewportFor(width),
          colorScheme: theme,
          isMobile: width < 900,
          hasTouch: width < 900,
          deviceScaleFactor: 1,
          locale: 'ru-RU',
          serviceWorkers: 'block',
        });

      const runOne = async (page: Page, state: State) => {
        try {
          await openState(page, state, ctx);
          if (state.prepare) await state.prepare(page, ctx);
        } catch (error) {
          warn(`${state.name} @${width} ${theme}: состояние не подготовлено — ${(error as Error).message.split('\n')[0]}`);
        }
        await onFrame({ page, state, theme, width, pane: null, ctx });
        if (ctx.panes && state.panes) {
          for (const pane of state.panes) {
            if (!(await openPane(page, pane))) {
              warn(`${state.name} @${width} ${theme}: нет вкладки «${pane}»`);
              continue;
            }
            await onFrame({ page, state, theme, width, pane, ctx });
          }
        }
      };

      const shared = selected.filter((state) => !state.isolated);
      if (shared.length > 0) {
        const context = await newContext();
        const page = await context.newPage();
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        for (const state of shared) await runOne(page, state);
        if (errors.length) warn(`ошибки на странице (${width}, ${theme}): ${[...new Set(errors)].join(' | ')}`);
        await context.close();
      }

      for (const state of selected.filter((item) => item.isolated)) {
        const context = await newContext();
        const page = await context.newPage();
        try {
          if (state.init) await state.init(context, page, ctx);
        } catch (error) {
          warn(`${state.name} @${width} ${theme}: окружение не подготовлено — ${(error as Error).message.split('\n')[0]}`);
        }
        await runOne(page, state);
        await context.close();
      }
    }
  }
}

/** Слаг вкладки для имени файла. */
export function paneSlug(pane: string): string {
  return ({ Задание: 'task', Код: 'code', Наставник: 'coach' } as Record<string, string>)[pane] ?? pane;
}

/** Две отрисовки браузера: раскладка после смены стилей уже применена (надёжнее фиксированной паузы). */
async function nextFrames(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

/**
 * Перед кадром: дождаться, пока экран откроется, снять фокус (кольцо фокуса не мешает снимку) и дать CodeMirror
 * дорисовать строки. Пока грузится часть экрана, React показывает прежний экран, затем «Открываю…»: ждём, чтобы
 * оболочка показывала экран из адреса (data-screen) и его содержимое уже было на месте.
 */
export async function settle(page: Page) {
  await page
    .waitForFunction(
      () => {
        const [first, second] = location.hash.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean);
        const expected =
          !first || first === 'today'
            ? 'today'
            : first === 'course' || first === 'lesson'
              ? second
                ? first === 'course'
                  ? 'module'
                  : 'lesson'
                : 'course'
              : ['projects', 'directions', 'progress', 'settings'].includes(first)
                ? first
                : 'not-found';
        const app = document.querySelector('.app');
        const main = document.querySelector('main');
        if (!app || !main) return true;
        const text = main.textContent ?? '';
        // «Загружаю курс…» снимаем только в состоянии loading (там загрузка курса задержана нарочно).
        if (/^\s*Загружаю курс/.test(text)) return Boolean((window as unknown as { __keepCourseLoading?: boolean }).__keepCourseLoading);
        if (app.getAttribute('data-screen') !== expected) return false;
        // «Открываю…» — часть экрана грузится; «Загружаю…» — данные ученика.
        if (/^\s*(Открываю|Загружаю…)/.test(text)) return false;
        // Пока грузится часть экрана, React какое-то время показывает прежний экран: ждём разметку нужного.
        const own: Record<string, string> = {
          today: '[class*="today-"], .empty-title',
          course: '.cmap-rows',
          module: '.module-head, .empty-title',
          projects: '.projects-ladder',
          directions: '.dir-rows, .dir-empty, .dir-doc',
          progress: '[class*="prog-"], .empty-title',
          settings: '#settings-body',
          lesson: '.workspace .lesson-main > *, .empty-title',
          'not-found': '.empty-title',
        };
        return Boolean(main.querySelector(`${own[expected]}, .screen-error`));
      },
      undefined,
      { timeout: 30_000 },
    )
    .catch(() => {});
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.waitForTimeout(300);
  // Плавная прокрутка (например, к документу направления на телефоне) под нагрузкой не успевает закончиться:
  // ждём, пока положения прокрутки не перестанут меняться (не дольше 2 с).
  await page
    .evaluate(
      () =>
        new Promise<void>((resolve) => {
          const snapshot = () =>
            [document.scrollingElement, ...document.querySelectorAll('main, main *')]
              .filter((element): element is Element => !!element && (element.scrollTop > 0 || element.scrollLeft > 0))
              .map((element) => `${element.scrollTop}:${element.scrollLeft}`)
              .join('|');
          const started = performance.now();
          let last = snapshot();
          const tick = () => {
            const now = snapshot();
            if (now === last || performance.now() - started > 2000) resolve();
            else {
              last = now;
              setTimeout(() => requestAnimationFrame(tick), 100);
            }
          };
          setTimeout(() => requestAnimationFrame(tick), 100);
        }),
    )
    .catch(() => {});
}

/** Режим «страницей»: окно не держит высоту, видно всё содержимое панелей (раздел 2.5 спецификации). */
export async function setPageMode(page: Page, on: boolean) {
  await page.evaluate((value) => {
    if (value) document.documentElement.dataset.scroll = 'page';
    else delete document.documentElement.dataset.scroll;
  }, on);
  await nextFrames(page);
}
