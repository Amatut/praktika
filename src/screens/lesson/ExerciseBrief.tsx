// Условие задания после текста: «Ввод / Результат» на линиях, ограничения чек-листом (отметки для себя),
// примеры ввода и вывода таблицей на линиях — без рамок-карточек, данные разделяют линии.

import { ScanText } from 'lucide-react';
import { useId, useState } from 'react';
import { InlineText } from '../../components/Markdown.tsx';
import { Tag } from '../../components/ui.tsx';
import type { Exercise } from '../../content/schema.ts';
import { EnvironmentInfo, hasEnvironment } from './environment.tsx';
import { IoBlock } from './results.tsx';

export function ExerciseBrief({ exercise }: { exercise: Exercise }) {
  const [checked, setChecked] = useState<number[]>([]);
  const id = useId();
  return (
    <>
      {(exercise.input || exercise.output) && (
        <dl className="task-spec">
          {exercise.input && (
            <>
              <dt>Ввод</dt>
              <dd>
                <InlineText text={exercise.input} />
              </dd>
            </>
          )}
          {exercise.output && (
            <>
              <dt>Результат</dt>
              <dd>
                <InlineText text={exercise.output} />
              </dd>
            </>
          )}
        </dl>
      )}
      {exercise.constraints.length > 0 && (
        <section className="task-constraints" aria-labelledby={`${id}-constraints`}>
          {/* Отметки ставит сам ученик, автопроверка их не смотрит: счётчика «0/1» нет, честная пометка — меткой. */}
          <div className="task-subhead-row">
            <h3 id={`${id}-constraints`} className="task-subhead">
              Ограничения
            </h3>
            <Tag>Отмечаешь сам</Tag>
          </div>
          <ul className="task-checks">
            {exercise.constraints.map((item, index) => (
              <li key={index}>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={checked.includes(index)}
                    onChange={() =>
                      setChecked((items) => (items.includes(index) ? items.filter((value) => value !== index) : [...items, index]))
                    }
                  />
                  <span>
                    <InlineText text={item} />
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

/** Примеры из тестов задания: «Пример | Ввод | Вывод». «Пробелы» показывает пробелы точками. */
export function ExerciseExamples({ exercise }: { exercise: Exercise }) {
  const [spaces, setSpaces] = useState(false);
  const examples = exercise.tests.filter((test) => test.example);
  if (examples.length === 0) return null;
  const usesInput = exercise.tests.some((item) => Boolean(item.stdin));
  const kind = examples[0].kind;
  const hasSource = kind === 'call' || (kind === 'io' && usesInput);
  const sourceLabel = kind === 'call' ? 'Вызов' : 'Ввод';
  const resultLabel = kind === 'call' ? 'Результат' : kind === 'assert' ? 'Условие проверки' : 'Вывод';
  const withEnvironment = examples.map((test, index) => ({ test, index })).filter(({ test }) => hasEnvironment(test));
  return (
    <section className="task-examples" aria-label="Примеры к заданию">
      <div className="task-examples-head">
        <h3 className="task-subhead">{examples.length === 1 ? 'Пример' : 'Примеры'}</h3>
        {spaces && <span className="task-legend">· — пробел</span>}
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSpaces(!spaces)} aria-pressed={spaces}>
          <ScanText aria-hidden="true" />
          Пробелы
        </button>
      </div>
      <table className="io-table">
        <caption className="visually-hidden">Примеры ввода и вывода</caption>
        <thead>
          <tr>
            <th scope="col">
              <span className="visually-hidden">Пример</span>
            </th>
            {hasSource && <th scope="col">{sourceLabel}</th>}
            <th scope="col">{resultLabel}</th>
          </tr>
        </thead>
        <tbody>
          {examples.map((test, index) => {
            const input = test.kind === 'call' ? test.call : (test.stdin ?? '');
            const expected =
              test.kind === 'assert'
                ? test.message
                : test.kind === 'io' && test.compare?.mode === 'regex'
                  ? (test.expectedLabel ?? '')
                  : test.expected;
            return (
              <tr key={test.id}>
                <th scope="row">
                  Пример <span className="n">{index + 1}</span>
                </th>
                {hasSource && (
                  <td>
                    <IoBlock text={input} showSpaces={spaces} emptyLabel="без ввода" />
                  </td>
                )}
                <td>
                  {test.kind === 'assert' ? <span className="io-text">{expected}</span> : <IoBlock text={expected} showSpaces={spaces} />}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {withEnvironment.map(({ test, index }) => (
        <div key={test.id} className="example-env">
          <h4 className="task-subhead">
            Пример <span className="n">{index + 1}</span> — свои данные
          </h4>
          <EnvironmentInfo source={test} />
        </div>
      ))}
    </section>
  );
}
