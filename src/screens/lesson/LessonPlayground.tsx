// Наглядные модели к истории урока: блок-«файл» «Попробуй». Они не запускают код ученика и не пишут прогресс.
// Подписи — короткие метки; учебные строки (что считает // и %, чем умножение отличается от повторения) — содержание.
import { CircleCheck, CircleX, Coffee, Croissant, Minus, MousePointer2, Play, Plus, RotateCcw } from 'lucide-react';
import { useId, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { CodeBlock } from '../../components/CodeBlock.tsx';
import { rovingKeyDown, rovingTabIndex } from '../../components/roving.ts';
import { StatusLine } from '../../components/ui.tsx';
import { highlightPython } from '../../editor/highlight.ts';
import { illustrationUrl } from './StoryIllustration.tsx';

function Playground({ title, foot, children }: { title: string; foot?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section className="lesson-playground" aria-labelledby={id}>
      <div className="playground-head">
        <MousePointer2 aria-hidden="true" />
        <span className="plabel">Попробуй</span>
        <h3 className="playground-title" id={id}>
          {title}
        </h3>
      </div>
      <div className="playground-body">
        {children}
        {foot && <p className="playground-foot">{foot}</p>}
      </div>
    </section>
  );
}

/** Табло, чек, сообщение: подпись-метка сверху, содержимое ниже. */
function Display({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="demo-display" aria-live="polite">
      <div className="demo-label">{label}</div>
      {children}
    </div>
  );
}

/** Одна строка Python с той же подсветкой, что у CodeBlock и редактора. */
function Expr({ code }: { code: string }) {
  const tokens = useMemo(() => highlightPython(code)[0] ?? [], [code]);
  return (
    <code className="demo-expr">
      {tokens.map((token, index) => (
        <span key={index} className={token.className || undefined}>
          {token.text}
        </span>
      ))}
    </code>
  );
}

function MenuDemo({ comments = false }: { comments?: boolean }) {
  const [step, setStep] = useState(0);
  const lines = comments ? ['# Меню на сегодня', 'print("Доброе утро!")', 'print("Капучино")'] : ['print("Доброе утро!")', 'print("Капучино")', 'print("Хорошего дня!")'];
  const output = lines.slice(0, step).filter((line) => !line.startsWith('#')).map((line) => line.slice(7, -2));
  // Табло сразу высотой со весь вывод модели: оно не растёт по нажатиям, и «Следующая строка» не уезжает.
  const total = lines.filter((line) => !line.startsWith('#')).length;
  return (
    <Playground title="Как код превращается в строки на табло">
      <div className="demo-flow" style={{ '--lines': total } as CSSProperties}>
        {/* Выполненная строка подсвечена в коде; скринридер слышит новую строку табло. */}
        <CodeBlock code={lines.join('\n')} highlightLine={step || null} label="Программа для табло" />
        <Display label="Табло кофейни">
          {output.length > 0 ? (
            <pre className="demo-screen">{output.join('\n')}</pre>
          ) : (
            <p className="demo-empty">{step && comments ? 'Комментарий пропущен — вывода нет.' : 'Пока пусто'}</p>
          )}
        </Display>
      </div>
      <div className="playground-actions">
        <button className="btn btn-sm" type="button" onClick={() => setStep(step + 1)} disabled={step === lines.length}>
          <Play aria-hidden="true" />
          Следующая строка
        </button>
        <button className="btn btn-ghost btn-sm" type="button" onClick={() => setStep(0)} disabled={!step}>
          <RotateCcw aria-hidden="true" />
          Сначала
        </button>
        <span className="playground-count">
          Строка <span className="n">{step}</span> из <span className="n">{lines.length}</span>
        </span>
      </div>
    </Playground>
  );
}

/** Ползунок модели: подпись и значение сверху, концы шкалы — по бокам дорожки, на её линии (у всех ползунков одинаково). */
function Slider({
  label,
  value,
  unit,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string;
  value: number;
  unit?: string;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="demo-slider">
      <span className="demo-slider-head">
        <span>{label}</span>
        <strong className="demo-value">
          <span className="n">{value}</span>
          {unit && ` ${unit}`}
        </strong>
      </span>
      <span className="demo-range">
        <span className="demo-range-end n" aria-hidden="true">
          {min}
        </span>
        <input
          type="range"
          aria-label={label}
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
        />
        <span className="demo-range-end n" aria-hidden="true">
          {max}
        </span>
      </span>
    </label>
  );
}

function Equation({ code, children }: { code: ReactNode; children: string }) {
  return (
    <div className="demo-eq">
      <code className="demo-eq-code">{code}</code>
      <span className="demo-eq-text">{children}</span>
    </div>
  );
}

function BoxesDemo() {
  const [count, setCount] = useState(14);
  const full = Math.floor(count / 6);
  const rest = count % 6;
  return (
    <Playground
      title="Сколько полных коробок получится?"
      foot={
        <>
          В коробке 6 мест: <code className="inline-code">//</code> — полные коробки, <code className="inline-code">%</code> — остаток.
        </>
      }
    >
      <Slider label="Эклеров сегодня" value={count} min={0} max={30} onChange={setCount} />
      <div className="pastry-boxes" aria-hidden="true">
        {Array.from({ length: Math.max(1, Math.ceil(count / 6)) }, (_, box) => (
          <div key={box} className="pastry-box-wrap">
            <div className="pastry-box" data-full={box < full}>
              {Array.from({ length: 6 }, (_, slot) => (
                <span key={slot} className="pastry" data-filled={box * 6 + slot < count} />
              ))}
            </div>
            <span className="pastry-box-label">{box < full ? 'Полная' : 'Остаток'}</span>
          </div>
        ))}
      </div>
      <div className="demo-equations" aria-live="polite">
        <Equation code={<>{count} // 6 = <b>{full}</b></>}>полных коробок</Equation>
        <Equation code={<>{count} % 6 = <b>{rest}</b></>}>эклеров в остатке</Equation>
      </div>
    </Playground>
  );
}

function BudgetDemo() {
  const [price, setPrice] = useState(4000);
  return (
    <Playground title="Меняешь одно значение — пересчитывается всё">
      <Slider label="Цена автобуса" value={price} unit="₽" min={2000} max={8000} step={500} onChange={setPrice} />
      <div className="demo-equations" aria-live="polite">
        <Equation code={<>bus_price = <b>{price}</b></>}>цена хранится в одном месте</Equation>
        <Equation code={<>bus_price * 2 = <b>{price * 2}</b></>}>туда и обратно</Equation>
      </div>
    </Playground>
  );
}

function MessageDemo({ cafe = false }: { cafe?: boolean }) {
  const [name, setName] = useState('Катя');
  const [time, setTime] = useState('18:00');
  const text = cafe ? `${name}, твой капучино готов!` : `${name}, завтра занятие в ${time}`;
  return (
    <Playground title={cafe ? 'Имя меняется — программа остаётся' : 'Собери напоминание из частей'}>
      <div className="demo-fields">
        <label className="field">
          <span className="field-label">Имя</span>
          <input className="input" value={name} maxLength={24} onChange={(event) => setName(event.target.value)} />
        </label>
        {!cafe && (
          <label className="field">
            <span className="field-label">Время</span>
            <select className="select" value={time} onChange={(event) => setTime(event.target.value)}>
              <option>16:00</option>
              <option>18:00</option>
              <option>19:30</option>
            </select>
          </label>
        )}
      </div>
      <div className="message-preview" aria-live="polite">
        {cafe && <Coffee aria-hidden="true" />}
        <div className="message-main">
          <div className="demo-label">{cafe ? 'Наклейка на стаканчике' : 'Готовое сообщение'}</div>
          <p className="message-text">{text}</p>
        </div>
      </div>
    </Playground>
  );
}

const TYPE_MODES: { value: 'text' | 'int'; label: ReactNode }[] = [
  { value: 'text', label: <>Текст из <code>input()</code></> },
  { value: 'int', label: <>Число через <code>int()</code></> },
];

function TypesDemo() {
  const [mode, setMode] = useState<'text' | 'int'>('text');
  const numeric = mode === 'int';
  return (
    <Playground title="Один ввод, два разных результата">
      {/* Как Choice, но в подписях есть код: input() и int() — моноширинным. */}
      <div className="segmented" role="radiogroup" aria-label="Как обработать ввод" onKeyDown={(event) => rovingKeyDown(event)}>
        {TYPE_MODES.map((option, index) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={mode === option.value}
            tabIndex={rovingTabIndex(mode === option.value, index, true)}
            onClick={() => setMode(option.value)}
          >
            <span>{option.label}</span>
          </button>
        ))}
      </div>
      <div className="demo-display" aria-live="polite">
        <Expr code={numeric ? 'int("3") * 150' : '"3" * 150'} />
        <pre className="demo-screen demo-screen-long">{numeric ? 450 : '3'.repeat(150)}</pre>
        <p className="demo-note">{numeric ? 'Умножение чисел: три чашки по 150.' : 'Повторение строки: символ «3» напечатан 150 раз.'}</p>
      </div>
    </Playground>
  );
}

function ReceiptDemo() {
  const [product, setProduct] = useState('Капучино');
  const [price, setPrice] = useState('150');
  const [quantity, setQuantity] = useState('2');
  const valid =
    price !== '' &&
    quantity !== '' &&
    Number.isInteger(Number(price)) &&
    Number(price) >= 0 &&
    Number(price) <= 100000 &&
    Number.isInteger(Number(quantity)) &&
    Number(quantity) >= 0 &&
    Number(quantity) <= 1000;
  return (
    <Playground title="Данные гостя превращаются в чек">
      <div className="demo-fields receipt-fields">
        <label className="field">
          <span className="field-label">Товар</span>
          <input className="input" value={product} maxLength={32} onChange={(event) => setProduct(event.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">Цена, ₽</span>
          <input className="input" type="number" min="0" max="100000" step="1" value={price} onChange={(event) => setPrice(event.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">Количество</span>
          <input className="input" type="number" min="0" max="1000" step="1" value={quantity} onChange={(event) => setQuantity(event.target.value)} />
        </label>
      </div>
      <Display label="Готовый чек">
        {valid ? (
          <pre className="demo-screen">{`Заказ: ${product}, ${quantity} шт.\nИтого: ${Math.round(Number(price) * Number(quantity) * 100) / 100}`}</pre>
        ) : (
          <StatusLine tone="err">Цена — целое число от 0 до 100000, количество — от 0 до 1000.</StatusLine>
        )}
      </Display>
    </Playground>
  );
}

function DebugDemo() {
  const [fixed, setFixed] = useState(false);
  return (
    <Playground title="Опечатка, которую можно исправить">
      <div className="demo-display" aria-live="polite">
        <Expr code={fixed ? 'print("Капучино")' : 'prnt("Капучино")'} />
        {/* Итог — меткой со значком и словом, не только цветом. */}
        <div className="demo-label demo-result-label" data-tone={fixed ? 'ok' : 'err'}>
          {fixed ? <CircleCheck aria-hidden="true" /> : <CircleX aria-hidden="true" />}
          {fixed ? 'Вывод' : 'Ошибка'}
        </div>
        <pre className="demo-screen" data-tone={fixed ? 'ok' : 'err'}>
          {fixed ? 'Капучино' : "NameError: name 'prnt' is not defined"}
        </pre>
      </div>
      <div className="playground-actions">
        <button type="button" className="btn btn-sm" onClick={() => setFixed(!fixed)}>
          {fixed ? (
            'Вернуть опечатку'
          ) : (
            <span>
              Добавить пропущенную <code className="inline-code">i</code>
            </span>
          )}
        </button>
      </div>
    </Playground>
  );
}

function Counter({ label, value, onChange, icon }: { label: string; value: number; onChange: (value: number) => void; icon: ReactNode }) {
  return (
    <div className="receipt-product">
      {icon}
      <span className="receipt-product-name">{label}</span>
      <div className="order-counter">
        <button type="button" aria-label={`Уменьшить: ${label}`} title="Уменьшить" disabled={value === 0} onClick={() => onChange(value - 1)}>
          <Minus aria-hidden="true" />
        </button>
        <output className="n" aria-label={`Количество: ${label}`}>
          {value}
        </output>
        <button type="button" aria-label={`Увеличить: ${label}`} title="Увеличить" disabled={value === 5} onClick={() => onChange(value + 1)}>
          <Plus aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

export function OrderDemo({ illustrated = false }: { illustrated?: boolean }) {
  const [coffee, setCoffee] = useState(2);
  const [pastry, setPastry] = useState(1);
  return (
    <Playground title="Из чего складывается сумма заказа" foot="В задании — исходный заказ: 2 капучино и 1 круассан.">
      {illustrated && <img className="order-scene" src={illustrationUrl('cafe')} alt="Лена и Артём в кофейне; на подносе две чашки и круассан." width="1672" height="941" decoding="async" />}
      <div className="order-model">
        <div className="order-items">
          <Counter label="Капучино · 180 ₽" icon={<Coffee aria-hidden="true" />} value={coffee} onChange={setCoffee} />
          <Counter label="Круассан · 95 ₽" icon={<Croissant aria-hidden="true" />} value={pastry} onChange={setPastry} />
          <button
            className="btn btn-ghost btn-sm"
            type="button"
            disabled={coffee === 2 && pastry === 1}
            onClick={() => {
              setCoffee(2);
              setPastry(1);
            }}
          >
            <RotateCcw aria-hidden="true" />
            Заказ из условия
          </button>
        </div>
        {/* «Бумажный» чек: свои цвета бумаги в обеих темах (контраст текста ≥ 10:1). */}
        <div className="order-receipt" aria-live="polite">
          <span className="receipt-caption">Твой чек</span>
          <div>
            <span>Капучино × {coffee}</span>
            <span>{coffee * 180}</span>
          </div>
          <div>
            <span>Круассан × {pastry}</span>
            <span>{pastry * 95}</span>
          </div>
          <strong>
            <span>Итого</span>
            <span>{coffee * 180 + pastry * 95} ₽</span>
          </strong>
        </div>
      </div>
    </Playground>
  );
}

export function LessonPlayground({ lessonId }: { lessonId: string }) {
  switch (lessonId) {
    case 'm0-l1':
    case 'm0-l4':
      return <MenuDemo />;
    case 'm0-l2':
      return <MenuDemo comments />;
    case 'm0-l3':
      return <DebugDemo />;
    case 'm1-l1':
      return <BoxesDemo />;
    case 'm1-l2':
      return <BudgetDemo />;
    case 'm1-l3':
      return <MessageDemo />;
    case 'm1-l4':
      return <MessageDemo cafe />;
    case 'm1-l5':
      return <TypesDemo />;
    case 'm1-l6':
      return <ReceiptDemo />;
    default:
      return null;
  }
}
