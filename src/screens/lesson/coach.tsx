// Панель «Наставник» и общие «гнёзда» кадра урока. Каждый шаг рисует своё содержимое наставника в общую
// колонку через портал — так подсказки остаются в состоянии шага. Кадр (LessonScreen) сообщает шагам раскладку:
// три панели на ПК, вкладки на планшете и телефоне, свёрнутые панели, а на телефоне — гнёзда для дока
// «Запустить / Проверить» и меню «⋯» в шапке урока.

import {
  BookMarked,
  CheckCheck,
  CircleCheck,
  CircleHelp,
  CircleX,
  Lightbulb,
  MapPin,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Sparkles,
  TriangleAlert,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { Children, createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useOnline, useSettings } from '../../app/hooks.ts';
import { connectionLabel, useCoachConnection, type CoachConnection } from '../../coach/connection.ts';
import type { Feedback } from '../../coach/types.ts';
import { InlineText, Markdown } from '../../components/Markdown.tsx';
import { Addr, Disclosure, PaneHead } from '../../components/ui.tsx';

export const CoachSlotContext = createContext<HTMLElement | null>(null);

export function CoachPortal({ children }: { children: ReactNode }) {
  const slot = useContext(CoachSlotContext);
  return slot ? createPortal(children, slot) : null;
}

// ------------------------------------------------------------ раскладка кадра урока

/** wide — три панели (≥ 1200), mid — вкладки «Задание | Наставник» и код (900–1199), narrow — вкладки и док (< 900). */
export type LessonLayout = 'wide' | 'mid' | 'narrow';
export type LessonPane = 'task' | 'code' | 'coach';
export type SidePane = 'task' | 'coach';

export interface LessonFrame {
  layout: LessonLayout;
  /** Наставник виден рядом с кодом: колонка на ПК или открытая вкладка на планшете. */
  coachVisible: boolean;
  collapsed: Record<SidePane, boolean>;
  toggleCollapsed: (pane: SidePane) => void;
  /** Открыть часть шага: вкладку на планшете и телефоне, свёрнутую панель на ПК. focus — куда перевести фокус. */
  showPane: (pane: LessonPane, focus?: string) => void;
  /** Появился новый разбор: на планшете открывается «Наставник», на телефоне у вкладки — точка «новое». */
  notifyFeedback: () => void;
  /** Есть непрочитанный разбор (точка у вкладки или у свёрнутой панели). */
  fresh: boolean;
  /** Гнёзда на телефоне: док внизу урока и меню «⋯» в шапке. */
  dock: HTMLElement | null;
  menu: HTMLElement | null;
}

const NOOP = () => {};

export const LessonFrameContext = createContext<LessonFrame>({
  layout: 'wide',
  coachVisible: true,
  collapsed: { task: false, coach: false },
  toggleCollapsed: NOOP,
  showPane: NOOP,
  notifyFeedback: NOOP,
  fresh: false,
  dock: null,
  menu: null,
});

export function useLessonFrame(): LessonFrame {
  return useContext(LessonFrameContext);
}

const PANE_NAME: Record<SidePane, string> = { task: 'Задание', coach: 'Наставник' };

/** Кнопка «Свернуть / Развернуть панель» в шапке боковой панели (только на ПК). */
export function CollapseButton({ pane, name = PANE_NAME[pane] }: { pane: SidePane; name?: string }) {
  const frame = useLessonFrame();
  if (frame.layout !== 'wide') return null;
  const collapsed = frame.collapsed[pane];
  const label = `${collapsed ? 'Развернуть' : 'Свернуть'} панель «${name}»`;
  const Icon = pane === 'coach' ? (collapsed ? PanelRightOpen : PanelRightClose) : collapsed ? PanelLeftOpen : PanelLeftClose;
  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm btn-icon pane-collapse"
      aria-label={label}
      title={label}
      aria-expanded={!collapsed}
      onClick={() => frame.toggleCollapsed(pane)}
    >
      <Icon aria-hidden="true" />
      {collapsed && pane === 'coach' && frame.fresh && (
        <>
          <span className="dot-new" aria-hidden="true" />
          <span className="visually-hidden">: новое — разбор ошибки</span>
        </>
      )}
    </button>
  );
}

