import assert from 'node:assert/strict';
import { test } from 'node:test';
import { containsAll, norm, same } from '../../src/lookup/Matcher.js';

test('norm оставляет только буквы и цифры', () => {
    assert.equal(norm('Рок-н-ролл мёртв!'), 'рокнроллмёртв');
    assert.equal(norm(undefined), '');
});

test('same: вложенность в обе стороны, но не похожесть', () => {
    assert.ok(same('Trilogy', 'Trilogy (Deluxe)'));
    assert.ok(same('Trilogy (Deluxe)', 'trilogy'));
    assert.ok(!same('Trilogy', 'Thriller'));
    assert.ok(!same('', 'что угодно'));
});

test('containsAll: все части должны встретиться', () => {
    assert.ok(containsAll('03 - Queen - Bohemian Rhapsody', 'Bohemian Rhapsody', 'Queen'));
    assert.ok(!containsAll('03 - Queen - Bohemian Rhapsody', 'Bohemian Rhapsody', 'Panic! at the Disco'));
    assert.ok(!containsAll('abc', ''));
});
