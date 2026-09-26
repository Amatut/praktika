// Создаёт PNG-иконки из SVG с помощью установленного браузера (Edge или Chrome):
// node scripts/make-icons.ts
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const icons = path.join(root, 'public', 'icons');

const jobs = [
  { source: 'icon.svg', target: 'icon-192.png', size: 192 },
  { source: 'icon.svg', target: 'icon-512.png', size: 512 },
  { source: 'icon-maskable.svg', target: 'icon-maskable-512.png', size: 512 },
];

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'msedge' });
try {
  const page = await browser.newPage();
  for (const job of jobs) {
    const svg = await readFile(path.join(icons, job.source), 'utf8');
    await page.setViewportSize({ width: job.size, height: job.size });
    await page.setContent(
      `<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${job.size}" height="${job.size}" `)}</body></html>`,
    );
    await page.screenshot({ path: path.join(icons, job.target), omitBackground: true, clip: { x: 0, y: 0, width: job.size, height: job.size } });
    console.log(`✓ ${job.target}`);
  }
} finally {
  await browser.close();
}
