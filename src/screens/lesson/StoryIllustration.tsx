import { Expand, X } from 'lucide-react';
import { useRef } from 'react';

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

export function StoryIllustration({ lessonId, title }: { lessonId: string; title: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const scene = LESSON_SCENE[lessonId];
  if (!scene) return null;
  const image = SCENES[scene];
  return (
    <figure className="story-figure">
      <button className="story-image-button" type="button" onClick={() => dialog.current?.showModal()} aria-label={`Рассмотреть иллюстрацию: ${title}`}>
        <img src={illustrationUrl(scene)} alt={image.alt} width="1672" height="941" decoding="async" />
        <span className="image-expand" aria-hidden="true"><Expand />Рассмотреть</span>
      </button>
      <figcaption><span className="scene-dot" aria-hidden="true" />Иллюстрация к истории · {title}</figcaption>
      <dialog className="illustration-dialog" ref={dialog} aria-label={`Иллюстрация: ${title}`} onClick={(event) => {
        if (event.target === event.currentTarget) dialog.current?.close();
      }}>
        <div className="illustration-dialog-head"><strong>{title}</strong><button autoFocus className="btn btn-icon btn-ghost" type="button" aria-label="Закрыть иллюстрацию" onClick={() => dialog.current?.close()}><X /></button></div>
        <img src={illustrationUrl(scene)} alt={image.alt} width="1672" height="941" />
      </dialog>
    </figure>
  );
}