// ------------------------------------------------------------ панель наставника

/**
 * Состояние связи с ИИ одними и теми же словами в шапке панели и в блоке ИИ-наставника: «подключён / нет связи /
 * не настроен». Подробная причина — в блоке ИИ, в «Почему и что проверить».
 */
export function shortConnection(state: CoachConnection['state'], online: boolean): string {
  return connectionLabel({ state }, online).text;
}

/**
 * Метка источника: «Подсказки курса · не ИИ» или «ИИ · подключён». Рядом с меткой панели «Наставник» коротко —
 * «ИИ»: полное название и состояние связи — в блоке ИИ-наставника и в подсказке метки.
 */
function SourceTag() {
  const settings = useSettings();
  const online = useOnline();
  const connection = useCoachConnection(settings.coach, online);
  if (settings.coach.mode === 'ai') {
    return (
      <span className="src-tag" title={`ИИ-наставник: ${shortConnection(connection.state, online)}`}>
        <Sparkles aria-hidden="true" />
        <span className="src-text">
          <span className="coach-mode">
            ИИ<span className="visually-hidden">-наставник</span>
          </span>
          <span> · {shortConnection(connection.state, online)}</span>
        </span>
      </span>
    );
  }
  return (
    <span className="src-tag" title="Разборы и подсказки написаны авторами курса">
      <BookMarked aria-hidden="true" />
      {/* .coach-mode — ровно «Подсказки курса»: на это опираются проверки. */}
      <span className="src-text">
        <span className="coach-mode">Подсказки курса</span>
        {/* Узкая колонка наставника в шаге-документе: «Курс · не ИИ» (название панели при этом остаётся). */}
        <span className="src-short">Курс</span>
        <span> · не ИИ</span>
      </span>
    </span>
  );
}

/**
 * Панель наставника: шапка с меткой источника → содержимое (разбор, подсказки, решение) → after (ИИ-наставник,
 * после подсказок курса: они бесплатные и работают всегда) → подвал с кнопками (actions) и строкой note над ними.
 * Без содержимого панели нет: колонка наставника не занимает места.
 */
export function CoachPanel({
  children,
  actions,
  after,
  note,
}: {
  children?: ReactNode;
  actions?: ReactNode;
  after?: ReactNode;
  /** Одна короткая строка над кнопками подвала («Подсказки — после первой проверки»). */
  note?: ReactNode;
}) {
  const frame = useLessonFrame();
  const hasBody = Children.toArray(children).length > 0 || Boolean(after);
  const hasFoot = Children.toArray(actions).length > 0;
  if (!hasBody && !hasFoot) return null;
  return (
    <section className="coach" aria-labelledby="coach-title">
      <PaneHead id="coach-title" label="Наставник" aside={<SourceTag />} actions={<CollapseButton pane="coach" />} className="coach-head" />
      <div className="coach-body" aria-live="polite">
        {children}
        {after}
      </div>
      {hasFoot && (
        // На ПК и планшете подвал закреплён строкой сетки панели; на телефоне это просто конец содержимого наставника.
        <div className={frame.layout === 'narrow' ? 'coach-tail' : 'coach-foot'}>
          {note && <p className="coach-note">{note}</p>}
          <div className="coach-actions">{actions}</div>
        </div>
      )}
    </section>
  );
}

export function CoachNote({ text }: { text: string }) {
  return <Markdown text={text} className="prose-compact coach-text" />;
}

/** Пустой наставник до первой попытки: одна строка. */
export function CoachEmpty({ children }: { children: ReactNode }) {
  return <p className="coach-empty">{children}</p>;
}

