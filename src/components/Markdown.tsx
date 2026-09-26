// Безопасный рендер учебного текста: абзацы, списки, **жирный**, *курсив*, `код`,
// блоки ```python```, [ссылки](https://…) и заметки «> ». HTML не поддерживается намеренно.

import { Fragment, type ReactNode } from 'react';
import { CodeBlock } from './CodeBlock.tsx';

type Block =
  | { type: 'code'; lang: string; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'heading'; text: string }
  | { type: 'quote'; text: string }
  | { type: 'paragraph'; text: string };

function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === '') {
      index += 1;
      continue;
    }
    const fence = /^```(\w*)\s*$/.exec(line.trim());
    if (fence) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && lines[index].trim() !== '```') {
        body.push(lines[index]);
        index += 1;
      }
      index += 1;
      blocks.push({ type: 'code', lang: fence[1] || 'python', text: body.join('\n') });
      continue;
    }
    if (/^#{2,4}\s+/.test(line)) {
      blocks.push({ type: 'heading', text: line.replace(/^#{2,4}\s+/, '') });
      index += 1;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const body: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        body.push(lines[index].replace(/^>\s?/, ''));
        index += 1;
      }
      blocks.push({ type: 'quote', text: body.join(' ') });
      continue;
    }
    const bullet = /^\s*[-*]\s+/;
    const numbered = /^\s*\d+[.)]\s+/;
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line);
      const pattern = ordered ? numbered : bullet;
      const items: string[] = [];
      while (index < lines.length && lines[index].trim() !== '') {
        if (pattern.test(lines[index])) items.push(lines[index].replace(pattern, ''));
        else if (items.length > 0) items[items.length - 1] += ` ${lines[index].trim()}`;
        index += 1;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }
    const body: string[] = [];
    while (index < lines.length && lines[index].trim() !== '' && !/^```/.test(lines[index].trim()) && !bullet.test(lines[index]) && !numbered.test(lines[index])) {
      body.push(lines[index].trim());
      index += 1;
    }
    blocks.push({ type: 'paragraph', text: body.join(' ') });
  }
  return blocks;
}

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\((https?:\/\/[^)\s]+)\))/g;

export function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const match of text.matchAll(INLINE)) {
    const start = match.index ?? 0;
    if (start > last) nodes.push(text.slice(last, start));
    const token = match[0];
    if (match[1]) nodes.push(<code key={key++} className="inline-code">{token.slice(1, -1)}</code>);
    else if (match[2]) nodes.push(<strong key={key++}>{renderInline(token.slice(2, -2))}</strong>);
    else if (match[3]) nodes.push(<em key={key++}>{renderInline(token.slice(1, -1))}</em>);
    else if (match[4]) {
      const label = token.slice(1, token.indexOf(']('));
      nodes.push(
        <a key={key++} href={match[5]} target="_blank" rel="noopener noreferrer">
          {label}
        </a>,
      );
    }
    last = start + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = parseBlocks(text);
  return (
    <div className={`prose${className ? ` ${className}` : ''}`}>
      {blocks.map((block, index) => {
        switch (block.type) {
          case 'code':
            return <CodeBlock key={index} code={block.text} language={block.lang} numbers={block.text.includes('\n')} />;
          case 'list': {
            const Tag = block.ordered ? 'ol' : 'ul';
            return (
              <Tag key={index}>
                {block.items.map((item, i) => (
                  <li key={i}>{renderInline(item)}</li>
                ))}
              </Tag>
            );
          }
          case 'heading':
            return <h4 key={index}>{renderInline(block.text)}</h4>;
          case 'quote':
            return (
              <p key={index} className="prose-note">
                {renderInline(block.text)}
              </p>
            );
          default:
            return <p key={index}>{renderInline(block.text)}</p>;
        }
      })}
    </div>
  );
}

/** Одна строка с inline-разметкой (без абзацев). */
export function InlineText({ text }: { text: string }) {
  return <Fragment>{renderInline(text)}</Fragment>;
}
