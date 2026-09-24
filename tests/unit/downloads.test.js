import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Settings } from '../../src/core/Settings.js';
import { DownloadQueue } from '../../src/downloads/DownloadQueue.js';
import { DownloadError, DownloadServer } from '../../src/downloads/DownloadServer.js';

const memoryStore = () => {
    let saved = null;
    return { read: fallback => saved ?? fallback, write: value => { saved = value; } };
};

/**
 * Сервер с подменённым fetch: routes — «путь → ответ», ответ — Response
 * или функция от запроса. Все запросы записываются.
 */
const makeServer = (routes, { code = 'secret' } = {}) => {
    const settings = new Settings({ store: memoryStore() });
    settings.set('downloadCode', code);
    const calls = [];
    const fetch = async (url, init) => {
        const path = url.replace('https://dl.test', '');
        calls.push({ path, init });
        const route = routes[path.split('?')[0]] ?? routes[path];
        if (!route) return new Response('{}', { status: 404 });
        return typeof route === 'function' ? route(path, init) : route.clone();
    };
    const server = new DownloadServer({ settings, fallback: 'https://dl.test', fetch });
    server.attach();
    return { server, settings, calls };
};

const json = (data, status = 200) => new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json' },
});

const RESULT = { id: '4uLU6hMCjMI75M1A2tKUQC', title: 'Группа крови', artist: 'Кино', album: 'Группа крови', duration: 285, cover: null };

test('клиент: код в заголовке, адрес по умолчанию, статус «на связи»', async () => {
    const { server, calls } = makeServer({ '/v1/search': json({ results: [RESULT] }) });
    assert.equal(server.status, 'unknown');
    const results = await server.search('кино группа');
    assert.deepEqual(results, [{ ...RESULT, source: 'spotify' }]);
    assert.equal(calls[0].path, '/v1/search?q=%D0%BA%D0%B8%D0%BD%D0%BE%20%D0%B3%D1%80%D1%83%D0%BF%D0%BF%D0%B0&source=spotify&limit=8');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer secret');
    assert.equal(server.status, 'ok');
});

test('клиент: без кода выключен, 401 — «не подошёл», нет сети — «недоступен»', async () => {
    const off = makeServer({}, { code: '' });
    assert.equal(off.server.enabled, false);
    assert.equal(off.server.status, 'off');
    await assert.rejects(off.server.search('x'), DownloadError);
    assert.equal(off.calls.length, 0, 'без кода в сеть не ходим');

    const rejected = makeServer({ '/v1/health': json({ error: 'unauthorized', message: 'Код доступа не подошёл' }, 401) });
    assert.equal(await rejected.server.check(), 'rejected');

    const settings = new Settings({ store: memoryStore() });
    settings.set('downloadCode', 'secret');
    const offline = new DownloadServer({ settings, fallback: 'https://dl.test', fetch: async () => { throw new TypeError('Failed to fetch'); } });
    const error = await offline.search('x').catch(e => e);
    assert.ok(error instanceof DownloadError && error.offline);
    assert.equal(offline.status, 'offline');

    // сменили код — статус снова «неизвестно», пока не спросим
    rejected.settings.set('downloadCode', 'other');
    assert.equal(rejected.server.status, 'unknown');
});

test('клиент: ошибка сервера — его сообщение, адрес из настроек важнее встроенного', async () => {
    const { server, settings, calls } = makeServer({
        '/v1/downloads': json({ error: 'busy', message: 'Уже качается несколько треков — дождитесь их' }, 429),
    });
    await assert.rejects(server.start(RESULT), { message: 'Уже качается несколько треков — дождитесь их' });
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.body, JSON.stringify({ source: 'spotify', id: RESULT.id }));

    settings.set('downloadServer', 'http://127.0.0.1:8765');
    assert.equal(server.url, 'http://127.0.0.1:8765');
});

test('клиент: файл читается потоком — с прогрессом и именем', async () => {
    const bytes = new Uint8Array(1000).fill(7);
    const body = new ReadableStream({
        start(controller) {
            controller.enqueue(bytes.slice(0, 400));
            controller.enqueue(bytes.slice(400));
            controller.close();
        },
    });
    const { server } = makeServer({
        '/v1/downloads/job1/file': () => new Response(body, { headers: {
            'Content-Type': 'audio/mp4', 'Content-Length': '1000',
            'X-Filename': encodeURIComponent('Кино - Группа крови.m4a'),
        } }),
    });
    const seen = [];
    const file = await server.file('job1', fraction => seen.push(fraction));
    assert.equal(file.name, 'Кино - Группа крови.m4a');
    assert.equal(file.type, 'audio/mp4');
    assert.equal(file.size, 1000);
    assert.deepEqual(seen, [0.4, 1, 1]);
});

