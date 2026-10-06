// Аудит читаемости интерфейса («текст не сливается с фоном и с другим текстом»):
//   node scripts/ui-audit.ts [--url=http://127.0.0.1:5173] [--screens=today,lesson-exercise*] [--widths=1440,1024,768,390,320]
//                            [--themes=light,dark] [--out=screenshots/audit] [--warn-only] [--strict] [--modes=window,page]
//   node scripts/ui-audit.ts --self-test   — проверка самого аудита на специально испорченной странице (scripts/ui-audit-fixture.html)
// Состояния — общие со снимками (scripts/ui-states.ts). Для каждого кадра страница проверяется в режиме окна и в режиме
// «страницей» (data-scroll='page'); проверки текстов — одним page.evaluate. Итог — список «экран · ширина · тема · селектор ·
// проблема · значения», JSON в screenshots/ui-audit.json и снимки кадров с находками в --out (красные рамки).
// Код выхода 1 при ошибках (кроме --warn-only).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from '@playwright/test';
import { DEFAULT_THEMES, DEFAULT_WIDTHS, paneSlug, runStates, setPageMode, settle, type Theme } from './ui-states.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(name: string, fallback: string): string {
  const found = process.argv.find((value) => value.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

/**
 * Поясняющие фразы, которых в интерфейсе быть не должно (правка пользователя 1). Проверяется только текст интерфейса:
 * учебное содержание (.prose, .story, разбор, подсказки, код, вывод, рынок, ответ ИИ) исключено. Пополняется при находках.
 */
export const FORBIDDEN = [
  'заранее написаны авторами',
  'можно идти дальше',
  'можно вернуться к заданию позже',
  'сначала подсказка, полное решение',
  'пропуск дня',
  'пропущенный день',
  'место остановки',
  'попробуй сначала сам',
  'здесь появятся',
  'это нормально',
  'можно менять и запускать',
  'без оценки',
  'учебное пространство',
  'мой маршрут',
  'сохраняется автоматически',
  'приложение не придумывает',
  'разберёмся',
  'интерес хранится отдельно',
  'готовность приложения и полнота курса',
  'повторение не сгорает',
  'задание подождёт',
];

type Severity = 'error' | 'warn';

interface RawFinding {
  rule: string;
  severity: Severity;
  selector: string;
  text: string;
  value: string;
  expected: string;
  /** Прямоугольник в координатах документа — для рамки на снимке. */
  rect: [number, number, number, number] | null;
  /** Метка элемента страницы самопроверки (data-expect / data-clean), в приложении — null. */
  marker: string | null;
}

interface AuditOptions {
  mode: 'window' | 'page';
  forbidden: string[];
  strict: boolean;
  touch: boolean;
  covered: boolean;
  focusOnly: boolean;
  /** Ширина окна: на телефоне видимая область расширяется под переполненное содержимое, innerWidth не годится. */
  viewportWidth: number;
}

interface AuditResult {
  findings: RawFinding[];
  unchecked: { selector: string; text: string }[];
  focus?: { selector: string; ok: boolean; problem: string; inEditor: boolean } | null;
}

/**
 * Проверка страницы. Выполняется в браузере (page.evaluate): всё нужное — внутри функции.
 * Видимый текст — текстовые узлы с ненулевыми прямоугольниками, видимостью, суммарной прозрачностью > 0.1,
 * не скрытые обрезкой (visually-hidden, свёрнутые блоки). Фон — первый непрозрачный фон вверх по дереву,
 * полупрозрачные слои сводятся; текст на картинке или градиенте — отдельный список «не проверено».
 */
function auditPage(opts: AuditOptions): AuditResult {
  const findings: RawFinding[] = [];
  const unchecked: { selector: string; text: string }[] = [];
  type RGBA = [number, number, number, number];
  type Box = { left: number; top: number; right: number; bottom: number };

  // ---------------------------------------------------------------- цвета
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const g = canvas.getContext('2d', { willReadFrequently: true })!;
  const colorCache = new Map<string, RGBA>();
  function parseColor(input: string): RGBA {
    const key = input.trim();
    const cached = colorCache.get(key);
    if (cached) return cached;
    let result: RGBA;
    const match = /^rgba?\(([^)]+)\)$/.exec(key);
    if (match) {
      const parts = match[1].split(/[\s,/]+/).filter(Boolean);
      const channel = (value: string) => (value.endsWith('%') ? (parseFloat(value) * 255) / 100 : parseFloat(value));
      const alpha = parts[3] === undefined ? 1 : parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
      result = [channel(parts[0]), channel(parts[1]), channel(parts[2]), alpha];
    } else {
      g.clearRect(0, 0, 1, 1);
      g.fillStyle = '#000';
      g.fillStyle = key;
      g.fillRect(0, 0, 1, 1);
      const data = g.getImageData(0, 0, 1, 1).data;
      result = [data[0], data[1], data[2], data[3] / 255];
    }
    colorCache.set(key, result);
    return result;
  }
  function blend(top: RGBA, bottom: RGBA): RGBA {
    const a = top[3];
    return [top[0] * a + bottom[0] * (1 - a), top[1] * a + bottom[1] * (1 - a), top[2] * a + bottom[2] * (1 - a), 1];
  }
  function luminance(color: RGBA): number {
    const [r, gg, b] = [color[0], color[1], color[2]].map((value) => {
      const c = value / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * gg + 0.0722 * b;
  }
  function contrast(a: RGBA, b: RGBA): number {
    const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (light + 0.05) / (dark + 0.05);
  }
  const hex = (c: RGBA) => '#' + [c[0], c[1], c[2]].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  const sameColor = (a: RGBA, b: RGBA | null) => !!b && Math.abs(a[0] - b[0]) <= 1 && Math.abs(a[1] - b[1]) <= 1 && Math.abs(a[2] - b[2]) <= 1;

  const rootStyle = getComputedStyle(document.documentElement);
  const token = (name: string): RGBA | null => {
    const value = rootStyle.getPropertyValue(name).trim();
    return value ? parseColor(value) : null;
  };
  const TEXT = token('--text');
  const TEXT2 = token('--text-2');
  const TEXT3 = token('--text-3');

  // ---------------------------------------------------------------- кеши по элементам
  const styleCache = new Map<Element, CSSStyleDeclaration>();
  const style = (el: Element) => {
    let cs = styleCache.get(el);
    if (!cs) {
      cs = getComputedStyle(el);
      styleCache.set(el, cs);
    }
    return cs;
  };

  const opacityCache = new Map<Element, number>();
  function opacity(el: Element | null): number {
    if (!el) return 1;
    const cached = opacityCache.get(el);
    if (cached !== undefined) return cached;
    const value = parseFloat(style(el).opacity || '1') * opacity(el.parentElement);
    opacityCache.set(el, value);
    return value;
  }

  const backdropCache = new Map<Element, { color: RGBA; media: Element | null }>();
  function backdrop(el: Element): { color: RGBA; media: Element | null } {
    const cached = backdropCache.get(el);
    if (cached) return cached;
    const cs = style(el);
    let result: { color: RGBA; media: Element | null };
    if (cs.backgroundImage && cs.backgroundImage !== 'none' && !/^url\(["']?data:image\/svg/.test(cs.backgroundImage)) {
      result = { color: [255, 255, 255, 1], media: el };
    } else {
      const own = parseColor(cs.backgroundColor);
      if (own[3] >= 0.99) result = { color: own, media: null };
      else {
        const below = el.parentElement ? backdrop(el.parentElement) : { color: parseColor(style(document.documentElement).backgroundColor || '#fff') as RGBA, media: null };
        const base: RGBA = below.color[3] >= 0.99 ? below.color : blend(below.color, [255, 255, 255, 1]);
        result = { color: own[3] > 0 ? blend(own, base) : base, media: below.media };
      }
    }
    backdropCache.set(el, result);
    return result;
  }

  function selectorOf(el: Element): string {
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && parts.length < 4 && node !== document.body && node !== document.documentElement) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift(`${part}#${node.id}`);
        break;
      }
      const classes = [...node.classList].filter((name) => !name.startsWith('ͼ')).slice(0, 2);
      if (classes.length) part += '.' + classes.join('.');
      parts.unshift(part);
      if (node.matches('main, .app, dialog')) break;
      node = node.parentElement;
    }
    return parts.join(' > ');
  }
  /** Элемент действительно отрисован: без display: none у предков, свёрнутых <details>, visibility и прозрачности. */
  const rendered = (el: Element) =>
    typeof el.checkVisibility === 'function'
      ? el.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true })
      : style(el).display !== 'none' && style(el).visibility === 'visible';
  const markerOf = (el: Element | null) => (el?.closest('[data-expect], [data-clean]') as HTMLElement | null)?.id || null;

  function rectOf(box: Box | DOMRect | null): [number, number, number, number] | null {
    if (!box) return null;
    return [box.left + window.scrollX, box.top + window.scrollY, box.right - box.left, box.bottom - box.top];
  }
  function add(rule: string, severity: Severity, el: Element, text: string, value: string, expected: string, box: Box | DOMRect | null) {
    findings.push({
      rule,
      severity,
      selector: selectorOf(el),
      text: text.replace(/\s+/g, ' ').trim().slice(0, 60),
      value,
      expected,
      rect: rectOf(box ?? el.getBoundingClientRect()),
      marker: markerOf(el),
    });
  }

  // ---------------------------------------------------------------- обрезка
  const intersect = (a: Box, b: Box): Box | null => {
    const box = { left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) };
    return box.right > box.left && box.bottom > box.top ? box : null;
  };
  const INFINITE: Box = { left: -1e9, top: -1e9, right: 1e9, bottom: 1e9 };
  const viewport: Box = opts.mode === 'window' ? { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight } : INFINITE;

  /** Жёсткая обрезка (overflow hidden/clip, clip) и обрезка прокруткой (auto/scroll) — отдельно. */
  const clipCache = new Map<Element, { hard: Box | null; scroll: Box | null }>();
  function clipOf(el: Element | null): { hard: Box | null; scroll: Box | null } {
    if (!el || el === document.documentElement) return { hard: INFINITE, scroll: viewport };
    const cached = clipCache.get(el);
    if (cached) return cached;
    const parent = clipOf(el.parentElement);
    let { hard, scroll } = parent;
    const cs = style(el);
    const position = cs.position;
    if (position === 'fixed') {
      hard = INFINITE;
      scroll = viewport;
    }
    if (cs.clip && cs.clip !== 'auto' && position === 'absolute') hard = null;
    const ox = cs.overflowX;
    const oy = cs.overflowY;
    if (hard && (ox !== 'visible' || oy !== 'visible')) {
      const r = el.getBoundingClientRect();
      const box: Box = {
        left: ox === 'visible' ? -1e9 : r.left,
        right: ox === 'visible' ? 1e9 : r.right,
        top: oy === 'visible' ? -1e9 : r.top,
        bottom: oy === 'visible' ? 1e9 : r.bottom,
      };
      const scrolls = /(auto|scroll)/.test(ox) || /(auto|scroll)/.test(oy);
      if (scrolls) {
        // Внутри прокручиваемой области содержимое за краем не скрыто, а прокручено: внешние жёсткие обрезки
        // (например, окно приложения с overflow: hidden) для него — обрезка прокруткой.
        const own = intersect(hard, box);
        if (!own || r.width < 1 || r.height < 1) hard = null;
        else {
          scroll = scroll ? intersect(scroll, own) : null;
          hard = INFINITE;
        }
      } else {
        hard = intersect(hard, box);
        // Контейнер в 1 px (visually-hidden) — содержимое скрыто.
        if (hard && (r.width <= 1 || r.height <= 1)) hard = null;
      }
    }
    const result = { hard, scroll };
    clipCache.set(el, result);
    return result;
  }

  // ---------------------------------------------------------------- видимый текст
  const scope: Element = document.querySelector('dialog:modal') ?? document.body;
  interface Item {
    node: Text;
    el: Element;
    text: string;
    /** Прямоугольники строк без обрезки — для правила «обрезанный текст». */
    raw: Box[];
    rects: Box[];
    geo: Box[];
    fontSize: number;
    cs: CSSStyleDeclaration;
  }
  const items: Item[] = [];
  const range = document.createRange();

  function geometry(node: Text, el: Element): { raw: Box[]; rects: Box[]; geo: Box[] } | null {
    range.selectNodeContents(node);
    const rects = [...range.getClientRects()].filter((r) => r.width >= 1 && r.height >= 1).map((r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom }));
    if (rects.length === 0) return null;
    const clip = clipOf(el);
    if (!clip.hard) return null;
    const visible = rects.map((r) => intersect(r, clip.hard!)).filter((r): r is Box => !!r && r.right - r.left > 1 && r.bottom - r.top > 1);
    if (visible.length === 0) return null;
    const geo = clip.scroll ? visible.map((r) => intersect(r, clip.scroll!)).filter((r): r is Box => !!r) : [];
    return { raw: rects, rects: visible, geo };
  }

  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  for (let node = opts.focusOnly ? null : (walker.nextNode() as Text | null); node; node = walker.nextNode() as Text | null) {
    const text = node.data.replace(/\s+/g, ' ').trim();
    if (!text || text === '​') continue;
    const el = node.parentElement;
    if (!el || el.closest('script, style, noscript, template, svg, title, option, datalist')) continue;
    const cs = style(el);
    if (cs.visibility !== 'visible' || cs.display === 'none') continue;
    if (opacity(el) <= 0.1) continue;
    // Свёрнутые <details>, content-visibility: hidden и т. п. — не видны, хотя прямоугольники у них есть.
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true })) continue;
    const geo = geometry(node, el);
    if (!geo) continue;
    items.push({ node, el, text, raw: geo.raw, rects: geo.rects, geo: geo.geo, fontSize: parseFloat(cs.fontSize), cs });
  }

  const CONTENT = '.prose, .story, .feedback, .hint-card, .solution, .code-block, .cm-editor, .console, .io-block, .market-table, .ai-answer, pre';
  const CODE = '.cm-content, pre, code, .code-block, .console, .io-block';
  const LESSON_TEXT = '.prose, .story, .feedback dd, .hint-card, .option-text';
  const words = (text: string) => text.split(/\s+/).filter((word) => /[\p{L}\d]/u.test(word)).length;
  const isInteractive = 'a[href], button, [role="tab"], input:not([type="hidden"]), select, textarea, summary, [role="radio"]';

  if (!opts.focusOnly) {
    // ---------------------------------------------------------------- правила по каждому тексту
    const media = [...scope.querySelectorAll('img, video, canvas')]
      .filter((el) => style(el).visibility === 'visible' && opacity(el) > 0.1)
      // Видимая часть картинки: прокрученная под шапку панели иллюстрация не «лежит» под текстом шапки.
      .map((el) => {
        const hard = clipOf(el).hard;
        return { el, box: hard ? intersect(el.getBoundingClientRect(), hard) : null };
      })
      .filter((m): m is { el: Element; box: Box } => !!m.box && m.box.right - m.box.left > 2 && m.box.bottom - m.box.top > 2);

    for (const item of items) {
      const { el, text, cs, fontSize } = item;
      const first = item.rects[0];
      const inCode = !!el.closest(CODE) && !el.closest('.code-ln, .cm-gutters, kbd');
      const inEditor = !!el.closest('.cm-editor');

      // 1. контраст
      const back = backdrop(el);
      const fgRaw = parseColor(cs.color);
      if (back.media) {
        unchecked.push({ selector: selectorOf(el), text: text.slice(0, 60) });
        add('text-over-media', 'error', el, text, `фон: ${style(back.media).backgroundImage.slice(0, 40)}`, 'текст на сплошном фоне', first);
      } else {
        const fg = blend([fgRaw[0], fgRaw[1], fgRaw[2], fgRaw[3] * opacity(el)], back.color);
        const ratio = contrast(fg, back.color);
        const weight = parseInt(cs.fontWeight, 10) || 400;
        const large = fontSize >= 24 || (fontSize >= 18.66 && weight >= 700);
        let min = large ? 3 : 4.5;
        let warnBelow = large ? 0 : 6;
        let role = 'цвет';
        if (inCode || inEditor) {
          const comment = !!el.closest('.tok-comment');
          min = comment ? 4.5 : 6;
          warnBelow = 0;
          role = comment ? 'комментарий' : 'код';
          if (el.closest('.code-ln, .cm-gutters')) {
            min = 4.5;
            role = 'номер строки';
          }
        } else if (sameColor(fgRaw, TEXT)) {
          min = 10;
          warnBelow = 0;
          role = '--text';
        } else if (sameColor(fgRaw, TEXT2)) {
          min = 7;
          warnBelow = 0;
          role = '--text-2';
        } else if (sameColor(fgRaw, TEXT3)) {
          min = 4.5;
          warnBelow = 0;
          role = '--text-3';
        }
        const value = `${ratio.toFixed(2)}:1 (${role} ${hex(fg)} на ${hex(back.color)})`;
        if (ratio < min - 0.005) add('contrast', 'error', el, text, value, `≥ ${min}:1`, first);
        else if (ratio < warnBelow - 0.005) add('contrast', 'warn', el, text, value, `лучше ≥ ${warnBelow}:1`, first);

        // 4. третичный цвет у фразы
        if (sameColor(fgRaw, TEXT3) && words(text) >= 3 && !el.closest('.code-ln, .cm-gutters, .n, .cm-placeholder, .cm-editor, .code-block')) {
          add('tertiary-phrase', 'error', el, text, `--text-3 у фразы из ${words(text)} слов`, 'фразы — --text или --text-2', first);
        }
      }

      // 2. текст поверх картинки
      for (const m of media) {
        if (m.el.contains(el) || el.contains(m.el)) continue;
        const hit = item.geo.some((r) => {
          const box = intersect(r, m.box);
          return box && box.right - box.left > 2 && box.bottom - box.top > 2;
        });
        if (hit) {
          add('text-over-media', 'error', el, text, `поверх ${selectorOf(m.el)}`, 'текст рядом с картинкой, не на ней', first);
          break;
        }
      }

      // 3. посторонний текст внутри редактора кода
      if (inEditor && el.closest('.cm-line')) {
        let node: Element | null = el;
        while (node && !node.classList.contains('cm-line')) {
          const foreign = [...node.classList].filter((name) => !/^(cm-|tok-|ͼ)/.test(name));
          if (foreign.length > 0 || (node.tagName !== 'SPAN' && node.tagName !== 'DIV')) {
            add('text-in-code', 'error', el, text, `элемент .${foreign.join('.') || node.tagName.toLowerCase()} в строке кода`, 'в строках кода — только код', first);
            break;
          }
          node = node.parentElement;
        }
      }

      // 5. кегль
      const minSize = inCode ? 14 : el.closest(LESSON_TEXT) && !el.closest('.code-ln') ? 16 : 13;
      if (fontSize < minSize - 0.01) {
        add('font-size', 'error', el, text, `${fontSize}px`, `≥ ${minSize}px (${minSize === 14 ? 'код' : minSize === 16 ? 'текст урока' : 'интерфейс'})`, first);
      }

      // 6. межстрочный у многострочного текста
      const lineTops = new Set(item.rects.filter((r) => r.bottom - r.top > fontSize * 0.5).map((r) => Math.round(r.top)));
      if (lineTops.size >= 2) {
        const lh = cs.lineHeight === 'normal' ? fontSize * 1.2 : parseFloat(cs.lineHeight);
        const ratio = lh / fontSize;
        const need = fontSize >= 18 ? 1.3 : 1.5;
        if (ratio < need - 0.01) add('line-height', 'error', el, text, `${lh.toFixed(1)}/${fontSize} = ${ratio.toFixed(2)}`, `≥ ${need}`, first);
      }

      // 7. капс
      if (cs.textTransform === 'uppercase') {
        if (words(text) > 2) add('caps', 'error', el, text, `капс, ${words(text)} слова`, 'капс — только метки из 1–2 слов', first);
        else if (fontSize < 13) add('caps', 'error', el, text, `капс ${fontSize}px`, '≥ 13px', first);
      }

      // 8. моноширинная фраза
      const family = cs.fontFamily.split(',')[0].toLowerCase();
      if (/mono|consolas|courier/.test(family) && (text.match(/[а-яё]{2,}/gi) ?? []).length >= 2) {
        if (!el.closest('code, pre, kbd, .cm-content, .cm-editor, .addr, .n, .console, .io-block, .code-block, .code-file-tab')) {
          add('mono-phrase', opts.strict ? 'error' : 'warn', el, text, 'моноширинный у фразы', 'моноширинный — код, адреса, числа', first);
        }
      }

      // 15. запрещённые поясняющие фразы
      if (!el.closest(CONTENT)) {
        const lower = text.toLowerCase();
        const phrase = opts.forbidden.find((item) => lower.includes(item));
        if (phrase) add('forbidden-text', 'error', el, text, `«${phrase}»`, 'интерфейс не объясняет сам себя', first);
      }
    }

    // ---------------------------------------------------------------- 9. перекрытие текстов, 3. текст поверх строк кода
    const geoItems = items.filter((item) => item.geo.length > 0);
    const BUCKET = 32;
    const buckets = new Map<number, { index: number; box: Box }[]>();
    geoItems.forEach((item, index) => {
      for (const box of item.geo) {
        for (let b = Math.floor(box.top / BUCKET); b <= Math.floor(box.bottom / BUCKET); b++) {
          const list = buckets.get(b) ?? [];
          list.push({ index, box });
          buckets.set(b, list);
        }
      }
    });
    const reported = new Set<string>();
    for (const list of buckets.values()) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = geoItems[list[i].index];
          const b = geoItems[list[j].index];
          if (a.el === b.el || a.el.contains(b.el) || b.el.contains(a.el)) continue;
          const box = intersect(list[i].box, list[j].box);
          if (!box || box.right - box.left <= 2 || box.bottom - box.top <= 2) continue;
          const key = `${list[i].index}:${list[j].index}`;
          if (reported.has(key)) continue;
          reported.add(key);
          const aCode = !!a.el.closest('.cm-line');
          const bCode = !!b.el.closest('.cm-line');
          if (aCode !== bCode && !(aCode ? b : a).el.closest('.cm-editor')) {
            const other = aCode ? b : a;
            add('text-in-code', 'error', other.el, other.text, `поверх строки кода «${(aCode ? a : b).text.slice(0, 30)}»`, 'объяснение — отдельным блоком', box);
          } else {
            add('overlap', 'error', a.el, a.text, `перекрывает «${b.text.slice(0, 30)}» (${selectorOf(b.el)})`, 'тексты не перекрываются', box);
          }
        }
      }
    }

    // Текст на чужом интерактивном элементе.
    const controls = [...scope.querySelectorAll(isInteractive)].filter((el) => rendered(el) && opacity(el) > 0.1 && !el.closest('.cm-editor'));
    for (const control of controls) {
      const clip = clipOf(control);
      if (!clip.hard || !clip.scroll) continue;
      const own = intersect(control.getBoundingClientRect(), clip.hard);
      const box = own && intersect(own, clip.scroll);
      if (!box) continue;
      for (const item of geoItems) {
        if (control.contains(item.el) || item.el.contains(control)) continue;
        const hit = item.geo.map((r) => intersect(r, box)).find((r) => r && r.right - r.left > 2 && r.bottom - r.top > 2);
        if (hit) {
          add('overlap', 'error', item.el, item.text, `лежит на ${selectorOf(control)}`, 'текст не заходит на чужую кнопку или поле', hit);
          break;
        }
      }
    }

    // ---------------------------------------------------------------- 10. зазор между соседними блоками текста
    const blockCache = new Map<Element, Element>();
    const blockOf = (el: Element): Element => {
      const cached = blockCache.get(el);
      if (cached) return cached;
      let node: Element = el;
      while (node.parentElement && /^(inline|contents)$/.test(style(node).display)) node = node.parentElement;
      blockCache.set(el, node);
      return node;
    };
    const lines = geoItems
      .filter((item) => !item.el.closest('.cm-editor, .code-block, pre, .console'))
      .flatMap((item) => item.geo.map((box) => ({ item, box })))
      .sort((a, b) => a.box.top - b.box.top);
    const spaced = new Set<string>();
    for (let i = 0; i < lines.length; i++) {
      const a = lines[i];
      for (let j = i + 1; j < lines.length; j++) {
        const b = lines[j];
        if (b.box.top > a.box.bottom + 8) break;
        if (b.box.top < a.box.bottom - 2) continue;
        const overlapX = Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left);
        if (overlapX <= 4) continue;
        const blockA = blockOf(a.item.el);
        const blockB = blockOf(b.item.el);
        if (blockA === blockB) break;
        const gap = b.box.top - a.box.bottom;
        const key = `${selectorOf(blockA)}|${selectorOf(blockB)}`;
        if (gap < 4 && !spaced.has(key)) {
          spaced.add(key);
          // Зазор между строками разных блоков меньше, чем между строками одного абзаца с межстрочным 1.4, — слипаются.
          add('spacing', gap < 1 ? 'error' : 'warn', b.item.el, b.item.text, `${gap.toFixed(1)}px до «${a.item.text.slice(0, 24)}»`, gap < 1 ? '≥ 1px (лучше отступ ≥ 8px)' : 'отступ ≥ 8px или линия', b.box);
        }
        break;
      }
    }

    // ---------------------------------------------------------------- 11. обрезанный текст
    for (const el of scope.querySelectorAll('*')) {
      const cs = style(el);
      if (cs.display === 'none' || cs.visibility !== 'visible') continue;
      const clamp = cs.getPropertyValue('-webkit-line-clamp');
      if (clamp && clamp !== 'none' && el.textContent?.trim()) {
        add('clip', 'error', el, el.textContent, `-webkit-line-clamp: ${clamp}`, 'многострочного обрезания нет', null);
        continue;
      }
      const ox = cs.overflowX;
      const oy = cs.overflowY;
      const hiddenX = ox === 'hidden' || ox === 'clip';
      const hiddenY = oy === 'hidden' || oy === 'clip';
      if (!hiddenX && !hiddenY) continue;
      const html = el as HTMLElement;
      const overX = hiddenX && html.scrollWidth > html.clientWidth + 1;
      const overY = hiddenY && html.scrollHeight > html.clientHeight + 1;
      if ((!overX && !overY) || !rendered(el)) continue;
      const box = el.getBoundingClientRect();
      if (box.width <= 1 || box.height <= 1 || !clipOf(el).hard) continue;
      const cut = items.find(
        (item) =>
          el.contains(item.node) &&
          item.raw.some((r) => (overX && (r.right > box.right + 1 || r.left < box.left - 1)) || (overY && (r.bottom > box.bottom + 1 || r.top < box.top - 1))),
      );
      if (!cut) continue;
      const ellipsis = cs.textOverflow === 'ellipsis' || style(cut.el).textOverflow === 'ellipsis';
      const titled = !!(cut.el.closest('[title], [aria-label]') && el.contains(cut.el.closest('[title], [aria-label]')!)) || el.closest('[title]');
      if (ellipsis && titled) continue;
      add('clip', 'error', el, cut.text, ellipsis ? 'многоточие без подсказки (title)' : `обрезано: ${html.scrollWidth}×${html.scrollHeight} в ${html.clientWidth}×${html.clientHeight}`, ellipsis ? 'title с полным текстом' : 'текст переносится, а не обрезается', box);
    }

    // ---------------------------------------------------------------- 11б. текст у края скрытой прокрутки вбок
    // Область прокручивается вбок, полосы прокрутки нет (scrollbar-width: none), маски затухания у края нет, а текст
    // пересекает её край: надпись обрезана посередине, и ничто не говорит, что дальше есть ещё. Код — со своей полосой.
    for (const el of scope.querySelectorAll('*')) {
      const cs = style(el);
      if (!/(auto|scroll)/.test(cs.overflowX) || cs.getPropertyValue('scrollbar-width') !== 'none') continue;
      const html = el as HTMLElement;
      if (html.scrollWidth <= html.clientWidth + 1 || !rendered(el) || el.closest(CODE)) continue;
      const mask = cs.getPropertyValue('mask-image') || cs.getPropertyValue('-webkit-mask-image');
      if (mask && mask !== 'none') continue;
      const box = el.getBoundingClientRect();
      if (box.width <= 1 || box.height <= 1 || !clipOf(el).hard) continue;
      const cut = items.find(
        (item) =>
          el.contains(item.node) &&
          item.raw.some((r) => (r.left < box.right - 1 && r.right > box.right + 1) || (r.left < box.left - 1 && r.right > box.left + 1)),
      );
      if (!cut) continue;
      add('scroll-edge', 'warn', el, cut.text, 'текст пересекает край области, прокрутки не видно', 'перенос (всё видно сразу) или маска затухания у края', box);
    }

    // ---------------------------------------------------------------- 12. горизонтальная прокрутка страницы
    const overflow = document.documentElement.scrollWidth - opts.viewportWidth;
    if (overflow > 1) {
      findings.push({ rule: 'page-overflow', severity: 'error', selector: 'html', text: '', value: `+${overflow}px`, expected: 'без горизонтальной прокрутки', rect: null, marker: null });
    }

    // ---------------------------------------------------------------- 13. касаемые элементы
    if (opts.touch) {
      for (const control of controls) {
        const box = control.getBoundingClientRect();
        if (box.width < 1 || box.height < 1 || !clipOf(control).hard) continue;
        if (box.width >= 43.5 && box.height >= 43.5) continue;
        if (control.tagName === 'A' && style(control).display === 'inline' && control.closest('p, li, dd, .prose')) continue;
        // Флажок или переключатель внутри подписи: цель касания — вся подпись.
        const label = control.closest('label');
        if (label && /^(checkbox|radio)$/.test((control as HTMLInputElement).type ?? '')) {
          const lb = label.getBoundingClientRect();
          if (lb.height >= 43.5) continue;
        }
        add('touch', 'error', control, control.textContent || control.getAttribute('aria-label') || '', `${Math.round(box.width)}×${Math.round(box.height)}`, '≥ 44×44', box);
      }
    }

    // ---------------------------------------------------------------- 14. статус только цветом
    const STATUS =
      '.badge-ok, .badge-err, .badge-warn, .badge-accent, .badge-good, .badge-error, .status-ok, .status-err, .status-warn, .status-good, .status-error, .status-muted, [data-state], [class^="st-"], [class*=" st-"]';
    for (const el of scope.querySelectorAll(STATUS)) {
      if (el.closest('svg') || el.matches('.flow-node, .step-chip, .flow-pop-item') || !rendered(el)) continue;
      const box = el.getBoundingClientRect();
      if (box.width < 2 || box.height < 2 || !clipOf(el).hard) continue;
      const hasIcon = !!el.querySelector('svg, img, .icon');
      const hasText = items.some((item) => el.contains(item.node));
      if (!hasIcon || !hasText) {
        add('status-color-only', 'error', el, el.textContent ?? '', hasIcon ? 'значок без слова' : 'слово без значка', 'значок + слово', box);
      }
    }

    // ---------------------------------------------------------------- 17. закреплённые панели поверх содержимого
    const bars = [...document.querySelectorAll('.bottombar, .statusbar, .topbar, .titlebar, .banners, .coach-foot, .dock, .lesson-dock, [data-bar]')].filter((bar) => {
      const box = bar.getBoundingClientRect();
      return rendered(bar) && box.width > 0 && box.height > 0;
    });
    for (const bar of bars) {
      const box = bar.getBoundingClientRect();
      const item = geoItems.find(
        (it) => !bar.contains(it.el) && !it.el.contains(bar) && !!it.el.closest('main') && it.geo.some((r) => {
          const hit = intersect(r, box);
          return hit && hit.right - hit.left > 2 && hit.bottom - hit.top > 2;
        }),
      );
      if (item) add('bars-overlap', 'error', item.el, item.text, `под ${selectorOf(bar)}`, 'закреплённые панели — строки сетки', item.geo[0]);
    }

    // ---------------------------------------------------------------- (ж) перекрытые элементы после прокрутки до конца
    if (opts.covered && opts.mode === 'window') {
      const coveredSeen = new Set<Element>();
      const probe = () => {
        clipCache.clear();
        const targets: { el: Element; box: Box; text: string }[] = [];
        for (const control of controls) {
          const clip = clipOf(control);
          if (!clip.hard || !clip.scroll) continue;
          const own = intersect(control.getBoundingClientRect(), clip.hard);
          const box = own && intersect(own, clip.scroll);
          if (box && box.right - box.left > 4 && box.bottom - box.top > 4) targets.push({ el: control, box, text: control.textContent || control.getAttribute('aria-label') || '' });
        }
        for (const item of items) {
          const geo = geometry(item.node, item.el);
          const box = geo?.geo[geo.geo.length - 1];
          if (box && box.right - box.left > 2 && box.bottom - box.top > 2) targets.push({ el: item.el, box, text: item.text });
        }
        for (const target of targets) {
          if (coveredSeen.has(target.el)) continue;
          const x = (target.box.left + target.box.right) / 2;
          const y = (target.box.top + target.box.bottom) / 2;
          if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) continue;
          const hit = document.elementFromPoint(x, y);
          if (!hit || hit === target.el || target.el.contains(hit) || hit.contains(target.el)) continue;
          // Подписи внутри одной кнопки или ссылки — не перекрытие.
          const control = target.el.closest(isInteractive);
          if (control && control.contains(hit)) continue;
          coveredSeen.add(target.el);
          add('covered', 'error', target.el, target.text, `закрыт ${selectorOf(hit)}`, 'ничего не закрывает кнопки и текст', target.box);
        }
      };
      const scrollers = [document.scrollingElement, ...scope.querySelectorAll('*')].filter((el): el is Element => {
        if (!el) return false;
        const html = el as HTMLElement;
        if (html.scrollHeight <= html.clientHeight + 1) return false;
        if (el === document.scrollingElement) return true;
        return /(auto|scroll)/.test(style(el).overflowY);
      });
      if (scrollers.length) {
        const saved = scrollers.map((el) => (el as HTMLElement).scrollTop);
        for (const el of scrollers) (el as HTMLElement).scrollTop = (el as HTMLElement).scrollHeight;
        probe();
        scrollers.forEach((el, index) => ((el as HTMLElement).scrollTop = saved[index]));
      } else probe();
    }
    return { findings, unchecked };
  }

  // ---------------------------------------------------------------- 16. фокус (одно значение за вызов)
  const active = document.activeElement;
  if (!active || active === document.body) return { findings, unchecked, focus: null };
  // Фокус в редакторе кода: кольцо рисует рамка .cm-editor (.cm-focused), а не .cm-content.
  const ringEl = active.closest('.cm-editor') ?? active;
  const cs = style(ringEl);
  const width = parseFloat(cs.outlineWidth) || 0;
  const offset = parseFloat(cs.outlineOffset) || 0;
  const ring = parseColor(cs.outlineColor);
  const back = offset < 0 || !ringEl.parentElement ? backdrop(ringEl) : backdrop(ringEl.parentElement);
  const behind = back.color;
  // Кольцо на картинке или градиенте не считается — фон неизвестен.
  const ratio = back.media ? 99 : contrast(blend(ring, behind), behind);
  let problem = '';
  if (cs.outlineStyle === 'none' || width < 2) problem = cs.outlineStyle === 'none' ? 'нет кольца фокуса (outline: none)' : `кольцо ${width}px`;
  else if (ratio < 3) problem = `контраст кольца ${ratio.toFixed(2)}:1`;
  if (problem) add('focus', 'error', active, active.textContent || active.getAttribute('aria-label') || '', problem, 'outline ≥ 2px, ≥ 3:1', null);
  return { findings, unchecked, focus: { selector: selectorOf(active), ok: !problem, problem, inEditor: !!active.closest('.cm-editor') } };
}

