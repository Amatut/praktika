// Панель наставника. Каждый шаг урока рендерит своё содержимое в общую колонку
// через портал — так подсказки остаются в состоянии шага.

import { CircleAlert, CircleCheck, Info, Sparkles, TriangleAlert } from 'lucide-react';
import { createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useOnline, useSettings } from '../../app/hooks.ts';
import { connectionLabel, useCoachConnection } from '../../coach/connection.ts';
import type { Feedback } from '../../coach/types.ts';
import { InlineText, Markdown } from '../../components/Markdown.tsx';

export const CoachSlotContext = createContext<HTMLElement | null>(null);

export function CoachPortal({ children }: { children: ReactNode }) {
  const slot = useContext(CoachSlotContext);
  return slot ? createPortal(children, slot) : null;
}

/**
 * Панель наставника: содержимое → кнопки подсказок курса → примечание → after (ИИ-наставник).
 * ИИ стоит после подсказок курса: они бесплатные и работают всегда.
 */
export function CoachPanel({
  children,
  actions,
  footnote,
  after,
}: {
  children: ReactNode;
  actions?: ReactNode;
  footnote?: string;
  after?: ReactNode;
}) {
  const settings = useSettings();
  const online = useOnline();
  const connection = useCoachConnection(settings.coach, online);
  // В режиме ИИ честно видно, есть ли связь с адаптером, а не просто «ИИ».
  const mode =
    settings.coach.mode === 'ai'
      ? connection.state === 'ready' && online
        ? 'ИИ-наставник · подключён, по запросу'
        : `ИИ-наставник · ${connectionLabel(connection, online).text}`
      : 'Подсказки курса';
  return (
    <section className="coach" aria-labelledby="coach-title">
      <div className="coach-head">
        <span className="coach-avatar" aria-hidden="true">
          <Sparkles />
        </span>
        <div>
          <div id="coach-title" className="coach-name">
            Твой наставник
          </div>
          <div className="coach-mode">{mode}</div>
        </div>
      </div>
      <div className="coach-body" aria-live="polite">
        {children}
      </div>
      {actions && <div className="coach-actions">{actions}</div>}
      {footnote && <p className="coach-foot">{footnote}</p>}
      {after}
    </section>
  );
}

export function CoachNote({ text }: { text: string }) {
  return <Markdown text={text} className="prose-compact" />;
}

const TITLES: Record<string, string> = {
  where: 'Где',
  why: 'Почему',
  tryThis: 'Попробуй',
  verify: 'Проверь',
};

/** Короткий разбор: где → почему → попробуй → проверь. */
export function FeedbackCard({ feedback }: { feedback: Feedback }) {
  const tone = feedback.source === 'environment' ? 'env' : feedback.source === 'timeout' || feedback.source === 'limit' ? 'error' : 'error';
  const Icon = tone === 'env' ? TriangleAlert : CircleAlert;
  return (
    <div className="feedback" data-tone={tone}>
      <div className="feedback-title">
        <Icon aria-hidden="true" />
        <span>{feedback.title}</span>
      </div>
      <dl>
        {feedback.where && (
          <div className="feedback-part">
            <dt>{TITLES.where}</dt>
            <dd>
              <InlineText text={feedback.where} />
            </dd>
          </div>
        )}
        <div className="feedback-part">
          <dt>{TITLES.why}</dt>
          <dd>
            <InlineText text={feedback.why} />
          </dd>
        </div>
        <div className="feedback-part">
          <dt>{TITLES.tryThis}</dt>
          <dd>
            <InlineText text={feedback.tryThis} />
          </dd>
        </div>
        {feedback.verify && (
          <div className="feedback-part">
            <dt>{TITLES.verify}</dt>
            <dd>
              <InlineText text={feedback.verify} />
            </dd>
          </div>
        )}
      </dl>
      {feedback.raw && (
        <details className="disclosure">
          <summary>Исходное сообщение Python</summary>
          <div className="disclosure-body">
            {/* Строки не переносятся: «^» должен стоять под ошибочным символом. Длинные строки — прокруткой. */}
            <pre className="raw" tabIndex={0}>
              {feedback.raw}
            </pre>
          </div>
        </details>
      )}
      {feedback.source === 'mistake' && <div className="tiny muted">Разбор из материалов урока.</div>}
    </div>
  );
}

export function InfoCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="feedback" data-tone="info">
      <div className="feedback-title">
        <Info aria-hidden="true" />
        <span>{title}</span>
      </div>
      <div className="small">{children}</div>
    </div>
  );
}

export function SuccessCard({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="success-card">
      <div className="status-line">
        <CircleCheck aria-hidden="true" />
        <span>{title}</span>
      </div>
      {children && <div className="small">{children}</div>}
    </div>
  );
}