function FeedbackPart({
  icon: Icon,
  label,
  aside,
  className,
  children,
}: {
  icon: LucideIcon;
  label: string;
  /** Рядом с меткой: адрес строки «main.py:3» у «Где». */
  aside?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`feedback-part${className ? ` ${className}` : ''}`}>
      <dt>
        <Icon aria-hidden="true" />
        <span className="feedback-label">
          <span>{label}</span>
          {aside}
        </span>
      </dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * Разбор: где → почему → попробуй → проверь. Тексты — из материалов курса и src/coach (содержание).
 * С onShowLine адрес «main.py:3» — кнопка, которая показывает строку в редакторе.
 */
export function FeedbackCard({
  feedback,
  file = 'main.py',
  onShowLine,
}: {
  feedback: Feedback;
  file?: string;
  onShowLine?: (line: number) => void;
}) {
  const env = feedback.source === 'environment';
  const Icon = env ? TriangleAlert : CircleX;
  const line = feedback.line;
  return (
    <div className="feedback" data-tone={env ? 'env' : 'error'}>
      <h3 className="feedback-title">
        <Icon aria-hidden="true" />
        <span>{feedback.title}</span>
      </h3>
      <dl className="feedback-parts">
        {(feedback.where || line) && (
          <FeedbackPart
            icon={MapPin}
            label="Где"
            className="is-where"
            aside={line ? <Addr file={file} line={line} onClick={onShowLine ? () => onShowLine(line) : undefined} /> : null}
          >
            {feedback.where ? <InlineText text={feedback.where} /> : <span className="visually-hidden">строка {line}</span>}
          </FeedbackPart>
        )}
        <FeedbackPart icon={CircleHelp} label="Почему">
          <InlineText text={feedback.why} />
        </FeedbackPart>
        <FeedbackPart icon={Wrench} label="Попробуй" className="is-try">
          <InlineText text={feedback.tryThis} />
        </FeedbackPart>
        {feedback.verify && (
          <FeedbackPart icon={CheckCheck} label="Проверь">
            <InlineText text={feedback.verify} />
          </FeedbackPart>
        )}
      </dl>
      {feedback.raw && (
        <Disclosure summary="Исходное сообщение Python" className="feedback-raw">
          <RawMessage text={feedback.raw} />
        </Disclosure>
      )}
    </div>
  );
}

/**
 * Исходное сообщение Python. Трассировка и строка кода с «^» не переносятся: каретка должна стоять под ошибочным
 * символом (они короткие, длинные — прокруткой). Итоговая строка «NameError: …» — длинная фраза: она переносится,
 * а не обрывается у края панели.
 */
function RawMessage({ text }: { text: string }) {
  const value = text.replace(/\s+$/, '');
  const cut = value.lastIndexOf('\n');
  const head = cut >= 0 ? value.slice(0, cut + 1) : '';
  const tail = cut >= 0 ? value.slice(cut + 1) : value;
  return (
    <pre className="raw" tabIndex={0} aria-label="Исходное сообщение Python">
      {head}
      <span className="raw-last">{tail}</span>
    </pre>
  );
}

/**
 * Подсказка, объяснение «Проще», ответ наставника: значок и метка строкой интерфейса, ниже — текст урока
 * (.hint-card — только сам текст подсказки).
 */
export function HintCard({ label, id, children }: { label: string; id?: string; children: ReactNode }) {
  return (
    <div className="hint" id={id} tabIndex={id ? -1 : undefined}>
      <Lightbulb aria-hidden="true" className="hint-icon" />
      <div className="hint-label">{label}</div>
      <div className="hint-card hint-text">{children}</div>
    </div>
  );
}

export function SuccessCard({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="success-card">
      <p className="status-line status-ok">
        <CircleCheck aria-hidden="true" />
        <span>{title}</span>
      </p>
      {children && <div className="success-text">{children}</div>}
    </div>
  );
}