// ============================================================ прогон

interface Finding extends RawFinding {
  state: string;
  width: number;
  theme: Theme;
  pane: string | null;
  modes: string[];
}

const RULE_TITLE: Record<string, string> = {
  contrast: 'контраст',
  'text-over-media': 'текст поверх картинки или градиента',
  'text-in-code': 'текст поверх кода',
  'tertiary-phrase': 'третичный цвет у фразы',
  'font-size': 'мелкий кегль',
  'line-height': 'тесный межстрочный',
  caps: 'капс',
  'mono-phrase': 'моноширинная фраза',
  overlap: 'перекрытие',
  spacing: 'слипшиеся блоки',
  clip: 'обрезанный текст',
  'scroll-edge': 'текст у края скрытой прокрутки',
  'page-overflow': 'горизонтальная прокрутка страницы',
  touch: 'маленькая цель касания',
  'status-color-only': 'статус только цветом',
  'forbidden-text': 'поясняющий текст',
  focus: 'фокус',
  'bars-overlap': 'панель поверх содержимого',
  covered: 'перекрытый элемент',
};

async function drawOverlay(page: Page, rects: [number, number, number, number][]) {
  await page.evaluate((boxes) => {
    const layer = document.createElement('div');
    layer.id = '__ui_audit_overlay';
    layer.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none';
    for (const [x, y, w, h] of boxes) {
      const box = document.createElement('div');
      box.style.cssText = `position:absolute;left:${x - 2}px;top:${y - 2}px;width:${w + 4}px;height:${h + 4}px;outline:2px solid #ff0033;outline-offset:0;box-shadow:0 0 0 4px rgb(255 0 51 / 25%)`;
      layer.append(box);
    }
    document.body.append(layer);
  }, rects);
}

