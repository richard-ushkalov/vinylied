import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeSilentWav } from '../../src/audio/silence.js';

test('беззвучный WAV: заголовок, длина и тишина 0x80', () => {
    const wav = makeSilentWav(10);
    const view = new DataView(wav.buffer);
    const text = (at, length) => String.fromCharCode(...wav.slice(at, at + length));

    assert.equal(text(0, 4), 'RIFF');
    assert.equal(text(8, 4), 'WAVE');
    assert.equal(view.getUint16(22, true), 1);          // моно
    assert.equal(view.getUint32(24, true), 8000);
    assert.equal(view.getUint16(34, true), 8);          // 8 бит
    assert.equal(view.getUint32(40, true), 80_000);     // 10 с — дольше 5 с, что нужно Chrome
    assert.equal(wav.length, 44 + 80_000);
    assert.ok(wav.subarray(44).every(byte => byte === 0x80));
});
