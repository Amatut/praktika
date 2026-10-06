// Редактор кода на CodeMirror 6. Цвета берутся из CSS-переменных темы (tokens.css),
// поэтому редактор сам следует за светлой и тёмной темой.
// Строка с ошибкой отмечается подсветкой и значком на полях — никакого текста внутри строк кода.

import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { python } from '@codemirror/lang-python';
import { bracketMatching, indentOnInput, indentUnit, syntaxHighlighting } from '@codemirror/language';
import {
  Annotation,
  Compartment,
  EditorState,
  RangeSet,
  RangeSetBuilder,
  StateEffect,
  StateField,
  Transaction,
  type Extension,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  GutterMarker,
  MatchDecorator,
  ViewPlugin,
  drawSelection,
  gutter,
  gutterLineClass,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder as placeholderExt,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { classHighlighter } from '@lezer/highlight';
import { useEffect, useRef } from 'react';
import { PYTHON_BUILTINS } from './highlight.ts';

/** Документ заменён снаружи (черновик, стартовый код), а не правкой ученика. */
const externalChange = Annotation.define<boolean>();

function lineDecoration(state: EditorState, line: number | null, className: string): DecorationSet {
  if (line === null || line < 1 || line > state.doc.lines) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  const from = state.doc.line(line).from;
  builder.add(from, from, Decoration.line({ class: className }));
  return builder.finish();
}

/** Значок ошибки на полях — как в редакторах кода: круг с крестиком (lucide CircleX). */
class ErrorMarker extends GutterMarker {
  toDOM() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    for (const [tag, attributes] of [
      ['circle', { cx: '12', cy: '12', r: '10' }],
      ['path', { d: 'm15 9-6 6' }],
      ['path', { d: 'm9 9 6 6' }],
    ] as const) {
      const element = document.createElementNS(ns, tag);
      for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
      svg.appendChild(element);
    }
    return svg;
  }
}

class ErrorGutterClass extends GutterMarker {
  elementClass = 'cm-error-gutter';
}

const errorMarker = new ErrorMarker();
const errorGutterClass = new ErrorGutterClass();

const setErrorLine = StateEffect.define<number | null>();

interface ErrorState {
  decorations: DecorationSet;
  markers: RangeSet<GutterMarker>;
  classes: RangeSet<GutterMarker>;
}

const NO_ERROR: ErrorState = { decorations: Decoration.none, markers: RangeSet.empty, classes: RangeSet.empty };

const errorLineField = StateField.define<ErrorState>({
  create: () => NO_ERROR,
  update(value, transaction) {
    // Любая правка кода снимает выделение ошибки: она относится к старой версии.
    if (transaction.docChanged) return NO_ERROR;
    let next = value;
    for (const effect of transaction.effects) {
      if (!effect.is(setErrorLine)) continue;
      const line = effect.value;
      if (line === null || line < 1 || line > transaction.state.doc.lines) {
        next = NO_ERROR;
        continue;
      }
      const from = transaction.state.doc.line(line).from;
      next = {
        decorations: lineDecoration(transaction.state, line, 'cm-error-line'),
        markers: RangeSet.of([errorMarker.range(from)]),
        classes: RangeSet.of([errorGutterClass.range(from)]),
      };
    }
    return next;
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.decorations),
    gutterLineClass.from(field, (value) => value.classes),
  ],
});

const errorGutter = gutter({
  class: 'cm-mark-gutter',
  markers: (view) => view.state.field(errorLineField).markers,
});

/** Строка, о которой сейчас пояснение (пример урока): подсвечивается, пока пояснение выбрано. */
const setNoteLine = StateEffect.define<number | null>();

