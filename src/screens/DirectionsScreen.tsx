// «Направления» — как панель «Расширения» редактора: слева список проб, справа документ выбранного направления
// (история, первая проба, что нужно знать, работа и заказы, карта интересов). Вид — src/styles/screens/directions.css.
import {
  ArrowUp,
  Bot,
  Brain,
  Bug,
  ChevronRight,
  CircleDashed,
  CodeXml,
  Compass,
  Cpu,
  Database,
  ExternalLink,
  Gamepad2,
  GitBranch,
  Heart,
  Hourglass,
  Search,
  Server,
  ShieldCheck,
  Smartphone,
  Timer,
  TriangleAlert,
  WifiOff,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useAsync, useDataVersion, useOnline, useSettings } from '../app/hooks.ts';
import { href, navigate, paths } from '../app/router.ts';
import { InlineText, Markdown } from '../components/Markdown.tsx';
import { Choice, Disclosure, EmptyState, Notice, StatusBadge, Tag, formatDate, plural } from '../components/ui.tsx';
import type { Course, Lab } from '../content/schema.ts';
import { getInterests, getMarketDatasets, saveInterest, type InterestInput } from '../storage/repo.ts';
import type { InterestRecord, MarketDataset, MarketEntry } from '../storage/types.ts';

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

const ENV_LABEL = { python: 'Python', web: 'веб-пример', external: 'внешний инструмент' } as const;
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
  if (entry.sourceType === 'survey') return 'опрос, со слов участников';
  if (entry.sourceType === 'statistics') return 'статистика выплат';
  return entry.isOffer ? 'объявление, не выплата' : 'подтверждённая оплата';
}

/** Данные старше 30 дней или без понятной даты проверки могли устареть. */
function checkedAge(checkedAt: string): { unknown: boolean; stale: boolean } {
  const time = new Date(checkedAt).getTime();
  if (Number.isNaN(time)) return { unknown: true, stale: true };
  return { unknown: false, stale: Date.now() - time > 30 * 24 * 3600 * 1000 };
}

/** 70794 → «70 794»: крупные суммы читаются легче. */
function formatAmount(value: number | null): string {
  return value === null ? '—' : value.toLocaleString('ru-RU');
}

function sameRegion(a: string, b: string): boolean {
  return a.trim().toLocaleLowerCase('ru-RU') === b.trim().toLocaleLowerCase('ru-RU');
}

/**
 * Дата источника — всегда с годом (данные прошлого года не должны выглядеть свежими), словами, как везде:
 * «26 сентября 2026». Сама дата не рвётся по строкам.
 */
function SourceDate({ value }: { value: string }) {
  if (Number.isNaN(new Date(value).getTime())) return <>дата неизвестна</>;
  return (
    <time dateTime={value} className="nowrap">
      {formatDate(value, { year: true })}
    </time>
  );
}

/** «4–6 сессий»: числа — моноширинным, слово — шрифтом интерфейса. */
function Sessions({ lab }: { lab: Lab }) {
  const [from, to] = lab.project.sessions;
  return (
    <>
      <span className="n">
        {from}–{to}
      </span>{' '}
      {plural(to, ['сессия', 'сессии', 'сессий'])}
    </>
  );
}

/** «после модуля 5»: слова — шрифтом интерфейса, номер — моноширинным. */
function UnlockText({ number }: { number: number }) {
  return (
    <>
      после модуля <span className="n">{number}</span>
    </>
  );
}

/** Телефон и планшет в портрете: документ направления стоит под списком, а не рядом. */
const NARROW = '(max-width: 899px)';

function smoothScroll(): ScrollBehavior {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}

/** Фокус на заголовок документа (скринридер объявит направление); на узком экране — ещё и прокрутка к документу. */
function revealDetail(scroll: boolean, behavior: ScrollBehavior): number {
  return requestAnimationFrame(() => {
    document.getElementById('lab-title')?.focus({ preventScroll: true });
    if (scroll) document.getElementById('lab-detail')?.scrollIntoView({ behavior, block: 'start' });
  });
}

