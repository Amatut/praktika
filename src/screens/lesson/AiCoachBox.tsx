// ИИ-наставник через серверный адаптер. Каждый запрос — только по кнопке ученика
// (запросы платные). Без сети или при недоступном адаптере вопрос сохраняется черновиком
// и отправляется вручную, когда связь появится.

import { RefreshCw, Send } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useOnline, useSettings } from '../../app/hooks.ts';
import { href, paths } from '../../app/router.ts';
import {
  CoachError,
  askCoach,
  buildCoachRequest,
  describeCoachError,
  type CoachAction,
  type CoachHistoryItem,
} from '../../coach/ai-client.ts';
import {
  connectionFromError,
  connectionLabel,
  refreshCoachConnection,
  reportCoachResult,
  useCoachConnection,
} from '../../coach/connection.ts';
import { Markdown } from '../../components/Markdown.tsx';
import { Notice } from '../../components/ui.tsx';
import { loadCourse, loadModule } from '../../content/loader.ts';
import type { Exercise, Lesson } from '../../content/schema.ts';
import { skillProgress } from '../../progress/model.ts';
import type { CheckOutcome } from '../../runner/runner.ts';
import { addCoachDraft, deleteCoachDraft, getAllExercises, getAllLessons, getAllReviews, getCoachDrafts } from '../../storage/repo.ts';
import type { CoachDraft } from '../../storage/types.ts';
import { skillCardLines, skillIdsFor } from './skill-card.ts';

/** Запрос не дошёл из-за связи (а не ИИ отказал) — вопрос стоит сохранить черновиком. */
function keepsDraft(error: unknown): boolean {
  return error instanceof CoachError && (error.kind === 'network' || error.kind === 'unavailable' || error.kind === 'timeout');
}

/** Краткая карточка навыков задания и урока из настоящих попыток. Не удалось собрать — запрос уйдёт без неё. */
async function loadSkillCard(lesson: Lesson, exercise: Exercise): Promise<string[]> {
  try {
    const course = await loadCourse();
    const skills = skillIdsFor(lesson, exercise).flatMap((id) => course.skills.filter((skill) => skill.id === id));
    const moduleIds = new Set(skills.map((skill) => skill.module));
    const files = await Promise.all(
      course.modules
        .filter((module) => module.file && moduleIds.has(module.id))
        .map((module) => loadModule(module).catch(() => null)),
    );
    const lessons = files.flatMap((file) => file?.lessons ?? []);
    if (!lessons.some((item) => item.id === lesson.id)) lessons.push(lesson);
    const [lessonRecords, exerciseRecords, reviews] = await Promise.all([getAllLessons(), getAllExercises(), getAllReviews()]);
    const lessonMap = new Map(lessonRecords.map((record) => [record.lessonId, record]));
    const exerciseMap = new Map(exerciseRecords.map((record) => [record.exerciseId, record]));
    const progress = new Map(skills.map((skill) => [skill.id, skillProgress(skill.id, lessons, lessonMap, exerciseMap, reviews)]));
    return skillCardLines(skills, progress);
  } catch {
    return [];
  }
}