const noteLineField = StateField.define<{ line: number | null; decorations: DecorationSet }>({
  create: () => ({ line: null, decorations: Decoration.none }),
  update(value, transaction) {
    let line = value.line;
    for (const effect of transaction.effects) if (effect.is(setNoteLine)) line = effect.value;
    if (line === value.line && !transaction.docChanged) return value;
    return { line, decorations: lineDecoration(transaction.state, line, 'cm-note-line') };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

/**
 * Висячий отступ перенесённых строк: продолжение начинается на 2 знака правее начала кода строки,
 * поэтому хвост длинной строки не принять за новую строку (в Python отступ — синтаксис).
 * Первая строка остаётся на месте за счёт отрицательного text-indent.
 */
const wrapIndentCache = new Map<number, Decoration>();

function wrapIndent(columns: number): Decoration {
  let decoration = wrapIndentCache.get(columns);
  if (!decoration) {
    const hang = columns + 2;
    decoration = Decoration.line({ attributes: { style: `padding-left: calc(4px + ${hang}ch); text-indent: -${hang}ch` } });
    wrapIndentCache.set(columns, decoration);
  }
  return decoration;
}

function leadingColumns(text: string, tabSize: number): number {
  let columns = 0;
  for (const char of text) {
    if (char === ' ') columns += 1;
    else if (char === '\t') columns += tabSize - (columns % tabSize);
    else break;
  }
  return columns;
}

/** Отступ для каждой строки документа: код заданий короткий, поэтому считается весь документ сразу. */
function wrapIndentDecorations(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (let number = 1; number <= state.doc.lines; number++) {
    const line = state.doc.line(number);
    builder.add(line.from, line.from, wrapIndent(leadingColumns(line.text, state.tabSize)));
  }
  return builder.finish();
}

const hangingIndent = StateField.define<DecorationSet>({
  create: (state) => wrapIndentDecorations(state),
  update: (value, transaction) => (transaction.docChanged ? wrapIndentDecorations(transaction.state) : value),
  provide: (field) => EditorView.decorations.from(field),
});

const builtinMatcher = new MatchDecorator({
  regexp: new RegExp(`\\b(?:${[...PYTHON_BUILTINS].join('|')})(?=\\s*\\()`, 'g'),
  decoration: Decoration.mark({ class: 'tok-builtin' }),
});

const builtinHighlight = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = builtinMatcher.createDeco(view);
    }
    update(update: ViewUpdate) {
      this.decorations = builtinMatcher.updateDeco(update, this.decorations);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

// Тема «Мастерской»: поля номеров шириной --gut (значок ошибки + номер), номер 13 px, текущая строка --bg-line,
// каретка --accent-edge, выделение --selection, фокус — рамка --focus внутрь.
const baseTheme = EditorView.theme({
  '&': {
    color: 'var(--text)',
    backgroundColor: 'var(--bg-editor)',
    fontSize: 'var(--code-size)',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-code)',
    lineHeight: '1.6',
    overflow: 'auto',
  },
  '.cm-content': {
    padding: '12px 0',
    caretColor: 'var(--accent-edge)',
  },
  '.cm-line': {
    padding: '0 var(--gutter) 0 4px',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--bg-editor)',
    color: 'var(--text-3)',
    border: 'none',
  },
  // Номер и значок стоят на первой строке перенесённой строки кода и на её высоте, при любом кегле кода.
  '.cm-mark-gutter .cm-gutterElement': {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'flex-end',
    width: '20px',
    color: 'var(--err)',
  },
  '.cm-mark-gutter .cm-gutterElement svg': {
    flex: 'none',
    marginTop: 'calc((var(--code-size) * 1.6 - 14px) / 2)',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    minWidth: 'calc(var(--gut) - 20px)',
    padding: '0 8px 0 0',
    fontSize: '13px',
    lineHeight: 'calc(var(--code-size) * 1.6)',
  },
  '.cm-activeLine': {
    backgroundColor: 'var(--bg-line)',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'var(--bg-line)',
    color: 'var(--text)',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--accent-edge)',
    borderLeftWidth: '2px',
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--selection) !important',
  },
  // Фокус виден рамкой, а не только кареткой. Контур рисуется поверх строк и полей номеров.
  // :focus-within срабатывает сразу, класс cm-focused CodeMirror ставит с задержкой — рамка не мигает.
  '&.cm-focused, &:focus-within': {
    outline: '2px solid var(--focus)',
    outlineOffset: '-2px',
  },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'transparent',
    outline: '1px solid var(--line-control)',
    outlineOffset: '-1px',
  },
  '.cm-nonmatchingBracket, &.cm-focused .cm-nonmatchingBracket': {
    backgroundColor: 'var(--err-line-bg)',
    color: 'var(--err)',
  },
  '.cm-error-line': {
    backgroundColor: 'var(--err-line-bg)',
    boxShadow: 'inset 2px 0 0 var(--err)',
  },
  '.cm-error-gutter': {
    backgroundColor: 'var(--err-line-bg)',
  },
  '.cm-lineNumbers .cm-error-gutter': {
    color: 'var(--err)',
    fontWeight: '600',
  },
  '.cm-note-line': {
    backgroundColor: 'var(--accent-soft)',
    boxShadow: 'inset 2px 0 0 var(--accent-edge)',
  },
  '.cm-placeholder': {
    color: 'var(--text-3)',
  },
});

