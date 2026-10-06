// Иллюстрация к истории урока: картинка без надписей поверх неё, под ней — кнопка «Увеличить»,
// крупный вид — в нативном <dialog> (фокус и Esc работают из коробки).
import { Expand, MoveHorizontal, X } from 'lucide-react';
import { useId, useRef } from 'react';
import { useMediaQuery } from '../../app/hooks.ts';

const SCENES = {
  cafe: { file: 'cafe.webp', alt: 'Лена и Артём за ноутбуком в кофейне: рядом табло, чашки и принтер чеков.' },
  bakery: { file: 'bakery.webp', alt: 'Марина раскладывает эклеры по коробкам в кондитерской; рядом стоит ноутбук.' },
  trip: { file: 'trip.webp', alt: 'Аня с учителем планируют школьную поездку за ноутбуком. За окном ждёт автобус.' },
  studio: { file: 'studio.webp', alt: 'Оля готовит напоминания за ноутбуком на стойке танцевальной студии.' },
};

const LESSON_SCENE: Record<string, keyof typeof SCENES> = {
  'm0-l1': 'cafe', 'm0-l2': 'cafe', 'm0-l3': 'cafe', 'm0-l4': 'cafe',
  'm1-l1': 'bakery', 'm1-l2': 'trip', 'm1-l3': 'studio',
  'm1-l4': 'cafe', 'm1-l5': 'cafe', 'm1-l6': 'cafe',
};

export function illustrationUrl(scene: keyof typeof SCENES) {
  return `${import.meta.env.BASE_URL}illustrations/${SCENES[scene].file}`;
}

/** Иллюстрация истории урока или null, если у урока её нет (превью урока на «Сегодня» — тот же список). */
export function lessonIllustrationUrl(lessonId: string): string | null {
  const scene = LESSON_SCENE[lessonId];
  return scene ? illustrationUrl(scene) : null;
}

export function StoryIllustration({ lessonId, title }: { lessonId: string; title: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // Телефон: в диалоге картинка во всю высоту экрана, сцену двигают вбок касанием или стрелками.
  const pan = useMediaQuery('(max-width: 599px)');
  const scene = LESSON_SCENE[lessonId];
  if (!scene) return null;
  const image = SCENES[scene];
  const open = () => {
    dialog.current?.showModal();
    // На телефоне картинка крупнее экрана и прокручивается вбок: начать с середины сцены.
    const area = body.current;
    if (area) area.scrollLeft = (area.scrollWidth - area.clientWidth) / 2;
  };
  return (
    <figure className="story-figure">
      {/* Картинка открывается и щелчком; с клавиатуры — кнопкой «Увеличить» под ней. */}
      <div className="story-image" onClick={open}>
        <img src={illustrationUrl(scene)} alt={image.alt} width="1672" height="941" decoding="async" />
      </div>
      <div className="story-figure-actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={open} aria-label={`Увеличить иллюстрацию: ${title}`}>
          <Expand aria-hidden="true" />
          Увеличить
        </button>
      </div>
      <dialog
        className="illustration-dialog"
        ref={dialog}
        aria-labelledby={titleId}
        onClick={(event) => {
          if (event.target === event.currentTarget) dialog.current?.close();
        }}
      >
        <div className="illustration-dialog-head">
          <p className="illustration-dialog-title" id={titleId}>
            {title}
          </p>
          {/* Телефон: края сцены за экраном — значок вместо подписи «двигай вбок». */}
          {pan && <MoveHorizontal aria-hidden="true" className="illustration-dialog-pan" />}
          <button
            autoFocus
            className="btn btn-icon btn-ghost"
            type="button"
            aria-label="Закрыть иллюстрацию"
            title="Закрыть иллюстрацию"
            onClick={() => dialog.current?.close()}
          >
            <X aria-hidden="true" />
          </button>
        </div>
        <div className="illustration-dialog-body" ref={body} role="group" tabIndex={pan ? 0 : undefined} aria-label={`Иллюстрация: ${title}`}>
          <img src={illustrationUrl(scene)} alt={image.alt} width="1672" height="941" />
        </div>
      </dialog>
    </figure>
  );
}
