import { useMemo } from 'react';
import { highlightPython } from '../editor/highlight.ts';

interface Props {
  code: string;
  language?: string;
  /** Номера строк слева. */
  numbers?: boolean;
  /** Номер строки, которую нужно выделить. */
  highlightLine?: number | null;
  label?: string;
}

/** Код только для чтения с подсветкой — в теории, примерах и разборах. */
export function CodeBlock({ code, language = 'python', numbers = true, highlightLine = null, label }: Props) {
  const text = code.replace(/\n$/, '');
  const lines = useMemo(
    () => (language === 'python' ? highlightPython(text) : text.split('\n').map((line) => [{ text: line, className: '' }])),
    [text, language],
  );
  return (
    <pre className={`code-block${numbers ? ' with-numbers' : ''}`} aria-label={label ?? 'Код'} tabIndex={0}>
      <code>
        {lines.map((tokens, index) => (
          <span key={index} className={`code-line${highlightLine === index + 1 ? ' is-marked' : ''}`}>
            {numbers && (
              <span className="code-ln" aria-hidden="true">
                {index + 1}
              </span>
            )}
            <span className="code-text">
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
}
