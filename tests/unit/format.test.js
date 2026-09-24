import assert from 'node:assert/strict';
import { test } from 'node:test';
import { baseName, formatBytes, formatTime, plural, tracksLabel } from '../../src/core/format.js';

test('formatTime: минуты, часы и мусор', () => {
    assert.equal(formatTime(0), '0:00');
    assert.equal(formatTime(83.9), '1:23');
    assert.equal(formatTime(3725), '1:02:05');
    assert.equal(formatTime(-4), '0:00');
    assert.equal(formatTime(Number.NaN), '0:00');
});

test('plural: русское согласование', () => {
    const forms = /** @type {[string, string, string]} */ (['трек', 'трека', 'треков']);
    assert.equal(plural(1, forms), 'трек');
    assert.equal(plural(3, forms), 'трека');
    assert.equal(plural(5, forms), 'треков');
    assert.equal(plural(11, forms), 'треков');
    assert.equal(plural(21, forms), 'трек');
    assert.equal(plural(112, forms), 'треков');
    assert.equal(tracksLabel(42), '42 трека');
});

test('formatBytes: двоичные единицы и запятая', () => {
    assert.equal(formatBytes(0), '0 Б');
    assert.equal(formatBytes(1536), '1,5 КБ');
    assert.equal(formatBytes(312 * 1024 * 1024), '312 МБ');
});

test('baseName: без расширения и номера дорожки', () => {
    assert.equal(baseName('03 - Кино - Группа крови.mp3'), 'Кино - Группа крови');
    assert.equal(baseName('track.flac'), 'track');
    assert.equal(baseName('1999.mp3'), '1999');
});
