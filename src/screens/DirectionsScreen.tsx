import { Bot, Brain, Bug, CodeXml, Cpu, Database, Gamepad2, Heart, Server, ShieldCheck, Smartphone, type LucideIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useAsync, useDataVersion, useOnline, useSettings } from '../app/hooks.ts';
import { href, navigate, paths } from '../app/router.ts';
import { InlineText, Markdown } from '../components/Markdown.tsx';
import { Notice, StatusBadge, formatDate, plural } from '../components/ui.tsx';
import type { Course, Lab } from '../content/schema.ts';
import { getInterests, getMarketDatasets, saveInterest, type InterestInput } from '../storage/repo.ts';
import type { InterestRecord, MarketDataset, MarketEntry } from '../storage/types.ts';
import { PathChips } from './TodayScreen.tsx';

export const LAB_ICON: Record<string, LucideIcon> = {
  web: CodeXml,
  backend: Server,
  automation: Bot,
  data: Database,
  ai: Brain,
  mobile: Smartphone,
  games: Gamepad2,
  qa: Bug,
  security: ShieldCheck,
  systems: Cpu,
};

const ENV_LABEL = { python: 'Python', web: 'Веб-пример', external: 'Внешний инструмент' } as const;
const PROTOTYPE_LABEL = {
  working: 'рабочий прототип',
  simulation: 'учебная имитация',
  concept: 'концептуальный пример',
} as const;

const SOURCE_LABEL: Record<MarketEntry['sourceType'], string> = {
  vacancy: 'Вакансия',
  order: 'Заказ',
  statistics: 'Статистика',
  survey: 'Опрос',
  platform: 'Площадка',
};

const PERIOD_LABEL: Record<MarketEntry['period'], string> = { month: 'в месяц', year: 'в год', hour: 'в час', project: 'за заказ' };

/** Что это за сумма: объявление — не выплата, опрос — не статистика выплат (см. docs/market.md). */
function entryKind(entry: MarketEntry): string {
  if (entry.sourceType === 'survey') return 'Опрос: суммы со слов участников, не выплаты';
  if (entry.sourceType === 'statistics') return 'Статистика выплат';
  return entry.isOffer ? 'Предложение (объявление), не выплата' : 'Подтверждённая оплата';
}

/** Данные старше 30 дней или без понятной даты проверки могли устареть. */
function checkedAge(checkedAt: string): { unknown: boolean; stale: boolean } {
  const time = new Date(checkedAt).getTime();
  if (Number.isNaN(time)) return { unknown: true, stale: true };
  return { unknown: false, stale: Date.now() - time > 30 * 24 * 3600 * 1000 };
}

function sameRegion(a: string, b: string): boolean {
  return a.trim().toLocaleLowerCase('ru-RU') === b.trim().toLocaleLowerCase('ru-RU');
}

export function DirectionsScreen({ course, labId }: { course: Course; labId: string | null }) {
  const version = useDataVersion(['interests', 'market']);
  const interests = useAsync(getInterests, [version]);
  const market = useAsync(getMarketDatasets, [version]);
  const selected = course.labs.find((lab) => lab.id === labId) ?? course.labs[0];
  const interestMap = new Map((interests.value ?? []).map((record) => [record.labId, record]));
  // Форма интересов берёт начальные значения один раз — поэтому ждём первой загрузки отметок.
  const interestsReady = interests.value !== undefined || interests.error !== null;

  return (
    <div className="page">
      <header className="page-head">
        <span className="eyebrow">Направления</span>
        <h1>Найди то, что хочется создавать</h1>
        <p className="page-lead">
          Истории о разных областях и маленькие пробы. Решать, кем стать, пока не нужно: интерес и навык оцениваются отдельно.
        </p>
        <div style={{ marginTop: 8 }}>
          <PathChips course={course} current="labs" />
        </div>
      </header>

      <div className="labs-layout">
        <div className="lab-grid" role="list" aria-label="Лаборатории">
          {course.labs.map((lab) => {
            const Icon = LAB_ICON[lab.id] ?? CodeXml;
            const interest = interestMap.get(lab.id);
            const unlock = course.modules.find((module) => module.id === lab.unlockAfter);
            return (
              <a
                key={lab.id}
                role="listitem"
                className="lab-card"
                href={href(paths.directions(lab.id))}
                aria-current={lab.id === selected.id ? 'true' : undefined}
                onClick={(event) => {
                  event.preventDefault();
                  navigate(paths.directions(lab.id), { replace: true });
                  // Описание под карточками: показываем его и переносим туда фокус (отступ под липкую строку — в CSS).
                  if (window.matchMedia('(max-width: 1199px)').matches) {
                    requestAnimationFrame(() => {
                      document.getElementById('lab-title')?.focus({ preventScroll: true });
                      document.getElementById('lab-detail')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    });
                  }
                }}
              >
                <span className="lab-card-head">
                  <Icon aria-hidden="true" />
                  <strong>{lab.title}</strong>
                </span>
                <span className="lab-hook">{lab.hook}</span>
                <span className="lab-facts">
                  <span>
                    <span className="lab-fact-label">Мини-проект:</span> {lab.project.title}
                  </span>
                  {lab.prerequisites[0] && (
                    <span>
                      <span className="lab-fact-label">Нужно знать:</span> {lab.prerequisites[0]}
                    </span>
                  )}
                </span>
                <span className="lab-foot">
                  <span className="badge">
                    {lab.project.sessions[0]}–{lab.project.sessions[1]} {plural(lab.project.sessions[1], ['сессия', 'сессии', 'сессий'])}
                  </span>
                  {unlock && <span className="badge">после модуля {unlock.number}</span>}
                  {interest && (
                    <span className="badge badge-accent">
                      <Heart aria-hidden="true" />
                      {interest.status === 'tried' ? 'Пробовал' : 'Интересно'}
                    </span>
                  )}
                </span>
              </a>
            );
          })}
        </div>

        <LabDetail
          key={selected.id}
          course={course}
          lab={selected}
          interest={interestMap.get(selected.id) ?? null}
          interestsReady={interestsReady}
          interestsError={interests.error}
          datasets={market.value ?? []}
        />
      </div>
    </div>
  );
}

