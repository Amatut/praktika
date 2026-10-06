import { FileCode2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { highlightPython } from '../editor/highlight.ts';

interface Props {
  code: string;
  language?: string;
  /** Номера строк слева. */
  numbers?: boolean;
  /** Номер строки, которую нужно выделить. */
  highlightLine?: number | null;
  label?: string;
  /** Имя файла: полоса-вкладка над кодом («menu.txt», «решение»). */
  file?: string;
  /** Перенос длинных строк (узкая колонка наставника); без него — прокрутка внутри блока (на телефоне — перенос всегда). */
  wrap?: boolean;
  /** Без своей рамки и фона — внутри блока-«файла», у которого рамка уже есть. */
  bare?: boolean;
}

/** Ведущие пробелы строки (табуляция — 4): от них считается висячий отступ перенесённого хвоста. */
function indentOf(line: string): number {
  const lead = /^[ \t]*/.exec(line)?.[0] ?? '';
  let width = 0;
  for (const char of lead) width += char === '\t' ? 4 : 1;
  return width;
}

/** Блок с прокруткой должен получать фокус (прокрутка с клавиатуры); без прокрутки — лишняя остановка Tab. */
function useOverflow<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [overflow, setOverflow] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const measure = () => setOverflow(element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, overflow] as const;
}

/** Код только для чтения с подсветкой — в теории, примерах и разборах. */
export function CodeBlock({ code, language = 'python', numbers = true, highlightLine = null, label, file, wrap = false, bare = false }: Props) {
  const text = code.replace(/\n$/, '');
  const lines = useMemo(
    () => (language === 'python' ? highlightPython(text) : text.split('\n').map((line) => [{ text: line, className: '' }])),
    [text, language],
  );
  // Отступы нужны и без wrap: на телефоне (< 600) переносит строки любой блок (ui.css).
  const indents = useMemo(() => text.split('\n').map(indentOf), [text]);
  const [ref, overflow] = useOverflow<HTMLPreElement>();
  const classes = ['code-block'];
  if (numbers) classes.push('with-numbers');
  if (wrap) classes.push('is-wrapped');
  if (bare || file) classes.push('is-bare');
  const pre = (
    <pre ref={ref} className={classes.join(' ')} aria-label={label ?? (file ? `Файл ${file}` : 'Код')} tabIndex={overflow ? 0 : undefined}>
      <code>
        {lines.map((tokens, index) => (
          <span key={index} className={`code-line${highlightLine === index + 1 ? ' is-marked' : ''}`}>
            {numbers && (
              <span className="code-ln" aria-hidden="true">
                {index + 1}
              </span>
            )}
            <span className="code-text" style={indents[index] ? ({ '--indent': indents[index] } as CSSProperties) : undefined}>
              {tokens.length === 0 ? '​' : tokens.map((token, i) => (
                <span key={i} className={token.className || undefined}>
                  {token.text}
                </span>
              ))}
            </span>
          </span>
        ))}
      </code>
    </pre>
  );
  if (!file) return pre;
  return (
    <div className={`code-file${bare ? ' is-bare' : ''}`}>
      <div className="code-file-tab">
        <FileCode2 aria-hidden="true" />
        <span className="code-file-name">{file}</span>
      </div>
      {pre}
    </div>
  );
}