/** Поддельный сервер для очереди: задание проходит заданные состояния. */
const fakeServer = (states, { file = new File(['x'], 'a.m4a', { type: 'audio/mp4' }), fail = null } = {}) => {
    let polls = 0;
    return {
        polls: () => polls,
        start: async () => ({ id: 'job', ...states[0] }),
        job: async () => {
            polls++;
            if (fail?.(polls)) throw fail(polls);
            return { id: 'job', ...states[Math.min(polls, states.length - 1)] };
        },
        file: async (_, onProgress) => { onProgress(0.5); onProgress(1); return file; },
    };
};

const run = queue => new Promise(resolve => {
    queue.on('done', detail => resolve({ type: 'done', ...detail }));
    queue.on('failed', detail => resolve({ type: 'failed', ...detail }));
});

test('очередь: прогресс только растёт до 1, в конце — файл', async () => {
    const server = fakeServer([
        { state: 'queued', progress: 0, stage: 'В очереди' },
        { state: 'running', progress: 0.4, stage: 'Качаю' },
        { state: 'running', progress: 0.3, stage: 'Качаю' },     // сервер «откатился»
        { state: 'running', progress: 0.95, stage: 'Записываю теги' },
        { state: 'done', progress: 1, stage: 'Готово' },
    ]);
    const queue = new DownloadQueue({ server: /** @type {any} */ (server), sleep: async () => {} });
    const progress = [];
    queue.on('progress', ({ progress: value }) => progress.push(value));
    const added = [];
    queue.on('added', detail => added.push(detail));

    const finished = run(queue);
    const id = queue.start(RESULT);
    assert.equal(added[0].id, id);
    assert.equal(queue.start(RESULT), id, 'второе нажатие не запускает второе скачивание');

    const result = await finished;
    assert.equal(result.type, 'done');
    assert.equal(result.id, id);
    assert.equal(result.file.name, 'a.m4a');
    assert.deepEqual(progress, [...progress].sort((a, b) => a - b), 'только растёт');
    assert.equal(progress.at(-1), 1);
    assert.ok(progress.includes(0.9 * 0.95), 'серверная часть — 90%');
    assert.equal(queue.stateOf(RESULT.id)?.state, 'done');
    assert.equal(queue.active, 0);
});

test('очередь: ошибка задания — «failed» с текстом сервера, опрос останавливается', async () => {
    const server = fakeServer([
        { state: 'running', progress: 0.1, stage: 'Ищу трек' },
        { state: 'error', progress: 0.1, stage: 'Ошибка', error: 'трек не нашёлся на YouTube Music' },
    ]);
    const queue = new DownloadQueue({ server: /** @type {any} */ (server), sleep: async () => {} });
    const result = await (() => { const done = run(queue); queue.start(RESULT); return done; })();
    assert.equal(result.type, 'failed');
    assert.equal(result.message, 'трек не нашёлся на YouTube Music');
    assert.equal(server.polls(), 1);
    // после ошибки можно ещё раз — новое скачивание
    assert.equal(queue.stateOf(RESULT.id)?.state, 'failed');
});

test('очередь: сеть моргнула — прощаем, пропала надолго — сдаёмся', async () => {
    const offline = new DownloadError('Сервер загрузки недоступен', { offline: true });
    const blink = fakeServer(
        [{ state: 'running', progress: 0.2, stage: 'Качаю' }, { state: 'running', progress: 0.5, stage: 'Качаю' }, { state: 'done', progress: 1, stage: 'Готово' }],
        { fail: polls => (polls <= 2 ? offline : null) },
    );
    const queue = new DownloadQueue({ server: /** @type {any} */ (blink), sleep: async () => {} });
    const ok = await (() => { const done = run(queue); queue.start(RESULT); return done; })();
    assert.equal(ok.type, 'done');

    const gone = fakeServer([{ state: 'running', progress: 0.2, stage: 'Качаю' }], { fail: () => offline });
    const lost = new DownloadQueue({ server: /** @type {any} */ (gone), sleep: async () => {} });
    const failed = await (() => { const done = run(lost); lost.start(RESULT); return done; })();
    assert.equal(failed.type, 'failed');
    assert.equal(failed.message, 'Сервер загрузки недоступен');
});

