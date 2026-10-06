// Общие компоненты «Мастерской»: кнопки-подсказки клавиш, метки, статусы, сообщения, пустые состояния,
// шапки панелей, вкладки, сегменты, раскрывающиеся блоки, адрес места в коде. Вид — src/styles/ui.css.
// Статус — всегда значок + слово (цвет не единственный сигнал); значки — aria-hidden.
import {
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleX,
  Info,
  TriangleAlert,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { problemMessage, storageProblem, useInlineProblem } from '../app/problems.ts';
import { rovingKeyDown, rovingTabIndex } from './roving.ts';

/** Диалог подтверждения на основе нативного <dialog>: фокус и Esc работают из коробки. */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel = 'Отмена',
  danger = false,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  // На экране бывает несколько диалогов: у каждого свои id заголовка и текста.
  const id = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-text`}
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="dialog-body">
        <div className="dialog-head">
          <h2 id={`${id}-title`} className="dialog-title">
            {title}
          </h2>
          <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label="Закрыть" title="Закрыть" onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </div>
        {/* Текст диалога — предупреждение перед действием: основной цвет, не вторичный. */}
        <div id={`${id}-text`} className="dialog-text">
          {children}
        </div>
      </div>
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={onClose}>
          {cancelLabel}
        </button>
        <button
          type="button"
          className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
          onClick={() => {
            onConfirm();
            onClose();
          }}
        >
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}

// ------------------------------------------------------------ тона статусов

/** Тон статуса. 'good' и 'error' — прежние имена 'ok' и 'err' (оставлены для не переписанных экранов). */
export type Tone = 'ok' | 'err' | 'warn' | 'accent' | 'muted' | 'good' | 'error';

type CanonicalTone = 'ok' | 'err' | 'warn' | 'accent' | 'muted';

export function canonicalTone(tone: Tone): CanonicalTone {
  return tone === 'good' ? 'ok' : tone === 'error' ? 'err' : tone;
}

const TONE_ICON: Record<CanonicalTone, LucideIcon> = {
  ok: CircleCheck,
  err: CircleX,
  warn: TriangleAlert,
  accent: CircleDot,
  muted: CircleDashed,
};

/** Бейдж статуса: значок + слово. icon={false} — только для счётчиков, где слово уже несёт смысл. */
export function StatusBadge({
  tone,
  children,
  icon = true,
  title,
}: {
  tone: Tone;
  children: ReactNode;
  icon?: boolean | LucideIcon;
  title?: string;
}) {
  const canonical = canonicalTone(tone);
  const Icon = typeof icon === 'boolean' ? TONE_ICON[canonical] : icon;
  const className = canonical === 'muted' ? 'badge' : `badge badge-${canonical}`;
  return (
    <span className={className} title={title}>
      {icon !== false && <Icon aria-hidden="true" />}
      {children}
    </span>
  );
}

/** Метка — не кнопка и не статус: «Найди ошибку», «только чтение», «Вымышленная история». */
export function Tag({ icon: Icon, children, title, className }: { icon?: LucideIcon; children: ReactNode; title?: string; className?: string }) {
  return (
    <span className={`tag${className ? ` ${className}` : ''}`} title={title}>
      {Icon && <Icon aria-hidden="true" />}
      {children}
    </span>
  );
}

/** Строка статуса без подложки: значок + текст цветом тона. */
export function StatusLine({ tone, icon, children, className }: { tone: Tone; icon?: LucideIcon; children: ReactNode; className?: string }) {
  const canonical = canonicalTone(tone);
  const Icon = icon ?? (canonical === 'err' ? CircleAlert : TONE_ICON[canonical]);
  return (
    <p className={`status-line status-${canonical}${className ? ` ${className}` : ''}`}>
      <Icon aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

export function Notice({
  tone = 'muted',
  title,
  icon,
  children,
  action,
}: {
  tone?: Tone;
  title?: string;
  icon?: LucideIcon;
  children?: ReactNode;
  action?: ReactNode;
}) {
  const canonical = canonicalTone(tone);
  const Icon = icon ?? (canonical === 'warn' ? TriangleAlert : canonical === 'err' ? CircleAlert : canonical === 'ok' ? CircleCheck : Info);
  return (
    <div className={`notice${canonical === 'muted' ? '' : ` notice-${canonical}`}`} role={canonical === 'err' ? 'alert' : undefined}>
      <Icon aria-hidden="true" />
      <div className="notice-main">
        {title && <div className="notice-title">{title}</div>}
        {children && <div className="notice-text">{children}</div>}
        {action && <div className="notice-actions">{action}</div>}
      </div>
    </div>
  );
}

/** Полоса прогресса 6 px; число — рядом, не внутри полосы. */
export function Meter({ value, max, label, tone = 'accent' }: { value: number; max: number; label: string; tone?: 'ok' | 'accent' }) {
  const percent = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div
      className={`meter${tone === 'ok' ? ' meter-ok' : ''}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
    >
      <span style={{ width: `${percent}%` }} />
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return <span className="spinner" role={label ? 'status' : undefined} aria-label={label} />;
}