export function DirectionsScreen({ course, labId }: { course: Course; labId: string | null }) {
  const [query, setQuery] = useState('');
  const search = query.trim().toLocaleLowerCase('ru-RU');
  const visibleLabs = course.labs.filter((lab) => [lab.title, lab.hook, lab.project.title].some((value) => value.toLocaleLowerCase('ru-RU').includes(search)));
  const version = useDataVersion(['interests', 'market']);
  const interests = useAsync(getInterests, [version]);
  const market = useAsync(getMarketDatasets, [version]);
  const selected = course.labs.find((lab) => lab.id === labId) ?? course.labs[0];
  const interestMap = new Map((interests.value ?? []).map((record) => [record.labId, record]));
  // Форма интересов берёт начальные значения один раз — поэтому ждём первой загрузки отметок.
  const interestsReady = interests.value !== undefined || interests.error !== null;
  // Поиск скрыл выбранное направление: на узком экране его документ под «Не нашлось» выглядел бы результатом поиска.
  const orphanDoc = search !== '' && !visibleLabs.includes(selected);
  const docRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Вход по адресу направления (#/directions/games — из «Прогресса» или «Сегодня») на узком экране: документ — под
  // списком из десяти рядов, поэтому сразу показываем его. Без направления в адресе (нижняя навигация) — список.
  useEffect(() => {
    if (!labId || !window.matchMedia(NARROW).matches) return;
    const frame = revealDetail(true, 'auto');
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Другое направление открывается с начала документа (на ПК документ прокручивается сам). Выбранный ряд
  // списка виден и при переходе по адресу (#/directions/systems — десятый ряд): на ПК список прокручивается
  // сам под неподвижным поиском; на телефоне список — сама страница, её не двигаем.
  useEffect(() => {
    docRef.current?.scrollTo({ top: 0 });
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!list || !row || list.scrollHeight <= list.clientHeight) return;
    const box = list.getBoundingClientRect();
    const rowBox = row.getBoundingClientRect();
    if (rowBox.top < box.top) list.scrollTop += rowBox.top - box.top;
    else if (rowBox.bottom > box.bottom) list.scrollTop += rowBox.bottom - box.bottom;
  }, [selected.id]);

  return (
    <div className="page-split dir">
      <div className="dir-list">
        {/* Шапка и поиск — неподвижная строка панели, под ними прокручивается список (≥ 900 px).
            На телефоне название экрана уже в верхней строке — метка панели остаётся только для скринридера. */}
        <div className="pane-head dir-list-head">
          <h1 className="plabel">
            <Compass aria-hidden="true" />
            Направления
          </h1>
        </div>
        <div className="dir-search">
          <label className="lab-search">
            <Search aria-hidden="true" />
            <input className="input" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Сайты, игры, боты…" aria-label="Поиск направления" />
          </label>
          <span className="dir-count" role="status">
            <span className="visually-hidden">Показано: </span>
            <span className="n">{visibleLabs.length}</span> из <span className="n">{course.labs.length}</span>
          </span>
        </div>
        <div className="dir-scroll" ref={listRef}>
          {visibleLabs.length === 0 ? (
            <div className="dir-empty">
              <EmptyState
                title="Такого направления не нашлось"
                icon={Search}
                action={
                  <button className="btn btn-sm" type="button" onClick={() => setQuery('')}>
                    <X aria-hidden="true" />
                    Сбросить поиск
                  </button>
                }
              />
            </div>
          ) : (
            <ul className="rows dir-rows" aria-label="Список направлений">
              {visibleLabs.map((lab) => {
                const Icon = LAB_ICON[lab.id] ?? CodeXml;
                const interest = interestMap.get(lab.id);
                const unlock = course.modules.find((module) => module.id === lab.unlockAfter);
                return (
                  <li key={lab.id}>
                    <a
                      className="row lab-card"
                      href={href(paths.directions(lab.id))}
                      aria-current={lab.id === selected.id ? 'true' : undefined}
                      onClick={(event) => {
                        event.preventDefault();
                        navigate(paths.directions(lab.id), { replace: true });
                        // Узкий экран: документ под списком — переносим туда фокус и прокрутку. На ПК документ рядом:
                        // с клавиатуры (Enter, у события detail = 0) фокус переходит к документу, мышью — остаётся в списке.
                        const narrow = window.matchMedia(NARROW).matches;
                        if (narrow || event.detail === 0) revealDetail(narrow, smoothScroll());
                      }}
                    >
                      <span className="row-ic" aria-hidden="true">
                        <Icon />
                      </span>
                      <span className="row-main">
                        <span className="row-title">{lab.title}</span>
                        <span className="row-sub">{lab.hook}</span>
                        <span className="lab-card-meta">
                          <span>
                            <Sessions lab={lab} />
                          </span>
                          {unlock && (
                            <span>
                              <UnlockText number={unlock.number} />
                            </span>
                          )}
                          {interest && (
                            <StatusBadge tone="accent" icon={Heart}>
                              {interest.status === 'tried' ? 'Пробовал' : 'Интересно'}
                            </StatusBadge>
                          )}
                        </span>
                      </span>
                    </a>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      <div className={`dir-doc${orphanDoc ? ' dir-doc-orphan' : ''}`} ref={docRef}>
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

  // Узкий экран: список выше документа — возвращаемся к выбранному ряду (не к полю поиска: на телефоне фокус в поле
  // открыл бы клавиатуру). Если поиск скрыл ряд — к поиску.
  function backToList() {
    const row = document.querySelector<HTMLElement>('.lab-card[aria-current="true"]');
    const target = row ?? document.querySelector<HTMLElement>('.dir-search input');
    target?.scrollIntoView({ behavior: smoothScroll(), block: row ? 'center' : 'start' });
    target?.focus({ preventScroll: true });
  }

  return (
    <section id="lab-detail" className="dir-detail" aria-labelledby="lab-title">
      <header className="dir-head">
        <button type="button" className="btn btn-sm btn-ghost dir-back" onClick={backToList}>
          <ArrowUp aria-hidden="true" />
          К списку
        </button>
        <div className="dir-head-top">
          <span className="row-ic dir-head-ic" aria-hidden="true">
            <Icon />
          </span>
          <h2 id="lab-title" tabIndex={-1}>
            {lab.title}
          </h2>
        </div>
        <Markdown text={lab.hook} className="dir-hook" />
        <div className="dir-tags">
          <Tag icon={Timer}>
            <Sessions lab={lab} />
          </Tag>
          {unlock && (
            <Tag icon={GitBranch}>
              <UnlockText number={unlock.number} />
            </Tag>
          )}
          <Tag>{PROTOTYPE_LABEL[lab.project.prototype]}</Tag>
          <Tag>{ENV_LABEL[lab.project.environment]}</Tag>
        </div>
        {interestsReady && !interestsError && <InterestMark labId={lab.id} interest={interest} />}
      </header>

      <section className="dir-sec" aria-labelledby="lab-story-title">
        <div className="dir-sec-head">
          <h3 id="lab-story-title">История</h3>
          {lab.story.fictional && <Tag>Вымышленная история</Tag>}
        </div>
        <div className="story">
          <h4 className="dir-story-title">{lab.story.title}</h4>
          <Markdown text={lab.story.text} />
        </div>
      </section>

      <section className="dir-sec" aria-labelledby="lab-try-title">
        <div className="dir-sec-head">
          <h3 id="lab-try-title">Первая проба</h3>
          {!lab.ready && (
            <StatusBadge tone="muted" icon={Hourglass}>
              Материалы пишутся
            </StatusBadge>
          )}
        </div>
        <div className="dir-try">
          <h4 className="dir-try-title">{lab.project.title}</h4>
          <Markdown text={lab.project.result} />
          <p className="dir-line">
            <span className="dir-line-label">Инструменты</span>
            <span>{lab.project.tools}</span>
          </p>
        </div>
      </section>

      <div className="dir-sec dir-cols">
        <section aria-labelledby="lab-know-title">
          <h3 id="lab-know-title">Нужно знать</h3>
          <ul className="bullets dir-bullets">
            {lab.prerequisites.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
        <section aria-labelledby="lab-make-title">
          <h3 id="lab-make-title">Что создают</h3>
          <ul className="bullets dir-bullets">
            {lab.products.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      </div>

      <Disclosure summary="Обычный день специалиста" className="dir-day">
        <div className="dir-day-body">
          <Markdown text={lab.day} />
          <div className="dir-cols dir-cols-tight">
            <div>
              <h4 className="dir-h4">Что нравится</h4>
              <ul className="bullets dir-bullets">
                {lab.likes.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
            <div>
              <h4 className="dir-h4">Что бывает сложно или скучно</h4>
              <ul className="bullets dir-bullets">
                {lab.hard.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </Disclosure>

      <WorkAndOrders lab={lab} datasets={datasets} />

      {interestsError ? (
        <section className="dir-sec" aria-labelledby="interest-title">
          <div className="dir-sec-head">
            <h3 id="interest-title">Карта интересов</h3>
          </div>
          <Notice tone="error" title="Отметки не загрузились">
            {interestsError.message}
          </Notice>
        </section>
      ) : interestsReady ? (
        <InterestForm lab={lab} interest={interest} />
      ) : (
        <p className="dir-sec loading-line" role="status">
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
  // Рынок задаёт обзор целиком («Международный фриланс»), а у записи регион уточнён по источнику
  // («Freelancer.com, удалённо, весь мир») — подходит совпадение любого из них.
  const inMarket = (entry: (typeof all)[number]) => sameRegion(entry.dataset.region, region!) || sameRegion(entry.region, region!);
  const forRegion = region ? all.filter(inMarket) : all;
  const otherRegions = [...new Set(all.filter((entry) => !forRegion.includes(entry)).map((entry) => entry.dataset.region))];
  const entries = showOther ? all : forRegion;
  const byType = (type: MarketEntry['type']) => entries.filter((entry) => entry.type === type);
  const fields: { type: MarketEntry['type']; title: string }[] = [
    { type: 'salary', title: 'Зарплата в найме' },
    { type: 'hourly', title: 'Ставка фрилансера за час' },
    { type: 'project', title: 'Бюджет заказа' },
  ];
  const marketLabel = region
    ? `Рынок: ${region}${settings.market.currency ? `, ${settings.market.currency}` : ''}${showOther ? ' и другие рынки' : ''}`
    : all.length > 0
      ? 'Все рынки · регион не выбран'
      : 'Регион и валюта не выбраны';

  return (
    <section className="dir-sec dir-market" aria-labelledby="market-title">
      <div className="dir-sec-head">
        <div className="dir-sec-title">
          <h3 id="market-title">Работа и заказы</h3>
          <p className="dir-sub">{marketLabel}</p>
        </div>
        {/* Без обзоров ведёт в настройки рынка «Загрузить обзор» ниже — второй вход туда же не нужен. */}
        {!region && datasets.length > 0 && (
          <a className="btn btn-sm" href={href(paths.settings('market'))}>
            Выбрать
          </a>
        )}
      </div>

      {datasets.length === 0 ? (
        <EmptyState
          title="Данные ещё не загружены"
          icon={CircleDashed}
          action={
            <a className="btn btn-sm" href={href(paths.settings('market'))}>
              Загрузить обзор
            </a>
          }
        />
      ) : all.length === 0 ? (
        <EmptyState
          title="В загруженных обзорах записей нет"
          icon={CircleDashed}
          action={
            <a className="btn btn-sm" href={href(paths.settings('market'))}>
              Обзоры рынка
            </a>
          }
        />
      ) : (
        <>
          <dl className="dir-fields">
            {fields.map((field) => {
              const count = byType(field.type).length;
              return (
                <div key={field.type} className="dir-field">
                  <dt>{field.title}</dt>
                  <dd>
                    {count === 0 ? (
                      'нет записей'
                    ) : (
                      <>
                        <span className="n">{count}</span> {plural(count, ['запись', 'записи', 'записей'])} ниже
                      </>
                    )}
                  </dd>
                </div>
              );
            })}
          </dl>

          {!online && (
            <div className="dir-offline">
              <Tag icon={WifiOff}>Без сети · сохранённый обзор</Tag>
            </div>
          )}

          {entries.length > 0 ? (
            <div className="dir-table-wrap">
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
                  {entries.map((entry, index) => (
                    <MarketRow key={index} entry={entry} />
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="dir-note">Для рынка «{region}» записей нет</p>
          )}
          {region && otherRegions.length > 0 && (
            <div>
              <button type="button" className="btn btn-sm btn-wrap" aria-pressed={showOther} onClick={() => setShowOther((value) => !value)}>
                {showOther ? `Только ${region}` : `Показать другие рынки: ${otherRegions.join(', ')}`}
              </button>
            </div>
          )}
        </>
      )}

      <div className="dir-paid">
        <h4 className="dir-h4">За что платят</h4>
        <ul className="dir-tasks">
          {lab.paidTasks.map((task) => (
            <li key={task.title}>
              <p className="dir-task-title">{task.title}</p>
              <dl className="dir-kv">
                <dt>Пример требований</dt>
                <dd>
                  <InlineText text={task.example} />
                </dd>
                <dt>Не хватает новичку</dt>
                <dd>{task.gap}</dd>
              </dl>
            </li>
          ))}
        </ul>
      </div>

      <Disclosure summary="Что нужно для настоящей работы" className="dir-real">
        <ul className="bullets dir-bullets">
          {lab.realWork.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </Disclosure>
    </section>
  );
}

/**
 * Запись обзора рынка — строка таблицы. «Подробнее» (заметка об источнике) раскрывается отдельной строкой на всю
 * ширину таблицы, а не узкой колонкой «Что»; в строках-карточках — сразу под источником.
 */
function MarketRow({ entry }: { entry: MarketEntry }) {
  const [open, setOpen] = useState(false);
  const noteId = useId();
  const age = checkedAge(entry.checkedAt);
  const note = entry.note.trim();
  const range = `${formatAmount(entry.amountMin)}${entry.amountMax !== null && entry.amountMax !== entry.amountMin ? `–${formatAmount(entry.amountMax)}` : ''}`;
  return (
    <>
      <tr>
        <td className="mt-what">
          <span className="mt-title">{entry.title}</span>
          <span className="mt-sub">{entryKind(entry)}</span>
        </td>
        <td data-label="Сумма">
          {/* Валюта не отрывается от суммы: строка может перенестись только после тире диапазона. */}
          <span className="mt-amount">
            <span className="n">{range}</span>
            {'\u00a0'}
            {entry.currency}
          </span>
          <span className="mt-sub">{PERIOD_LABEL[entry.period]} · до налогов</span>
        </td>
        <td data-label="Рынок и уровень">
          <span>{entry.region}</span>
          <span className="mt-sub">{entry.level}</span>
        </td>
        <td data-label="Источник">
          <a className="mt-link" href={entry.url} target="_blank" rel="noopener noreferrer">
            {SOURCE_LABEL[entry.sourceType]}
            <ExternalLink aria-hidden="true" />
            <span className="visually-hidden"> (откроется в новой вкладке)</span>
          </a>
          {entry.publishedAt && (
            <span className="mt-sub">
              опубл. <SourceDate value={entry.publishedAt} />
            </span>
          )}
          <span className="mt-sub">
            {age.unknown ? (
              'дата проверки неизвестна'
            ) : (
              <>
                проверено <SourceDate value={entry.checkedAt} />
              </>
            )}
          </span>
          {age.stale && (
            <span className="mt-stale">
              <TriangleAlert aria-hidden="true" />
              могло устареть
            </span>
          )}
          {note && (
            <button type="button" className="mt-note-toggle" aria-expanded={open} aria-controls={noteId} onClick={() => setOpen((value) => !value)}>
              <ChevronRight aria-hidden="true" />
              Подробнее<span className="visually-hidden"> об источнике</span>
            </button>
          )}
        </td>
      </tr>
      {note && (
        <tr className="mt-note-row" id={noteId} hidden={!open}>
          <td colSpan={4}>
            <p className="mt-note">{note}</p>
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * Отметка интереса в шапке документа: кнопка, пока отметки нет, затем бейдж. Фокус остаётся на месте кнопки
 * (обёртка с tabIndex −1), иначе после нажатия он ушёл бы в начало страницы.
 */
function InterestMark({ labId, interest }: { labId: string; interest: InterestRecord | null }) {
  const markRef = useRef<HTMLDivElement>(null);
  return (
    <div className="dir-head-mark" ref={markRef} tabIndex={-1}>
      {interest ? (
        <StatusBadge tone="accent" icon={Heart}>
          {interest.status === 'tried' ? 'Пробовал' : 'Интересно'}
        </StatusBadge>
      ) : (
        <button
          type="button"
          className="btn"
          onClick={async () => {
            markRef.current?.focus({ preventScroll: true });
            await saveInterest({ labId, status: 'curious' });
          }}
        >
          <Heart aria-hidden="true" />
          Интересно, хочу попробовать
        </button>
      )}
    </div>
  );
}

type ContinueAnswer = NonNullable<InterestRecord['continue']>;

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
    <section className="dir-sec dir-interest" aria-labelledby="interest-title">
      {/* Отметка «Интересно» / «Пробовал» и кнопка для неё — в шапке документа (InterestMark), здесь только вопросы. */}
      <div className="dir-sec-head">
        <h3 id="interest-title">Карта интересов</h3>
      </div>
      <div className="interest-form">
        <label className="field">
          <span className="field-label">Что понравилось?</span>
          <textarea className="textarea" rows={3} value={liked} onChange={(event) => setLiked(event.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">Что утомило или показалось скучным?</span>
          <textarea className="textarea" rows={3} value={tiring} onChange={(event) => setTiring(event.target.value)} />
        </label>
        <div className="field">
          <span className="field-label" id={`${lab.id}-continue`}>
            Хочется продолжить?
          </span>
          {/* Пока ответа нет, в группе ни одна кнопка не выбрана — в Tab попадает первая. */}
          <Choice<ContinueAnswer | ''>
            label="Хочется продолжить?"
            labelledBy={`${lab.id}-continue`}
            value={answer ?? ''}
            options={[
              ['yes', 'Да'],
              ['maybe', 'Возможно'],
              ['no', 'Пока нет'],
            ]}
            onChange={(value) => setAnswer(value === '' ? null : value)}
          />
        </div>
        <div className="dir-actions">
          <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={!dirty}>
            Сохранить
          </button>
          {lab.ready && interest?.status !== 'tried' && (
            <button type="button" className="btn" onClick={() => void save('tried')}>
              Проба пройдена
            </button>
          )}
          <span role="status" className="dir-saved">
            {saved && <StatusBadge tone="ok">Сохранено</StatusBadge>}
          </span>
        </div>
      </div>
    </section>
  );
}
