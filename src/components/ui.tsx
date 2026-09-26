import { CircleAlert, CircleCheck, CircleDashed, CircleDot, Info, TriangleAlert, X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { useInlineProblem } from '../app/problems.ts';

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
        <div className="row-between" style={{ alignItems: 'flex-start' }}>
          <h2 id={`${id}-title`} className="dialog-title">
            {title}
          </h2>
          <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label="Закрыть" onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </div>
        <div id={`${id}-text`} className="stack-sm muted">
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

export type Tone = 'good' | 'error' | 'warn' | 'accent' | 'muted';

const TONE_ICON = {
  good: CircleCheck,
  error: CircleAlert,
  warn: TriangleAlert,
  accent: CircleDot,
  muted: CircleDashed,
};

/** Метка статуса: всегда значок + текст, цвет — не единственный сигнал. */
export function StatusBadge({ tone, children, icon = true }: { tone: Tone; children: ReactNode; icon?: boolean }) {
  const Icon = TONE_ICON[tone];
  const className = tone === 'muted' ? 'badge' : `badge badge-${tone}`;
  return (
    <span className={className}>
      {icon && <Icon aria-hidden="true" />}
      {children}
    </span>
  );
}

export function Notice({
  tone = 'muted',
  title,
  children,
  action,
}: {
  tone?: 'muted' | 'accent' | 'warn' | 'error' | 'good';
  title?: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  const Icon = tone === 'warn' ? TriangleAlert : tone === 'error' ? CircleAlert : tone === 'good' ? CircleCheck : Info;
  return (
    <div className={`notice${tone === 'muted' ? '' : ` notice-${tone}`}`} role={tone === 'error' ? 'alert' : undefined}>
      <Icon aria-hidden="true" />
      <div className="stack-sm" style={{ gap: 4, flex: 1, minWidth: 0 }}>
        {title && <div className="notice-title">{title}</div>}
        {children && <div>{children}</div>}
        {action && <div className="row">{action}</div>}
      </div>
    </div>
  );
}

export function Meter({ value, max, label }: { value: number; max: number; label: string }) {
  const percent = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="meter" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}>
      <span style={{ width: `${percent}%` }} />
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return <span className="spinner" role={label ? 'status' : undefined} aria-label={label} />;
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {children && <div>{children}</div>}
      {action}
    </div>
  );
}

/** Экран ждёт данные ученика: «Загружаю…» или понятная причина, если хранилище недоступно. */
export function PendingData({ error }: { error: Error | null }) {
  useInlineProblem(error?.message ?? null);
  return (
    <div className="page">
      {error ? (
        <EmptyState
          title="Прогресс не загрузился"
          action={
            <button type="button" className="btn" onClick={() => window.location.reload()}>
              Обновить страницу
            </button>
          }
        >
          {error.message}
        </EmptyState>
      ) : (
        <p className="muted" role="status">
          Загружаю…
        </p>
      )}
    </div>
  );
}

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
 * данные прошлого года не должны выглядеть свежими). Неверная дата — «дата неизвестна».
 */
export function formatDate(timestamp: number | string, options: { year?: boolean } = {}): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return 'дата неизвестна';
  const withYear = options.year || date.getFullYear() !== new Date().getFullYear();
  return date.toLocaleDateString('ru-RU', withYear ? { day: 'numeric', month: 'long', year: 'numeric' } : { day: 'numeric', month: 'long' });
}
