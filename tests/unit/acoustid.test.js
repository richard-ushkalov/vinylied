import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AcoustIdClient } from '../../src/lookup/AcoustIdClient.js';
import { NetworkError } from '../../src/lookup/http.js';

const RESULTS = [
    { id: 'low', score: 0.4, recordings: [{ id: 'r0', title: 'Wrong', artists: [{ name: 'X' }] }] },
    {
        id: 'good', score: 0.93,
        recordings: [{
            id: 'rec-1', title: 'Группа крови',
            artists: [{ name: 'Кино' }],
            releasegroups: [
                { id: 'rg-live', title: 'Концерт', type: 'Album', secondarytypes: ['Live'] },
                { id: 'rg-album', title: 'Группа крови', type: 'Album' },
                { id: 'rg-single', title: 'Группа крови', type: 'Single' },
            ],
        }],
    },
];

test('pickBest: самый уверенный результат и студийный альбом', () => {
    const best = AcoustIdClient.pickBest(RESULTS);
    assert.deepEqual(best, {
        title: 'Группа крови', artist: 'Кино', album: 'Группа крови',
        releaseGroupId: 'rg-album', recordingId: 'rec-1', score: 0.93,
    });
});

test('pickBest: ниже порога — ничего', () => {
    assert.equal(AcoustIdClient.pickBest([RESULTS[0]]), null);
    assert.equal(AcoustIdClient.pickBest([]), null);
});

test('pickBest: соавторы склеиваются через joinphrase', () => {
    const best = AcoustIdClient.pickBest([{
        id: 'x', score: 0.9,
        recordings: [{ id: 'r', title: 'Song', artists: [{ name: 'A', joinphrase: ' feat. ' }, { name: 'B' }] }],
    }]);
    assert.equal(best?.artist, 'A feat. B');
    assert.equal(best?.album, '');
});

const json = body => async () => ({ json: async () => body });

test('lookup: обычный ответ', async () => {
    const client = new AcoustIdClient({ key: 'k', fetch: json({ status: 'ok', results: RESULTS }) });
    assert.equal((await client.lookup({ fingerprint: 'AQ', duration: 200 })).length, 2);
});

test('lookup: неверный ключ выключает распознавание, а не зацикливает', async () => {
    const client = new AcoustIdClient({ key: 'bad', fetch: json({ status: 'error', error: { code: 4, message: 'invalid API key' } }) });
    assert.equal(client.enabled, true);
    assert.deepEqual(await client.lookup({ fingerprint: 'AQ', duration: 200 }), []);
    assert.equal(client.enabled, false);
});

test('lookup: CORS не пустил — идём через JSONP', async () => {
    let jsonpUrl = '';
    const client = new AcoustIdClient({
        key: 'k',
        fetch: async () => { throw new TypeError('Failed to fetch'); },
        jsonp: async url => { jsonpUrl = url; return { status: 'ok', results: [] }; },
    });
    await client.lookup({ fingerprint: 'AQ+/', duration: 100.4 });
    assert.match(jsonpUrl, /format=jsonp/);
    assert.match(jsonpUrl, /duration=100/);
    assert.match(jsonpUrl, /fingerprint=AQ%2B%2F/);
});

test('lookup: прочая ошибка сервиса — «попробовать позже»', async () => {
    const client = new AcoustIdClient({ key: 'k', fetch: json({ status: 'error', error: { code: 14, message: 'rate limit' } }) });
    await assert.rejects(client.lookup({ fingerprint: 'AQ', duration: 1 }), NetworkError);
});

test('статус ключа: нет → задан → работает; отказ до смены ключа', async () => {
    let reply = { status: 'ok', results: [] };
    const client = new AcoustIdClient({ key: '', fetch: async () => ({ json: async () => reply }) });
    const seen = [];
    client.on('status', ({ status }) => seen.push(status));

    assert.equal(client.status, 'missing');
    client.setKey('AppKey01');
    assert.equal(client.status, 'unverified');
    await client.lookup({ fingerprint: 'AQ', duration: 10 });
    assert.equal(client.status, 'ok');

    reply = { status: 'error', error: { code: 4, message: 'invalid API key' } };
    client.setKey('UserKey123');
    await client.lookup({ fingerprint: 'AQ', duration: 10 });
    assert.equal(client.status, 'rejected');
    assert.equal(client.enabled, false);

    // новый ключ — прежний отказ к нему не относится
    client.setKey('AppKey02');
    assert.equal(client.status, 'unverified');
    assert.deepEqual(seen, ['unverified', 'ok', 'unverified', 'rejected', 'unverified']);
});