async function removeOverlay(page: Page) {
  await page.evaluate(() => document.getElementById('__ui_audit_overlay')?.remove());
}

/** Tab по странице: у каждого элемента в фокусе видимое кольцо (outline ≥ 2 px, ≥ 3:1). Из редактора кода — Esc, затем Tab. */
async function focusWalk(page: Page, options: AuditOptions): Promise<RawFinding[]> {
  const found: RawFinding[] = [];
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    window.getSelection()?.removeAllRanges();
  });
  const seen = new Set<string>();
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press('Tab');
    const result = await page.evaluate(auditPage, { ...options, focusOnly: true });
    if (!result.focus) continue;
    if (result.focus.inEditor) await page.keyboard.press('Escape');
    for (const finding of result.findings) {
      const key = `${finding.selector}|${finding.value}`;
      if (!seen.has(key)) {
        seen.add(key);
        found.push(finding);
      }
    }
  }
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  return found;
}

async function auditFrame(page: Page, options: { touch: boolean; strict: boolean; modes: ('window' | 'page')[]; width: number }) {
  const perMode: { mode: 'window' | 'page'; result: AuditResult }[] = [];
  for (const mode of options.modes) {
    await setPageMode(page, mode === 'page');
    await settle(page);
    const result = await page.evaluate(auditPage, {
      mode,
      forbidden: FORBIDDEN,
      strict: options.strict,
      touch: options.touch,
      covered: mode === 'window',
      focusOnly: false,
      viewportWidth: options.width,
    });
    perMode.push({ mode, result });
  }
  await setPageMode(page, false);
  return perMode;
}

