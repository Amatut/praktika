// Редактор кода на CodeMirror 6. Цвета берутся из CSS-переменных темы,
// поэтому редактор сам следует за светлой и тёмной темой.

import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { python } from '@codemirror/lang-python';
import { bracketMatching, indentOnInput, indentUnit, syntaxHighlighting } from '@codemirror/language';
import {
  Annotation,
  Compartment,
  EditorState,
  RangeSetBuilder,
  StateEffect,
  StateField,
  Transaction,
  type Extension,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  MatchDecorator,
  ViewPlugin,
  drawSelection,
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

const setErrorLine = StateEffect.define<number | null>();

const errorLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    let decorations = value.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(setErrorLine)) decorations = lineDecoration(transaction.state, effect.value, 'cm-error-line');
    }
    // Любая правка кода снимает выделение ошибки: она относится к старой версии.
    if (transaction.docChanged) decorations = Decoration.none;
    return decorations;
  },
  provide: (field) => EditorView.decorations.from(field),
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

const baseTheme = EditorView.theme({
  '&': {
    color: 'var(--text)',
    backgroundColor: 'var(--surface)',
    fontSize: 'var(--code-size)',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-code)',
    lineHeight: '1.7',
    overflow: 'auto',
  },
  '.cm-content': {
    padding: '12px 0',
    caretColor: 'var(--accent)',
  },
  '.cm-line': {
    padding: '0 16px 0 8px',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--surface)',
    color: 'var(--muted)',
    border: 'none',
    paddingLeft: '8px',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    minWidth: '28px',
    padding: '0 4px 0 0',
  },
  '.cm-activeLine': {
    backgroundColor: 'var(--syn-active-line)',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
    color: 'var(--text)',
  },
  '&.cm-focused .cm-cursor': {
    borderLeftColor: 'var(--accent)',
    borderLeftWidth: '2px',
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--syn-selection) !important',
  },
  // Фокус виден рамкой, а не только кареткой. Контур рисуется поверх строк и полей номеров.
  '&.cm-focused': {
    outline: '2px solid var(--accent)',
    outlineOffset: '-2px',
  },
  '.cm-matchingBracket': {
    backgroundColor: 'var(--accent-soft)',
    outline: '1px solid var(--accent-soft-border)',
  },
  '.cm-error-line': {
    backgroundColor: 'var(--syn-error-line)',
    boxShadow: 'inset 3px 0 0 var(--error)',
  },
  '.cm-note-line': {
    backgroundColor: 'var(--accent-soft)',
    boxShadow: 'inset 3px 0 0 var(--accent)',
  },
  '.cm-placeholder': {
    color: 'var(--muted)',
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
  /** Подсветить строку, к которой относится выбранное пояснение. */
  noteLine?: number | null;
  placeholder?: string;
  minLines?: number;
}

export function CodeEditor({
  value,
  onChange,
  onSubmit,
  readOnly = false,
  ariaLabel,
  errorLine = null,
  noteLine = null,
  placeholder,
  minLines = 6,
}: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const readOnlyCompartment = useRef(new Compartment());
  const historyCompartment = useRef(new Compartment());
  const callbacks = useRef({ onChange, onSubmit });
  callbacks.current = { onChange, onSubmit };

  useEffect(() => {
    if (!host.current) return;
    const extensions: Extension[] = [
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
        if (!update.docChanged || update.transactions.some((transaction) => transaction.annotation(externalChange))) return;
        callbacks.current.onChange?.(update.state.doc.toString());
      }),
    ];
    if (placeholder) extensions.push(placeholderExt(placeholder));
    view.current = new EditorView({
      parent: host.current,
      state: EditorState.create({ doc: value, extensions }),
    });
    return () => {
      view.current?.destroy();
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
  }, [errorLine]);

  useEffect(() => {
    view.current?.dispatch({ effects: setNoteLine.of(noteLine) });
  }, [noteLine]);

  return (
    <div
      ref={host}
      className="code-editor"
      style={{ ['--editor-min-lines' as string]: String(minLines) }}
      data-readonly={readOnly || undefined}
    />
  );
}
