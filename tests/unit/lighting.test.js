import assert from 'node:assert/strict';
import { test } from 'node:test';
import { faceLight } from '../../src/ui/shelf/lighting.js';

const SIZE = 300;
const DISTANCE = 1000;
const DEG = Math.PI / 180;

/** Слот как его рисует ShelfScroller: рыбий глаз 20°, утопание 140px. */
const slot = (offset, { strength = 1, expand = 0 } = {}) => {
    const t = Math.max(-1, Math.min(1, offset / 320));
    return faceLight({
        y: offset,
        z: -Math.abs(t) * 140 + expand * SIZE / 2,
        angle: -t * 20 * DEG - expand * Math.PI / 2,
        size: SIZE,
        distance: DISTANCE,
        strength,
    });
};

test('корешок по центру — самое яркое место, ровно 1', () => {
    assert.equal(slot(0).side, 1);
});

test('к краям корешки темнеют', () => {
    const sides = [0, 80, 160, 240, 320].map(offset => slot(offset).side);
    for (let i = 1; i < sides.length; i++) {
        assert.ok(sides[i] < sides[i - 1], `${sides[i]} темнее ${sides[i - 1]}`);
    }
    assert.ok(sides.at(-1) > 0.3, 'отвёрнутое не уходит в чёрное');
});

test('выше и ниже центра — зеркально: верх нижнего = низ верхнего', () => {
    for (const offset of [60, 150, 300]) {
        const below = slot(offset);
        const above = slot(-offset);
        assert.equal(below.side, above.side, `корешки на ±${offset}`);
        assert.equal(below.front, above.back, `верх на +${offset} и низ на −${offset}`);
    }
});

test('видна та грань, что смотрит на лампу: ниже центра — верх, выше — низ', () => {
    const below = slot(200);
    const above = slot(-200);
    assert.ok(below.front > below.back, 'ниже центра светится верх');
    assert.ok(above.back > above.front, 'выше центра светится низ');
});

test('сила 0 — свет выключен, все грани как есть', () => {
    for (const offset of [-300, -40, 0, 90, 300]) {
        assert.deepEqual(slot(offset, { strength: 0 }), { side: 1, front: 1, back: 1 });
    }
});

test('встал текущий — его обложка смотрит на лампу и светится полностью', () => {
    const standing = slot(0, { expand: 1 });
    assert.equal(standing.front, 1);
    assert.ok(standing.side < 0.5, 'корешок внизу, от лампы отвёрнут');
});
