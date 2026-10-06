// Снимки экранов и состояний для визуальной проверки:
//   node scripts/screenshots.ts [--url=http://127.0.0.1:5173] [--widths=1440,1024,768,390,320] [--themes=light,dark]
//                               [--screens=today,lesson-exercise*] [--full=0]
// Нужен запущенный сервер (npm run dev или npm run preview). Снимки — в папке screenshots/.
// Список состояний — общий с аудитом читаемости: scripts/ui-states.ts.
// Приложение занимает ровно окно, поэтому на каждое состояние два кадра: {width}-{theme}-{state}[-{pane}].png —
// как видит ученик (окно), и …-full.png — в режиме «страницей» (data-scroll='page'), где видно всё содержимое панелей.
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from '@playwright/test';
import { DEFAULT_THEMES, DEFAULT_WIDTHS, paneSlug, runStates, setPageMode, settle, type Theme } from './ui-states.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'screenshots');

function arg(name: string, fallback: string): string {
  const found = process.argv.find((value) => value.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
}

const baseUrl = arg('url', 'http://127.0.0.1:5173').replace(/\/$/, '');
const widths = arg('widths', DEFAULT_WIDTHS.join(',')).split(',').map(Number);
const themes = arg('themes', DEFAULT_THEMES.join(',')).split(',') as Theme[];
const only = arg('screens', '').split(',').filter(Boolean);
const full = arg('full', '1') !== '0';

/** Предупреждения: переполнение страницы и элементы, вылезающие из своей области без прокрутки. */
async function reportOverflow(page: Page, label: string) {
  const problems = await page.evaluate(() => {
    const found: string[] = [];
    const overflow = document.documentElement.scrollWidth - window.innerWidth;
    if (overflow > 0) found.push(`горизонтальное переполнение страницы ${overflow}px`);
    for (const element of document.querySelectorAll<HTMLElement>('main *')) {
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      if (!/(auto|scroll|hidden|clip)/.test(style.overflowX) && element.scrollWidth > element.clientWidth + 1 && element.clientWidth > 0) {
        const parent = element.parentElement;
        if (parent && element.getBoundingClientRect().right > parent.getBoundingClientRect().right + 1) {
          const name = element.className && typeof element.className === 'string' ? `.${element.className.split(' ')[0]}` : element.tagName.toLowerCase();
          found.push(`${name} шире своей области на ${element.scrollWidth - element.clientWidth}px`);
        }
      }
      if (found.length > 6) break;
    }
    return found;
  });
  for (const problem of problems) console.warn(`  ⚠ ${label}: ${problem}`);
}

async function capture(page: Page, file: string, fullPage: boolean) {
  await settle(page);
  await page.screenshot({ path: file, fullPage });
  console.log(`✓ ${path.relative(root, file)}`);
}

await mkdir(outDir, { recursive: true });
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'msedge' });
try {
  await runStates({
    browser,
    baseUrl,
    widths,
    themes,
    only,
    onFrame: async ({ page, state, theme, width, pane }) => {
      const name = `${width}-${theme}-${state.name}${pane ? `-${paneSlug(pane)}` : ''}`;
      await capture(page, path.join(outDir, `${name}.png`), false);
      await reportOverflow(page, `${state.name}${pane ? ` (${pane})` : ''} @${width} ${theme}`);
      if (full) {
        await setPageMode(page, true);
        await capture(page, path.join(outDir, `${name}-full.png`), true);
        await setPageMode(page, false);
      }
    },
  });
} finally {
  await browser.close();
}
