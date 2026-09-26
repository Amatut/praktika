// Учёт времени занятий: считается только время, когда вкладка открыта и ученик
// что-то делал в последнюю минуту. Никаких «серий» и наказаний за пропуск.

import { addActivity } from '../storage/repo.ts';

const IDLE_MS = 60_000;
const TICK_MS = 5_000;
const FLUSH_MS = 30_000;

export function startActivityTracking(): () => void {
  let lastInput = Date.now();
  let pending = 0;
  let lastTick = Date.now();

  const onInput = () => {
    lastInput = Date.now();
  };
  const events = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
  for (const name of events) window.addEventListener(name, onInput, { passive: true });

  const flush = () => {
    if (pending < 1000) return;
    const value = pending;
    pending = 0;
    void addActivity(value).catch(() => {
      pending += value;
    });
  };

  const tick = window.setInterval(() => {
    const now = Date.now();
    const delta = Math.min(now - lastTick, TICK_MS * 2);
    lastTick = now;
    if (document.visibilityState === 'visible' && now - lastInput < IDLE_MS) pending += delta;
  }, TICK_MS);
  const flusher = window.setInterval(flush, FLUSH_MS);
  const onHide = () => {
    if (document.visibilityState === 'hidden') flush();
  };
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', flush);

  return () => {
    for (const name of events) window.removeEventListener(name, onInput);
    window.clearInterval(tick);
    window.clearInterval(flusher);
    document.removeEventListener('visibilitychange', onHide);
    window.removeEventListener('pagehide', flush);
    flush();
  };
}