function LabDetail({
  course,
  lab,
  interest,
  interestsReady,
  interestsError,
  datasets,
}: {
  course: Course;
  lab: Lab;
  interest: InterestRecord | null;
  interestsReady: boolean;
  interestsError: Error | null;
  datasets: MarketDataset[];
}) {
  const unlock = course.modules.find((module) => module.id === lab.unlockAfter);
  const Icon = LAB_ICON[lab.id] ?? CodeXml;
  return (
    <section id="lab-detail" className="lab-detail" aria-labelledby="lab-title">
      <div className="card stack">
        <div className="stack-sm">
          <span className="eyebrow row" style={{ gap: 6 }}>
            <Icon aria-hidden="true" width={14} height={14} />
            Лаборатория
          </span>
          <h2 id="lab-title" tabIndex={-1}>
            {lab.title}
          </h2>
          <p className="muted">{lab.hook}</p>
        </div>
        <div className="story">
          <h3 className="story-title">{lab.story.title}</h3>
          <Markdown text={lab.story.text} />
          {lab.story.fictional && <p className="story-note">История-пример: придумана или составлена для наглядности.</p>}
        </div>

        <div className="stack-sm">
          <span className="label">Первая проба</span>
          <div className="fact">
            <strong>{lab.project.title}</strong>
            <span className="small">{lab.project.result}</span>
            <span className="row" style={{ marginTop: 4 }}>
              <span className="badge">
                {lab.project.sessions[0]}–{lab.project.sessions[1]} сессий по 20–30 мин
              </span>
              <span className="badge">{ENV_LABEL[lab.project.environment]}</span>
              <span className="badge">{PROTOTYPE_LABEL[lab.project.prototype]}</span>
            </span>
            <span className="tiny muted">Инструменты: {lab.project.tools}</span>
          </div>
          {!lab.ready && (
            <StatusBadge tone="muted">
              Материалы пробы готовятся{unlock ? ` · имеет смысл после модуля ${unlock.number}` : ''}
            </StatusBadge>
          )}
        </div>

        <div className="grid-2">
          <div className="stack-sm">
            <span className="label">Нужно знать</span>
            <ul className="bullets small">
              {lab.prerequisites.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
          <div className="stack-sm">
            <span className="label">Что создают</span>
            <ul className="bullets small">
              {lab.products.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        </div>

        <details className="disclosure">
          <summary>Обычный день специалиста</summary>
          <div className="disclosure-body stack-sm small">
            <p>{lab.day}</p>
            <div className="grid-2">
              <div>
                <span className="label">Что нравится</span>
                <ul className="bullets" style={{ marginTop: 6 }}>
                  {lab.likes.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
              <div>
                <span className="label">Что бывает сложно или скучно</span>
                <ul className="bullets" style={{ marginTop: 6 }}>
                  {lab.hard.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </details>
      </div>

      <WorkAndOrders lab={lab} datasets={datasets} />
      {interestsError ? (
        <Notice tone="error" title="Отметки об интересах не загрузились">
          {interestsError.message}
        </Notice>
      ) : interestsReady ? (
        <InterestForm lab={lab} interest={interest} />
      ) : (
        <p className="small muted" role="status">
          Загружаю отметки…
        </p>
      )}
    </section>
  );
}

function WorkAndOrders({ lab, datasets }: { lab: Lab; datasets: MarketDataset[] }) {
  const settings = useSettings();
  const online = useOnline();
  const [showOther, setShowOther] = useState(false);
  const region = settings.market.region;
  const all: (MarketEntry & { dataset: MarketDataset })[] = datasets.flatMap((dataset) =>
    dataset.entries.filter((entry) => entry.lab === lab.id).map((entry) => ({ ...entry, dataset })),
  );
  // Заголовок называет выбранный рынок — значит, и записи показываем для него; остальные по запросу.
  const forRegion = region ? all.filter((entry) => sameRegion(entry.region, region)) : all;
  const otherRegions = [...new Set(all.filter((entry) => !forRegion.includes(entry)).map((entry) => entry.region))];
  const entries = showOther ? all : forRegion;
  const byType = (type: MarketEntry['type']) => entries.filter((entry) => entry.type === type);
  const fields: { type: MarketEntry['type']; title: string }[] = [
    { type: 'salary', title: 'Зарплата в найме' },
    { type: 'hourly', title: 'Ставка фрилансера за час' },
    { type: 'project', title: 'Бюджет заказа' },
  ];

  return (
    <section className="card stack" aria-labelledby="market-title">
      <div className="card-head" style={{ marginBottom: 0 }}>
        <div>
          <h3 id="market-title" className="card-title">
            Работа и заказы
          </h3>
          <p className="card-sub">
            {region
              ? `Рынок: ${region}${settings.market.currency ? `, ${settings.market.currency}` : ''}${showOther ? ' и другие рынки' : ''}`
              : all.length > 0
                ? 'Регион не выбран — показаны записи всех рынков'
                : 'Регион и валюта ещё не выбраны'}
          </p>
        </div>
        {!region && (
          <a className="btn btn-sm" href={href(paths.settings('market'))}>
            Выбрать
          </a>
        )}
      </div>

      <div className="market-fields">
        {fields.map((field) => {
          const items = byType(field.type);
          return (
            <div key={field.type} className="market-field">
              <div className="label">{field.title}</div>
              <div className="value">{items.length === 0 ? 'Данные ещё не загружены' : `${items.length} ${plural(items.length, ['запись', 'записи', 'записей'])} ниже`}</div>
            </div>
          );
        })}
      </div>

      {entries.length > 0 ? (
        <div style={{ overflowX: 'auto' }}>
          <table className="market-table">
            <thead>
              <tr>
                <th scope="col">Что</th>
                <th scope="col">Сумма</th>
                <th scope="col">Рынок и уровень</th>
                <th scope="col">Источник</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry, index) => {
                const age = checkedAge(entry.checkedAt);
                return (
                  <tr key={index}>
                    <td>
                      {entry.title}
                      <div className="tiny muted">{entryKind(entry)}</div>
                      {entry.note.trim() && <div className="tiny market-note">{entry.note}</div>}
                    </td>
                    <td className="nowrap">
                      {entry.amountMin ?? '—'}
                      {entry.amountMax !== null && entry.amountMax !== entry.amountMin ? `–${entry.amountMax}` : ''} {entry.currency}
                      <div className="tiny muted">{PERIOD_LABEL[entry.period]}, до налогов и комиссий</div>
                    </td>
                    <td>
                      {entry.region}
                      <div className="tiny muted">{entry.level}</div>
                    </td>
                    <td>
                      <a href={entry.url} target="_blank" rel="noopener noreferrer">
                        {SOURCE_LABEL[entry.sourceType]}
                      </a>
                      <div className={`tiny ${age.stale ? 'status-warn' : 'muted'}`}>
                        {entry.publishedAt ? `опубл. ${formatDate(entry.publishedAt, { year: true })}, ` : ''}
                        {age.unknown ? 'дата проверки неизвестна — могло устареть' : `проверено ${formatDate(entry.checkedAt, { year: true })}`}
                        {age.stale && !age.unknown ? ' · могло устареть' : ''}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!online && <p className="tiny muted">Нет сети — показан сохранённый обзор.</p>}
        </div>
      ) : (
        <p className="small muted">
          {all.length > 0
            ? `Для рынка «${region}» записей нет. Суммы одного рынка нельзя переносить на другой.`
            : 'Суммы здесь появятся только из проверенных источников — с датой, регионом, валютой, уровнем и ссылкой. Обзор можно импортировать в настройках. Приложение не придумывает цифры.'}
        </p>
      )}
      {region && otherRegions.length > 0 && (
        <div className="row">
          <button type="button" className="btn btn-ghost btn-sm" aria-pressed={showOther} onClick={() => setShowOther((value) => !value)}>
            {showOther ? `Только ${region}` : `Показать другие рынки: ${otherRegions.join(', ')}`}
          </button>
        </div>
      )}

      <div className="stack-sm">
        <span className="label">За что платят</span>
        <ul className="plain-list">
          {lab.paidTasks.map((task) => (
            <li key={task.title} className="fact">
              <strong className="small">{task.title}</strong>
              <span className="small">
                <span className="muted">Пример требований. </span>
                <InlineText text={task.example} />
              </span>
              <span className="tiny muted">Чего пока не хватает новичку: {task.gap}</span>
            </li>
          ))}
        </ul>
      </div>
      <details className="disclosure">
        <summary>Что нужно для настоящей работы</summary>
        <div className="disclosure-body">
          <ul className="bullets small">
            {lab.realWork.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <p className="tiny muted" style={{ marginTop: 8 }}>
            Ни один курс и ни один заказ сам по себе не означает готовность к работе: к учебным навыкам добавляются требования,
            сроки, тестирование, правки, документация и общение.
          </p>
        </div>
      </details>
    </section>
  );
}

function InterestForm({ lab, interest }: { lab: Lab; interest: InterestRecord | null }) {
  const [liked, setLiked] = useState(interest?.liked ?? '');
  const [tiring, setTiring] = useState(interest?.tiring ?? '');
  const [answer, setAnswer] = useState<InterestRecord['continue']>(interest?.continue ?? null);
  const [saved, setSaved] = useState(false);
  useEffect(() => setSaved(false), [liked, tiring, answer]);
  const dirty = liked !== (interest?.liked ?? '') || tiring !== (interest?.tiring ?? '') || answer !== (interest?.continue ?? null);

  /**
   * Сохраняются только изменённые поля, поэтому прежние ответы не затираются.
   * «Пробовал» ставится только отдельной отметкой после пробы: ответы на вопросы — это ещё не проба.
   */
  async function save(status?: InterestRecord['status']) {
    const patch: InterestInput = { labId: lab.id };
    if (status) patch.status = status;
    else if (!interest) patch.status = 'curious';
    if (liked !== (interest?.liked ?? '')) patch.liked = liked;
    if (tiring !== (interest?.tiring ?? '')) patch.tiring = tiring;
    if (answer !== (interest?.continue ?? null)) patch.continue = answer;
    await saveInterest(patch);
    setSaved(true);
  }

  return (
    <section className="card stack" aria-labelledby="interest-title">
      <div>
        <h3 id="interest-title" className="card-title">
          Карта интересов
        </h3>
        <p className="card-sub">«Понравилось» не значит «освоено»: интерес хранится отдельно от навыков.</p>
      </div>
      {!interest && (
        <div className="row">
          <button type="button" className="btn" onClick={() => void save('curious')}>
            <Heart aria-hidden="true" />
            Интересно, хочу попробовать
          </button>
        </div>
      )}
      <div className="interest-form">
        <p className="small muted">После пробы (или просто прочитав историю) ответь на три вопроса — это поможет выбрать маршрут.</p>
        <label className="field">
          <span className="field-label">Что понравилось?</span>
          <textarea className="textarea" rows={2} value={liked} onChange={(event) => setLiked(event.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">Что утомило или показалось скучным?</span>
          <textarea className="textarea" rows={2} value={tiring} onChange={(event) => setTiring(event.target.value)} />
        </label>
        <div className="field">
          <span className="field-label" id={`${lab.id}-continue`}>
            Хочется продолжить?
          </span>
          <div className="segmented" role="radiogroup" aria-labelledby={`${lab.id}-continue`}>
            {(
              [
                ['yes', 'Да'],
                ['maybe', 'Возможно'],
                ['no', 'Пока нет'],
              ] as const
            ).map(([value, label]) => (
              <button key={value} type="button" role="radio" aria-checked={answer === value} onClick={() => setAnswer(value)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="row">
          <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={!dirty}>
            Сохранить
          </button>
          {lab.ready && interest?.status !== 'tried' && (
            <button type="button" className="btn" onClick={() => void save('tried')}>
              Проба пройдена
            </button>
          )}
          {saved && <StatusBadge tone="good">Сохранено</StatusBadge>}
        </div>
        {interest && (
          <p className="tiny muted">
            {interest.status === 'tried'
              ? 'Отмечено: пробовал это направление.'
              : lab.ready
                ? 'Отмечено: интересно. После пробы отметь «Проба пройдена».'
                : 'Отмечено: интересно. Отметка «пробовал» появится, когда будут готовы материалы пробы.'}
          </p>
        )}
      </div>
    </section>
  );
}
