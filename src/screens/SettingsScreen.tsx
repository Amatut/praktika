import {
  BookMarked,
  BriefcaseBusiness,
  CircleX,
  CloudDownload,
  DatabaseBackup,
  Download,
  FileJson,
  FileUp,
  HardDrive,
  Info,
  Palette,
  RotateCcw,
  ShieldCheck,
  Trash2,
  Wifi,
  WifiOff,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from 'react';
import { initSettings, updateSettings, useAsync, useDataVersion, useRunnerState, useSettings, useSettingsEpoch } from '../app/hooks.ts';
import { href, navigate, paths } from '../app/router.ts';
import { CoachError, checkHealth } from '../coach/ai-client.ts';
import { reportCoachHealth } from '../coach/connection.ts';
import { CodeBlock } from '../components/CodeBlock.tsx';
import { Choice, ConfirmDialog, Disclosure, Notice, Spinner, StatusBadge, StatusLine, Tag, formatDate, plural } from '../components/ui.tsx';
import type { Course } from '../content/schema.ts';
import { formatBytes } from '../pwa/offline.ts';
import { useUpdateState } from '../pwa/register.ts';
import { parseMarketFile } from '../storage/market-import.ts';
import { isStoragePersisted, requestPersistentStorage, storageEstimate, type PersistResult } from '../storage/persist.ts';
import { deleteMarketDataset, getMarketDatasets, saveMarketDataset } from '../storage/repo.ts';
import { applyImport, exportAll, listBackups, parseImport, resetAll, restoreBackup } from '../storage/transfer.ts';
import type { ExportFile, ImportStrategy, MarketDataset, Settings } from '../storage/types.ts';
import { OfflineOverview } from './offline-controls.tsx';

// Разделы настроек: адрес #/settings/{id}, секция section#settings-{id} (на эти id опираются e2e и баннеры).
const SECTIONS = [
  { id: 'appearance', title: 'Оформление', icon: Palette },
  { id: 'offline', title: 'Работа без сети', icon: CloudDownload },
  { id: 'data', title: 'Прогресс и копии', icon: DatabaseBackup },
  { id: 'coach', title: 'Наставник', icon: BookMarked },
  { id: 'market', title: 'Рынок труда', icon: BriefcaseBusiness },
  { id: 'about', title: 'О приложении', icon: Info },
] as const satisfies readonly { id: string; title: string; icon: LucideIcon }[];

type SectionId = (typeof SECTIONS)[number]['id'];

function isSection(value: string | null): value is SectionId {
  return SECTIONS.some((item) => item.id === value);
}

function Section({ id, children }: { id: SectionId; children: ReactNode }) {
  const { title, icon: Icon } = SECTIONS.find((item) => item.id === id)!;
  return (
    <section id={`settings-${id}`} className="settings-section" aria-labelledby={`settings-${id}-title`}>
      {/* tabIndex -1: переход из оглавления переводит фокус на заголовок раздела. */}
      <h2 id={`settings-${id}-title`} className="settings-section-title" tabIndex={-1}>
        <Icon aria-hidden="true" />
        {title}
      </h2>
      {children}
    </section>
  );
}

/**
 * Строка настроек: слева метка (и одна короткая строка, где без неё никак), справа — элемент.
 * controlId связывает подпись с полем ввода; labelId — имя для группы переключателей (aria-labelledby).
 */
function Row({
  label,
  hint,
  hintId,
  controlId,
  labelId,
  className,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  hintId?: string;
  controlId?: string;
  labelId?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`setting-row${className ? ` ${className}` : ''}`}>
      <div className="setting-label">
        {controlId ? (
          <label htmlFor={controlId} id={labelId} className="setting-name">
            {label}
          </label>
        ) : (
          <span id={labelId} className="setting-name">
            {label}
          </span>
        )}
        {hint && (
          <span id={hintId ?? (controlId ? `${controlId}-hint` : undefined)} className="setting-hint">
            {hint}
          </span>
        )}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

/**
 * Черновик текстовой настройки: сохраняется через полсекунды после набора, при уходе из поля
 * и при закрытии экрана или вкладки — адрес и токен не теряются, если не нажать «Проверить соединение».
 */
function useSettingDraft(initial: string, save: (value: string) => Promise<void>) {
  const [value, setValue] = useState(initial);
  // Значение поменялось не из этого поля (загрузка обзора выставила рынок) — поле показывает новое,
  // если ученик не набрал в нём своё.
  const [synced, setSynced] = useState(initial);
  if (initial !== synced) {
    setSynced(initial);
    if (value === synced) setValue(initial);
  }
  const pending = useRef<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  });
  const flush = useCallback(async () => {
    window.clearTimeout(timer.current);
    const next = pending.current;
    if (next === null) return;
    pending.current = null;
    await saveRef.current(next);
  }, []);
  useEffect(() => {
    const onHide = () => void flush();
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      void flush();
    };
  }, [flush]);
  function change(next: string) {
    setValue(next);
    pending.current = next;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), 500);
  }
  return { value, change, flush };
}

