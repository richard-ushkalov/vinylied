import { expect } from '@playwright/test';
import { FIXTURES, makePng } from '../fixtures/make-fixtures.mjs';

const DIR = new URL('../fixtures/.generated/', import.meta.url).pathname;

/** Пути тестовых файлов в порядке FIXTURES — он же порядок на полке. */
export const fixturePaths = (names = FIXTURES.map(f => f.file)) => names.map(name => `${DIR}${name}`);

export const PNG = makePng(64, [10, 120, 200]);

/**
 * Внешние сервисы в тестах — только моки. По умолчанию все молчат
 * («не нашли»); тест подставляет свои ответы.
 * @param {import('@playwright/test').Page} page
 * @param {{ itunes?: (url: URL) => any[], acoustid?: (url: URL) => any, image?: boolean }} [handlers]
 */
export const mockServices = async (page, handlers = {}) => {
    const calls = { itunes: [], acoustid: [], images: [] };
    const cors = { 'access-control-allow-origin': '*' };
    await page.route(/itunes\.apple\.com\/search/, route => {
        const url = new URL(route.request().url());
        calls.itunes.push(url.searchParams.get('term'));
        route.fulfill({ status: 200, headers: cors, contentType: 'application/json',
            body: JSON.stringify({ results: handlers.itunes?.(url) ?? [] }) });
    });
    await page.route(/api\.acoustid\.org/, route => {
        const url = new URL(route.request().url());
        calls.acoustid.push(url.searchParams.get('duration'));
        route.fulfill({ status: 200, headers: cors, contentType: 'application/json',
            body: JSON.stringify(handlers.acoustid?.(url) ?? { status: 'ok', results: [] }) });
    });
    await page.route(/coverartarchive\.org|mzstatic\.com|example\.test/, route => {
        calls.images.push(route.request().url());
        if (handlers.image === false) route.fulfill({ status: 404, headers: cors, body: '' });
        else route.fulfill({ status: 200, headers: cors, contentType: 'image/png', body: PNG });
    });
    return calls;
};

/** @param {import('@playwright/test').Page} page */
export const importTracks = async (page, paths = fixturePaths()) => {
    const before = await page.locator('.slot').count();
    await page.setInputFiles('.file-input', paths);
    await expect(page.locator('.slot')).toHaveCount(before + paths.length);
    await expect(page.locator('.slot--loading')).toHaveCount(0);
};

/** Состояние приложения глазами пользователя и системы. */
export const state = page => page.evaluate(() => ({
    title: document.querySelector('.dock__title')?.textContent,
    playing: document.querySelector('[data-action="play"] use')?.getAttribute('href') === '#i-pause',
    session: navigator.mediaSession.playbackState,
    sessionTitle: navigator.mediaSession.metadata?.title ?? null,
    position: Number(document.querySelector('.progress')?.getAttribute('aria-valuenow')),
    current: document.querySelector('.slot--current')?.getAttribute('aria-label') ?? null,
    audio: [...document.querySelectorAll('audio')].map(a => ({ paused: a.paused, loop: a.loop, stream: Boolean(a.srcObject) })),
}));

/** Тап по кнопке ⏯ в панели. */
export const togglePlay = page => page.locator('.dock [data-action="play"]').click();

/**
 * Подменяет встроенный ключ AcoustID, оставляя остальной src/config.js
 * как есть: из него импортируется не только ключ.
 * @param {import('@playwright/test').Page} page
 * @param {string} key
 */
export const withAcoustIdKey = (page, key) => page.route('**/src/config.js', async route => {
    const response = await route.fetch();
    const body = (await response.text()).replace(/ACOUSTID_KEY = '[^']*'/, `ACOUSTID_KEY = '${key}'`);
    await route.fulfill({ response, body });
});
