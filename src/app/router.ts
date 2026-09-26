// Маршрутизация через адрес после «#»: работает офлайн и на любом статическом хостинге.

import { useSyncExternalStore } from 'react';

export type Route =
  | { name: 'today' }
  | { name: 'course' }
  | { name: 'module'; moduleId: string }
  | { name: 'projects'; projectId: string | null }
  | { name: 'lesson'; lessonId: string; step: number | null }
  | { name: 'directions'; labId: string | null }
  | { name: 'progress' }
  | { name: 'settings'; section: string | null }
  | { name: 'not-found'; path: string };

export type NavSection = 'today' | 'course' | 'directions' | 'progress' | 'settings';

function currentPath(): string {
  const hash = window.location.hash.replace(/^#/, '');
  return hash.startsWith('/') ? hash : `/${hash}`;
}

export function parsePath(path: string): Route {
  const parts = path
    .split('?')[0]
    .split('/')
    .filter(Boolean)
    .map((part) => decodeURIComponent(part));
  const [first, second, third] = parts;
  switch (first) {
    case undefined:
    case 'today':
      return { name: 'today' };
    case 'course':
      return second ? { name: 'module', moduleId: second } : { name: 'course' };
    case 'projects':
      return { name: 'projects', projectId: second ?? null };
    case 'lesson':
      if (!second) return { name: 'course' };
      return { name: 'lesson', lessonId: second, step: third !== undefined && /^\d+$/.test(third) ? Number(third) : null };
    case 'directions':
      return { name: 'directions', labId: second ?? null };
    case 'progress':
      return { name: 'progress' };
    case 'settings':
      return { name: 'settings', section: second ?? null };
    default:
      return { name: 'not-found', path };
  }
}

export function sectionOf(route: Route): NavSection | null {
  switch (route.name) {
    case 'today':
      return 'today';
    case 'course':
    case 'module':
    case 'projects':
    case 'lesson':
      return 'course';
    case 'directions':
      return 'directions';
    case 'progress':
      return 'progress';
    case 'settings':
      return 'settings';
    default:
      return null;
  }
}

function subscribe(listener: () => void) {
  window.addEventListener('hashchange', listener);
  return () => window.removeEventListener('hashchange', listener);
}

export function usePath(): string {
  return useSyncExternalStore(subscribe, currentPath, () => '/');
}

export function useRoute(): Route {
  return parsePath(usePath());
}

export function href(path: string): string {
  return `#${path.startsWith('/') ? path : `/${path}`}`;
}

export function navigate(path: string, options: { replace?: boolean } = {}) {
  const target = href(path);
  if (options.replace) {
    window.history.replaceState(null, '', target);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else if (window.location.hash !== target) {
    window.location.hash = target;
  }
}

export const paths = {
  today: () => '/',
  course: () => '/course',
  module: (moduleId: string) => `/course/${moduleId}`,
  projects: (projectId?: string) => (projectId ? `/projects/${projectId}` : '/projects'),
  lesson: (lessonId: string, step?: number) => (step === undefined ? `/lesson/${lessonId}` : `/lesson/${lessonId}/${step}`),
  directions: (labId?: string) => (labId ? `/directions/${labId}` : '/directions'),
  progress: () => '/progress',
  settings: (section?: string) => (section ? `/settings/${section}` : '/settings'),
};