/** Область разделов: уже 1200 прокручивается сама, под полосой разделов. */
const SETTINGS_BODY = 'settings-body';

/**
 * Что сейчас прокручивается: область разделов (уже 1200), <main> (≥ 1200) или, в режиме «страницей», окно (null).
 */
function activeScroller(): HTMLElement | null {
  for (const id of [SETTINGS_BODY, 'main']) {
    const element = document.getElementById(id);
    if (element && element.scrollHeight > element.clientHeight + 1 && getComputedStyle(element).overflowY !== 'visible') return element;
  }
  return null;
}

function scrollTopOf(scroller: HTMLElement | null): number {
  return scroller ? scroller.scrollTop : window.scrollY;
}

/** Прокрутка дошла до конца. */
function scrolledToEnd(scroller: HTMLElement | null): boolean {
  if (scroller) return scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
  const page = document.documentElement;
  return page.scrollHeight > window.innerHeight + 1 && window.scrollY + window.innerHeight >= page.scrollHeight - 2;
}

/**
 * Текущий раздел для оглавления: последний, чей заголовок поднялся выше середины видимой области
 * (прокручивается область разделов, <main> или, в режиме «страницей», окно).
 * После перехода по оглавлению раздел выбран явно: ни прокрутка от самого перехода, ни небольшая прокрутка
 * после него его не перебивают (у короткого раздела следующий заголовок сразу оказывается выше середины).
 */
function useCurrentSection(section: string | null) {
  const [current, setCurrent] = useState<SectionId>(isSection(section) ? section : SECTIONS[0].id);
  const quietUntil = useRef(0);
  // Выбранный в оглавлении раздел и где стояла прокрутка, когда переход закончился (null — ещё не закончился).
  const chosen = useRef<{ id: SectionId; at: number | null } | null>(null);

  const choose = useCallback((id: SectionId) => {
    quietUntil.current = performance.now() + 300;
    chosen.current = { id, at: null };
    setCurrent(id);
    document.getElementById(`settings-${id}`)?.scrollIntoView({ block: 'start' });
  }, []);

  // Адрес #/settings/offline (баннер, ссылка с другого экрана, оглавление). Кадр спустя: при смене экрана
  // App прокручивает <main> к началу уже после эффектов экрана.
  useEffect(() => {
    if (!isSection(section)) return;
    const frame = requestAnimationFrame(() => choose(section));
    return () => cancelAnimationFrame(frame);
  }, [section, choose]);

  useEffect(() => {
    const areas = [document.getElementById(SETTINGS_BODY), document.getElementById('main')];
    let frame = 0;
    function update() {
      // Полоса разделов (уже 1200) идёт за прокруткой страницы: текущий пункт снова виден, даже если полосу
      // сдвинули вбок пальцем. Кадр спустя — после отрисовки нового текущего пункта.
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const strip = document.querySelector<HTMLElement>('.settings-toc ul');
        if (strip) revealCurrent(strip, false);
      });
      if (performance.now() < quietUntil.current) return;
      const scroller = activeScroller();
      const area = scroller?.getBoundingClientRect();
      const top = Math.max(0, area?.top ?? 0);
      const bottom = Math.min(area?.bottom ?? window.innerHeight, window.innerHeight);
      const position = scrollTopOf(scroller);
      if (chosen.current) {
        chosen.current.at ??= position;
        if (Math.abs(position - chosen.current.at) < (bottom - top) / 4) return;
        chosen.current = null;
      }
      const edge = top + Math.max(96, (bottom - top) / 2);
      let found: SectionId = SECTIONS[0].id;
      for (const { id } of SECTIONS) {
        const sectionTop = document.getElementById(`settings-${id}`)?.getBoundingClientRect().top;
        if (sectionTop !== undefined && sectionTop <= edge) found = id;
      }
      // В самом низу последний короткий раздел до середины не поднимется — он и текущий.
      setCurrent(scrolledToEnd(scroller) ? SECTIONS[SECTIONS.length - 1].id : found);
    }
    for (const area of areas) area?.addEventListener('scroll', update, { passive: true });
    window.addEventListener('scroll', update, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      for (const area of areas) area?.removeEventListener('scroll', update);
      window.removeEventListener('scroll', update);
    };
  }, []);

  return { current, choose };
}

/** Сдвинуть полосу разделов вбок так, чтобы текущий пункт был в её видимой части (страница не двигается). */
function revealCurrent(strip: HTMLElement, smooth: boolean) {
  const link = strip.querySelector<HTMLElement>('[aria-current]');
  if (!link || strip.scrollWidth <= strip.clientWidth + 1) return;
  const box = strip.getBoundingClientRect();
  const item = link.getBoundingClientRect();
  const margin = 16;
  const shift = item.left < box.left + margin ? item.left - box.left - margin : item.right > box.right - margin ? item.right - box.right + margin : 0;
  if (shift === 0) return;
  const still = !smooth || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  strip.scrollBy({ left: shift, behavior: still ? 'auto' : 'smooth' });
}

