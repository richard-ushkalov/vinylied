import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ShelfLayout, lowerBound } from '../../src/ui/shelf/ShelfLayout.js';

const SIZE = 350;                  // обложка 350px
const NORMAL = SIZE * 2 / 7;       // обычное место в стопке — 100px
const close = (actual, expected, message) =>
    assert.ok(Math.abs(actual - expected) < 1e-6, `${message}: ${actual} ≠ ${expected}`);

const make = (ids = ['a', 'b', 'c', 'd']) => {
    const layout = new ShelfLayout();
    layout.setMetrics(SIZE);
    layout.setItems(ids);
    return layout;
};

/** Прокрутить анимацию до конца шагами dt. */
const settle = (layout, dt = 1 / 60) => {
    for (let i = 0; i < 1000 && layout.step(dt); i++);
};

test('обычные конверты: центры через равный шаг', () => {
    const layout = make();
    assert.deepEqual(layout.centers(), [NORMAL / 2, NORMAL * 1.5, NORMAL * 2.5, NORMAL * 3.5]);
});

test('текущий встаёт: его место — целая обложка, соседи раздвигаются', () => {
    const layout = make();
    layout.setCurrent('b', { instant: true });
    const [a, b, c] = layout.centers();
    close(a, NORMAL / 2, 'a');
    close(b, NORMAL + SIZE / 2, 'b — середина стоящего конверта');
    close(c, NORMAL + SIZE + NORMAL / 2, 'c');
});

test('анимация сходится к той же геометрии при 60 и 120 Гц', () => {
    const at60 = make();
    const at120 = make();
    at60.setCurrent('c');
    at120.setCurrent('c');
    settle(at60, 1 / 60);
    settle(at120, 1 / 120);
    const instant = make();
    instant.setCurrent('c', { instant: true });
    assert.deepEqual(at60.centers(), instant.centers());
    assert.deepEqual(at120.centers(), instant.centers());

    // и по пути, в одно и то же время, они одинаковы
    const half60 = make(), half120 = make();
    half60.setCurrent('c');
    half120.setCurrent('c');
    for (let i = 0; i < 6; i++) half60.step(1 / 60);
    for (let i = 0; i < 12; i++) half120.step(1 / 120);
    close(half60.centerOf('c'), half120.centerOf('c'), 'середина пути');
});

test('смена текущего: прежний складывается, новый раскрывается', () => {
    const layout = make();
    layout.setCurrent('a', { instant: true });
    layout.setCurrent('d');
    assert.equal(layout.step(1 / 60), true);
    settle(layout);
    close(layout.centerOf('d'), NORMAL * 3 + SIZE / 2, 'd стоит');
    close(layout.centerOf('a'), NORMAL / 2, 'a лёг обратно');
});

test('отсеянный схлопывается не сразу, а после задержки', () => {
    const layout = make();
    layout.setPresent('b', false, { delay: 500 });
    for (let t = 0; t < 0.45; t += 1 / 60) layout.step(1 / 60);
    close(layout.centerOf('c'), NORMAL * 2.5, 'до задержки место ещё занято');
    settle(layout);
    close(layout.centerOf('c'), NORMAL * 1.5, 'после — c сдвинулся на место b');
    assert.equal(layout.isPresent(1), false);
    assert.equal(layout.presenceAt(1), 0);
});

test('nearest пропускает отсеянных', () => {
    const layout = make();
    layout.setPresent('b', false, { instant: true });
    layout.setPresent('c', false, { instant: true });
    // b и c схлопнуты в точку между a и d; ближайший видимый к ней — a или d
    const between = NORMAL;
    assert.ok([0, 3].includes(layout.nearest(between)));
    assert.equal(layout.nearest(-50), 0);
    assert.equal(layout.nearest(10_000), 3);
    for (const id of ['a', 'd']) layout.setPresent(id, false, { instant: true });
    assert.equal(layout.nearest(0), -1);
});

test('состав меняется — состояние знакомых сохраняется', () => {
    const layout = make(['a', 'b']);
    layout.setCurrent('b', { instant: true });
    layout.setItems(['x', 'a', 'b']);
    close(layout.centerOf('b'), NORMAL * 2 + SIZE / 2, 'b по-прежнему стоит');
    assert.equal(layout.indexOf('x'), 0);
    assert.equal(layout.centerOf('нет такого'), null);
});

test('размер обложки меняется — геометрия масштабируется', () => {
    const layout = make();
    assert.equal(layout.setMetrics(SIZE), false);
    assert.equal(layout.setMetrics(SIZE * 2), true);
    close(layout.centerOf('b'), NORMAL * 2 * 1.5, 'b');
});

test('range и lowerBound', () => {
    const layout = make();
    assert.deepEqual(layout.range(NORMAL, NORMAL * 3), [1, 2]);
    assert.deepEqual(layout.range(-100, -1), [0, -1]);
    assert.equal(lowerBound([1, 2, 2, 5], 2), 1);
    assert.equal(lowerBound([1, 2, 2, 5], 6), 4);
});