/**
 * Пустое состояние: слева, заголовок + одна строка + действие. Не абзац-объяснение.
 * as — уровень заголовка: h1, когда пустое состояние заменяет весь экран и другого h1 нет.
 */
export function EmptyState({
  title,
  icon: Icon,
  children,
  action,
  as: Title = 'div',
}: {
  title: string;
  icon?: LucideIcon;
  children?: ReactNode;
  action?: ReactNode;
  as?: 'h1' | 'h2' | 'div';
}) {
  return (
    <div className="empty">
      {Icon && <Icon aria-hidden="true" className="empty-icon" />}
      <div className="empty-main">
        <Title className="empty-title">{title}</Title>
        {children && <div className="empty-text">{children}</div>}
        {action && <div className="empty-actions">{action}</div>}
      </div>
    </div>
  );
}

/**
 * Экран ждёт данные ученика: «Загружаю…» или причина, если хранилище недоступно, — две короткие строки
 * («что случилось» и «что сделать»), не абзац.
 */
export function PendingData({ error }: { error: Error | null }) {
  useInlineProblem(error ? problemMessage(error) : null);
  const storage = error ? storageProblem(error) : null;
  return (
    <div className="page">
      {error ? (
        <EmptyState
          as="h1"
          title="Прогресс не загрузился"
          icon={CircleAlert}
          action={
            <button type="button" className="btn" onClick={() => window.location.reload()}>
              Обновить страницу
            </button>
          }
        >
          {storage ? (
            <>
              <p>{storage.cause} — прогресс не сохраняется</p>
              <p>{storage.action}</p>
            </>
          ) : (
            error.message
          )}
        </EmptyState>
      ) : (
        <p className="loading-line" role="status">
          <Spinner />
          Загружаю…
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------ панели, вкладки, сегменты, раскрывающиеся блоки

/**
 * Шапка панели: метка капсом из 1–2 слов («Задание», «Наставник», «На повторение»), справа — короткая
 * пометка (aside) и значки-действия. level — уровень заголовка метки (h2 по умолчанию).
 */
export function PaneHead({
  label,
  icon: Icon,
  aside,
  actions,
  level = 2,
  id,
  className,
}: {
  label: ReactNode;
  icon?: LucideIcon;
  aside?: ReactNode;
  actions?: ReactNode;
  level?: 2 | 3 | 4;
  id?: string;
  className?: string;
}) {
  const Heading = `h${level}` as 'h2' | 'h3' | 'h4';
  return (
    <div className={`pane-head${className ? ` ${className}` : ''}`}>
      <Heading className="plabel" id={id}>
        {Icon && <Icon aria-hidden="true" />}
        {label}
      </Heading>
      {aside && <span className="pane-aside">{aside}</span>}
      {actions && <span className="pane-actions">{actions}</span>}
    </div>
  );
}

export interface TabItem<T extends string> {
  value: T;
  label: ReactNode;
  /** Счётчик-бейдж рядом со словом («✕ 3», «✓ 4/4»). */
  badge?: ReactNode;
  /** Точка «новое» у вкладки + скрытый текст для скринридера. */
  fresh?: string | null;
  disabled?: boolean;
}

/**
 * Вкладки: div.tabs[role=tablist] + button.tab[role=tab]. Панели рисует экран: id панели —
 * `${idPrefix}-panel-${value}`, id вкладки — `${idPrefix}-tab-${value}`. Стрелки, Home и End — по кругу.
 */
export function Tabs<T extends string>({
  label,
  items,
  value,
  onChange,
  idPrefix,
  className,
}: {
  label: string;
  items: TabItem<T>[];
  value: T;
  onChange: (value: T) => void;
  idPrefix: string;
  className?: string;
}) {
  const hasSelection = items.some((item) => item.value === value);
  return (
    <div
      className={`tabs${className ? ` ${className}` : ''}`}
      role="tablist"
      aria-label={label}
      onKeyDown={(event: KeyboardEvent<HTMLElement>) => rovingKeyDown(event)}
    >
      {items.map((item, index) => (
        <button
          key={item.value}
          type="button"
          role="tab"
          className="tab"
          id={`${idPrefix}-tab-${item.value}`}
          aria-controls={`${idPrefix}-panel-${item.value}`}
          aria-selected={item.value === value}
          tabIndex={rovingTabIndex(item.value === value, index, hasSelection)}
          disabled={item.disabled}
          onClick={() => onChange(item.value)}
        >
          <span>{item.label}</span>
          {item.badge}
          {item.fresh && (
            <>
              <span className="dot-new" aria-hidden="true" />
              <span className="visually-hidden">: {item.fresh}</span>
            </>
          )}
        </button>
      ))}
    </div>
  );
}

/** Выбор одного из нескольких (radiogroup): одна остановка Tab на группу, выбор — стрелками. */
export function Choice<T extends string | number>({
  label,
  value,
  options,
  onChange,
  labelledBy,
}: {
  label: string;
  value: T;
  options: [T, string][];
  onChange: (value: T) => void;
  labelledBy?: string;
}) {
  const hasSelection = options.some(([option]) => option === value);
  return (
    <div
      className="segmented"
      role="radiogroup"
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      onKeyDown={(event) => rovingKeyDown(event)}
    >
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

/** Раскрывающийся блок на линиях: шеврон поворачивается, текст тела — на одной линии с текстом summary. */
export function Disclosure({
  summary,
  children,
  open,
  className,
  onToggle,
}: {
  summary: ReactNode;
  children: ReactNode;
  open?: boolean;
  className?: string;
  onToggle?: (open: boolean) => void;
}) {
  return (
    <details
      className={`disclosure${className ? ` ${className}` : ''}`}
      open={open}
      onToggle={onToggle ? (event) => onToggle((event.currentTarget as HTMLDetailsElement).open) : undefined}
    >
      <summary>
        <ChevronRight aria-hidden="true" className="disclosure-chevron" />
        <span className="disclosure-summary">{summary}</span>
      </summary>
      <div className="disclosure-body">{children}</div>
    </details>
  );
}

/**
 * Подсказка клавиши внутри кнопки («Ctrl ↵»). Скрыта от скринридера — иначе имя кнопки станет
 * «Проверить Ctrl ↵»; клавишу объявляет aria-keyshortcuts у самой кнопки. Нет на сенсорных экранах и уже 1280 px.
 */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="kbd" aria-hidden="true">
      {children}
    </kbd>
  );
}

/**
 * Адрес места в коде: «main.py:4» моноширинным. С onClick — кнопка, с href — ссылка, иначе просто метка.
 */
export function Addr({
  file,
  line,
  onClick,
  href,
  label,
}: {
  file: string;
  line?: number | null;
  onClick?: () => void;
  href?: string;
  /** Доступное имя; по умолчанию «main.py, строка 4 — показать в коде». */
  label?: string;
}) {
  const text = line ? `${file}:${line}` : file;
  const name = label ?? (line ? `${file}, строка ${line}${onClick || href ? ' — показать в коде' : ''}` : file);
  if (href) {
    return (
      <a className="addr" href={href} aria-label={name}>
        {text}
      </a>
    );
  }
  if (onClick) {
    return (
      <button type="button" className="addr" onClick={onClick} aria-label={name}>
        {text}
      </button>
    );
  }
  return (
    <span className="addr addr-static" aria-label={name === text ? undefined : name}>
      {text}
    </span>
  );
}

// ------------------------------------------------------------ форматирование

/** Склонение: plural(3, ['урок', 'урока', 'уроков']). */
export function plural(count: number, forms: [string, string, string]): string {
  const n = Math.abs(count) % 100;
  const n1 = n % 10;
  if (n > 10 && n < 20) return forms[2];
  if (n1 > 1 && n1 < 5) return forms[1];
  if (n1 === 1) return forms[0];
  return forms[2];
}

export function formatMinutes(range: [number, number]): string {
  return range[0] === range[1] ? `${range[0]} мин` : `${range[0]}–${range[1]} мин`;
}

/**
 * «26 сентября». Год добавляется, если дата не в текущем году или если year: true (даты источников:
 * данные прошлого года не должны выглядеть свежими) — «26 сентября 2026», без «г.». Неверная дата — «дата неизвестна».
 * Одна запись даты на всё приложение.
 */
export function formatDate(timestamp: number | string, options: { year?: boolean } = {}): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return 'дата неизвестна';
  const withYear = options.year || date.getFullYear() !== new Date().getFullYear();
  if (!withYear) return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).replace(/\s*г\.?$/, '');
}
