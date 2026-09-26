import { Download, FileUp, RotateCcw, ShieldCheck, Trash2, Wifi } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { initSettings, updateSettings, useAsync, useDataVersion, useRunnerState, useSettings, useSettingsEpoch } from '../app/hooks.ts';
import { checkHealth } from '../coach/ai-client.ts';
import { reportCoachHealth } from '../coach/connection.ts';
import { CodeBlock } from '../components/CodeBlock.tsx';
import { rovingKeyDown, rovingTabIndex } from '../components/roving.ts';
import { ConfirmDialog, Notice, StatusBadge, formatDate } from '../components/ui.tsx';
import type { Course } from '../content/schema.ts';
import { formatBytes } from '../pwa/offline.ts';
import { useUpdateState } from '../pwa/register.ts';
import { parseMarketFile } from '../storage/market-import.ts';
import { requestPersistentStorage, storageEstimate } from '../storage/persist.ts';
import { deleteMarketDataset, getMarketDatasets, saveMarketDataset } from '../storage/repo.ts';
import { applyImport, exportAll, listBackups, parseImport, resetAll, restoreBackup } from '../storage/transfer.ts';
import type { ExportFile, ImportStrategy, MarketDataset, Settings } from '../storage/types.ts';
import { OfflineOverview } from './offline-controls.tsx';

function Section({ id, title, lead, children }: { id: string; title: string; lead?: string; children: ReactNode }) {
  return (
    <section id={`settings-${id}`} className="card settings-section" aria-labelledby={`settings-${id}-title`}>
      <div>
        <h2 id={`settings-${id}-title`} className="card-title">
          {title}
        </h2>
        {lead && <p className="card-sub">{lead}</p>}
      </div>
      {children}
    </section>
  );
}

/** Строка настроек. controlId связывает подпись и подсказку с полем ввода (для скринридера и клика по подписи). */
function Row({ label, hint, controlId, children }: { label: string; hint?: string; controlId?: string; children: ReactNode }) {
  return (
    <div className="setting-row">
      <div className="setting-label">
        {controlId ? <label htmlFor={controlId}>{label}</label> : <strong>{label}</strong>}
        {hint && <span id={controlId ? `${controlId}-hint` : undefined}>{hint}</span>}
      </div>
      <div className="stack-sm">{children}</div>
    </div>
  );
}

/**
 * Черновик текстовой настройки: сохраняется через полсекунды после набора, при уходе из поля
 * и при закрытии экрана или вкладки — адрес и токен не теряются, если не нажать «Проверить соединение».
 */
