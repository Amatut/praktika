// Small, optional visual models. They never run the learner's code or write learning progress.
import { ArrowRight, Coffee, Croissant, Minus, MousePointer2, Play, Plus, RotateCcw } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { illustrationUrl } from './StoryIllustration.tsx';

function Playground({ title, children }: { title: string; children: ReactNode }) {
  return <section className="lesson-playground" aria-label={title}>
    <div className="playground-heading"><MousePointer2 aria-hidden="true" /><div><span className="label">Попробуй наглядно</span><h3>{title}</h3></div><span className="playground-note">Без оценки</span></div>
    {children}
  </section>;
}

function MenuDemo({ comments = false }: { comments?: boolean }) {
  const [step, setStep] = useState(0);
  const lines = comments ? ['# Меню на сегодня', 'print("Доброе утро!")', 'print("Капучино")'] : ['print("Доброе утро!")', 'print("Капучино")', 'print("Хорошего дня!")'];
  const output = lines.slice(0, step).filter((line) => !line.startsWith('#')).map((line) => line.slice(7, -2));
  return <Playground title="Как код превращается в строки на табло">
    <p className="playground-intro">Запускай по одной строке и наблюдай за табло справа.</p>
    <div className="demo-flow"><ol className="demo-code">{lines.map((line, index) => <li key={line} data-active={step === index + 1}><span>{index + 1}</span><code>{line}</code>{step === index + 1 && <ArrowRight aria-label="Выполненная строка" />}</li>)}</ol>
      <div className="demo-display" aria-live="polite"><span className="label">Табло кофейни</span><pre>{output.join('\n') || (step && comments ? 'Комментарий пропущен — вывода нет.' : 'Пока пусто')}</pre></div></div>
    <div className="playground-actions"><button className="btn btn-primary btn-sm" type="button" onClick={() => setStep(step + 1)} disabled={step === lines.length}><Play aria-hidden="true" />Следующая строка</button><button className="btn btn-ghost btn-sm" type="button" onClick={() => setStep(0)} disabled={!step}><RotateCcw aria-hidden="true" />Сначала</button><span className="small muted" aria-live="polite">{step} из {lines.length}</span></div>
  </Playground>;
}

function BoxesDemo() {
  const [count, setCount] = useState(14);
  const full = Math.floor(count / 6);
  const rest = count % 6;
  return <Playground title="Сколько полных коробок получится?">
    <label className="demo-slider"><span>Эклеров сегодня <strong>{count}</strong></span><input type="range" min="0" max="30" step="1" value={count} onChange={(event) => setCount(Number(event.target.value))} aria-label="Количество эклеров" /><span className="demo-range-ends"><span>0</span><span>30</span></span></label>
    <div className="pastry-boxes" aria-hidden="true">{Array.from({ length: Math.max(1, Math.ceil(count / 6)) }, (_, box) => <div key={box} className="pastry-box" data-full={box < full}>{Array.from({ length: 6 }, (_, slot) => <span key={slot} className="pastry" data-filled={box * 6 + slot < count} />)}<span className="pastry-box-label">{box < full ? 'Полная коробка' : 'Остаток'}</span></div>)}</div>
    <div className="demo-equations" aria-live="polite"><span><code>{count} // 6 = <b>{full}</b></code>полных коробок</span><span><code>{count} % 6 = <b>{rest}</b></code>эклеров в остатке</span></div>
    <p className="playground-foot">В одной коробке 6 мест. Меняй количество: <code>//</code> считает полные группы, <code>%</code> — остаток.</p>
  </Playground>;
}

function BudgetDemo() {
  const [price, setPrice] = useState(4000);
  return <Playground title="Меняешь одно значение — пересчитывается всё">
    <label className="demo-slider"><span>Цена автобуса <strong>{price} ₽</strong></span><input aria-label="Цена автобуса" type="range" min="2000" max="8000" step="500" value={price} onChange={(event) => setPrice(Number(event.target.value))} /></label>
    <div className="demo-equations" aria-live="polite"><span><code>bus_price = <b>{price}</b></code>цена хранится в одном месте</span><span><code>bus_price * 2 = <b>{price * 2}</b></code>туда и обратно</span></div>
    <p className="playground-foot">Учебная модель: попробуй поднять цену и проследи за вторым выражением.</p>
  </Playground>;
}

function MessageDemo({ cafe = false }: { cafe?: boolean }) {
  const [name, setName] = useState('Катя');
  const [time, setTime] = useState('18:00');
  const text = cafe ? `${name}, твой капучино готов!` : `${name}, завтра занятие в ${time}`;
  return <Playground title={cafe ? 'Имя меняется — программа остаётся' : 'Собери напоминание из частей'}>
    <div className="demo-fields"><label className="field"><span>Имя</span><input className="input" value={name} maxLength={24} onChange={(event) => setName(event.target.value)} /></label>{!cafe && <label className="field"><span>Время</span><select className="select" value={time} onChange={(event) => setTime(event.target.value)}><option>16:00</option><option>18:00</option><option>19:30</option></select></label>}</div>
    <div className="message-preview" aria-live="polite">{cafe && <Coffee aria-hidden="true" />}<div><span className="label">{cafe ? 'Наклейка на стаканчике' : 'Готовое сообщение'}</span><p>{text}</p></div></div>
    <p className="playground-foot">Впиши другое имя и посмотри, какая часть текста изменится.</p>
  </Playground>;
}

