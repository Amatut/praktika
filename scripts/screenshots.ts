// Скриншоты ключевых экранов для визуальной проверки:
//   node scripts/screenshots.ts [--url=http://127.0.0.1:5173] [--widths=1440,390] [--themes=light,dark] [--screens=lesson-exercise]
// Нужен запущенный сервер (npm run dev или npm run preview). Снимки — в папке screenshots/.
// Шаги урока ищутся по типу (теория, пример, прогноз…) в материалах, которые отдаёт сервер, —
// номера шагов не зашиты и не разъезжаются с уроком. Кроме начальных экранов снимаются состояния
// после действий: проверенный порядок, ответ на прогноз, три подсказки, решение, итог урока.
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'screenshots');

function arg(name: string, fallback: string): string {
  const found = process.argv.find((value) => value.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
}

const baseUrl = arg('url', 'http://127.0.0.1:5173').replace(/\/$/, '');
const widths = arg('widths', '1440,1024,768,390,320').split(',').map(Number);
const themes = arg('themes', 'light,dark').split(',') as ('light' | 'dark')[];
const only = arg('screens', '').split(',').filter(Boolean);

const LESSON = 'm0-l1';

interface MaterialStep {
  type: string;
  exercise?: { solution: { code: string } };
}

/** Шаги урока из материалов, которые отдаёт сервер. */
async function lessonMaterial(lessonId: string): Promise<MaterialStep[]> {
  const course = (await (await fetch(`${baseUrl}/content/course.json`)).json()) as {
    modules: { file: string | null; lessons: { id: string }[] }[];
  };
  const module = course.modules.find((item) => item.lessons.some((lesson) => lesson.id === lessonId));
  if (!module?.file) throw new Error(`Урок ${lessonId} не найден в материалах сервера`);
  const file = (await (await fetch(`${baseUrl}/${module.file}`)).json()) as { lessons: { id: string; steps: MaterialStep[] }[] };
  const lesson = file.lessons.find((item) => item.id === lessonId);
  if (!lesson) throw new Error(`Урок ${lessonId} не найден в файле модуля`);
  return lesson.steps;
}

const material = await lessonMaterial(LESSON);
/** Номера шагов в адресе по типу шага: в адресе 0 — история, шаги идут с 1. */
const steps = new Map<string, number[]>();
material.forEach((step, index) => steps.set(step.type, [...(steps.get(step.type) ?? []), index + 1]));
/** Адрес шага: n-й шаг этого типа (с 0). */
function stepHash(type: string, n = 0): string {
  const index = steps.get(type)?.[n];
  if (index === undefined) throw new Error(`В уроке ${LESSON} нет шага ${type} №${n + 1}`);
  return `#/lesson/${LESSON}/${index}`;
}

/** Во вкладочном режиме (уже 900 px) наставник — отдельная вкладка. */
async function openCoach(page: Page, panes: boolean) {
  if (panes) await page.getByRole('tab', { name: 'Тренер' }).click();
}

async function failCheck(page: Page, panes: boolean) {
  if (panes) await page.getByRole('tab', { name: 'Код' }).click();
  const editor = page.locator('.cm-content').first();
  await editor.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('Print("Привет, Практика!")');
  await page.keyboard.press('Control+Enter');
  await page.locator('.test-list, .feedback').first().waitFor({ timeout: 90_000 });
  await page.waitForTimeout(300);
}

async function checkOrder(page: Page) {
  await page.getByRole('button', { name: 'Проверить порядок' }).click();
  await page.waitForTimeout(200);
}

async function answerPredict(page: Page) {
  // Варианты ответа или поле для своего — что есть в шаге.
  await page.locator('.step-card [role="radio"], .step-card textarea').first().waitFor();
  const option = page.getByRole('radio').first();
  if ((await option.count()) > 0) await option.click();
  else await page.locator('.step-card textarea').first().fill('Шаг 1');
  await page.getByRole('button', { name: /Проверить прогноз|Не знаю — покажи/ }).click();
  await page.locator('.step-result').first().waitFor({ timeout: 90_000 });
  await page.waitForTimeout(300);
}

async function showHints(page: Page, panes: boolean) {
  await openCoach(page, panes);
  for (let shown = 0; shown < 3; shown++) {
    await page.getByRole('button', { name: /Подсказка \d из 3/ }).click();
    await page.waitForTimeout(150);
  }
}

async function showSolution(page: Page, panes: boolean) {
  await openCoach(page, panes);
  await page.getByRole('button', { name: 'Показать решение' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Показать', exact: true }).click();
  await page.waitForTimeout(300);
}

/** Решает все задания урока эталонами: без этого «Завершить урок» недоступно. */
async function solveExercises(page: Page, panes: boolean) {
  for (const [index, step] of material.entries()) {
    if (!step.exercise) continue;
    await page.goto(`${baseUrl}/#/lesson/${LESSON}/${index + 1}`);
    if (panes) await page.getByRole('tab', { name: 'Код' }).click();
    const editor = page.locator('.cm-content').first();
    await editor.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Delete');
    // Вставка через буфер обмена не зависит от автозакрытия скобок и автоотступов.
    await editor.evaluate((element, text) => {
      const data = new DataTransfer();
      data.setData('text/plain', text);
      element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, step.exercise.solution.code);
    await page.getByRole('button', { name: 'Проверить', exact: true }).click();
    await page.getByText(/Все проверки пройдены/).first().waitFor({ timeout: 90_000 });
  }
  await page.goto(`${baseUrl}/${stepHash('recap')}`);
  await page.waitForLoadState('networkidle').catch(() => {});
}

async function finishLesson(page: Page, panes: boolean) {
  await solveExercises(page, panes);
  await page.locator('.step-card textarea').first().fill('Python выполняет строки сверху вниз, а цифры в кавычках — просто текст.');
  await page.getByRole('button', { name: 'Сравнить с ответом наставника' }).click();
  const self = page.locator('[aria-labelledby$="-self"] button').first();
  if ((await self.count()) > 0) await self.click();
  await page.getByRole('button', { name: 'Завершить урок' }).click();
  await page.waitForTimeout(400);
}

interface Screen {
  name: string;
  hash: string;
  prepare?: (page: Page, panes: boolean) => Promise<void>;
  /** Вкладки, которые снимаются отдельно во вкладочном режиме. */
  panes?: string[];
}

// Порядок важен: действия сохраняются в прогрессе браузера (подсказки, решение, итог урока),
// поэтому состояния, которые меняют прогресс, снимаются в конце.
const screens: Screen[] = [
  { name: 'today', hash: '#/' },
  { name: 'course', hash: '#/course' },
  { name: 'module', hash: '#/course/m0' },
  { name: 'lesson-intro', hash: `#/lesson/${LESSON}/0` },
  { name: 'lesson-order', hash: stepHash('order') },
  { name: 'lesson-order-checked', hash: stepHash('order'), prepare: checkOrder },
  { name: 'lesson-theory', hash: stepHash('theory') },
  { name: 'lesson-example', hash: stepHash('example') },
  { name: 'lesson-predict', hash: stepHash('predict') },
  { name: 'lesson-predict-answered', hash: stepHash('predict'), prepare: answerPredict },
  { name: 'lesson-exercise', hash: stepHash('exercise', 1), prepare: failCheck, panes: ['Код', 'Тренер'] },
  { name: 'lesson-exercise-hints', hash: stepHash('exercise', 2), prepare: showHints },
  { name: 'lesson-exercise-solution', hash: stepHash('exercise', 2), prepare: showSolution },
  { name: 'lesson-recap', hash: stepHash('recap') },
  { name: 'lesson-recap-finished', hash: stepHash('recap'), prepare: finishLesson },
  { name: 'directions', hash: '#/directions/automation' },
  { name: 'projects', hash: '#/projects' },
  { name: 'progress', hash: '#/progress' },
  { name: 'settings', hash: '#/settings' },
];

/** Горизонтальная прокрутка страницы — признак переполнения. На телефоне вьюпорт расширяется под содержимое. */
async function reportOverflow(page: Page, label: string, width: number) {
  const overflow = (await page.evaluate(() => document.documentElement.scrollWidth)) - width;
  if (overflow > 0) console.warn(`  ⚠ ${label} @${width}: горизонтальное переполнение ${overflow}px`);
}

async function capture(page: Page, file: string) {
  // CodeMirror измеряет строки, только когда редактор виден: без прокрутки к нему номера строк
  // на полностраничном снимке стоят по оценке и расходятся с кодом (у ученика такого нет).
  for (const editor of await page.locator('.cm-editor').all()) {
    if (await editor.isVisible()) {
      await editor.scrollIntoViewIfNeeded();
      await page.waitForTimeout(150);
    }
  }
  // Снимаем с верха страницы и без фокуса: так липкие панели стоят на своих местах.
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, 0);
  });
  await page.screenshot({ path: file, fullPage: true });
  console.log(`✓ ${path.relative(root, file)}`);
}

await mkdir(outDir, { recursive: true });
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'msedge' });
try {
  for (const theme of themes) {
    for (const width of widths) {
      const mobile = width < 768;
      const context = await browser.newContext({
        viewport: { width, height: mobile ? 800 : 900 },
        colorScheme: theme,
        isMobile: mobile,
        hasTouch: mobile,
        deviceScaleFactor: 1,
        locale: 'ru-RU',
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      for (const screen of screens) {
        if (only.length && !only.includes(screen.name)) continue;
        await page.goto(`${baseUrl}/${screen.hash}`);
        await page.waitForLoadState('networkidle').catch(() => {});
        await page.waitForTimeout(400);
        const panesMode = width < 900;
        if (screen.prepare) {
          try {
            await screen.prepare(page, panesMode);
          } catch (error) {
            console.warn(`  ⚠ ${screen.name} @${width}: состояние не подготовлено — ${(error as Error).message.split('\n')[0]}`);
          }
        }
        await capture(page, path.join(outDir, `${width}-${theme}-${screen.name}.png`));
        await reportOverflow(page, screen.name, width);
        if (panesMode && screen.panes) {
          for (const pane of screen.panes) {
            const tab = page.getByRole('tab', { name: pane });
            if ((await tab.count()) === 0) {
              console.warn(`  ⚠ ${screen.name} @${width}: нет вкладки «${pane}»`);
              continue;
            }
            await tab.first().click();
            await page.waitForTimeout(200);
            await capture(page, path.join(outDir, `${width}-${theme}-${screen.name}-${pane === 'Код' ? 'code' : 'coach'}.png`));
            await reportOverflow(page, `${screen.name} (${pane})`, width);
          }
        }
      }
      if (errors.length) console.warn(`  ⚠ ошибки на странице (${width}, ${theme}): ${errors.join(' | ')}`);
      await context.close();
    }
  }
} finally {
  await browser.close();
}
