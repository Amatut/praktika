import { ArrowRight, CheckCheck, Keyboard, ListChecks, ScanText, Target, Terminal } from 'lucide-react';
import { useState } from 'react';
import { InlineText } from '../../components/Markdown.tsx';
import { rovingKeyDown } from '../../components/roving.ts';
import type { Exercise } from '../../content/schema.ts';
import { IoBlock } from './results.tsx';

export function ExerciseBrief({ exercise }: { exercise: Exercise }) {
  const [checked, setChecked] = useState<number[]>([]);
  return <>
    {(exercise.input || exercise.output) && <div className="task-facts">
      {exercise.input && <section className="task-fact"><div className="task-fact-heading"><Keyboard aria-hidden="true" /><h3>Входные данные</h3></div><p><InlineText text={exercise.input} /></p></section>}
      {exercise.output && <section className="task-fact task-fact-result"><div className="task-fact-heading"><Target aria-hidden="true" /><h3>Результат</h3></div><p><InlineText text={exercise.output} /></p></section>}
    </div>}
    {exercise.constraints.length > 0 && <section className="task-requirements" aria-label="Ограничения задания">
      <div className="task-fact-heading"><ListChecks aria-hidden="true" /><h3>Ограничения</h3><span>{checked.length}/{exercise.constraints.length}</span></div>
      <ul>{exercise.constraints.map((item, index) => <li key={index}><label data-checked={checked.includes(index)}><input type="checkbox" checked={checked.includes(index)} onChange={() => setChecked((items) => items.includes(index) ? items.filter((item) => item !== index) : [...items, index])} /><span><InlineText text={item} /></span></label></li>)}</ul>
      <p className="task-note"><CheckCheck aria-hidden="true" />Отметки для себя. Проверка кода выполняется отдельно.</p>
    </section>}
  </>;
}

export function ExerciseExamples({ exercise }: { exercise: Exercise }) {
  const [active, setActive] = useState(0);
  const [spaces, setSpaces] = useState(false);
  const examples = exercise.tests.filter((test) => test.example);
  const test = examples[active] ?? examples[0];
  if (!test) return null;
  const usesInput = exercise.tests.some((item) => Boolean(item.stdin));
  const hasSource = test.kind === 'call' || (test.kind === 'io' && usesInput);
  const input = test.kind === 'call' ? test.call : test.stdin ?? '';
  const expected = test.kind === 'assert' ? test.message : test.kind === 'io' && test.compare?.mode === 'regex' ? test.expectedLabel ?? '' : test.expected;
  return <section className="example-deck" aria-label="Примеры к заданию">
    <div className="example-deck-head"><div className="task-fact-heading"><Terminal aria-hidden="true" /><h3>{examples.length === 1 ? 'Пример' : 'Примеры'}</h3></div><button type="button" className="btn btn-ghost btn-sm" onClick={() => setSpaces(!spaces)} aria-pressed={spaces}><ScanText aria-hidden="true" />Пробелы</button></div>
    {examples.length > 1 && <div className="example-tabs" role="tablist" aria-label="Примеры ввода и вывода" onKeyDown={rovingKeyDown}>{examples.map((example, index) => <button type="button" key={example.id} role="tab" id={`${exercise.id}-example-tab-${index}`} aria-controls={`${exercise.id}-example-panel`} aria-selected={index === active} tabIndex={index === active ? 0 : -1} onClick={() => setActive(index)}>Пример {index + 1}</button>)}</div>}
    <div className="example-flow" data-has-input={hasSource} role={examples.length > 1 ? 'tabpanel' : undefined} id={`${exercise.id}-example-panel`} aria-labelledby={examples.length > 1 ? `${exercise.id}-example-tab-${active}` : undefined} tabIndex={examples.length > 1 ? 0 : undefined}>
      {hasSource && <><div className="example-cell"><span className="label">{test.kind === 'call' ? 'Вызов' : 'Ввод'}</span><IoBlock text={input} showSpaces={spaces} emptyLabel="без ввода" /></div><ArrowRight className="example-arrow" aria-hidden="true" /></>}
      <div className="example-cell example-output"><span className="label">{test.kind === 'call' ? 'Результат' : test.kind === 'assert' ? 'Условие проверки' : 'Вывод'}</span><IoBlock text={expected} showSpaces={spaces} /></div>
    </div>
    <p className="task-note">{spaces ? 'Точки обозначают пробелы; вводить точки в программе не нужно.' : hasSource ? 'Для этих данных программа должна получить показанный результат.' : 'Так должен выглядеть результат программы.'}</p>
  </section>;
}
