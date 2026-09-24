import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SCHEMA, Settings, coerce, sanitize } from '../../src/core/Settings.js';

const memory = initial => {
    let value = initial;
    return { read: fallback => value ?? fallback, write: next => { value = next; }, get value() { return value; } };
};

test('sanitize: пустое или чужое хранилище — значения по умолчанию', () => {
    const defaults = sanitize(SCHEMA, null);
    assert.equal(defaults.theme, 'system');
    assert.equal(defaults.volume, 1);
    assert.deepEqual(sanitize(SCHEMA, { v: 999, values: { theme: 'light' } }), defaults);
});

test('coerce: обрезка чисел, чужие варианты и типы', () => {
    assert.equal(coerce(SCHEMA.volume, 7), 1);
    assert.equal(coerce(SCHEMA.volume, -1), 0);
    assert.equal(coerce(SCHEMA.volume, '0.5'), 1);   // строка — не число, берём умолчание
    assert.equal(coerce(SCHEMA.theme, 'purple'), 'system');
    assert.equal(coerce(SCHEMA.haptics, 'yes'), true);
});

test('set сохраняет, сообщает и не шумит без изменений', () => {
    const store = memory(null);
    const settings = new Settings({ store });
    const changes = [];
    settings.on('change', change => changes.push(change));

    settings.set('theme', 'light');
    settings.set('theme', 'light');
    settings.set('edgeBlur', 0.25);
    assert.deepEqual(changes, [{ key: 'theme', value: 'light' }, { key: 'edgeBlur', value: 0.25 }]);
    assert.equal(store.value.values.theme, 'light');

    // новый экземпляр читает то же хранилище
    assert.equal(new Settings({ store }).get('edgeBlur'), 0.25);
    assert.throws(() => settings.set('nope', 1));
});

test('watch вызывается сразу и на изменения своих ключей', () => {
    const settings = new Settings({ store: memory(null) });
    const calls = [];
    settings.watch(['order', 'repeat'], values => calls.push(values));
    settings.set('volume', 0.5);
    settings.set('repeat', 'one');
    assert.deepEqual(calls, [
        { order: 'sequential', repeat: 'all' },
        { order: 'sequential', repeat: 'one' },
    ]);
});

test('reset возвращает умолчания и рассылает только изменённое', () => {
    const settings = new Settings({ store: memory(null) });
    settings.set('fisheye', 0);
    const keys = [];
    settings.on('change', ({ key }) => keys.push(key));
    settings.reset();
    assert.deepEqual(keys, ['fisheye']);
    assert.equal(settings.get('fisheye'), 1);
});

test('строковая настройка: пробелы срезаются, мусор отбрасывается', () => {
    assert.equal(coerce(SCHEMA.acoustidKey, '  AbC12345 '), 'AbC12345');
    assert.equal(coerce(SCHEMA.acoustidKey, 'bad key!'), '');
    assert.equal(coerce(SCHEMA.acoustidKey, 'x'.repeat(40)), '');
    assert.equal(coerce(SCHEMA.acoustidKey, 42), '');
    const settings = new Settings({ store: memory(null) });
    settings.set('acoustidKey', ' 8XaBELgH ');
    assert.equal(settings.get('acoustidKey'), '8XaBELgH');
});

test('адрес сервера скачивания: только origin, https или этот компьютер', async () => {
    const { SCHEMA, coerce } = await import('../../src/core/Settings.js');
    const field = SCHEMA.downloadServer;
    for (const ok of ['https://dl.richard-ushkalov.com', 'https://x.test:8443', 'http://127.0.0.1:8765', 'http://localhost', '']) {
        assert.equal(coerce(field, ok), ok, ok);
    }
    for (const bad of ['javascript:alert(1)', 'http://192.168.1.2:8765', 'https://x.test/path', 'ftp://x.test', 'https://']) {
        assert.equal(coerce(field, bad), '', bad);
    }
    assert.equal(coerce(SCHEMA.downloadCode, 'lxM57u1SboPy'), 'lxM57u1SboPy');
    assert.equal(coerce(SCHEMA.downloadCode, 'код с пробелом'), '');
});
