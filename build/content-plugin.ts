// Плагин Vite: собирает учебные материалы перед запуском и пересобирает их
// при изменении YAML-файлов во время разработки.
// В режиме разработки ошибка в материалах только выводится в консоль,
// при сборке (npm run build) — останавливает сборку.

import path from 'node:path';
import type { Plugin } from 'vite';
import { buildContent } from './content-lib.ts';

export function contentPlugin(): Plugin {
  let root = process.cwd();
  let serving = false;
  return {
    name: 'praktika:content',
    // Сборка до запуска сервера: Vite запоминает список файлов public/ при старте.
    async configResolved(config) {
      root = config.root;
      serving = config.command === 'serve';
      try {
        const { course, warnings } = await buildContent(root);
        const ready = course.modules.flatMap((module) => module.lessons).filter((lesson) => lesson.ready).length;
        config.logger.info(`Материалы: ${ready} готовых уроков, версия ${course.contentVersion}`);
        for (const warning of warnings) config.logger.warn(`[материалы] ${warning}`);
      } catch (error) {
        if (!serving) throw error;
        config.logger.error(`Материалы не собраны: ${(error as Error).message}`);
      }
    },
    configureServer(server) {
      const contentDir = path.join(root, 'content');
      server.watcher.add(contentDir);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onChange = (file: string) => {
        if (!file.startsWith(contentDir) || !/\.ya?ml$/i.test(file)) return;
        clearTimeout(timer);
        timer = setTimeout(async () => {
          try {
            const { warnings } = await buildContent(root);
            for (const warning of warnings) server.config.logger.warn(`[материалы] ${warning}`);
            server.config.logger.info('[материалы] пересобраны');
            server.ws.send({ type: 'full-reload' });
          } catch (error) {
            const message = String((error as Error).message ?? error);
            server.config.logger.error(message);
            server.ws.send({ type: 'error', err: { message, stack: '' } });
          }
        }, 150);
      };
      server.watcher.on('change', onChange);
      server.watcher.on('add', onChange);
      server.watcher.on('unlink', onChange);
    },
  };
}
