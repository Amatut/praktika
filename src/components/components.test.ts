// Общие компоненты после редизайна: маршрут («Основы» пройдены целиком — без «текущего» узла), блок кода (висячий
// отступ от отступа строки, Tab только при прокрутке), код в тексте (короткий фрагмент не рвётся).
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Course } from '../content/schema.ts';
import { CodeBlock } from './CodeBlock.tsx';
import { renderInline } from './Markdown.tsx';
import { RouteGraph, finishedModuleIds } from './RouteGraph.tsx';

/** Курс из двух модулей «Основ» по два урока, проба после первого модуля, проект после второго. */
function course(unready: string[] = []): Course {
  const lesson = (id: string) => ({ id, title: id, ready: !unready.includes(id) });
  return {
    modules: [
      { id: 'm0', number: 0, part: 'basics', lessons: [lesson('m0-l1'), lesson('m0-l2')] },
      { id: 'm1', number: 1, part: 'basics', lessons: [lesson('m1-l1'), lesson('m1-l2')] },
    ],
    labs: [{ unlockAfter: 'm0' }],
    projects: [{ after: 'm1' }],
    stages: [
      { id: 'basics', title: 'Основы', description: '' },
      { id: 'labs', title: 'Пробы направлений', description: '' },
      { id: 'choice', title: 'Твой выбор', description: '' },
      { id: 'projects', title: 'Свой проект', description: '' },
    ],
  } as unknown as Course;
}

const render = (props: { course: Course; currentModuleId: string | null; lessonsDone: number; lessonsTotal: number; finishedModules?: Set<string> }) =>
  renderToStaticMarkup(createElement(RouteGraph, { moduleStates: new Map(), ...props }));

describe('RouteGraph', () => {
  it('в середине «Основ»: стадия текущая, у текущего модуля янтарный узел', () => {
    const html = render({ course: course(), currentModuleId: 'm1', lessonsDone: 2, lessonsTotal: 4 });
    expect(html).toContain('class="rt rt-basics is-current"');
    expect(html).toContain('идёт · <span class="n">2/4</span>');
    expect(html).toContain('class="cm is-current"');
    // Проба открывается после модуля 0 — модуль 1 уже дальше.
    expect(html).toContain('открыты');
  });

  it('все уроки написаны и пройдены: «пройдены», без текущего узла, пробы и проект достигнуты', () => {
    const html = render({ course: course(), currentModuleId: 'm1', lessonsDone: 4, lessonsTotal: 4 });
    expect(html).toContain('class="rt rt-basics is-complete"');
    expect(html).not.toContain('is-current');
    expect(html).not.toContain('aria-current');
    expect(html).toContain('пройдены · <span class="n">4/4</span>');
    expect(html).toContain('доступен');
    // «Пройдены 4/4» — и все узлы модулей закрашены, даже если навыки ещё «изучаю».
    expect(html.match(/class="cm is-done"/g)).toHaveLength(2);
  });

  it('модуль, все уроки которого завершены, на маршруте пройден (навыки ещё не освоены)', () => {
    const done = new Set(['m0-l1', 'm0-l2', 'm1-l1']);
    const finished = finishedModuleIds(course(), (id) => done.has(id));
    expect([...finished]).toEqual(['m0']);
    const html = render({ course: course(), currentModuleId: 'm1', lessonsDone: 3, lessonsTotal: 4, finishedModules: finished });
    expect(html).toContain('class="cm is-done"');
    expect(html).toContain('class="cm is-current"');
    // Модуль с ненаписанным уроком пройденным не считается.
    expect([...finishedModuleIds(course(['m0-l2']), (id) => done.has(id))]).toEqual([]);
  });

  it('пройдены все готовые, но часть уроков ещё пишется — «Основы» не закончены', () => {
    const html = render({ course: course(['m1-l2']), currentModuleId: 'm1', lessonsDone: 3, lessonsTotal: 3 });
    expect(html).toContain('class="rt rt-basics is-current"');
    expect(html).not.toContain('пройдены');
  });
});

describe('CodeBlock', () => {
  it('в режиме переноса у строки с отступом --indent — число ведущих пробелов', () => {
    const html = renderToStaticMarkup(createElement(CodeBlock, { code: 'for n in range(3):\n    print(n)\n\tpass', wrap: true }));
    expect(html).toContain('<span class="code-text" style="--indent:4">');
    expect(html).toContain('<span class="code-text" style="--indent:4"><span');
    // Первая строка без отступа — без переменной (по умолчанию 0).
    expect(html).toMatch(/<span class="code-ln" aria-hidden="true">1<\/span><span class="code-text">/);
  });

  it('без wrap отступ тоже считается (на телефоне переносит любой блок); блок без прокрутки — не остановка Tab', () => {
    const html = renderToStaticMarkup(createElement(CodeBlock, { code: '    x = 1' }));
    expect(html).toContain('<span class="code-text" style="--indent:4">');
    expect(html).not.toContain('is-wrapped');
    expect(html).not.toContain('tabindex');
    expect(html).toContain('aria-label="Код"');
  });
});

describe('код в тексте', () => {
  const html = (text: string) => renderToStaticMarkup(createElement('p', null, ...renderInline(text)));

  it('короткий фрагмент держится одной строкой, длинный переносится (.is-long)', () => {
    expect(html('Проверь `py --version` в терминале')).toContain('<code class="inline-code">py --version</code>');
    expect(html('Запусти `python -m http.server 8000 --bind 127.0.0.1`')).toContain(
      '<code class="inline-code is-long">python -m http.server 8000 --bind 127.0.0.1</code>',
    );
  });
});
