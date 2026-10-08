import { expect, test } from '@playwright/test';
import { makeId3, makeWav } from '../fixtures/make-fixtures.mjs';
import { importTracks, mockServices, PNG, togglePlay } from './helpers.js';

/**
 * «Похожее» и микс дня: советы — от Last.fm (мок), звук — со своего
 * сервера (мок) по названию: Spotify, а не нашлось — YouTube.
 */

const SERVER = 'https://dl.vinilyed.test';
const CODE = 'secret-code';
const FILE = makeWav({ seconds: 20, frequency: 440, id3: makeId3({ title: 'Прогулки по воде', artist: 'Наутилус', cover: PNG }) });

/** @param {string} artist @param {string} title */
const song = (artist, title) => ({ name: title, artist: { name: artist }, duration: '200' });

/** Похожие на любой трек: свои для каждого исполнителя-семени плюс уже стоящий на полке. */
const lastfm = url => {
    if (url.searchParams.get('method') !== 'track.getSimilar') return { error: 6, message: 'not found' };
    const artist = url.searchParams.get('artist');
    return { similartracks: { track: [
        song('Наутилус', 'Прогулки по воде'),
        song(`Похожий на ${artist}`, 'Первая'),
        song(`Похожий на ${artist}`, 'Вторая'),
        song('Кино', 'Группа крови'),            // уже на полке
        song('ДДТ', 'Осень'),
    ] } };
};

/**
 * Сервер: поиск отвечает тем же названием (или ошибкой Spotify), задания
 * висят, пока тест их не отпустит, — так видно, сколько качается сразу.
 * @param {import('@playwright/test').Page} page
 * @param {{ spotifyBroken?: boolean, down?: boolean }} [options]
 */
const mockServer = async (page, { spotifyBroken = false, down = false } = {}) => {
    const calls = { search: [], start: [], running: 0, peak: 0, release: false };
    const cors = {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'Authorization, Content-Type',
        'access-control-expose-headers': 'X-Filename, Content-Length',
    };
    /** @type {Map<string, { polls: number }>} */
    const jobs = new Map();
    await page.route(`${SERVER}/**`, route => {
        if (down) return route.abort('connectionrefused');
        const request = route.request();
        if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
        const url = new URL(request.url());
        const reply = (body, status = 200) => route.fulfill({ status, headers: cors, json: body });
        const job = url.pathname.match(/^\/v1\/downloads\/(\w+)(\/file)?$/);
        if (url.pathname === '/v1/health') return reply({ ok: true, version: '1.1.0', spotdl: '4.5.2', active: 0 });
        if (url.pathname === '/v1/search') {
            const source = url.searchParams.get('source');
            const query = url.searchParams.get('q') ?? '';
            calls.search.push(`${source}:${query}`);
            if (source === 'spotify' && spotifyBroken) return reply({ error: 'engine', message: 'Spotify не ответил на поиск' }, 502);
            // «исполнитель название» → один результат с тем же названием
            const [artist, ...title] = query.split(' ');
            const id = `${source === 'youtube' ? 'y' : 's'}${calls.search.length}`.padEnd(source === 'youtube' ? 11 : 22, '0');
            return reply({ results: [{ id, source, title: source === 'youtube' ? `${artist} - ${title.join(' ')} (audio)` : title.join(' '),
                artist, album: '', duration: 200, cover: null }] });
        }
        if (url.pathname === '/v1/downloads' && request.method() === 'POST') {
            calls.start.push(request.postDataJSON());
            const id = String(calls.start.length).padStart(32, 'a');
            jobs.set(id, { polls: 0 });
            calls.running++;
            calls.peak = Math.max(calls.peak, calls.running);
            return reply({ id, state: 'queued', progress: 0, stage: 'В очереди' }, 202);
        }
        if (job && !job[2]) {
            const state = calls.release ? 'done' : 'running';
            if (state === 'done' && jobs.get(job[1])?.polls !== -1) {
                jobs.set(job[1], { polls: -1 });
                calls.running--;
            }
            return reply({ id: job[1], state, progress: state === 'done' ? 1 : 0.3, stage: 'Качаю' });
        }
        if (job?.[2]) {
            return route.fulfill({ status: 200, body: FILE, headers: {
                ...cors, 'content-type': 'audio/wav', 'x-filename': encodeURIComponent(`${job[1]}.wav`),
            } });
        }
        return reply({ error: 'not_found', message: 'Нет такого адреса' }, 404);
    });
    return calls;
};

/** @param {import('@playwright/test').Page} page @param {boolean} [withCode] */
const withSettings = (page, withCode = true) => page.addInitScript(([server, code]) => {
    if (localStorage.getItem('vinilyed:settings')) return;
    localStorage.setItem('vinilyed:settings', JSON.stringify({ v: 1, values: { downloadServer: server, downloadCode: code } }));
}, [SERVER, withCode ? CODE : '']);

const sheet = page => page.getByRole('dialog', { name: 'Похожее' });
const discoverButton = page => page.getByRole('button', { name: 'Похожее и микс дня' });

