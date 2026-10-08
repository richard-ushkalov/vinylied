import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DailyMix, dayOf, mergeMix, pickSeeds } from '../../src/discover/DailyMix.js';
import { LastFmClient, LastFmError, interleave, toSuggestion } from '../../src/discover/LastFmClient.js';
import { PlayHistory } from '../../src/discover/PlayHistory.js';
import { resolveTrack, sameTrack } from '../../src/discover/resolve.js';
import { DownloadError } from '../../src/downloads/DownloadServer.js';
import { norm } from '../../src/lookup/Matcher.js';

const memoryStore = (initial = null) => {
    let saved = initial;
    return { read: fallback => saved ?? fallback, write: value => { saved = structuredClone(value); }, clear() { saved = null; } };
};

/** @param {string} artist @param {string} title */
const song = (artist, title, duration = 200) => ({ name: title, artist: { name: artist }, duration: String(duration) });
/** @param {string} artist @param {string} title */
const suggestion = (artist, title) => /** @type {any} */ (toSuggestion(song(artist, title)));

/**
 * Last.fm на подменённом fetch: answers — «метод → ответ или функция от
 * параметров». Запросы записываются.
 */
const makeLastFm = answers => {
    const calls = [];
    const fetch = async url => {
        const params = new URL(url).searchParams;
        calls.push(params);
        const answer = answers[params.get('method')];
        const data = typeof answer === 'function' ? answer(params) : answer ?? { error: 6, message: 'not found' };
        if (data instanceof Error) throw data;
        return new Response(JSON.stringify(data), { status: data.error ? 400 : 200 });
    };
    return { client: new LastFmClient({ key: 'k'.repeat(32), fetch, interval: 0 }), calls };
};

const similarTo = (...pairs) => ({ similartracks: { track: pairs.map(([artist, title]) => song(artist, title)) } });

// ── Last.fm ───────────────────────────────────────────────────

test('Last.fm: похожие треки — названия, исполнители, секунды и ключ', async () => {
    const { client, calls } = makeLastFm({
        'track.getSimilar': similarTo(['Кино', 'Кукушка'], ['Наутилус Помпилиус', 'Прогулки по воде'],
            ['ДДТ', 'Осень'], ['Сплин', 'Выхода нет'], ['Аквариум', 'Город золотой']),
    });
    const items = await client.similar({ artist: 'Кино', title: 'Группа крови' });
    assert.equal(items.length, 5);
    assert.deepEqual(items[1], {
        key: 'наутилуспомпилиус|прогулкиповоде', title: 'Прогулки по воде', artist: 'Наутилус Помпилиус',
        album: '', duration: 200, cover: null,
    });
    const params = calls[0];
    assert.equal(params.get('artist'), 'Кино');
    assert.equal(params.get('track'), 'Группа крови');
    assert.equal(params.get('autocorrect'), '1');
    assert.equal(params.get('format'), 'json');
    assert.equal(calls.length, 1, 'хватило — по исполнителю не добираем');
});

test('Last.fm: новый трек без похожих — добор по похожим исполнителям, вперемешку', async () => {
    const { client, calls } = makeLastFm({
        'track.getSimilar': similarTo(['Muse', 'Starlight']),
        'artist.getSimilar': { similarartists: { artist: [{ name: 'Radiohead' }, { name: 'Placebo' }] } },
        'artist.getTopTracks': params => ({
            toptracks: { track: params.get('artist') === 'Radiohead'
                ? [song('Radiohead', 'Creep'), song('Radiohead', 'Karma Police')]
                : [song('Placebo', 'Every You Every Me'), song('Muse', 'Starlight')] },
        }),
    });
    const items = await client.similar({ artist: 'Muse', title: 'New Song' });
    assert.deepEqual(items.map(item => item.title), ['Starlight', 'Creep', 'Every You Every Me', 'Karma Police'],
        'свой — первым, дальше по очереди от исполнителей, без повторов');
    assert.deepEqual(calls.map(params => params.get('method')),
        ['track.getSimilar', 'artist.getSimilar', 'artist.getTopTracks', 'artist.getTopTracks']);
});

test('Last.fm: «не знаю» — пусто; ключ, лимит и сеть — понятные ошибки', async () => {
    const unknown = makeLastFm({});
    assert.deepEqual(await unknown.client.similar({ artist: 'Никто', title: 'Ничто' }), []);

    const badKey = makeLastFm({ 'track.getSimilar': { error: 10, message: 'Invalid API key' } });
    await assert.rejects(badKey.client.similar({ artist: 'a', title: 'b' }),
        error => error instanceof LastFmError && error.code === 'key' && error.message === 'Ключ Last.fm не подошёл');

    const busy = makeLastFm({ 'track.getSimilar': { error: 29, message: 'Rate limit' } });
    await assert.rejects(busy.client.similar({ artist: 'a', title: 'b' }), { code: 'busy' });

    const offline = makeLastFm({ 'track.getSimilar': new TypeError('Failed to fetch') });
    await assert.rejects(offline.client.similar({ artist: 'a', title: 'b' }), { code: 'offline' });

    const keyless = new LastFmClient({ key: '', fetch: async () => { throw new Error('не должен ходить'); } });
    assert.equal(keyless.enabled, false);
    await assert.rejects(keyless.similar({ artist: 'a', title: 'b' }), { code: 'key' });
});

