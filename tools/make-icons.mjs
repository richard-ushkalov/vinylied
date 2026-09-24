/**
 * Растеризует SVG-иконки в PNG нужных размеров (npm run icons).
 * PNG коммитятся: Android и iOS берут иконку установки именно из них.
 */
import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const icons = new URL('../icons/', import.meta.url);
const jobs = [
    ['icon.svg', 'icon-192.png', 192],
    ['icon.svg', 'icon-512.png', 512],
    // маскируемая и для iOS — без скруглений: система скругляет сама
    ['icon-maskable.svg', 'icon-maskable-512.png', 512],
    ['icon-maskable.svg', 'apple-touch-icon.png', 180],
];

const browser = await chromium.launch();
const page = await browser.newPage();
for (const [source, target, size] of jobs) {
    const svg = await readFile(new URL(source, icons), 'utf8');
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
    await page.screenshot({ path: new URL(target, icons).pathname, omitBackground: true });
    console.log(target);
}
await browser.close();