function printSummary(findings: Finding[], unchecked: number) {
  const errors = findings.filter((finding) => finding.severity === 'error');
  const warnings = findings.filter((finding) => finding.severity === 'warn');
  console.log('');
  console.log(`Аудит читаемости: ошибок ${errors.length}, предупреждений ${warnings.length}, текстов на картинке/градиенте (не проверено) ${unchecked}`);
  const rules = [...new Set(findings.map((finding) => finding.rule))].sort();
  for (const rule of rules) {
    const list = findings.filter((finding) => finding.rule === rule);
    const e = list.filter((finding) => finding.severity === 'error').length;
    console.log('');
    console.log(`■ ${RULE_TITLE[rule] ?? rule} (${rule}): ошибок ${e}, предупреждений ${list.length - e}`);
    for (const f of [...list].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1)).slice(0, 10)) {
      const where = `${f.state}${f.pane ? ` [${f.pane}]` : ''} · ${f.width} · ${f.theme}`;
      console.log(`  ${f.severity === 'error' ? '✕' : '!'} ${where} · ${f.selector} · «${f.text}» · ${f.value} (нужно ${f.expected})`);
    }
    if (list.length > 10) console.log(`  … ещё ${list.length - 10}`);
  }
}

// ------------------------------------------------------------ самопроверка на испорченной странице