function useSettingDraft(initial: string, save: (value: string) => Promise<void>) {
  const [value, setValue] = useState(initial);
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

function Choice<T extends string | number>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (value: T) => void }) {
  // Одна остановка Tab на группу, выбор — стрелками (как у обычных радиокнопок).
  const hasSelection = options.some(([option]) => option === value);
  return (
    <div className="segmented" role="radiogroup" aria-label={label} onKeyDown={(event) => rovingKeyDown(event)}>
      {options.map(([option, text], index) => (
        <button
          key={String(option)}
          type="button"
          role="radio"
          aria-checked={value === option}
          tabIndex={rovingTabIndex(value === option, index, hasSelection)}
          onClick={() => onChange(option)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

export function SettingsScreen({ course, section }: { course: Course; section: string | null }) {
  const settings = useSettings();
  // После сброса, импорта или восстановления копии поля с черновиками пересоздаются с новыми значениями.
  const epoch = useSettingsEpoch();
  useEffect(() => {
    if (section) document.getElementById(`settings-${section}`)?.scrollIntoView({ block: 'start' });
  }, [section]);

  return (
    <div className="page page-narrow">
      <header className="page-head">
        <span className="eyebrow">Настройки</span>
        <h1>Настройки</h1>
        <p className="page-lead">Всё хранится на этом устройстве. Резервную копию прогресса можно сохранить в файл.</p>
      </header>
      <div className="settings-layout">
        <Section id="appearance" title="Оформление">
          <Row label="Тема">
            <Choice
              label="Тема"
              value={settings.theme}
              options={[
                ['system', 'Как в системе'],
                ['light', 'Светлая'],
                ['dark', 'Тёмная'],
              ]}
              onChange={(theme) => void updateSettings({ theme })}
            />
          </Row>
          <Row label="Текст урока" hint="Размер основного текста">
            <Choice
              label="Размер текста урока"
              value={settings.lessonFontSize}
              options={[
                [16, '16'],
                [17, '17'],
                [18, '18'],
                [20, '20'],
              ]}
              onChange={(lessonFontSize) => void updateSettings({ lessonFontSize })}
            />
          </Row>
          <Row label="Код" hint="Размер в редакторе и примерах">
            <Choice
              label="Размер кода"
              value={settings.codeFontSize}
              options={[
                [14, '14'],
                [15, '15'],
                [16, '16'],
                [18, '18'],
              ]}
              onChange={(codeFontSize) => void updateSettings({ codeFontSize })}
            />
            <CodeBlock code={'for number in range(1, 6):\n    print(number)  # пять заказов'} label="Пример кода" />
          </Row>
        </Section>

        <Section id="offline" title="Работа без сети" lead="Уроки и Python можно скачать заранее — тогда они работают без интернета.">
          <OfflineOverview modules={course.modules.filter((module) => module.file).map((module) => ({ id: module.id, title: module.title, number: module.number }))} />
          <StorageInfo />
        </Section>

        <Section id="data" title="Прогресс и резервные копии" lead="Прогресс между компьютером и телефоном переносится файлом: экспорт на одном устройстве, импорт на другом.">
          <DataControls course={course} />
        </Section>

        <Section id="coach" title="Наставник">
          <CoachSettings key={epoch} settings={settings} />
        </Section>

        <Section id="market" title="Рынок труда" lead="Нужен для раздела «Работа и заказы». Суммы показываются только из проверенных обзоров.">
          <MarketSettings key={epoch} settings={settings} />
        </Section>

        <Section id="about" title="О приложении">
          <About course={course} />
        </Section>
      </div>
    </div>
  );
}

function StorageInfo() {
  const [persisted, setPersisted] = useState<string | null>(null);
  const estimate = useAsync(storageEstimate, []);
  useEffect(() => {
    if (navigator.storage?.persisted) void navigator.storage.persisted().then((value) => setPersisted(value ? 'granted' : 'denied'));
    else setPersisted('unsupported');
  }, []);
  return (
    <Row label="Хранилище" hint={estimate.value ? `Занято ${formatBytes(estimate.value.usage)}` : undefined}>
      {persisted === 'granted' ? (
        <StatusBadge tone="good">Браузер не удалит данные при нехватке места</StatusBadge>
      ) : (
        <>
          <p className="small muted">
            При нехватке места браузер может очистить данные сайта. Можно попросить хранить их постоянно (браузер решает сам).
          </p>
          <div className="row">
            <button
              type="button"
              className="btn btn-sm"
              onClick={async () => setPersisted(await requestPersistentStorage())}
              disabled={persisted === 'unsupported'}
            >
              <ShieldCheck aria-hidden="true" />
              Хранить постоянно
            </button>
            {persisted === 'denied' && <span className="tiny muted">Браузер пока не разрешил — сохраняй резервные копии.</span>}
          </div>
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

function DataControls({ course }: { course: Course }) {
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof parseImport>> | null>(null);
  const [strategy, setStrategy] = useState<ImportStrategy>('merge');
  const [message, setMessage] = useState<{ tone: 'good' | 'error'; text: string } | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<{ id: string; label: string } | null>(null);
  const version = useDataVersion(['backups']);
  const backups = useAsync(listBackups, [version, message]);
  const app = { version: __APP_VERSION__, contentVersion: course.contentVersion };

  async function onFile(file: File | undefined) {
    setMessage(null);
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) {
      setPreview({ ok: false, message: 'Файл слишком большой для резервной копии «Практики». Текущие данные не изменены.' });
      return;
    }
    setPreview(parseImport(await file.text()));
  }

  return (
    <>
      <p className="small muted">
        Очистка данных браузера или удаление приложения стирает локальный прогресс. Сохраняй резервную копию время от времени.
      </p>
      <Row label="Экспорт" hint="Файл JSON со всем прогрессом">
        <div className="row">
          <button
            type="button"
            className="btn"
            onClick={async () => {
              download(await exportAll(app));
              setMessage({ tone: 'good', text: 'Файл с прогрессом сохранён.' });
            }}
          >
            <Download aria-hidden="true" />
            Сохранить в файл
          </button>
        </div>
      </Row>
      <Row label="Импорт" hint="Перенос с другого устройства">
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
          <div className="stack-sm fact">
            <strong className="small">
              Резервная копия от {formatDate(preview.file.exportedAt, { year: true })} · версия данных {preview.file.schemaVersion}
            </strong>
            <span className="small muted">
              Уроков начато: {preview.counts.lessons}, заданий решено: {preview.counts.passed} из {preview.counts.exercises}, попыток:{' '}
              {preview.counts.attempts}, дней занятий: {preview.counts.days}.
            </span>
            <Choice
              label="Как импортировать"
              value={strategy}
              options={[
                ['merge', 'Объединить с текущим'],
                ['replace', 'Заменить текущий'],
              ]}
              onChange={setStrategy}
            />
            <span className="tiny muted">
              {strategy === 'merge'
                ? 'Лучшие результаты из обоих устройств сохранятся, новые черновики заменят старые.'
                : 'Текущий прогресс будет заменён данными из файла. Перед этим создаётся резервная копия.'}
            </span>
            <div className="row">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={async () => {
                  try {
                    await applyImport(preview.file, strategy);
                    // Настройки из файла (тема, шрифты, наставник) применяются сразу, без перезагрузки.
                    await initSettings();
                    setPreview(null);
                    setMessage({ tone: 'good', text: 'Прогресс импортирован. Предыдущее состояние сохранено в резервной копии.' });
                  } catch (error) {
                    setMessage({ tone: 'error', text: failureText('Импорт не выполнен', error) });
                  }
                }}
              >
                {strategy === 'merge' ? 'Объединить' : 'Заменить'}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPreview(null)}>
                Отмена
              </button>
            </div>
          </div>
        )}
      </Row>
      {message && <Notice tone={message.tone}>{message.text}</Notice>}
      <Row label="Резервные копии" hint="Создаются автоматически перед импортом и сбросом">
        {(backups.value ?? []).length === 0 ? (
          <span className="small muted">Пока нет.</span>
        ) : (
          <ul className="plain-list">
            {(backups.value ?? []).map((backup) => (
              <li key={backup.id} className="row-between small">
                <span>
                  {new Date(backup.createdAt).toLocaleString('ru-RU')} · {backup.reason}
                </span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setRestoreTarget({ id: backup.id, label: new Date(backup.createdAt).toLocaleString('ru-RU') })}
                >
                  <RotateCcw aria-hidden="true" />
                  Восстановить
                </button>
              </li>
            ))}
          </ul>
        )}
      </Row>
      <Row label="Сброс" hint="Начать курс заново на этом устройстве">
        <div className="row">
          <button type="button" className="btn btn-danger btn-sm" onClick={() => setConfirmReset(true)}>
            <Trash2 aria-hidden="true" />
            Сбросить прогресс
          </button>
        </div>
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
            setMessage({ tone: 'good', text: 'Прогресс и настройки сброшены. Резервная копия сохранена — её можно восстановить.' });
          } catch (error) {
            setMessage({ tone: 'error', text: failureText('Сброс не выполнен', error) });
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
            setMessage({ tone: 'good', text: 'Состояние из резервной копии восстановлено.' });
          } catch (error) {
            setMessage({ tone: 'error', text: failureText('Копия не восстановлена', error) });
          }
        }}
        onClose={() => setRestoreTarget(null)}
      >
        <p>
          Прогресс и настройки станут такими, как {restoreTarget?.label}. Текущее состояние перед этим сохранится в новой
          резервной копии.
        </p>
      </ConfirmDialog>
    </>
  );
}

function CoachSettings({ settings }: { settings: Settings }) {
  const endpointId = useId();
  const tokenId = useId();
  const endpoint = useSettingDraft(settings.coach.endpoint, (value) => updateSettings({ coach: { endpoint: value } }));
  const token = useSettingDraft(settings.coach.accessToken, (value) => updateSettings({ coach: { accessToken: value } }));
  const [status, setStatus] = useState<{ tone: 'good' | 'error' | 'warn'; text: string } | null>(null);
  const [checking, setChecking] = useState(false);

  async function test() {
    setChecking(true);
    setStatus(null);
    try {
      await Promise.all([endpoint.flush(), token.flush()]);
      const health = await checkHealth(endpoint.value, token.value);
      // Итог проверки виден и в строке состояния, и в панели наставника.
      reportCoachHealth(endpoint.value, token.value, { health });
      setStatus(
        health.configured
          ? { tone: 'good', text: `Сервер наставника отвечает: ${health.provider}, модель ${health.model}.` }
          : { tone: 'warn', text: 'Сервер запущен, но ИИ не настроен (нет ключа в .env). Пока работают подсказки курса.' },
      );
    } catch (error) {
      reportCoachHealth(endpoint.value, token.value, { error });
      setStatus({ tone: 'error', text: (error as Error).message });
    } finally {
      setChecking(false);
    }
  }

  return (
    <>
      <Row label="Режим" hint="Подсказки курса работают всегда, даже без сети">
        <Choice
          label="Режим наставника"
          value={settings.coach.mode}
          options={[
            ['course', 'Подсказки курса'],
            ['ai', 'ИИ через сервер'],
          ]}
          onChange={(mode) => void updateSettings({ coach: { mode } })}
        />
        <p className="small muted">
          {settings.coach.mode === 'course'
            ? 'Разборы и подсказки заранее написаны к каждому заданию и работают офлайн. Это не ИИ.'
            : 'Запросы к ИИ отправляются только по твоей кнопке, через твой сервер-адаптер. Каждый запрос платный у выбранного провайдера. Без сети или без сервера работают подсказки курса.'}
        </p>
      </Row>
      {settings.coach.mode === 'ai' && (
        <>
          <Row label="Адрес сервера" hint="Локально: http://127.0.0.1:8787 (npm run coach)" controlId={endpointId}>
            <input
              id={endpointId}
              className="input mono"
              value={endpoint.value}
              onChange={(event) => endpoint.change(event.target.value)}
              onBlur={() => void endpoint.flush()}
              aria-describedby={`${endpointId}-hint`}
              spellCheck={false}
            />
          </Row>
          <Row
            label="Токен доступа"
            hint="Только для своего удалённого сервера. Это не ключ ИИ-провайдера — тот хранится на сервере."
            controlId={tokenId}
          >
            <input
              id={tokenId}
              className="input mono"
              type="password"
              value={token.value}
              onChange={(event) => token.change(event.target.value)}
              onBlur={() => void token.flush()}
              aria-describedby={`${tokenId}-hint ${tokenId}-risk`}
              autoComplete="off"
              spellCheck={false}
            />
            <p id={`${tokenId}-risk`} className="tiny muted">
              Пока токен указан, не запускай в тренажёре чужой код из интернета: у запускаемого кода может быть доступ к данным
              приложения, в том числе к токену.
            </p>
          </Row>
          <Row label="Соединение">
            <div className="row">
              <button type="button" className="btn btn-sm" onClick={() => void test()} disabled={checking}>
                {checking ? <span className="spinner" aria-hidden="true" /> : <Wifi aria-hidden="true" />}
                Проверить соединение
              </button>
            </div>
            {status && <Notice tone={status.tone}>{status.text}</Notice>}
            <p className="tiny muted">
              Адрес и токен сохраняются автоматически. Как запустить сервер наставника — в файле docs/coach.md проекта. С телефона
              локальный сервер компьютера недоступен.
            </p>
          </Row>
        </>
      )}
    </>
  );
}

const REGIONS = ['Россия', 'Казахстан', 'Беларусь', 'Узбекистан', 'Кыргызстан', 'Армения', 'Грузия', 'Международный фриланс'];
const CURRENCIES = ['RUB', 'KZT', 'BYN', 'UZS', 'KGS', 'AMD', 'GEL', 'USD', 'EUR'];

function MarketSettings({ settings }: { settings: Settings }) {
  const regionId = useId();
  const currencyId = useId();
  const region = useSettingDraft(settings.market.region ?? '', (value) => updateSettings({ market: { region: value.trim() || null } }));
  const [message, setMessage] = useState<{ tone: 'good' | 'error'; text: string } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const version = useDataVersion(['market']);
  const datasets = useAsync(getMarketDatasets, [version]);
  return (
    <>
      <Row label="Страна или рынок" controlId={regionId}>
        <input
          id={regionId}
          className="input"
          list="regions"
          value={region.value}
          placeholder="Например, Россия или Международный фриланс"
          onChange={(event) => region.change(event.target.value)}
          onBlur={() => void region.flush()}
        />
        <datalist id="regions">
          {REGIONS.map((item) => (
            <option key={item} value={item} />
          ))}
        </datalist>
      </Row>
      <Row label="Валюта" controlId={currencyId}>
        <select
          id={currencyId}
          className="select"
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
      <Row label="Готовые обзоры" hint="Собраны из открытых источников и перепроверены: у каждой суммы есть ссылка и дата">
        <BundledMarketOverviews
          loaded={datasets.value ?? []}
          regionUnset={!settings.market.region}
          onMessage={setMessage}
        />
      </Row>
      <Row label="Обзоры рынка" hint="Проверенный набор в формате praktika-market (JSON)">
        {(datasets.value ?? []).length === 0 ? (
          <span className="small muted">Данные ещё не загружены.</span>
        ) : (
          <ul className="plain-list">
            {(datasets.value ?? []).map((dataset) => (
              <li key={dataset.id} className="row-between small">
                <span>
                  {dataset.title} · {dataset.region}, {dataset.currency} · проверено {formatDate(dataset.checkedAt, { year: true })}
                </span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm btn-icon"
                  aria-label={`Удалить обзор ${dataset.title}`}
                  onClick={() => void deleteMarketDataset(dataset.id)}
                >
                  <Trash2 aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="row">
          <button type="button" className="btn btn-sm" onClick={() => input.current?.click()}>
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
                setMessage({ tone: 'error', text: result.message });
                return;
              }
              try {
                await saveMarketDataset(result.dataset);
                setMessage({ tone: 'good', text: `Обзор «${result.dataset.title}» сохранён: ${result.dataset.entries.length} записей.` });
              } catch (error) {
                setMessage({ tone: 'error', text: `Обзор не сохранён: ${(error as Error).message}` });
              }
            }}
          />
        </div>
        {message && <Notice tone={message.tone}>{message.text}</Notice>}
      </Row>
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
  loaded,
  regionUnset,
  onMessage,
}: {
  loaded: MarketDataset[];
  regionUnset: boolean;
  onMessage: (message: { tone: 'good' | 'error'; text: string }) => void;
}) {
  const list = useAsync(async (): Promise<BundledOverview[]> => {
    const response = await fetch(`${import.meta.env.BASE_URL}market/index.json`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as BundledOverview[];
  }, []);
  const [busy, setBusy] = useState<string | null>(null);

  if (list.error) return <span className="small muted">Список готовых обзоров не загрузился — нужна сеть при первом открытии.</span>;
  if (!list.value) return <span className="small muted">Загружаю список…</span>;

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
        tone: 'good',
        text: `Обзор «${item.title}» загружен: ${result.dataset.entries.length} записей.${regionUnset ? ` Рынок: ${item.region}, ${item.currency}.` : ''} Смотри раздел «Работа и заказы» в «Направлениях».`,
      });
    } catch (error) {
      onMessage({ tone: 'error', text: `Обзор не загружен: ${(error as Error).message}` });
    } finally {
      setBusy(null);
    }
  }

  return (
    <ul className="plain-list">
      {list.value.map((item) => {
        const isLoaded = loaded.some((dataset) => dataset.title === item.title && dataset.checkedAt === item.checkedAt);
        return (
          <li key={item.file} className="row-between small">
            <span>
              {item.title} · {item.entries} записей · проверено {formatDate(item.checkedAt, { year: true })}
            </span>
            {isLoaded ? (
              <StatusBadge tone="good">Загружен</StatusBadge>
            ) : (
              <button type="button" className="btn btn-sm" onClick={() => void load(item)} disabled={busy !== null}>
                {busy === item.file ? <span className="spinner" aria-hidden="true" /> : <Download aria-hidden="true" />}
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
      <dl className="kv">
        <dt>Версия приложения</dt>
        <dd>{__APP_VERSION__}</dd>
        <dt>Версия материалов</dt>
        <dd className="mono">{course.contentVersion}</dd>
        <dt>Python</dt>
        <dd>{runner.pythonVersion ? `${runner.pythonVersion} (Pyodide ${runner.pyodideVersion})` : 'ещё не запускался'}</dd>
        <dt>Офлайн-оболочка</dt>
        <dd>{update.controlled ? 'сохранена' : 'ещё не сохранена (нужна собранная версия и одно открытие с сетью)'}</dd>
      </dl>
      <details className="disclosure">
        <summary>Ограничения этой версии</summary>
        <div className="disclosure-body">
          <ul className="bullets small">
            <li>Готова только часть курса — точный счёт на экране «Курс».</li>
            <li>Код запускается в отдельном потоке браузера. Это защищает интерфейс от зависаний, но не является песочницей безопасности.</li>
            <li>input() работает с заранее заданным вводом (из тестов или поля «Ввод»), а не интерактивно.</li>
            <li>Прогресс не синхронизируется между устройствами автоматически — используй экспорт и импорт.</li>
            <li>ИИ-наставник работает только после настройки своего сервера и ключа; без этого — подсказки курса.</li>
            <li>Работа на реальном Android-устройстве ещё не проверялась.</li>
          </ul>
        </div>
      </details>
    </>
  );
}