/**
 * Полоса разделов на узком экране прокручивается вбок: текущий пункт держим видимым — при смене раздела и при смене
 * размера полосы (поворот экрана, стили экрана догрузились уже после первого кадра).
 */
function useCurrentInView(list: RefObject<HTMLUListElement | null>, current: SectionId) {
  useEffect(() => {
    if (list.current) revealCurrent(list.current, true);
  }, [list, current]);
  useEffect(() => {
    const strip = list.current;
    if (!strip || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => revealCurrent(strip, false));
    observer.observe(strip);
    return () => observer.disconnect();
  }, [list]);
}

export function SettingsScreen({ course, section }: { course: Course; section: string | null }) {
  const settings = useSettings();
  // После сброса, импорта или восстановления копии поля с черновиками пересоздаются с новыми значениями.
  const epoch = useSettingsEpoch();
  const { current, choose } = useCurrentSection(section);
  const tocList = useRef<HTMLUListElement>(null);
  useCurrentInView(tocList, current);

  function open(event: MouseEvent<HTMLAnchorElement>, id: SectionId) {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    choose(id);
    document.getElementById(`settings-${id}-title`)?.focus({ preventScroll: true });
    navigate(paths.settings(id), { replace: true });
  }

  // ≥ 1200 оглавление — колонкой слева, прокручивается <main>. 900–1199 — полосой разделов сверху: это строка
  // раскладки, а заголовок и разделы прокручиваются ниже неё, в своей области, и под полосу не заходят. < 900 — сеткой
  // в начале страницы: все шесть разделов видны целиком, до экспорта и рынка — одно касание.
  return (
    <div className="settings">
      <nav className="settings-toc" aria-label="Разделы настроек">
        <ul ref={tocList}>
          {SECTIONS.map(({ id, title, icon: Icon }) => (
            <li key={id}>
              <a href={href(paths.settings(id))} aria-current={current === id ? 'location' : undefined} onClick={(event) => open(event, id)}>
                <Icon aria-hidden="true" />
                {title}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <div className="settings-body" id={SETTINGS_BODY}>
        <div className="settings-main">
          <header className="page-head settings-head">
            <h1>Настройки</h1>
          </header>

          <Section id="appearance">
            <Appearance settings={settings} />
          </Section>

          <Section id="offline">
            <OfflineOverview modules={course.modules.filter((module) => module.file).map((module) => ({ id: module.id, title: module.title, number: module.number }))} />
            <StorageInfo />
          </Section>

          <Section id="data">
            <DataControls course={course} />
          </Section>

          <Section id="coach">
            <CoachSettings key={epoch} settings={settings} />
          </Section>

          <Section id="market">
            <MarketSettings key={epoch} settings={settings} />
          </Section>

          <Section id="about">
            <About course={course} />
          </Section>
        </div>
      </div>
    </div>
  );
}

function Appearance({ settings }: { settings: Settings }) {
  const id = useId();
  return (
    <>
      <Row label="Тема" labelId={`${id}-theme`}>
        <Choice
          label="Тема"
          labelledBy={`${id}-theme`}
          value={settings.theme}
          options={[
            ['system', 'Как в системе'],
            ['light', 'Светлая'],
            ['dark', 'Тёмная'],
          ]}
          onChange={(theme) => void updateSettings({ theme })}
        />
      </Row>
      <Row label="Текст урока" labelId={`${id}-lesson`}>
        <Choice
          label="Текст урока"
          labelledBy={`${id}-lesson`}
          value={settings.lessonFontSize}
          options={[
            [16, '16'],
            [17, '17'],
            [18, '18'],
            [20, '20'],
          ]}
          onChange={(lessonFontSize) => void updateSettings({ lessonFontSize })}
        />
        {/* Образец текста урока выбранным кеглем (как пример кода ниже). Скринридеру он не нужен. */}
        <p className="prose settings-sample" aria-hidden="true">
          Программа — это список шагов, которые компьютер выполняет по порядку.
        </p>
      </Row>
      <Row label="Код" labelId={`${id}-code`}>
        <Choice
          label="Код"
          labelledBy={`${id}-code`}
          value={settings.codeFontSize}
          options={[
            [14, '14'],
            [15, '15'],
            [16, '16'],
            [18, '18'],
          ]}
          onChange={(codeFontSize) => void updateSettings({ codeFontSize })}
        />
        {/* Строки до 18 знаков помещаются даже с кодом 18 на 320 px; перенос — запас, чтобы пример не обрезался краем. */}
        <CodeBlock code={'# пять заказов\nfor n in range(5):\n    print(n + 1)'} file="main.py" label="Пример кода" wrap />
      </Row>
    </>
  );
}

function StorageInfo() {
  // 'idle' — ещё не просили; 'denied' — попросили, браузер отказал.
  const [persisted, setPersisted] = useState<PersistResult | 'idle' | null>(null);
  const estimate = useAsync(storageEstimate, []);
  useEffect(() => {
    void isStoragePersisted().then((value) => setPersisted(value === null ? 'unsupported' : value ? 'granted' : 'idle'));
  }, []);
  return (
    <Row label="Хранилище" hint={estimate.value ? `Занято ${formatBytes(estimate.value.usage)}` : undefined}>
      {persisted === 'granted' ? (
        <StatusBadge tone="ok" icon={ShieldCheck}>
          Хранится постоянно
        </StatusBadge>
      ) : (
        <>
          <StatusLine tone="warn">Браузер может очистить данные</StatusLine>
          {/* Браузер без запроса постоянного хранения: кнопка, которую нельзя нажать, не нужна. */}
          {persisted !== 'unsupported' && (
            <div className="row">
              <button type="button" className="btn" onClick={async () => setPersisted(await requestPersistentStorage())}>
                <ShieldCheck aria-hidden="true" />
                Хранить постоянно
              </button>
              {persisted === 'denied' && (
                <StatusLine tone="muted" icon={CircleX}>
                  Браузер не разрешил
                </StatusLine>
              )}
            </div>
          )}
        </>
      )}
    </Row>
  );
}

function download(file: ExportFile) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `praktika-progress-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/**
 * Текст ошибки импорта, сброса или восстановления. Ошибки transfer.ts (ImportError) уже говорят, что не получилось
 * и что данные не изменены, — показываем их как есть; к остальным (хранилище не открылось) добавляем действие.
 */
function failureText(action: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return error instanceof Error && error.name === 'ImportError' ? message : `${action}. ${message}`;
}

/** «26.09.2026, 10:00» — дата и время резервной копии. */
function formatStamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Сообщение о результате — рядом с кнопкой, которая его вызвала. */
type DataMessage = { where: 'export' | 'import' | 'backups' | 'reset'; tone: 'good' | 'error'; text: string };

function DataControls({ course }: { course: Course }) {
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof parseImport>> | null>(null);
  const [strategy, setStrategy] = useState<ImportStrategy>('merge');
  const [message, setMessage] = useState<DataMessage | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<{ id: string; label: string } | null>(null);
  const version = useDataVersion(['backups']);
  const backups = useAsync(listBackups, [version, message]);
  const app = { version: __APP_VERSION__, contentVersion: course.contentVersion };
  const strategyId = useId();

  async function onFile(file: File | undefined) {
    setMessage(null);
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) {
      setPreview({ ok: false, message: 'Файл слишком большой для резервной копии «Практики». Текущие данные не изменены.' });
      return;
    }
    setPreview(parseImport(await file.text()));
  }

  const note = (where: DataMessage['where']) => message?.where === where && <Notice tone={message.tone}>{message.text}</Notice>;

  return (
    <>
      {/* Нейтральная метка: тревожная строка про очистку браузера уже стоит у «Хранилища» выше. */}
      <Tag icon={HardDrive} className="settings-lead">
        Прогресс — только на этом устройстве
      </Tag>
      <Row label="Экспорт">
        <div className="row">
          <button
            type="button"
            className="btn"
            onClick={async () => {
              download(await exportAll(app));
              setMessage({ where: 'export', tone: 'good', text: 'Файл с прогрессом сохранён.' });
            }}
          >
            <Download aria-hidden="true" />
            Сохранить в файл
          </button>
        </div>
        {note('export')}
      </Row>
      <Row label="Импорт">
        <div className="row">
          <button type="button" className="btn" onClick={() => input.current?.click()}>
            <FileUp aria-hidden="true" />
            Выбрать файл
          </button>
          <input
            ref={input}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(event) => {
              void onFile(event.target.files?.[0]);
              event.target.value = '';
            }}
          />
        </div>
        {preview && !preview.ok && (
          <Notice tone="error" title="Файл не импортирован">
            {preview.message}
          </Notice>
        )}
        {preview && preview.ok && (
          <div className="import-preview">
            <div className="import-preview-head">
              <FileJson aria-hidden="true" />
              <span className="import-preview-title">
                Резервная копия от <span className="nowrap">{formatDate(preview.file.exportedAt, { year: true })}</span>
              </span>
              <span className="import-preview-meta">
                версия данных <span className="n">{preview.file.schemaVersion}</span>
              </span>
            </div>
            <div className="import-preview-body">
              <dl className="import-counts">
                <div>
                  <dt>Уроков начато</dt>
                  <dd className="n">{preview.counts.lessons}</dd>
                </div>
                <div>
                  <dt>Заданий решено</dt>
                  <dd>
                    <span className="n">{preview.counts.passed}</span> из <span className="n">{preview.counts.exercises}</span>
                  </dd>
                </div>
                <div>
                  <dt>Попыток</dt>
                  <dd className="n">{preview.counts.attempts}</dd>
                </div>
                <div>
                  <dt>Дней занятий</dt>
                  <dd className="n">{preview.counts.days}</dd>
                </div>
              </dl>
              <Choice
                label="Как импортировать"
                value={strategy}
                options={[
                  ['merge', 'Объединить с текущим'],
                  ['replace', 'Заменить текущий'],
                ]}
                onChange={setStrategy}
              />
              {strategy === 'replace' && (
                <div id={strategyId}>
                  <StatusLine tone="warn">Текущий прогресс заменится, резервная копия — автоматически</StatusLine>
                </div>
              )}
              <div className="row">
                <button
                  type="button"
                  className="btn btn-primary"
                  aria-describedby={strategy === 'replace' ? strategyId : undefined}
                  onClick={async () => {
                    try {
                      await applyImport(preview.file, strategy);
                      // Настройки из файла (тема, шрифты, наставник) применяются сразу, без перезагрузки.
                      await initSettings();
                      setPreview(null);
                      setMessage({ where: 'import', tone: 'good', text: 'Прогресс импортирован. Резервная копия сохранена.' });
                    } catch (error) {
                      setMessage({ where: 'import', tone: 'error', text: failureText('Импорт не выполнен', error) });
                    }
                  }}
                >
                  {strategy === 'merge' ? 'Объединить' : 'Заменить'}
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => setPreview(null)}>
                  Отмена
                </button>
              </div>
            </div>
          </div>
        )}
        {note('import')}
      </Row>
      <Row label="Резервные копии">
        {(backups.value ?? []).length === 0 ? (
          <p className="setting-value muted">Пока нет</p>
        ) : (
          <ul className="settings-list">
            {(backups.value ?? []).map((backup) => (
              <li key={backup.id}>
                <span className="settings-list-text">
                  <span className="tnum">{formatStamp(backup.createdAt)}</span> · {backup.reason}
                </span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setRestoreTarget({ id: backup.id, label: formatStamp(backup.createdAt) })}
                >
                  <RotateCcw aria-hidden="true" />
                  Восстановить
                </button>
              </li>
            ))}
          </ul>
        )}
        {note('backups')}
      </Row>
      <Row label="Сброс">
        <div className="row">
          <button type="button" className="btn btn-danger" onClick={() => setConfirmReset(true)}>
            <Trash2 aria-hidden="true" />
            Сбросить прогресс
          </button>
        </div>
        {note('reset')}
      </Row>
      <ConfirmDialog
        open={confirmReset}
        title="Сбросить прогресс?"
        confirmLabel="Сбросить"
        danger
        onConfirm={async () => {
          try {
            await resetAll();
            await initSettings();
            setMessage({ where: 'reset', tone: 'good', text: 'Прогресс и настройки сброшены. Резервная копия сохранена.' });
          } catch (error) {
            setMessage({ where: 'reset', tone: 'error', text: failureText('Сброс не выполнен', error) });
          }
        }}
        onClose={() => setConfirmReset(false)}
      >
        <p>
          Черновики, попытки и отметки на этом устройстве будут удалены. Настройки тоже вернутся к исходным: тема, размер текста
          и кода, наставник, рынок. Перед сбросом создаётся резервная копия.
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        open={restoreTarget !== null}
        title="Восстановить резервную копию?"
        confirmLabel="Восстановить"
        onConfirm={async () => {
          if (!restoreTarget) return;
          try {
            await restoreBackup(restoreTarget.id);
            await initSettings();
            setMessage({ where: 'backups', tone: 'good', text: 'Состояние из резервной копии восстановлено.' });
          } catch (error) {
            setMessage({ where: 'backups', tone: 'error', text: failureText('Копия не восстановлена', error) });
          }
        }}
        onClose={() => setRestoreTarget(null)}
      >
        <p>Прогресс и настройки станут как {restoreTarget?.label}; текущее состояние сохранится в новой резервной копии.</p>
      </ConfirmDialog>
    </>
  );
}

/** Итог «Проверить соединение». Ошибка — коротким заголовком по виду, полный текст адаптера — в «Подробностях». */
export type CoachCheck =
  | { kind: 'ok'; provider: string; model: string }
  | { kind: 'no-key' }
  | { kind: 'error'; error: unknown; endpoint: string };

/** Заголовок ошибки проверки по её виду (src/coach/ai-client.ts). На «отвечает» опирается e2e: в ошибке этого слова нет. */
function checkErrorTitle(error: unknown): string {
  switch (error instanceof CoachError ? error.kind : null) {
    case 'unavailable':
      return 'Сервер недоступен';
    case 'access':
      return 'Нет доступа: токен или адрес приложения';
    case 'endpoint':
      return 'Неверный адрес сервера';
    case 'timeout':
      return 'Сервер не ответил вовремя';
    case 'network':
      return 'Нет сети';
    case 'server':
      return 'Ошибка сервера наставника';
    case 'not-configured':
      return 'Ключа ИИ нет';
    case 'limit':
      return 'Лимит запросов исчерпан';
    default:
      return 'Не удалось проверить';
  }
}

/** «http://127.0.0.1:8787» — адрес, по которому шла проверка; null, если адрес не разобрать. */
function endpointOrigin(value: string): string | null {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

export function CheckResult({ check }: { check: CoachCheck }) {
  if (check.kind === 'ok') return <Notice tone="good">{`Сервер отвечает: ${check.provider}, ${check.model}`}</Notice>;
  if (check.kind === 'no-key') {
    return (
      <Notice tone="warn" title="Ключа ИИ нет">
        Сервер запущен · ключ — в <span className="mono">.env</span> на сервере
      </Notice>
    );
  }
  const kind = check.error instanceof CoachError ? check.error.kind : null;
  // Адрес — там, где он что-то говорит: при неверном адресе он и так в поле выше, без сети не важен.
  const origin = kind === 'endpoint' || kind === 'network' ? null : endpointOrigin(check.endpoint);
  return (
    <Notice tone="error" title={checkErrorTitle(check.error)}>
      {origin && <span className="mono check-origin">{origin}</span>}
      <Disclosure summary="Подробности" className="check-details">
        <p>{check.error instanceof Error ? check.error.message : String(check.error)}</p>
      </Disclosure>
    </Notice>
  );
}

function CoachSettings({ settings }: { settings: Settings }) {
  const id = useId();
  const endpointId = useId();
  const tokenId = useId();
  const endpoint = useSettingDraft(settings.coach.endpoint, (value) => updateSettings({ coach: { endpoint: value } }));
  const token = useSettingDraft(settings.coach.accessToken, (value) => updateSettings({ coach: { accessToken: value } }));
  const [check, setCheck] = useState<CoachCheck | null>(null);
  const [checking, setChecking] = useState(false);
  // Предупреждение о чужом коде — только пока токен указан.
  const tokenSet = token.value.trim() !== '';

  async function test() {
    setChecking(true);
    setCheck(null);
    try {
      await Promise.all([endpoint.flush(), token.flush()]);
      const health = await checkHealth(endpoint.value, token.value);
      // Итог проверки виден и в строке состояния, и в панели наставника.
      reportCoachHealth(endpoint.value, token.value, { health });
      setCheck(health.configured ? { kind: 'ok', provider: health.provider, model: health.model } : { kind: 'no-key' });
    } catch (error) {
      reportCoachHealth(endpoint.value, token.value, { error });
      setCheck({ kind: 'error', error, endpoint: endpoint.value });
    } finally {
      setChecking(false);
    }
  }

  return (
    <>
      <Row label="Режим" labelId={`${id}-mode`}>
        <Choice
          label="Режим наставника"
          labelledBy={`${id}-mode`}
          value={settings.coach.mode}
          options={[
            ['course', 'Подсказки курса'],
            ['ai', 'ИИ через сервер'],
          ]}
          onChange={(mode) => void updateSettings({ coach: { mode } })}
        />
        <p className="setting-note">
          {settings.coach.mode === 'course' ? 'Не ИИ · работают без сети' : 'Только по кнопке · каждый запрос платный'}
        </p>
      </Row>
      {settings.coach.mode === 'ai' && (
        <>
          <Row label="Адрес сервера" controlId={endpointId}>
            <input
              id={endpointId}
              className="input mono setting-input"
              value={endpoint.value}
              placeholder="http://127.0.0.1:8787"
              onChange={(event) => endpoint.change(event.target.value)}
              onBlur={() => void endpoint.flush()}
              spellCheck={false}
              autoComplete="off"
            />
          </Row>
          <Row label="Токен доступа" hint="Токен своего сервера, не ключ ИИ" controlId={tokenId}>
            <input
              id={tokenId}
              className="input mono setting-input"
              type="password"
              value={token.value}
              onChange={(event) => token.change(event.target.value)}
              onBlur={() => void token.flush()}
              aria-describedby={tokenSet ? `${tokenId}-hint ${tokenId}-risk` : `${tokenId}-hint`}
              autoComplete="off"
              spellCheck={false}
            />
            {tokenSet && (
              <div id={`${tokenId}-risk`} className="setting-risk">
                <Notice tone="warn">Пока токен указан, не запускай чужой код: коду доступны данные приложения</Notice>
              </div>
            )}
          </Row>
          <Row label="Соединение">
            <div className="row">
              <button type="button" className="btn" onClick={() => void test()} disabled={checking}>
                {checking ? <Spinner /> : <Wifi aria-hidden="true" />}
                Проверить соединение
              </button>
            </div>
            {check && <CheckResult check={check} />}
          </Row>
        </>
      )}
    </>
  );
}

const REGIONS = ['Россия', 'Казахстан', 'Беларусь', 'Узбекистан', 'Кыргызстан', 'Армения', 'Грузия', 'Международный фриланс'];
const CURRENCIES = ['RUB', 'KZT', 'BYN', 'UZS', 'KGS', 'AMD', 'GEL', 'USD', 'EUR'];

type MarketMessage = { where: 'bundled' | 'imported'; tone: 'good' | 'error'; text: string };

/** Список готовых обзоров (public/market). Нужен и рядам «Готовые обзоры», и удалению загруженных. */
async function loadBundledOverviews(): Promise<BundledOverview[]> {
  const response = await fetch(`${import.meta.env.BASE_URL}market/index.json`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as BundledOverview[];
}

function MarketSettings({ settings }: { settings: Settings }) {
  const regionId = useId();
  const currencyId = useId();
  const listId = useId();
  const region = useSettingDraft(settings.market.region ?? '', (value) => updateSettings({ market: { region: value.trim() || null } }));
  const [message, setMessage] = useState<MarketMessage | null>(null);
  const [removeTarget, setRemoveTarget] = useState<MarketDataset | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const version = useDataVersion(['market']);
  const datasets = useAsync(getMarketDatasets, [version]);
  const bundled = useAsync(loadBundledOverviews, []);

  function remove(dataset: MarketDataset) {
    // Готовый обзор возвращается кнопкой «Загрузить», импортированный — только повторным импортом файла.
    const isBundled = (bundled.value ?? []).some((item) => item.title === dataset.title);
    if (isBundled) void deleteMarketDataset(dataset.id);
    else setRemoveTarget(dataset);
  }

  return (
    <>
      <Row label="Страна или рынок" controlId={regionId}>
        <input
          id={regionId}
          className="input setting-input"
          list={listId}
          value={region.value}
          placeholder="Россия, Международный фриланс…"
          onChange={(event) => region.change(event.target.value)}
          onBlur={() => void region.flush()}
        />
        <datalist id={listId}>
          {REGIONS.map((item) => (
            <option key={item} value={item} />
          ))}
        </datalist>
      </Row>
      <Row label="Валюта" controlId={currencyId}>
        <select
          id={currencyId}
          className="select setting-select"
          value={settings.market.currency ?? ''}
          onChange={(event) => void updateSettings({ market: { currency: event.target.value || null } })}
        >
          <option value="">Не выбрана</option>
          {CURRENCIES.map((currency) => (
            <option key={currency} value={currency}>
              {currency}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Готовые обзоры">
        <BundledMarketOverviews
          list={bundled.value}
          failed={Boolean(bundled.error)}
          loaded={datasets.value ?? []}
          regionUnset={!settings.market.region}
          onMessage={setMessage}
        />
        {message?.where === 'bundled' && (
          <Notice
            tone={message.tone}
            action={
              message.tone === 'good' && (
                <a className="btn btn-sm" href={href(paths.directions())}>
                  <BriefcaseBusiness aria-hidden="true" />
                  Открыть в «Направлениях»
                </a>
              )
            }
          >
            {message.text}
          </Notice>
        )}
      </Row>
      <Row label="Загруженные обзоры">
        {(datasets.value ?? []).length === 0 ? (
          <p className="setting-value muted">Данные ещё не загружены</p>
        ) : (
          <ul className="settings-list">
            {(datasets.value ?? []).map((dataset) => (
              <li key={dataset.id}>
                <span className="settings-list-main">
                  <span className="settings-list-title">{dataset.title}</span>
                  {/* Регион и валюта — уже в названии и в полях выше: здесь число записей и дата. */}
                  <span className="settings-list-sub">
                    {dataset.entries.length} {plural(dataset.entries.length, ['запись', 'записи', 'записей'])} · проверено{' '}
                    {formatDate(dataset.checkedAt, { year: true })}
                  </span>
                </span>
                <button type="button" className="btn btn-ghost btn-sm" aria-label={`Удалить обзор ${dataset.title}`} onClick={() => remove(dataset)}>
                  <Trash2 aria-hidden="true" />
                  Удалить
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="row">
          <button type="button" className="btn" onClick={() => input.current?.click()}>
            <FileUp aria-hidden="true" />
            Импортировать обзор
          </button>
          <input
            ref={input}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={async (event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (!file) return;
              const result = parseMarketFile(await file.text());
              if (!result.ok) {
                setMessage({ where: 'imported', tone: 'error', text: result.message });
                return;
              }
              try {
                await saveMarketDataset(result.dataset);
                setMessage({ where: 'imported', tone: 'good', text: `Обзор «${result.dataset.title}» сохранён: ${result.dataset.entries.length} записей.` });
              } catch (error) {
                setMessage({ where: 'imported', tone: 'error', text: `Обзор не сохранён: ${(error as Error).message}` });
              }
            }}
          />
        </div>
        {message?.where === 'imported' && <Notice tone={message.tone}>{message.text}</Notice>}
      </Row>
      <ConfirmDialog
        open={removeTarget !== null}
        title={`Удалить обзор «${removeTarget?.title ?? ''}»?`}
        confirmLabel="Удалить"
        danger
        onConfirm={() => {
          if (removeTarget) void deleteMarketDataset(removeTarget.id);
        }}
        onClose={() => setRemoveTarget(null)}
      >
        <p>Вернуть можно только повторным импортом файла.</p>
      </ConfirmDialog>
    </>
  );
}

interface BundledOverview {
  file: string;
  title: string;
  region: string;
  currency: string;
  checkedAt: string;
  entries: number;
}

/** Обзоры, которые поставляются вместе с приложением (public/market): загрузка одной кнопкой, в том числе на телефоне. */
function BundledMarketOverviews({
  list,
  failed,
  loaded,
  regionUnset,
  onMessage,
}: {
  list: BundledOverview[] | null | undefined;
  failed: boolean;
  loaded: MarketDataset[];
  regionUnset: boolean;
  onMessage: (message: MarketMessage) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);

  if (failed) {
    return (
      <StatusLine tone="muted" icon={WifiOff}>
        Список не загрузился — нужна сеть
      </StatusLine>
    );
  }
  if (!list) {
    return (
      <p className="loading-line" role="status">
        <Spinner />
        Загружаю список…
      </p>
    );
  }

  async function load(item: BundledOverview) {
    setBusy(item.file);
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}${item.file}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = parseMarketFile(await response.text());
      if (!result.ok) throw new Error(result.message);
      await saveMarketDataset(result.dataset);
      if (regionUnset) await updateSettings({ market: { region: item.region, currency: item.currency } });
      onMessage({
        where: 'bundled',
        tone: 'good',
        // Число записей — без склонения: на этот текст опирается e2e.
        text: `Обзор «${item.title}» загружен: ${result.dataset.entries.length} записей.${regionUnset ? ` Рынок: ${item.region}, ${item.currency}.` : ''}`,
      });
    } catch (error) {
      onMessage({ where: 'bundled', tone: 'error', text: `Обзор не загружен: ${(error as Error).message}` });
    } finally {
      setBusy(null);
    }
  }

  return (
    <ul className="settings-list">
      {list.map((item) => {
        const isLoaded = loaded.some((dataset) => dataset.title === item.title && dataset.checkedAt === item.checkedAt);
        return (
          <li key={item.file}>
            <span className="settings-list-main">
              <span className="settings-list-title">{item.title}</span>
              <span className="settings-list-sub">
                {item.entries} {plural(item.entries, ['запись', 'записи', 'записей'])} · проверено {formatDate(item.checkedAt, { year: true })}
              </span>
            </span>
            {isLoaded ? (
              <StatusBadge tone="good">Загружен</StatusBadge>
            ) : (
              <button type="button" className="btn btn-sm" onClick={() => void load(item)} disabled={busy !== null}>
                {busy === item.file ? <Spinner /> : <Download aria-hidden="true" />}
                Загрузить
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function About({ course }: { course: Course }) {
  const runner = useRunnerState();
  const update = useUpdateState();
  return (
    <>
      <dl className="settings-facts">
        <div className="setting-row">
          <dt className="setting-name">Версия приложения</dt>
          <dd className="mono">{__APP_VERSION__}</dd>
        </div>
        <div className="setting-row">
          <dt className="setting-name">Версия материалов</dt>
          <dd className="mono">{course.contentVersion}</dd>
        </div>
        <div className="setting-row">
          <dt className="setting-name">Python</dt>
          <dd>
            {runner.pythonVersion ? (
              <>
                <span className="mono">{runner.pythonVersion}</span> · Pyodide <span className="mono">{runner.pyodideVersion}</span>
              </>
            ) : (
              <span className="muted">ещё не запускался</span>
            )}
          </dd>
        </div>
        <div className="setting-row">
          <dt className="setting-name">Офлайн-оболочка</dt>
          <dd>
            <StatusBadge tone={update.controlled ? 'ok' : 'muted'}>{update.controlled ? 'Сохранена' : 'Не сохранена'}</StatusBadge>
          </dd>
        </div>
      </dl>
      <Disclosure summary="Ограничения этой версии" className="settings-limits">
        <ul className="bullets">
          <li>Готова только часть курса — точный счёт на экране «Курс».</li>
          <li>Код запускается в отдельном потоке браузера. Это защищает интерфейс от зависаний, но не является песочницей безопасности.</li>
          <li>input() работает с заранее заданным вводом (из тестов или поля «Ввод»), а не интерактивно.</li>
          <li>Прогресс не синхронизируется между устройствами автоматически — используй экспорт и импорт.</li>
          <li>ИИ-наставник работает только после настройки своего сервера и ключа; без этого — подсказки курса.</li>
          <li>Работа на реальном Android-устройстве ещё не проверялась.</li>
        </ul>
      </Disclosure>
    </>
  );
}
