// Конвейер шагов урока «Понять — Сделать — Закрепить»: один компонент для шапки урока и «Сегодня».
// Узлы на линии: пройденный — ✓ на зелёном, текущий — янтарный «7_», остальные — номер в рамке.
// В уроке узлы — кнопки (доступное имя начинается с метки шага: «Практика 1: …»), на «Сегодня» — только рисунок.
// StepPicker — список шагов по этапам («7 из 10 · Практика 1 ▾»), MiniBar — мини-конвейер для телефона.
import { Check, ChevronDown } from 'lucide-react';
import { Fragment, useEffect, useRef } from 'react';

export type FlowGroup = 'understand' | 'do' | 'reinforce';

export interface FlowStep {
  id: string;
  /** «История», «Идея», «Практика 1», «Итог» — как метка шага в уроке. */
  label: string;
  /** Название шага. */
  title: string;
  done: boolean;
}

export const FLOW_GROUP_LABEL: Record<FlowGroup, string> = {
  understand: 'Понять',
  do: 'Сделать',
  reinforce: 'Закрепить',
};

/** До первого задания — «Понять», от первого задания до итога — «Сделать», итог — «Закрепить». */
export function flowGroups(steps: { type: string }[]): FlowGroup[] {
  const firstExercise = steps.findIndex((step) => step.type === 'exercise');
  return steps.map((step, index) => {
    if (step.type === 'recap') return 'reinforce';
    if (firstExercise >= 0 && index >= firstExercise) return 'do';
    return 'understand';
  });
}

interface Section {
  group: FlowGroup;
  items: { step: FlowStep; index: number }[];
}

/** Шаги подряд по этапам (этап может встретиться только один раз — идут по порядку). */
function sections(steps: FlowStep[], groups: FlowGroup[]): Section[] {
  const result: Section[] = [];
  steps.forEach((step, index) => {
    const group = groups[index] ?? 'understand';
    const last = result[result.length - 1];
    if (last && last.group === group) last.items.push({ step, index });
    else result.push({ group, items: [{ step, index }] });
  });
  return result;
}

function nodeState(step: FlowStep, index: number, current: number): 'current' | 'done' | undefined {
  if (index === current) return 'current';
  return step.done ? 'done' : undefined;
}

function NodeFace({ step, index, current }: { step: FlowStep; index: number; current: number }) {
  if (index === current) return <span className="flow-num">{index + 1}</span>;
  if (step.done) return <Check aria-hidden="true" />;
  return <span className="flow-num">{index + 1}</span>;
}

/** Подсказка узла: «7 · Практика 1 · Табло с новым напитком» (без повтора, если метка и название совпадают). */
function tipText(step: FlowStep, index: number): string {
  return step.title && step.title !== step.label ? `${index + 1} · ${step.label} · ${step.title}` : `${index + 1} · ${step.label}`;
}

