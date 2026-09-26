// Собирает и проверяет учебные материалы: node scripts/build-content.ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildContent, ContentError } from '../build/content-lib.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

try {
  const { course, warnings } = await buildContent(root);
  for (const warning of warnings) console.warn(`⚠ ${warning}`);
  for (const module of course.modules) {
    const ready = module.lessons.filter((lesson) => lesson.ready).length;
    console.log(`${String(module.number).padStart(2)}. ${module.title} — уроков готово ${ready} из ${module.lessons.length} (${module.status})`);
  }
  console.log(`Лабораторий: ${course.labs.length}, проектов: ${course.projects.length}, навыков: ${course.skills.length}`);
  console.log(`Версия материалов: ${course.contentVersion}`);
} catch (error) {
  if (error instanceof ContentError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