test('без кода сервера кнопки «Похожее» нет, с кодом — есть', async ({ page }) => {
    await mockServices(page, { lastfm });
    await mockServer(page);
    await withSettings(page, false);
    await page.goto('/');
    await importTracks(page);
    await expect(discoverButton(page)).toBeHidden();

    await page.evaluate(([server, code]) => localStorage.setItem('vinilyed:settings',
        JSON.stringify({ v: 1, values: { downloadServer: server, downloadCode: code } })), [SERVER, CODE]);
    await page.reload();
    await expect(discoverButton(page)).toBeVisible();
});

test('похожее на играющий: без того, что на полке; «Добавить» ищет звук в Spotify и качает', async ({ page }) => {
    const calls = await mockServer(page);
    const services = await mockServices(page, { lastfm });
    await withSettings(page);
    await page.goto('/');
    await importTracks(page);
    await togglePlay(page);
    await expect(page.locator('.slot--current')).toHaveCount(1);
    const playing = await page.locator('.dock__title').textContent();

    await discoverButton(page).click();
    const dialog = sheet(page);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('radio', { name: 'На этот трек' })).toBeChecked();
    await expect(dialog.getByRole('status')).toContainText(`Похожее на «${playing}»`);
    const rows = dialog.locator('.suggest__item');
    await expect(rows).toHaveCount(4);
    await expect(dialog.getByText('Группа крови', { exact: true })).toHaveCount(0);
    expect(services.lastfm.some(url => url.searchParams.get('track') === playing)).toBe(true);
    expect(calls.search, 'пока ничего не нажали — сервер не трогаем').toEqual([]);

    await dialog.getByRole('button', { name: 'Добавить «Прогулки по воде — Наутилус»' }).click();
    await expect.poll(() => calls.start.length).toBe(1);
    expect(calls.search).toEqual(['spotify:Наутилус Прогулки по воде']);
    expect(calls.start[0].source).toBe('spotify');
    await expect(page.locator('.slot--pending')).toHaveCount(1);
    await expect(dialog.getByRole('button', { name: /Прогулки по воде — Наутилус».*%/ })).toBeDisabled();
});

test('Spotify сломан — звук берётся с YouTube', async ({ page }) => {
    const calls = await mockServer(page, { spotifyBroken: true });
    await mockServices(page, { lastfm });
    await withSettings(page);
    await page.goto('/');
    await importTracks(page);
    await togglePlay(page);
    await discoverButton(page).click();
    const dialog = sheet(page);
    await dialog.getByRole('button', { name: 'Добавить «Осень — ДДТ»' }).click();
    await expect.poll(() => calls.start.length).toBe(1);
    expect(calls.search).toEqual(['spotify:ДДТ Осень', 'youtube:ДДТ Осень']);
    expect(calls.start[0].source).toBe('youtube');
});

test('микс дня: от нескольких треков полки, раз в день; «Добавить все» качает по двое', async ({ page }) => {
    const calls = await mockServer(page);
    const services = await mockServices(page, { lastfm });
    await withSettings(page);
    await page.goto('/');
    await importTracks(page);
    await discoverButton(page).click();

    const dialog = sheet(page);
    await expect(dialog.getByRole('radio', { name: 'Микс дня' })).toBeChecked();
    await expect(dialog.getByRole('status')).toContainText('Собран сегодня по трекам');
    const similar = () => services.lastfm.filter(url => url.searchParams.get('method') === 'track.getSimilar').length;
    expect(similar()).toBe(5);
    // от каждого семени — свои, общий совет — один раз, что на полке — нет
    await expect(dialog.getByText(/^Похожий на /)).toHaveCount(5 * 2);
    await expect(dialog.getByText('Прогулки по воде', { exact: true })).toHaveCount(1);
    await expect(dialog.getByText('Группа крови', { exact: true })).toHaveCount(0);

    // тот же день — из памяти, в Last.fm не ходим
    await page.reload();
    await discoverButton(page).click();
    await expect(sheet(page).locator('.suggest__item')).toHaveCount(12);
    expect(similar()).toBe(5);

    // звук ищется по одному; качается не больше двух — третий ждёт у себя,
    // а не получает от сервера «слишком много загрузок»
    await sheet(page).getByRole('button', { name: 'Добавить все' }).click();
    const waiting = sheet(page).getByRole('button', { name: /в очереди на скачивание/ });
    await expect.poll(async () => calls.start.length === 2 && await waiting.count() > 0, { timeout: 20_000 }).toBe(true);
    await page.waitForTimeout(500);
    expect(calls.start.length, 'пока двое качаются, третий на сервер не уходит').toBe(2);
    calls.release = true;
    await expect.poll(() => calls.start.length, { timeout: 20_000 }).toBeGreaterThanOrEqual(3);
    expect(calls.peak, 'одновременно на сервере не больше двух заданий').toBeLessThanOrEqual(2);
});

test('Мак выключен — микс всё равно собирается, а «Добавить» объясняет, что не так', async ({ page }) => {
    await mockServer(page, { down: true });
    await mockServices(page, { lastfm });
    await withSettings(page);
    await page.goto('/');
    await importTracks(page);
    await discoverButton(page).click();
    const dialog = sheet(page);
    await expect(dialog.locator('.suggest__item')).toHaveCount(12);
    await dialog.getByRole('button', { name: 'Добавить «Осень — ДДТ»' }).click();
    await expect(dialog.getByRole('status')).toHaveText('Сервер загрузки недоступен');
    await expect(dialog.getByRole('button', { name: 'Добавить «Осень — ДДТ»' })).toBeEnabled();
});
