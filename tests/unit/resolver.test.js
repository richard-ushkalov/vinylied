import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MetadataResolver } from '../../src/lookup/MetadataResolver.js';
import { NetworkError } from '../../src/lookup/http.js';

const image = new Blob(['img'], { type: 'image/jpeg' });

const record = (tags, name = 'file.mp3') => ({
    name, file: new Blob(['audio']), tags: { title: '', artist: '', album: '', ...tags },
});

const itunes = responses => ({
    queries: [],
    async search(term, entity) {
        this.queries.push(`${entity}:${term}`);
        const next = responses.shift();
        if (next instanceof Error) throw next;
        return next ?? [];
    },
});

const make = ({ acoustEnabled = false, lookup = [], fingerprint, responses = [], cover = null } = {}) => new MetadataResolver({
    acoustId: { enabled: acoustEnabled, lookup: async () => lookup },
    fingerprinter: { fingerprint: fingerprint ?? (async () => ({ fingerprint: 'AQ', duration: 100 })) },
    itunes: itunes(responses),
    coverArt: { front: async () => cover },
    fetchImage: async () => image,
});

const song = (trackName, artistName, collectionName = 'Album - Single') => ({
    trackName, artistName, collectionName, artworkUrl100: 'https://x/100x100bb.jpg',
});

test('по тегам: совпали название и исполнитель — берём подписи сайта', async () => {
    const resolver = make({ responses: [[song('Wrong', 'Other'), song('Группа крови (Remastered)', 'Кино')]] });
    const { match, usedAcoustId } = await resolver.resolve(record({ title: 'Группа крови', artist: 'Кино' }));
    assert.equal(usedAcoustId, false);
    assert.equal(match?.title, 'Группа крови (Remastered)');
    assert.equal(match?.album, 'Album');      // «- Single» отрезан
    assert.equal(match?.cover, image);
    assert.equal(match?.source, 'itunes');
});

test('мусорные теги не проходят сверку, а имя файла — проходит', async () => {
    const resolver = make({
        responses: [[song('Совсем другое', 'Кто-то')], [song('Bohemian Rhapsody', 'Queen', 'A Night at the Opera')]],
    });
    const { match } = await resolver.resolve(record({ title: 'asdf', artist: 'qwerty' }, '03 - Queen - Bohemian Rhapsody.mp3'));
    assert.equal(match?.artist, 'Queen');
    assert.equal(match?.source, 'itunes-file');
});

test('ничего не сошлось — честное «не нашли»', async () => {
    const resolver = make({ responses: [[song('X', 'Y')], [song('X', 'Y')]] });
    const { match } = await resolver.resolve(record({ title: 'asdf', artist: 'qwerty' }, 'zzz.mp3'));
    assert.equal(match, null);
});

test('AcoustID: подписи по звуку, обложка из Cover Art Archive', async () => {
    const lookup = [{ id: 'a', score: 0.9, recordings: [{ id: 'r', title: 'Весна', artists: [{ name: 'Дельфин' }],
        releasegroups: [{ id: 'rg', title: 'Существо', type: 'Album' }] }] }];
    const resolver = make({ acoustEnabled: true, lookup, cover: image });
    const { match, usedAcoustId } = await resolver.resolve(record({ title: 'Track 01' }));
    assert.equal(usedAcoustId, true);
    assert.deepEqual(match, { title: 'Весна', artist: 'Дельфин', album: 'Существо', cover: image, source: 'acoustid' });
});

test('AcoustID не узнал — дальше по тегам', async () => {
    const resolver = make({ acoustEnabled: true, lookup: [], responses: [[song('Искала', 'Земфира')]] });
    const { match, usedAcoustId } = await resolver.resolve(record({ title: 'Искала', artist: 'Земфира' }));
    assert.equal(usedAcoustId, true);
    assert.equal(match?.source, 'itunes');
});

test('недекодируемый файл не ломает поиск', async () => {
    const resolver = make({
        acoustEnabled: true,
        fingerprint: async () => { throw new Error('decode'); },
        responses: [[song('Искала', 'Земфира')]],
    });
    const { match } = await resolver.resolve(record({ title: 'Искала', artist: 'Земфира' }));
    assert.equal(match?.title, 'Искала');
});

test('сетевой сбой пробрасывается — это «позже», а не «не нашли»', async () => {
    const resolver = make({ responses: [new NetworkError('offline')] });
    await assert.rejects(resolver.resolve(record({ title: 'a', artist: 'b' })), NetworkError);
});