export function FlowSteps({
  steps,
  groups,
  current,
  variant,
  onSelect,
  label,
}: {
  steps: FlowStep[];
  groups: FlowGroup[];
  current: number;
  variant: 'lesson' | 'home';
  /** Только для 'lesson'. */
  onSelect?: (index: number) => void;
  /** aria-label списка: «Шаги урока». */
  label: string;
}) {
  const parts = sections(steps, groups);
  const currentGroup = groups[current];
  const line = (
    <ol className="flow-line" aria-label={variant === 'lesson' ? label : undefined} aria-hidden={variant === 'home' ? true : undefined}>
      {parts.map((part, partIndex) => {
        const allDone = part.items.every(({ step, index }) => step.done || index < current);
        const groupClass = part.group === currentGroup ? ' is-current' : allDone ? ' is-done' : '';
        return (
          <li key={`${part.group}-${partIndex}`} className={`flow-group${groupClass}`} data-group={part.group}>
            <span className="flow-cap">{FLOW_GROUP_LABEL[part.group]}</span>
            <ol>
              {part.items.map(({ step, index }) => {
                const state = nodeState(step, index, current);
                const liClass = state === 'current' ? 'is-current' : state === 'done' ? 'is-done' : undefined;
                if (variant === 'home') {
                  return (
                    <li key={step.id} className={liClass}>
                      <span className="flow-node">
                        <NodeFace step={step} index={index} current={current} />
                      </span>
                    </li>
                  );
                }
                const suffix = index === current ? (step.done ? ', пройден, сейчас' : ', сейчас') : step.done ? ', пройден' : '';
                return (
                  <li key={step.id} className={liClass}>
                    <button
                      type="button"
                      className="step-chip flow-node"
                      data-state={state}
                      aria-current={index === current ? 'step' : undefined}
                      aria-label={`${step.label}: ${step.title}${suffix}`}
                      onClick={() => onSelect?.(index)}
                    >
                      <NodeFace step={step} index={index} current={current} />
                      <span className="flow-tip" aria-hidden="true">
                        {tipText(step, index)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </li>
        );
      })}
    </ol>
  );

  if (variant === 'lesson') return <nav className="flow flow-lesson">{line}</nav>;

  const now = steps[current];
  return (
    <div className="flow flow-home">
      {now && (
        <p className="flow-label">
          Шаг <span className="n">{current + 1}</span> из <span className="n">{steps.length}</span> · {now.title || now.label}
        </p>
      )}
      {line}
    </div>
  );
}

/** Список шагов урока по этапам: «7 из 10 · Практика 1 ▾». Esc и клик мимо закрывают. */
export function StepPicker({
  steps,
  groups,
  current,
  onSelect,
}: {
  steps: FlowStep[];
  groups: FlowGroup[];
  current: number;
  onSelect: (index: number) => void;
}) {
  const ref = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const details = ref.current;
    if (!details) return;
    const close = (event: Event) => {
      if (!details.open) return;
      if (event instanceof KeyboardEvent) {
        if (event.key !== 'Escape') return;
        details.open = false;
        details.querySelector('summary')?.focus();
        return;
      }
      if (!details.contains(event.target as Node)) details.open = false;
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, []);

  const now = steps[current];
  const parts = sections(steps, groups);
  return (
    <details className="flow-pick" ref={ref}>
      <summary aria-label={`Список шагов: шаг ${current + 1} из ${steps.length}`}>
        <span className="flow-count">
          <span className="n">{current + 1}</span> из <span className="n">{steps.length}</span>
        </span>
        {now && <span className="flow-now">{now.label}</span>}
        <ChevronDown aria-hidden="true" className="flow-pick-chevron" />
      </summary>
      <div className="flow-pop">
        {parts.map((part, partIndex) => (
          <Fragment key={`${part.group}-${partIndex}`}>
            <div className="plabel flow-pop-group">{FLOW_GROUP_LABEL[part.group]}</div>
            <ul>
              {part.items.map(({ step, index }) => {
                const state = nodeState(step, index, current);
                return (
                  <li key={step.id}>
                    <button
                      type="button"
                      className={`flow-pop-item${state ? ` is-${state}` : ''}`}
                      aria-current={index === current ? 'step' : undefined}
                      aria-label={`Шаг ${index + 1}. ${step.label}${step.title && step.title !== step.label ? ` — ${step.title}` : ''}${
                        step.done ? ', пройден' : ''
                      }`}
                      onClick={() => {
                        if (ref.current) ref.current.open = false;
                        onSelect(index);
                      }}
                    >
                      <span className="step-node" aria-hidden="true">
                        <NodeFace step={step} index={index} current={current} />
                      </span>
                      <span className="flow-pop-text">
                        <span className="flow-pop-label">{step.label}</span>
                        {step.title && step.title !== step.label && <span className="flow-pop-title">{step.title}</span>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </Fragment>
        ))}
      </div>
    </details>
  );
}

/** Мини-конвейер для телефона: узлы 8 px на линии, текущий 12 px янтарный, разрывы между этапами; рядом «7 из 10». */
export function MiniBar({ steps, groups, current }: { steps: FlowStep[]; groups: FlowGroup[]; current: number }) {
  const parts = sections(steps, groups);
  return (
    <span className="mbar-wrap">
      <span className="mbar" aria-hidden="true">
        {parts.map((part, partIndex) => (
          <Fragment key={`${part.group}-${partIndex}`}>
            {partIndex > 0 && <b />}
            {part.items.map(({ step, index }) => {
              const state = nodeState(step, index, current);
              return <i key={step.id} className={state ? `is-${state}` : undefined} />;
            })}
          </Fragment>
        ))}
      </span>
      <span className="mbar-count">
        <span className="n">{current + 1}</span> из <span className="n">{steps.length}</span>
      </span>
    </span>
  );
}