test('Last.fm: один элемент приходит объектом — тоже список', async () => {
    const { client } = makeLastFm({
        'track.getSimilar': { similartracks: { track: song('ДДТ', 'Осень') } },
        'artist.getSimilar': { similarartists: { artist: { name: 'ДДТ' } } },
    });
    const items = await client.similar({ artist: 'Кино', title: 'Звезда' });
    assert.deepEqual(items.map(item => item.title), ['Осень']);
    assert.equal(interleave([[1, 3], [2]]).join(), '1,2,3');
});

// ── звук по названию ──────────────────────────────────────────

/** Сервер поиска: answers[source] — список или ошибка (или функция). */
const searchServer = answers => {
    const calls = [];
    return {
        calls,
        search: async (query, { source }) => {
            calls.push(`${source}:${query}`);
            const answer = typeof answers[source] === 'function' ? answers[source]() : answers[source];
            if (answer instanceof Error) throw answer;
            return answer ?? [];
        },
    };
};

const ITEM = { ...suggestion('Muse', 'Starlight'), duration: 240 };
const spotify = (title, artist, duration = 240) => ({ id: `s-${title}`, source: 'spotify', title, artist, album: '', duration, cover: null });
const video = (title, artist) => ({ id: `y-${title}`, source: 'youtube', title, artist, album: '', duration: 0, cover: null });

test('звук: в Spotify — тот же трек, а не первый попавшийся', async () => {
    const server = searchServer({ spotify: [spotify('Starlight (Live)', 'Someone Else'), spotify('Starlight', 'Muse'), spotify('Starlight', 'Muse', 300)] });
    const result = await resolveTrack(/** @type {any} */ (server), ITEM);
    assert.equal(result.id, 's-Starlight');
    assert.deepEqual(server.calls, ['spotify:Muse Starlight']);
    assert.equal(sameTrack(spotify('Starlight', 'Muse', 300), ITEM), false, 'другая длительность — другая версия');
});

test('звук: в Spotify нет или он сломан — YouTube; Мака нет — сразу ошибка', async () => {
    const missing = searchServer({
        spotify: [spotify('Something Else', 'Muse')],
        youtube: [video('Starlight piano cover', 'Someone'), video('Muse - Starlight (Official Video)', 'Muse')],
    });
    assert.equal((await resolveTrack(/** @type {any} */ (missing), ITEM)).id, 'y-Muse - Starlight (Official Video)');

    const broken = searchServer({
        spotify: new DownloadError('Spotify не ответил на поиск', { status: 502, code: 'engine' }),
        youtube: [video('Starlight', 'Muse - Topic')],
    });
    assert.equal((await resolveTrack(/** @type {any} */ (broken), ITEM)).source, 'youtube');

    const offline = searchServer({ spotify: new DownloadError('Сервер загрузки недоступен', { offline: true }) });
    await assert.rejects(resolveTrack(/** @type {any} */ (offline), ITEM), { offline: true });
    assert.deepEqual(offline.calls, ['spotify:Muse Starlight'], 'на YouTube уже не идём');

    const nothing = searchServer({ spotify: [], youtube: [] });
    await assert.rejects(resolveTrack(/** @type {any} */ (nothing), ITEM), /ни в Spotify, ни на YouTube/);
});

test('звук: поиск вытеснили поиском из строки — повторяем один раз', async () => {
    let first = true;
    const server = searchServer({
        spotify: () => {
            if (!first) return [spotify('Starlight', 'Muse')];
            first = false;
            throw new DownloadError('Запрос устарел', { status: 409, code: 'superseded' });
        },
    });
    const waits = [];
    const result = await resolveTrack(/** @type {any} */ (server), ITEM, { wait: async ms => { waits.push(ms); } });
    assert.equal(result.id, 's-Starlight');
    assert.equal(server.calls.length, 2);
    assert.equal(waits.length, 1);
});

// ── микс дня ──────────────────────────────────────────────────

const shelf = [
    { id: '1', artist: 'Кино', title: 'Группа крови' },
    { id: '2', artist: 'Кино', title: 'Кукушка' },
    { id: '3', artist: 'Muse', title: 'Starlight' },
    { id: '4', artist: 'Radiohead', title: 'Creep' },
    { id: '5', artist: '', title: 'Без исполнителя' },
    { id: '6', artist: 'Земфира', title: 'Искала' },
    { id: '7', artist: 'Сплин', title: 'Выхода нет' },
    { id: '8', artist: 'Би-2', title: 'Полковнику никто не пишет' },
    { id: '9', artist: 'ДДТ', title: 'Осень' },
];

