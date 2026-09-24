import { expect, test } from '@playwright/test';
import { makeId3, makeWav } from '../fixtures/make-fixtures.mjs';
import { importTracks, mockServices, PNG, state, togglePlay } from './helpers.js';

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
const VIDEO = { id: 'dQw4w9WgXcQ', source: 'youtube', title: 'Кино — Кукушка (live 1990)', artist: 'Кино Official',
                album: '', duration: 20, cover: 'https://i.example.test/video.jpg' };

const FILE = makeWav({ seconds: 20, frequency: 523,
    id3: makeId3({ title: 'Кукушка', artist: 'Кино', album: 'Чёрный альбом', cover: PNG }) });

/**
 * @param {import('@playwright/test').Page} page
 * @param {{ results?: object[], health?: number, down?: boolean }} [options]
 */
const mockServer = async (page, { results = [KUKUSHKA, GRUPPA], health = 200, down = false } = {}) => {
    const job = { id: 'a'.repeat(32), state: 'queued', progress: 0, stage: 'В очереди', error: undefined };
    const calls = { search: [], start: [], previews: [], streamed: 0, failSearch: 0 };
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
        // плеер ходит по ссылке без заголовка: пропуск — сам токен в адресе
        const tokenOnly = url.pathname.startsWith('/v1/preview/');
        if (!tokenOnly && (request.headers().authorization !== `Bearer ${CODE}` || health === 401)) {
            return reply({ error: 'unauthorized', message: 'Код доступа не подошёл' }, 401);
        }
        switch (url.pathname) {
            case '/v1/health': return reply({ ok: true, version: '1.0.0', spotdl: '4.5.2', active: 0 });
            case '/v1/search':
                calls.search.push(`${url.searchParams.get('source')}:${url.searchParams.get('q')}`);
                if (calls.failSearch > 0) {
                    calls.failSearch--;
                    return reply({ error: 'engine', message: 'Spotify не ответил на поиск' }, 502);
                }
                return reply({ results: url.searchParams.get('source') === 'youtube' ? [VIDEO] : results });
            case '/v1/downloads':
                calls.start.push(request.postDataJSON());
                return reply({ ...job }, 202);
            case '/v1/previews':
                calls.previews.push(request.postDataJSON());
                return reply({ url: '/v1/preview/tok.sig' });
            case '/v1/preview/tok.sig':
                calls.streamed++;
                return route.fulfill({ status: 200, body: FILE, headers: { ...cors, 'content-type': 'audio/wav' } });
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
    await expect(panel.getByRole('button', { name: /^Добавить/ })).toHaveCount(1);
    expect(calls.search).toEqual(['spotify:Кукушка']);

    job.state = 'running';
    job.progress = 0.2;
    job.stage = 'Качаю';
    await panel.getByRole('button', { name: 'Добавить «Кукушка — Кино»' }).click();
    expect(calls.start).toEqual([{ source: 'spotify', id: KUKUSHKA.id }]);

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
    await expect(panel.getByRole('button', { name: 'Добавить «Кукушка — Кино»' })).toBeVisible();
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
    await page.getByRole('button', { name: 'Добавить «Кукушка — Кино»' }).click();
    await expect(page.locator('.slot--pending')).toHaveCount(1);

    job.state = 'error';
    job.error = 'трек не нашёлся на YouTube Music';
    await expect(page.locator('.status')).toContainText('Не удалось скачать «Кукушка»: трек не нашёлся на YouTube Music');
    await expect(page.locator('.slot--pending')).toHaveCount(0);
    await expect(page.locator('.slot')).toHaveCount(8);
    await expect(page.getByRole('button', { name: 'Добавить «Кукушка — Кино»' })).toHaveText('Ещё раз');
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

test('вкладка YouTube: ролики с превью, «Добавить», вкладка запоминается', async ({ page }) => {
    const { job, calls } = await mockServer(page);
    await withCode(page);
    await page.goto('/');
    await importTracks(page);

    await search(page, 'Кукушка');
    const panel = page.getByRole('region', { name: 'Скачать из сети' });
    await expect(panel.getByRole('button', { name: 'Добавить «Кукушка — Кино»' })).toBeVisible();
    await panel.locator('label', { hasText: 'YouTube' }).click();
    const name = 'Кино — Кукушка (live 1990) — Кино Official';
    await expect(panel.getByRole('link', { name: `Открыть «${name}» на YouTube` }))
        .toHaveAttribute('href', `https://www.youtube.com/watch?v=${VIDEO.id}`);
    expect(calls.search).toEqual(['spotify:Кукушка', 'youtube:Кукушка']);

    job.state = 'done';
    job.progress = 1;
    await panel.getByRole('button', { name: `Добавить «${name}»` }).click();
    expect(calls.start).toEqual([{ source: 'youtube', id: VIDEO.id }]);
    await expect(page.locator('.slot')).toHaveCount(9);
    await expect(panel.getByRole('button', { name: `Показать «${name}» на полке` })).toBeVisible();

    await page.reload();
    await search(page, 'Кукушка');
    await expect(page.locator('.suggest__tabs input[value="youtube"]')).toBeChecked();
});

test('▶ слушать до добавления: полка на паузу, стоп возвращает как было', async ({ page }) => {
    const { calls } = await mockServer(page);
    await withCode(page);
    await page.goto('/');
    await importTracks(page);
    await togglePlay(page);
    await expect.poll(() => state(page)).toMatchObject({ playing: true });

    await search(page, 'Кукушка');
    const panel = page.getByRole('region', { name: 'Скачать из сети' });
    await panel.getByRole('button', { name: 'Послушать «Кукушка — Кино»' }).click();
    const stop = panel.getByRole('button', { name: 'Остановить «Кукушка — Кино»' });
    await expect(stop).toHaveAttribute('aria-pressed', 'true');
    expect(calls.previews).toEqual([{ source: 'spotify', id: KUKUSHKA.id }]);
    await expect.poll(() => calls.streamed).toBeGreaterThan(0);
    // полка замолчала, на полку ничего не легло
    await expect.poll(() => state(page)).toMatchObject({ playing: false });
    await expect(page.locator('.slot')).toHaveCount(8);

    await stop.click();
    await expect(panel.getByRole('button', { name: 'Послушать «Кукушка — Кино»' })).toHaveAttribute('aria-pressed', 'false');
});

test('поиск не удался — «Искать ещё раз» ищет заново', async ({ page }) => {
    const { calls } = await mockServer(page);
    calls.failSearch = 1;
    await withCode(page);
    await page.goto('/');
    await importTracks(page);

    await search(page, 'Кукушка');
    const panel = page.getByRole('region', { name: 'Скачать из сети' });
    await expect(panel).toContainText('Spotify не ответил на поиск');
    await panel.getByRole('button', { name: 'Искать ещё раз' }).click();
    await expect(panel.getByRole('button', { name: 'Добавить «Кукушка — Кино»' })).toBeVisible();
    expect(calls.search).toEqual(['spotify:Кукушка', 'spotify:Кукушка']);
});

test('набор по буквам — один запрос к серверу; Enter ищет сразу', async ({ page }) => {
    const { calls } = await mockServer(page);
    await withCode(page);
    await page.goto('/');
    await importTracks(page);

    await page.getByRole('button', { name: 'Поиск по полке' }).click();
    const box = page.getByRole('searchbox', { name: 'Поиск по полке' });
    await box.pressSequentially('michael jackson you are not alone', { delay: 40 });
    await expect.poll(() => calls.search.length).toBe(1);
    await page.waitForTimeout(900);
    expect(calls.search).toEqual(['spotify:michael jackson you are not alone']);

    await box.fill('Кукушка');
    await box.press('Enter');
    // без паузы в 600 мс — запрос уходит сразу
    await expect.poll(() => calls.search.length, { timeout: 400 }).toBe(2);
});