function TypesDemo() {
  const [numeric, setNumeric] = useState(false);
  return <Playground title="Один ввод, два разных результата">
    <div className="demo-choice" aria-label="Как обработать ввод"><button type="button" className="btn btn-sm" aria-pressed={!numeric} onClick={() => setNumeric(false)}>Текст из input()</button><button type="button" className="btn btn-sm" aria-pressed={numeric} onClick={() => setNumeric(true)}>Число через int()</button></div>
    <div className="demo-display" aria-live="polite"><code>{numeric ? 'int("3") * 150' : '"3" * 150'}</code><pre>{numeric ? 450 : '3'.repeat(150)}</pre><p className="small muted">{numeric ? 'Умножение чисел: три чашки по 150.' : 'Повторение строки: символ «3» напечатан 150 раз.'}</p></div>
  </Playground>;
}

function ReceiptDemo() {
  const [product, setProduct] = useState('Капучино');
  const [price, setPrice] = useState('150');
  const [quantity, setQuantity] = useState('2');
  const valid = price !== '' && quantity !== '' && Number.isInteger(Number(price)) && Number(price) >= 0 && Number(price) <= 100000 && Number.isInteger(Number(quantity)) && Number(quantity) >= 0 && Number(quantity) <= 1000;
  return <Playground title="Данные гостя превращаются в чек">
    <div className="demo-fields receipt-fields">
      <label className="field"><span>Товар</span><input className="input" value={product} maxLength={32} onChange={(event) => setProduct(event.target.value)} /></label>
      <label className="field"><span>Цена, ₽</span><input className="input" type="number" min="0" max="100000" step="1" value={price} onChange={(event) => setPrice(event.target.value)} /></label>
      <label className="field"><span>Количество</span><input className="input" type="number" min="0" max="1000" step="1" value={quantity} onChange={(event) => setQuantity(event.target.value)} /></label>
    </div>
    <div className="demo-display" aria-live="polite"><span className="label">Готовый чек</span><pre>{valid ? `Заказ: ${product}, ${quantity} шт.\nИтого: ${Math.round(Number(price) * Number(quantity) * 100) / 100}` : 'Цена: целое число от 0 до 100000. Количество: целое число от 0 до 1000.'}</pre></div>
    <p className="playground-foot">Измени входные данные и проследи за чеком. В задании эту связь нужно описать на Python.</p>
  </Playground>;
}

function DebugDemo() {
  const [fixed, setFixed] = useState(false);
  return <Playground title="Опечатка, которую можно исправить">
    <div className="demo-display" aria-live="polite"><code>{fixed ? 'print("Капучино")' : 'prnt("Капучино")'}</code><pre className={fixed ? 'tone-good' : 'tone-error'}>{fixed ? 'Капучино' : "NameError: name 'prnt' is not defined"}</pre></div>
    <button type="button" className="btn btn-sm" onClick={() => setFixed(!fixed)}>{fixed ? 'Вернуть опечатку' : 'Добавить пропущенную i'}</button>
    <p className="playground-foot">Сравни написание команды: одна буква меняет результат запуска.</p>
  </Playground>;
}

function Counter({ label, value, onChange, icon }: { label: string; value: number; onChange: (value: number) => void; icon: ReactNode }) {
  return <div className="receipt-product">{icon}<span>{label}</span><div className="order-counter"><button type="button" aria-label={`Уменьшить: ${label}`} disabled={value === 0} onClick={() => onChange(value - 1)}><Minus aria-hidden="true" /></button><output aria-label={`Количество: ${label}`}>{value}</output><button type="button" aria-label={`Увеличить: ${label}`} disabled={value === 5} onClick={() => onChange(value + 1)}><Plus aria-hidden="true" /></button></div></div>;
}

export function OrderDemo({ illustrated = false }: { illustrated?: boolean }) {
  const [coffee, setCoffee] = useState(2);
  const [pastry, setPastry] = useState(1);
  return <Playground title="Из чего складывается сумма заказа">
    {illustrated && <img className="order-scene" src={illustrationUrl('cafe')} alt="Лена и Артём в кофейне; на подносе две чашки и круассан." width="1672" height="941" decoding="async" />}
    <div className="order-model"><div className="order-items"><Counter label="Капучино · 180 ₽" icon={<Coffee aria-hidden="true" />} value={coffee} onChange={setCoffee} /><Counter label="Круассан · 95 ₽" icon={<Croissant aria-hidden="true" />} value={pastry} onChange={setPastry} /><button className="btn btn-ghost btn-sm" type="button" disabled={coffee === 2 && pastry === 1} onClick={() => { setCoffee(2); setPastry(1); }}><RotateCcw aria-hidden="true" />Заказ из условия</button></div>
      <div className="order-receipt" aria-live="polite"><span className="receipt-caption">Твой чек</span><div><span>Капучино × {coffee}</span><span>{coffee * 180}</span></div><div><span>Круассан × {pastry}</span><span>{pastry * 95}</span></div><strong><span>Итого</span><span>{coffee * 180 + pastry * 95} ₽</span></strong></div></div>
    <p className="playground-foot">Меняй количества кнопками + и −. В задании остаётся исходный заказ: два капучино и один круассан.</p>
  </Playground>;
}

export function LessonPlayground({ lessonId }: { lessonId: string }) {
  switch (lessonId) {
    case 'm0-l1': case 'm0-l4': return <MenuDemo />;
    case 'm0-l2': return <MenuDemo comments />;
    case 'm0-l3': return <DebugDemo />;
    case 'm1-l1': return <BoxesDemo />;
    case 'm1-l2': return <BudgetDemo />;
    case 'm1-l3': return <MessageDemo />;
    case 'm1-l4': return <MessageDemo cafe />;
    case 'm1-l5': return <TypesDemo />;
    case 'm1-l6': return <ReceiptDemo />;
    default: return null;
  }
}