async function selfTest(): Promise<number> {
  const html = await readFile(path.join(root, 'scripts', 'ui-audit-fixture.html'), 'utf8');
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'msedge' });
  let failures = 0;
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    const [{ result }] = await auditFrame(page, { touch: true, strict: false, modes: ['window'], width: 390 });
    const expected = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('[data-expect]')].map((el) => ({ id: el.id, rules: el.dataset.expect!.split(' ') })),
    );
    const clean = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-clean]')].map((el) => el.id));
    for (const { id, rules } of expected) {
      for (const rule of rules) {
        const ok = result.findings.some((finding) => finding.marker === id && finding.rule === rule);
        console.log(`${ok ? '✓' : '✕'} #${id}: найдено «${rule}»`);
        if (!ok) failures++;
      }
    }
    for (const id of clean) {
      const noise = result.findings.filter((finding) => finding.marker === id);
      console.log(`${noise.length === 0 ? '✓' : '✕'} #${id}: без ложных срабатываний${noise.length ? ` — ${noise.map((f) => `${f.rule}: ${f.value}`).join('; ')}` : ''}`);
      if (noise.length) failures++;
    }
    const pageOverflow = result.findings.some((finding) => finding.rule === 'page-overflow');
    console.log(`${pageOverflow ? '✓' : '✕'} найдена горизонтальная прокрутка страницы`);
    if (!pageOverflow) failures++;
    const focus = await focusWalk(page, { mode: 'window', forbidden: FORBIDDEN, strict: false, touch: true, covered: false, focusOnly: true, viewportWidth: 390 });
    const focusOk = focus.some((finding) => finding.selector.includes('#bad-focus'));
    console.log(`${focusOk ? '✓' : '✕'} #bad-focus: найдено «focus»`);
    if (!focusOk) failures++;
    const focusNoise = focus.filter((finding) => !finding.selector.includes('#bad-focus'));
    if (focusNoise.length) {
      failures++;
      console.log(`✕ лишние находки фокуса: ${focusNoise.map((f) => f.selector).join(', ')}`);
    }
    await context.close();
  } finally {
    await browser.close();
  }
  console.log(failures ? `\nСамопроверка: ${failures} расхождений` : '\nСамопроверка пройдена');
  return failures ? 1 : 0;
}