export function AiCoachBox({
  lesson,
  exercise,
  code,
  checkOutcome,
  checkedCode,
  hintsUsed,
}: {
  lesson: Lesson;
  exercise: Exercise;
  code: string;
  checkOutcome: CheckOutcome | null;
  /** Код на момент последней проверки: результаты относятся только к нему. */
  checkedCode: string | null;
  hintsUsed: number;
}) {
  const settings = useSettings();
  const online = useOnline();
  const connection = useCoachConnection(settings.coach, online);
  const status = connectionLabel(connection, online);
  const [question, setQuestion] = useState('');
  const [pending, setPending] = useState<CoachAction | null>(null);
  const [answer, setAnswer] = useState<{ text: string; model: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [history, setHistory] = useState<CoachHistoryItem[]>([]);
  const [drafts, setDrafts] = useState<CoachDraft[]>([]);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    void getCoachDrafts({ exerciseId: exercise.id }).then(setDrafts);
    return () => controller.current?.abort();
  }, [exercise.id]);

  const checkResult = checkOutcome?.status === 'done' ? checkOutcome.result : null;
  const failed = checkResult ? Boolean(checkResult.compileError) || checkResult.tests.some((test) => !test.passed) : false;

  async function send(action: CoachAction, text?: string, draftId?: string) {
    if (pending) return;
    setError(null);
    setSaved(false);
    setPending(action);
    controller.current = new AbortController();
    try {
      const skillCard = await loadSkillCard(lesson, exercise);
      const request = buildCoachRequest({
        action,
        lesson: { id: lesson.id, title: lesson.title, objective: lesson.objective },
        exercise: { id: exercise.id, title: exercise.title, kind: exercise.kind, statement: exercise.statement },
        code,
        checkResult,
        checkedCode,
        tests: exercise.tests,
        hintsUsed,
        skillCard,
        question: text ?? null,
        history,
      });
      const reply = await askCoach(settings.coach.endpoint, settings.coach.accessToken, request, controller.current.signal);
      reportCoachResult(settings.coach.endpoint, settings.coach.accessToken, { ok: true, model: reply.model });
      setAnswer({ text: reply.text, model: reply.model });
      setHistory((previous) =>
        [...previous, { role: 'student' as const, text: text ?? action }, { role: 'coach' as const, text: reply.text }].slice(-4),
      );
      if (text) setQuestion('');
      if (draftId) {
        await deleteCoachDraft(draftId);
        setDrafts((items) => items.filter((item) => item.id !== draftId));
      }
    } catch (reason) {
      reportCoachResult(settings.coach.endpoint, settings.coach.accessToken, { ok: false, error: reason });
      // Причину нет связи уже объясняет блок состояния выше — здесь коротко.
      setError(connectionFromError(reason) ? 'Не получилось связаться с наставником.' : describeCoachError(reason));
      // Вопрос своими словами не теряется, если связи нет (в том числе при Wi-Fi без интернета).
      if (text && !draftId && keepsDraft(reason)) await saveDraft(text);
    } finally {
      setPending(null);
    }
  }

  async function saveDraft(text = question.trim()) {
    if (!text) return;
    const draft = await addCoachDraft({ text, exerciseId: exercise.id, lessonId: lesson.id });
    setDrafts((items) => [...items, draft]);
    setQuestion('');
    setSaved(true);
  }

  const actions: [CoachAction, string][] = [
    ...(failed ? ([['explain-error', 'Разбери ошибку']] as [CoachAction, string][]) : []),
    ['simpler', 'Объясни проще'],
    ['detailed', 'Подробнее'],
    ['short', 'Коротко'],
  ];
  const problem = connection.state === 'unavailable' || connection.state === 'not-configured' ? connection.message : null;

  return (
    <div className="ai-box">
      <div className="row-between">
        <span className="label">ИИ-наставник</span>
        <span className={`ai-status tone-${status.tone}`}>
          <span className="dot" aria-hidden="true" />
          {status.text}
          {connection.state === 'ready' && online ? ', по запросу' : ''}
        </span>
      </div>
      {online && problem && (
        <div className="stack-sm">
          <details className="disclosure">
            <summary>Почему и что проверить</summary>
            <div className="disclosure-body small">{problem}</div>
          </details>
          <span className="row" style={{ gap: 6 }}>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => void refreshCoachConnection(settings.coach.endpoint, settings.coach.accessToken, { force: true })}
            >
              <RefreshCw aria-hidden="true" />
              Проверить связь
            </button>
            <a className="btn btn-ghost btn-sm" href={href(paths.settings('coach'))}>
              Настройки наставника
            </a>
          </span>
        </div>
      )}
      <div className="row" style={{ gap: 6 }}>
        {actions.map(([action, label]) => (
          <button
            key={action}
            type="button"
            className="btn btn-sm"
            disabled={!online || pending !== null}
            onClick={() => void send(action)}
          >
            {pending === action && <span className="spinner" aria-hidden="true" />}
            {label}
          </button>
        ))}
      </div>
      <label className="field">
        <span className="visually-hidden">Вопрос наставнику</span>
        <textarea
          className="textarea"
          rows={2}
          value={question}
          maxLength={1000}
          placeholder="Спроси о задании своими словами"
          onChange={(event) => {
            setQuestion(event.target.value);
            setSaved(false);
          }}
        />
      </label>
      <div className="row">
        {online ? (
          <button
            type="button"
            className="btn btn-sm"
            disabled={!question.trim() || pending !== null}
            onClick={() => void send('question', question.trim())}
          >
            {pending === 'question' ? <span className="spinner" aria-hidden="true" /> : <Send aria-hidden="true" />}
            Спросить
          </button>
        ) : (
          <button type="button" className="btn btn-sm" disabled={!question.trim()} onClick={() => void saveDraft()}>
            Сохранить черновик
          </button>
        )}
        {pending && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => controller.current?.abort()}>
            Отменить
          </button>
        )}
      </div>
      {drafts.length > 0 && (
        <div className="stack-sm">
          <span className="tiny muted">
            Неотправленные вопросы ({drafts.length}). {online ? 'Отправь нужные вручную — каждый запрос платный.' : 'Отправишь, когда появится сеть.'}
          </span>
          {drafts.map((draft) => (
            <div key={draft.id} className="hint-card stack-sm">
              <span className="small">{draft.text}</span>
              <span className="row" style={{ gap: 4 }}>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={!online || pending !== null}
                  onClick={() => void send('question', draft.text, draft.id)}
                >
                  Отправить
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={async () => {
                    await deleteCoachDraft(draft.id);
                    setDrafts((items) => items.filter((item) => item.id !== draft.id));
                  }}
                >
                  Удалить
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
      {error && (
        <Notice tone="warn">
          {error} {saved ? 'Вопрос сохранён — отправишь, когда связь появится. ' : ''}Подсказки курса выше работают как обычно.
        </Notice>
      )}
      {!error && saved && <p className="tiny muted" role="status">Вопрос сохранён черновиком.</p>}
      {answer && (
        <div className="ai-answer stack-sm" aria-live="polite">
          <span className="tiny muted">Ответ ИИ{answer.model ? ` · ${answer.model}` : ''} — сверяй его с результатами тестов</span>
          <Markdown text={answer.text} className="prose-compact" />
        </div>
      )}
    </div>
  );
}