test('клиент: источник в поиске и скачивании, ссылка для прослушивания', async () => {
    const { server, calls } = makeServer({
        '/v1/search': json({ results: [{ ...RESULT, id: 'dQw4w9WgXcQ', source: 'youtube' }] }),
        '/v1/downloads': json({ id: 'job', state: 'queued', progress: 0, stage: '' }, 202),
        '/v1/previews': json({ url: '/v1/preview/abc.def' }),
    });
    const [video] = await server.search('кино', { source: 'youtube' });
    assert.match(calls[0].path, /&source=youtube&/);
    assert.equal(video.source, 'youtube');

    await server.start(video);
    assert.equal(calls[1].init.body, JSON.stringify({ source: 'youtube', id: 'dQw4w9WgXcQ' }));
    // старые результаты без источника — это Spotify
    await server.start({ ...RESULT, source: undefined });
    assert.equal(calls[2].init.body, JSON.stringify({ source: 'spotify', id: RESULT.id }));

    assert.equal(await server.preview(video), 'https://dl.test/v1/preview/abc.def');
});

test('клиент: долгий ответ — «долго не отвечает», а не «Мак выключен»', async () => {
    const settings = new Settings({ store: memoryStore() });
    settings.set('downloadCode', 'secret');
    // fetch, который ждёт, пока его не отменят по таймауту
    const hanging = (_, init) => new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason));
    });
    const server = new DownloadServer({ settings, fallback: 'https://dl.test', fetch: hanging });
    const realTimeout = AbortSignal.timeout;
    AbortSignal.timeout = () => realTimeout.call(AbortSignal, 5);
    // таймер AbortSignal.timeout не держит процесс — держим сами, пока ждём
    const keepAlive = setInterval(() => {}, 1000);
    try {
        const error = await server.search('кино').catch(e => e);
        assert.ok(error instanceof DownloadError);
        assert.equal(error.timeout, true);
        assert.equal(error.offline, false);
        assert.equal(error.message, 'Сервер долго не отвечает');
        assert.notEqual(server.status, 'offline');
    } finally {
        AbortSignal.timeout = realTimeout;
        clearInterval(keepAlive);
    }
});

test('клиент: код ошибки сервера доступен — устаревший поиск можно отличить', async () => {
    const { server } = makeServer({ '/v1/search': json({ error: 'superseded', message: 'Запрос устарел' }, 409) });
    const error = await server.search('mi').catch(e => e);
    assert.equal(error.code, 'superseded');
    assert.equal(error.status, 409);
});

/** Поддельный <audio>: запоминает src, события шлёт тест. */
class FakeAudio extends EventTarget {
    src = '';
    paused = true;
    preload = '';
    getAttribute(name) { return name === 'src' ? this.src : null; }
    removeAttribute() { this.src = ''; }
    load() {}
    play() { this.paused = false; return Promise.resolve(); }
    pause() { if (!this.paused) { this.paused = true; this.dispatchEvent(new Event('pause')); } }
}

test('предпрослушивание: грузится → играет → стоп; второе нажатие останавливает', async () => {
    const { PreviewPlayer } = await import('../../src/downloads/PreviewPlayer.js');
    const audio = new FakeAudio();
    let resolve;
    const server = { preview: () => new Promise(r => { resolve = r; }) };
    const player = new PreviewPlayer({ server: /** @type {any} */ (server), createAudio: () => /** @type {any} */ (audio) });
    const states = [];
    player.on('state', ({ result, state }) => states.push(`${result?.id}:${state}`));

    player.toggle(RESULT);
    assert.equal(player.stateOf(RESULT.id), 'loading');
    assert.match(audio.src, /^blob:/, 'в том же нажатии элемент «отперт» тишиной');
    audio.dispatchEvent(new Event('playing'));                  // это играет тишина — не в счёт
    assert.equal(player.stateOf(RESULT.id), 'loading');

    resolve('https://dl.test/v1/preview/t');
    await new Promise(r => setTimeout(r, 0));
    assert.equal(audio.src, 'https://dl.test/v1/preview/t');
    audio.dispatchEvent(new Event('playing'));
    assert.equal(player.stateOf(RESULT.id), 'playing');

    player.toggle(RESULT);
    assert.equal(player.stateOf(RESULT.id), 'stopped');
    assert.equal(audio.src, '');
    assert.deepEqual(states, [`${RESULT.id}:loading`, `${RESULT.id}:playing`, `${RESULT.id}:stopped`]);
});

test('предпрослушивание: ошибка сервера — состояние error с текстом', async () => {
    const { PreviewPlayer } = await import('../../src/downloads/PreviewPlayer.js');
    const server = { preview: async () => { throw new DownloadError('Трек не нашёлся на YouTube Music'); } };
    const player = new PreviewPlayer({ server: /** @type {any} */ (server), createAudio: () => /** @type {any} */ (new FakeAudio()) });
    const failed = new Promise(r => player.on('state', detail => { if (detail.state === 'error') r(detail); }));
    player.play(RESULT);
    const detail = await failed;
    assert.equal(detail.message, 'Трек не нашёлся на YouTube Music');
    assert.equal(detail.result.id, RESULT.id);
    assert.equal(player.current, null);
});