test('семена: в один день одни и те же, в другой — другие; без исполнителя и повторов', () => {
    const today = pickSeeds(shelf, { day: '2026-10-08' });
    assert.deepEqual(pickSeeds(shelf, { day: '2026-10-08' }), today, 'один день — одна выборка');
    assert.equal(today.length, 5);
    assert.ok(today.every(track => track.artist), 'без исполнителя не берём');
    assert.equal(new Set(today.map(track => track.artist)).size, 5, 'один трек на исполнителя');

    const days = ['2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12']
        .map(day => pickSeeds(shelf, { day }).map(track => track.id).join());
    assert.ok(days.some(ids => ids !== today.map(track => track.id).join()), 'дни различаются');
});

test('семена: недавно игранные — в первую очередь', () => {
    const seeds = pickSeeds(shelf, { day: '2026-10-08', recent: ['9', '8', '5'] });
    const ids = seeds.map(track => track.id);
    assert.ok(ids.includes('9') && ids.includes('8'), 'оба недавних с исполнителем — в семенах');
    assert.ok(!ids.includes('5'));
});

test('микс: по очереди из каждого списка, без повторов и того, что на полке', () => {
    const a = [suggestion('A', '1'), suggestion('A', '2'), suggestion('A', '3')];
    const b = [suggestion('B', '1'), suggestion('A', '1'), suggestion('B', '2')];
    const onShelf = new Set([suggestion('B', '2').key]);
    const mix = mergeMix([a, b], { limit: 4, isOnShelf: item => onShelf.has(item.key) });
    assert.deepEqual(mix.map(item => `${item.artist}${item.title}`), ['A1', 'B1', 'A2', 'A3']);
});

test('микс дня: собирается раз в день, повтор — из памяти; «Собрать заново» — заново', async () => {
    const { client, calls } = makeLastFm({
        'track.getSimilar': params => similarTo(
            [`${params.get('artist')} fan`, 'One'], [`${params.get('artist')} fan`, 'Two'],
            ['Shared', 'Hit'], ['Кино', 'Кукушка'], [`${params.get('artist')} fan`, 'Three']),
    });
    const store = memoryStore();
    let day = '2026-10-08';
    const keys = new Set(shelf.map(track => `${norm(track.artist)}|${norm(track.title)}`));
    const covers = [];
    const mix = new DailyMix({
        lastfm: client,
        tracks: () => shelf,
        history: new PlayHistory({ store: memoryStore() }),
        isOnShelf: item => keys.has(item.key),
        cover: async item => { covers.push(item.key); return `https://img.test/${item.key}.jpg`; },
        store: /** @type {any} */ (store),
        today: () => day,
    });

    const first = await mix.get();
    assert.equal(first.day, '2026-10-08');
    assert.equal(first.seeds.length, 5);
    assert.equal(calls.length, 5, 'по запросу на семя');
    assert.ok(!first.items.some(item => item.key === suggestion('Кино', 'Кукушка').key), 'что на полке — не советуем');
    assert.equal(first.items.filter(item => item.title === 'Hit').length, 1, 'общий совет — один раз');

    assert.equal((await mix.get()).built, first.built, 'тот же день — из памяти');
    assert.equal(calls.length, 5);

    await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(covers.length > 0, 'обложки подтягиваются после');
    assert.ok(mix.current?.items.some(item => item.cover?.startsWith('https://img.test/')), 'и сохраняются');

    day = '2026-10-09';
    assert.equal(mix.current, null, 'новый день — вчерашний микс не годится');
    const next = await mix.get();
    assert.equal(next.day, '2026-10-09');
    assert.equal(calls.length, 10);
});

test('микс дня: ключ не подошёл — ошибка, а не пустой микс', async () => {
    const { client } = makeLastFm({ 'track.getSimilar': { error: 10, message: 'Invalid API key' } });
    const mix = new DailyMix({
        lastfm: client, tracks: () => shelf, history: new PlayHistory({ store: memoryStore() }),
        isOnShelf: () => false, store: /** @type {any} */ (memoryStore()), today: () => '2026-10-08',
    });
    await assert.rejects(mix.get(), { code: 'key' });
    assert.equal(mix.current, null);
});

test('история: свежие первыми, без повторов, не длиннее лимита', () => {
    const store = memoryStore();
    const plays = new PlayHistory({ store: /** @type {any} */ (store), limit: 3 });
    for (const id of ['a', 'b', 'a', 'c', 'd']) plays.add(id);
    assert.deepEqual(plays.recent, ['d', 'c', 'a']);
    assert.deepEqual(new PlayHistory({ store: /** @type {any} */ (store) }).recent, ['d', 'c', 'a'], 'переживает перезапуск');
    assert.match(dayOf(new Date(2026, 0, 5)), /^2026-01-05$/);
});
