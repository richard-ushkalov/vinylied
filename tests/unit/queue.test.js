import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Queue } from '../../src/playback/Queue.js';

/** детерминированный «случай» для перемешивания */
const seeded = (seed = 42) => () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
};

const make = options => {
    const queue = new Queue({ random: seeded(), ...options });
    queue.setItems(['a', 'b', 'c', 'd']);
    return queue;
};

test('по очереди: вперёд, назад, по кругу', () => {
    const queue = make();
    assert.equal(queue.next(null), 'a');
    assert.equal(queue.next('b'), 'c');
    assert.equal(queue.next('d'), 'a');
    assert.equal(queue.prev('a'), 'd');
    assert.equal(queue.prev('c'), 'b');
});

test('повтор трека — только когда трек доиграл сам', () => {
    const queue = make({ repeat: 'one' });
    assert.equal(queue.next('b', { auto: true }), 'b');
    assert.equal(queue.next('b'), 'c');
});

test('без повтора: после последнего — стоп, но кнопка «следующий» не молчит', () => {
    const queue = make({ repeat: 'off' });
    assert.equal(queue.next('d', { auto: true }), null);
    assert.equal(queue.next('d'), 'a');
    assert.equal(queue.prev('a'), null);
});

test('отфильтрованная очередь: ходим только по видимым', () => {
    const queue = make();
    queue.setItems(['b', 'd']);
    assert.equal(queue.next('b'), 'd');
    // играющий трек отсеян поиском — следующим идёт первый видимый
    assert.equal(queue.next('c'), 'b');
});

test('перемешивание: каждый трек ровно раз за круг, круг начинается с текущего', () => {
    const queue = make();
    queue.setOrder('shuffle', 'c');
    const seen = ['c'];
    let current = 'c';
    for (let i = 0; i < 3; i++) {
        current = /** @type {string} */ (queue.next(current, { auto: true }));
        seen.push(current);
    }
    assert.deepEqual([...seen].sort(), ['a', 'b', 'c', 'd']);
});

test('новый круг перемешивания не начинается с только что доигравшего', () => {
    for (let seed = 1; seed < 40; seed++) {
        const queue = new Queue({ order: 'shuffle', random: seeded(seed) });
        queue.setItems(['a', 'b', 'c']);
        let current = /** @type {string} */ (queue.next(null));
        for (let i = 0; i < 2; i++) current = /** @type {string} */ (queue.next(current, { auto: true }));
        const nextRound = queue.next(current, { auto: true });
        assert.notEqual(nextRound, current, `seed ${seed}`);
    }
});

test('peek ничего не меняет и знает про повтор трека', () => {
    const queue = make();
    assert.equal(queue.peek('a'), 'b');
    assert.equal(queue.peek('d'), 'a');
    queue.setRepeat('one');
    assert.equal(queue.peek('c'), 'c');
});

test('пустая очередь', () => {
    const queue = new Queue();
    assert.equal(queue.next(null), null);
    assert.equal(queue.prev('x'), null);
    assert.equal(queue.peek(null), null);
});
