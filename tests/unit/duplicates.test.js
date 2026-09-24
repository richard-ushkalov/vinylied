import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findDuplicates, sameSong, sha256 } from '../../src/library/duplicates.js';

let added = 0;
/**
 * Трек глазами поиска дубликатов: подписи с конверта плюс запись библиотеки.
 * content — содержимое файла: одинаковое содержимое = один и тот же файл.
 */
const track = (id, { title = '', artist = '', duration = 200, size = 1000, content = id, found = false } = {}) => ({
    id, title, artist, duration,
    record: /** @type {any} */ ({
        size, addedAt: ++added, file: new Blob([content]),
        lookup: found ? { status: 'found' } : {},
    }),
});

/** Хеш «по содержимому» без crypto — для тестов хватает самого текста. */
const digest = async blob => blob.text();

const ids = groups => groups.map(({ keep, remove }) => [keep.id, remove.map(t => t.id)]);

test('sameSong: подписи без регистра и знаков, длительность с допуском', () => {
    const a = { title: 'Группа крови', artist: 'Кино', duration: 285 };
    assert.ok(sameSong(a, { title: 'группа  крови!', artist: 'КИНО', duration: 286.5 }));
    assert.ok(!sameSong(a, { title: 'Группа крови', artist: 'Кино', duration: 295 }), 'другая версия');
    assert.ok(!sameSong(a, { title: 'Кукушка', artist: 'Кино', duration: 285 }));
    // длительность неизвестна — судим по подписям
    assert.ok(sameSong(a, { title: 'Группа крови', artist: 'Кино', duration: 0 }));
    // без исполнителя не склеиваем: «Intro» с разных альбомов — разные треки
    assert.ok(!sameSong({ title: 'Intro', artist: '', duration: 60 }, { title: 'Intro', artist: '', duration: 60 }));
});

test('та же песня другим файлом — дубликат, остаётся лучшего качества', async () => {
    const low = track('low', { title: 'Кукушка', artist: 'Кино', size: 3_000 });
    const high = track('high', { title: 'Кукушка', artist: 'Кино', size: 9_000 });
    const other = track('other', { title: 'Звезда', artist: 'Кино' });
    assert.deepEqual(ids(await findDuplicates([low, high, other], { digest })), [['high', ['low']]]);
});

test('тот же файл под другим именем — дубликат, даже без тегов', async () => {
    const a = track('a', { title: 'song', size: 500, content: 'same' });
    const b = track('b', { title: 'song (1)', size: 500, content: 'same' });
    const c = track('c', { title: 'other', size: 500, content: 'different' });
    assert.deepEqual(ids(await findDuplicates([a, b, c], { digest })), [['a', ['b']]]);
});

test('хешируются только файлы одного размера', async () => {
    const hashed = [];
    const spy = async blob => { hashed.push(await blob.text()); return blob.text(); };
    await findDuplicates([
        track('a', { size: 1, content: 'x' }),
        track('b', { size: 2, content: 'y' }),
        track('c', { size: 2, content: 'z' }),
    ], { digest: spy });
    assert.deepEqual(hashed.sort(), ['y', 'z']);
});

test('кого оставить: играющий → опознанный → качество → старший', async () => {
    const song = { title: 'Хочу перемен', artist: 'Кино' };
    const old = track('old', { ...song, size: 5_000 });
    const young = track('young', { ...song, size: 5_000 });
    const known = track('known', { ...song, size: 1_000, found: true });
    const playing = track('playing', { ...song, size: 500 });

    assert.deepEqual(ids(await findDuplicates([old, young], { digest: async () => Math.random().toString() })),
        [['old', ['young']]]);
    assert.deepEqual(ids(await findDuplicates([old, young, known], { digest })), [['known', ['old', 'young']]]);
    assert.deepEqual(ids(await findDuplicates([old, known, playing], { current: 'playing', digest })),
        [['playing', ['known', 'old']]]);
});

test('правила сцепляются в одну группу', async () => {
    // a и b — один файл; b и c — одна песня; значит, все трое вместе
    const a = track('a', { title: 'x.mp3', size: 700, content: 'bytes' });
    const b = track('b', { title: 'Кончится лето', artist: 'Кино', size: 700, content: 'bytes' });
    const c = track('c', { title: 'Кончится лето', artist: 'Кино', size: 900 });
    const [group] = await findDuplicates([a, b, c], { digest });
    assert.equal(group.remove.length, 2);
    assert.equal(group.keep.id, 'c', 'больше битрейт');
});

test('sha256 — настоящий хеш', async () => {
    assert.equal(await sha256(new Blob(['abc'])),
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
