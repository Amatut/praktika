// Статическая подсветка Python тем же разбором, что и в редакторе (Lezer),
// чтобы примеры в тексте и код в редакторе выглядели одинаково.

import { classHighlighter, highlightTree } from '@lezer/highlight';
import { parser } from '@lezer/python';

export const PYTHON_BUILTINS = new Set([
  'print', 'input', 'range', 'len', 'int', 'float', 'str', 'bool', 'list', 'dict', 'set', 'tuple', 'type',
  'abs', 'round', 'min', 'max', 'sum', 'sorted', 'reversed', 'enumerate', 'zip', 'map', 'filter', 'open',
  'isinstance', 'any', 'all', 'chr', 'ord', 'help', 'exit', 'quit',
]);

export interface Token {
  text: string;
  className: string;
}

/** Разбивает код на строки из токенов с CSS-классами tok-*. */
export function highlightPython(code: string): Token[][] {
  const tree = parser.parse(code);
  const pieces: { from: number; to: number; className: string }[] = [];
  highlightTree(tree, classHighlighter, (from, to, classes) => {
    pieces.push({ from, to, className: classes });
  });

  const tokens: Token[] = [];
  let position = 0;
  for (const piece of pieces) {
    if (piece.from > position) tokens.push({ text: code.slice(position, piece.from), className: '' });
    let className = piece.className;
    const text = code.slice(piece.from, piece.to);
    if (className.includes('tok-variableName') && PYTHON_BUILTINS.has(text)) className += ' tok-builtin';
    tokens.push({ text, className });
    position = piece.to;
  }
  if (position < code.length) tokens.push({ text: code.slice(position), className: '' });

  const lines: Token[][] = [[]];
  for (const token of tokens) {
    const parts = token.text.split('\n');
    parts.forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (part) lines[lines.length - 1].push({ text: part, className: token.className });
    });
  }
  return lines;
}
