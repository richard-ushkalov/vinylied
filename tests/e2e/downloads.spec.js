import { expect, test } from '@playwright/test';
import { makeId3, makeWav } from '../fixtures/make-fixtures.mjs';
import { importTracks, mockServices, PNG } from './helpers.js';

/**
 * Скачивание со своего сервера. Сервер — мок на page.route: задание
 * проходит состояния, которые тест двигает сам, — так видно, что
 * конверт проявляется вместе с загрузкой, а не сразу.
 */

const SERVER = 'https://dl.vinilyed.test';
const CODE = 'secret-code';
const KUKUSHKA = { id: '0000000000000000000001', title: 'Кукушка', artist: 'Кино', album: 'Чёрный альбом',
                   duration: 20, cover: 'https://i.example.test/kukushka.png' };
const GRUPPA = { id: '0000000000000000000002', title: 'Группа крови', artist: 'Кино', album: 'Группа крови',
                 duration: 20, cover: null };

const FILE = makeWav({ seconds: 20, frequency: 523,
    id3: makeId3({ title: 'Кукушка', artist: 'Кино', album: 'Чёрный альбом', cover: PNG }) });

/**
 * @param {import('@playwright/test').Page} page
 * @param {{ results?: object[], health?: number, down?: boolean }} [options]
 */
const mockServer = async (page, { results = [KUKUSHKA, GRUPPA], health = 200, down = false } = {}) => {
    const job = { id: 'a'.repeat(32), state: 'queued', progress: 0, stage: 'В очереди', error: undefined };
    const calls = { search: [], start: [] };
    const cors = {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'Authorization, Content-Type',
        'access-control-expose-headers': 'X-Filename, Content-Length',
    };
    await page.route(`${SERVER}/**`, route => {
        if (down) return route.abort('connectionrefused');
        const request = route.request();
        if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
        const url = new URL(request.url());
        const reply = (body, status = 200) => route.fulfill({ status, headers: cors, json: body });
        if (request.headers().authorization !== `Bearer ${CODE}` || health === 401) {
            return reply({ error: 'unauthorized', message: 'Код доступа не подошёл' }, 401);
        }
        switch (url.pathname) {
            case '/v1/health': return reply({ ok: true, version: '1.0.0', spotdl: '4.5.2', active: 0 });
            case '/v1/search':
                calls.search.push(url.searchParams.get('q'));
                return reply({ results });
            case '/v1/downloads':
                calls.start.push(request.postDataJSON().id);
                return reply({ ...job }, 202);
            case `/v1/downloads/${job.id}`: return reply({ ...job });
            case `/v1/downloads/${job.id}/file`:
                return route.fulfill({ status: 200, body: FILE, headers: {
                    ...cors, 'content-type': 'audio/wav', 'x-filename': encodeURIComponent('Кино - Кукушка.wav'),
                } });
            default: return reply({ error: 'not_found', message: 'Нет такого адреса' }, 404);
        }
    });
    return { job, calls };
};

/** Код и адрес сервера — прямо в сохранённых настройках, как после ввода. */
const withCode = page => page.addInitScript(([server, code]) => {
    if (localStorage.getItem('vinilyed:settings')) return;
    localStorage.setItem('vinilyed:settings', JSON.stringify({ v: 1, values: { downloadServer: server, downloadCode: code } }));
}, [SERVER, CODE]);

/** @param {import('@playwright/test').Page} page @param {string} query */
const search = async (page, query) => {
    await page.getByRole('button', { name: 'Поиск по полке' }).click();
    await page.getByRole('searchbox', { name: 'Поиск по полке' }).fill(query);
};

/** Прозрачность видимой грани заготовки (лежащий конверт — это корешок). */
const pendingOpacity = page => page.locator('.slot--pending .vinyl__side')
    .evaluate(element => Number(getComputedStyle(element).opacity));

test.beforeEach(async ({ page }) => {
    await mockServices(page);
});

test('нет на полке — предлагает скачать; конверт проявляется вместе с загрузкой', async ({ page }) => {
    const { job, calls } = await mockServer(page);
    await withCode(page);
    await page.goto('/');
    await importTracks(page);

    await search(page, 'Кукушка');
    const panel = page.getByRole('region', { name: 'Скачать из сети' });
    await expect(panel).toBeVisible();
    // «Группа крови» уже на полке — её не предлагаем
    await expect(panel.getByRole('button', { name: /^Скачать/ })).toHaveCount(1);
    expect(calls.search).toEqual(['Кукушка']);

    job.state = 'running';
    job.progress = 0.2;
    job.stage = 'Качаю';
    await panel.getByRole('button', { name: 'Скачать «Кукушка — Кино»' }).click();
    expect(calls.start).toEqual([KUKUSHKA.id]);

    const pending = page.locator('.slot--pending');
    await expect(pending).toHaveCount(1);
    await expect(pending).toHaveAttribute('aria-label', /Кукушка — Кино: скачивается, 18%/);
    await expect.poll(() => pendingOpacity(page)).toBeLessThan(0.4);
    await expect(panel.getByRole('button', { name: /Кукушка — Кино».*18%/ })).toBeDisabled();

    job.progress = 0.8;
    await expect(pending).toHaveAttribute('aria-label', /72%/);
    await expect.poll(() => pendingOpacity(page)).toBeGreaterThan(0.6);
    // пока качается, играть его нельзя
    expect(await page.locator('.slot--current').count()).toBe(0);

    job.state = 'done';
    job.progress = 1;
    await expect(pending).toHaveCount(0);
    await expect(page.locator('.slot')).toHaveCount(9);
    await expect(page.locator('.slot[aria-label^="Кукушка — Кино"]')).toHaveCount(1);
    await expect(page.locator('.status')).toContainText('Добавлено: 1 трек');
    await expect(panel.getByRole('button', { name: 'Показать «Кукушка — Кино» на полке' })).toBeVisible();

    // скачанное — в библиотеке насовсем
    await page.reload();
    await expect(page.locator('.slot')).toHaveCount(9);
    await expect(page.locator('.slot[aria-label^="Кукушка — Кино"]')).toHaveCount(1);
});