// ------------------------------------------------------------ точка входа

async function main(): Promise<number> {
  if (flag('self-test')) return selfTest();

  const baseUrl = arg('url', 'http://127.0.0.1:5173').replace(/\/$/, '');
  const widths = arg('widths', DEFAULT_WIDTHS.join(',')).split(',').map(Number);
  const themes = arg('themes', DEFAULT_THEMES.join(',')).split(',') as Theme[];
  const only = arg('screens', '').split(',').filter(Boolean);
  const outDir = path.resolve(root, arg('out', 'screenshots/audit'));
  const modes = arg('modes', 'window,page').split(',') as ('window' | 'page')[];
  const strict = flag('strict');
  const warnOnly = flag('warn-only');

  await mkdir(outDir, { recursive: true });
  const findings: Finding[] = [];
  let unchecked = 0;
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'msedge' });
  const started = Date.now();
  try {
    await runStates({
      browser,
      baseUrl,
      widths,
      themes,
      only,
      onFrame: async ({ page, state, theme, width, pane }) => {
        const frameStart = Date.now();
        const touch = width < 900;
        const perMode = await auditFrame(page, { touch, strict, modes, width });
        const frame = new Map<string, Finding>();
        const overlays: Record<'window' | 'page', [number, number, number, number][]> = { window: [], page: [] };
        for (const { mode, result } of perMode) {
          unchecked += result.unchecked.length;
          for (const raw of result.findings) {
            const key = `${raw.rule}|${raw.selector}|${raw.text}|${raw.value.replace(/\d+(\.\d+)?px/g, '')}`;
            const existing = frame.get(key);
            if (existing) existing.modes.push(mode);
            else frame.set(key, { ...raw, state: state.name, width, theme, pane, modes: [mode] });
            if (raw.rect) overlays[mode].push(raw.rect);
          }
        }
        if ((width === 1440 || width === 390) && pane === null) {
          for (const raw of await focusWalk(page, { mode: 'window', forbidden: FORBIDDEN, strict, touch, covered: false, focusOnly: true, viewportWidth: width })) {
            frame.set(`focus|${raw.selector}`, { ...raw, state: state.name, width, theme, pane, modes: ['window'] });
          }
        }
        findings.push(...frame.values());
        const name = `${width}-${theme}-${state.name}${pane ? `-${paneSlug(pane)}` : ''}`;
        const errors = [...frame.values()].filter((finding) => finding.severity === 'error').length;
        console.log(`${errors ? '✕' : '✓'} ${name}: ошибок ${errors}, предупреждений ${frame.size - errors} (${((Date.now() - frameStart) / 1000).toFixed(1)} с)`);
        // Снимки кадров с находками: красные рамки вокруг элементов.
        for (const mode of ['window', 'page'] as const) {
          if (overlays[mode].length === 0) continue;
          await setPageMode(page, mode === 'page');
          await settle(page);
          await drawOverlay(page, overlays[mode]);
          await page.screenshot({ path: path.join(outDir, `${name}${mode === 'page' ? '-full' : ''}.png`), fullPage: mode === 'page' });
          await removeOverlay(page);
          await setPageMode(page, false);
        }
      },
    });
  } finally {
    await browser.close();
  }

  const report = { generatedAt: new Date().toISOString(), url: baseUrl, seconds: Math.round((Date.now() - started) / 1000), unchecked, findings };
  const json = JSON.stringify(report, null, 2);
  await mkdir(path.join(root, 'screenshots'), { recursive: true });
  await writeFile(path.join(root, 'screenshots', 'ui-audit.json'), json);
  await writeFile(path.join(outDir, 'report.json'), json);
  printSummary(findings, unchecked);
  console.log(`\nОтчёт: screenshots/ui-audit.json, кадры с находками: ${path.relative(root, outDir)}`);
  const errors = findings.filter((finding) => finding.severity === 'error').length;
  return errors > 0 && !warnOnly ? 1 : 0;
}

process.exitCode = await main();