export interface CodeEditorProps {
  value: string;
  onChange?: (value: string) => void;
  /** Ctrl/Cmd+Enter. */
  onSubmit?: () => void;
  readOnly?: boolean;
  ariaLabel: string;
  errorLine?: number | null;
  /**
   * Чей это разбор (например, объект разбора): новая проверка с той же строкой ошибки снова подсвечивает её,
   * хотя правка кода между проверками подсветку сняла.
   */
  errorKey?: unknown;
  /** Подсветить строку, к которой относится выбранное пояснение. */
  noteLine?: number | null;
  placeholder?: string;
  minLines?: number;
  /** Номер строки с кареткой — для строки состояния («main.py:4»). */
  onCursor?: (line: number) => void;
  /** Показать строку: каретка в её начало, прокрутка и фокус. tick — чтобы повторить для той же строки. */
  revealLine?: { line: number; tick: number } | null;
}

export function CodeEditor({
  value,
  onChange,
  onSubmit,
  readOnly = false,
  ariaLabel,
  errorLine = null,
  errorKey,
  noteLine = null,
  placeholder,
  minLines = 6,
  onCursor,
  revealLine = null,
}: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const readOnlyCompartment = useRef(new Compartment());
  const historyCompartment = useRef(new Compartment());
  const callbacks = useRef({ onChange, onSubmit, onCursor });
  callbacks.current = { onChange, onSubmit, onCursor };

  useEffect(() => {
    if (!host.current) return;
    let cursorLine = 0;
    const extensions: Extension[] = [
      errorGutter,
      lineNumbers(),
      highlightActiveLineGutter(),
      historyCompartment.current.of(history()),
      drawSelection(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      highlightActiveLine(),
      indentUnit.of('    '),
      EditorState.tabSize.of(4),
      python(),
      syntaxHighlighting(classHighlighter),
      builtinHighlight,
      errorLineField,
      noteLineField,
      baseTheme,
      // Длинные строки переносятся на любой ширине: код не уезжает вбок под колонку номеров строк.
      // Продолжение — с висячим отступом.
      EditorView.lineWrapping,
      hangingIndent,
      keymap.of([
        {
          key: 'Mod-Enter',
          run: () => {
            callbacks.current.onSubmit?.();
            return true;
          },
        },
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        indentWithTab,
      ]),
      EditorView.contentAttributes.of({
        'aria-label': ariaLabel,
        autocorrect: 'off',
        autocapitalize: 'off',
        spellcheck: 'false',
        translate: 'no',
      }),
      readOnlyCompartment.current.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
      // onChange — только правки ученика: подстановка черновика или стартового кода снаружи
      // не считается правкой (не сохраняется заново и не меняет время черновика).
      EditorView.updateListener.of((update) => {
        if (update.selectionSet || update.docChanged) {
          const line = update.state.doc.lineAt(update.state.selection.main.head).number;
          if (line !== cursorLine) {
            cursorLine = line;
            callbacks.current.onCursor?.(line);
          }
        }
        if (!update.docChanged || update.transactions.some((transaction) => transaction.annotation(externalChange))) return;
        callbacks.current.onChange?.(update.state.doc.toString());
      }),
    ];
    if (placeholder) extensions.push(placeholderExt(placeholder));
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({ doc: value, extensions }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
    // Редактор создаётся один раз; значения обновляются эффектами ниже.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const current = editor.state.doc.toString();
    if (current !== value) {
      // Новый текст снаружи — новый документ: он не попадает в историю, а прежняя история
      // сбрасывается, иначе Ctrl+Z вернул бы стартовый код или обрывки старого.
      editor.dispatch({
        changes: { from: 0, to: current.length, insert: value },
        annotations: [externalChange.of(true), Transaction.addToHistory.of(false)],
        effects: historyCompartment.current.reconfigure([]),
      });
      editor.dispatch({ effects: historyCompartment.current.reconfigure(history()) });
    }
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({
      effects: readOnlyCompartment.current.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
    });
  }, [readOnly]);

  useEffect(() => {
    view.current?.dispatch({ effects: setErrorLine.of(errorLine) });
  }, [errorLine, errorKey]);

  useEffect(() => {
    view.current?.dispatch({ effects: setNoteLine.of(noteLine) });
  }, [noteLine]);

  useEffect(() => {
    const editor = view.current;
    if (!editor || !revealLine) return;
    const line = Math.min(Math.max(revealLine.line, 1), editor.state.doc.lines);
    // Кадр ждёт, пока вкладка «Код» станет видимой (на телефоне), иначе прокрутка не сработает.
    const frame = requestAnimationFrame(() => {
      editor.dispatch({ selection: { anchor: editor.state.doc.line(line).from }, scrollIntoView: true });
      editor.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [revealLine]);

  return (
    <div
      ref={host}
      className="code-editor"
      style={{ ['--editor-min-lines' as string]: String(minLines) }}
      data-readonly={readOnly || undefined}
    />
  );
}
