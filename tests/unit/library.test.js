import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAudio, keyOf } from '../../src/library/Library.js';

test('isAudio: по типу или по расширению', () => {
    assert.ok(isAudio(/** @type {File} */ ({ type: 'audio/mpeg', name: 'x' })));
    // Android нередко отдаёт пустой type — выручает расширение
    assert.ok(isAudio(/** @type {File} */ ({ type: '', name: 'Песня.FLAC' })));
    assert.ok(!isAudio(/** @type {File} */ ({ type: 'image/png', name: 'cover.png' })));
});

test('keyOf: имя, размер и дата', () => {
    assert.equal(keyOf({ name: 'a.mp3', size: 10, lastModified: 5 }), 'a.mp3|10|5');
    assert.equal(keyOf({ name: 'a.mp3', size: 10 }), 'a.mp3|10|0');
});

test('без хранилища полка живёт в памяти: импорт и правки работают', async () => {
    const { Library } = await import('../../src/library/Library.js');
    const broken = new Proxy({}, { get: () => async () => { throw new Error('IndexedDB недоступна'); } });
    const reader = { read: async () => ({ title: 'T', artist: 'A', album: '', duration: 1, cover: null, spine: null, spineText: null }) };
    const library = new Library({ db: /** @type {any} */ (broken), reader: /** @type {any} */ (reader) });

    await assert.rejects(library.load());
    assert.equal(library.persistent, false);

    const file = new File(['x'], 'a.mp3', { type: 'audio/mpeg', lastModified: 1 });
    const [record] = await library.import([file]);
    assert.equal(library.size, 1);
    await library.update(record.id, { lookup: { status: 'none' } });
    assert.equal(library.get(record.id)?.lookup.status, 'none');
    await library.remove(record.id);
    assert.equal(library.size, 0);
});