test('на полке нашлось — список свёрнут в «Найти в сети»', async ({ page }) => {
    const { calls } = await mockServer(page);
    await withCode(page);
    await page.goto('/');
    await importTracks(page);

    await search(page, 'Кино');
    const panel = page.getByRole('region', { name: 'Скачать из сети' });
    const more = panel.getByRole('button', { name: 'Нет нужного? Найти в сети' });
    await expect(more).toBeVisible();
    await expect(panel.getByRole('listitem')).toHaveCount(0);
    expect(calls.search).toEqual([]);

    await more.click();
    await expect(panel.getByRole('button', { name: 'Скачать «Кукушка — Кино»' })).toBeVisible();
    await expect(panel.getByRole('listitem')).toHaveCount(1);

    await page.getByRole('button', { name: 'Закрыть поиск' }).click();
    await expect(panel).toBeHidden();
});

test('без кода доступа скачивания нет', async ({ page }) => {
    const { calls } = await mockServer(page);
    await page.goto('/');
    await importTracks(page);
    await search(page, 'Кукушка');
    await expect(page.locator('.slot:not(.slot--gone)')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Скачать из сети' })).toBeHidden();
    expect(calls.search).toEqual([]);
});

test('скачать не вышло — заготовка уходит, причина в строке состояния', async ({ page }) => {
    const { job } = await mockServer(page);
    await withCode(page);
    await page.goto('/');
    await importTracks(page);

    job.state = 'running';
    job.progress = 0.3;
    await search(page, 'Кукушка');
    await page.getByRole('button', { name: 'Скачать «Кукушка — Кино»' }).click();
    await expect(page.locator('.slot--pending')).toHaveCount(1);

    job.state = 'error';
    job.error = 'трек не нашёлся на YouTube Music';
    await expect(page.locator('.status')).toContainText('Не удалось скачать «Кукушка»: трек не нашёлся на YouTube Music');
    await expect(page.locator('.slot--pending')).toHaveCount(0);
    await expect(page.locator('.slot')).toHaveCount(8);
    await expect(page.getByRole('button', { name: 'Скачать «Кукушка — Кино»' })).toHaveText('Ещё раз');
});

test('код в настройках: не подошёл, подошёл — так и написано', async ({ page }) => {
    await mockServer(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Полка и настройки' }).click();
    await page.locator('#library-sheet').getByRole('button', { name: 'Настройки' }).click();
    const status = page.locator('#settings-sheet .field:has(#setting-downloadCode) [data-bind="status"]');
    await expect(status).toHaveText('Скачивание выключено: нет кода доступа.');

    await page.getByLabel('Адрес сервера').fill(`${SERVER}/`);
    await page.getByLabel('Адрес сервера').press('Tab');
    // лишний слэш в конце — не повод отказать
    await expect(page.getByLabel('Адрес сервера')).toHaveValue(SERVER);

    await page.getByLabel('Код доступа').fill('wrong');
    await page.getByLabel('Код доступа').press('Tab');
    await expect(status).toHaveText('Код не подошёл — попросите новый у владельца сервера.');

    await page.getByLabel('Код доступа').fill(CODE);
    await page.getByLabel('Код доступа').press('Tab');
    await expect(status).toHaveText('Сервер на связи.');

    await page.getByLabel('Адрес сервера').fill('http://192.168.1.5:8765');
    await page.getByLabel('Адрес сервера').press('Tab');
    await expect(page.locator('#settings-sheet .field:has(#setting-downloadServer) [data-bind="status"]'))
        .toHaveText('Нужен адрес вида https://сервер — без пути.');
});

test('Мак выключен — в поиске так и сказано', async ({ page }) => {
    await mockServer(page, { down: true });
    await withCode(page);
    await page.goto('/');
    await importTracks(page);
    await search(page, 'Кукушка');
    await expect(page.getByRole('region', { name: 'Скачать из сети' }))
        .toContainText('Сервер загрузки недоступен — Мак выключен или нет интернета.');
});
