import { expect, test } from '@playwright/test';
import { importTracks, mockServices, state, togglePlay } from './helpers.js';

/**
 * Центрирование полки. Раньше полку двигали две системы — CSS раздувал
 * отступы текущего конверта, а JS ехал к центру, посчитанному один раз, —
 * и она то «не успевала», то вставала мимо центра. Здесь меряем по-честному:
 * центр того, что видно на экране, против центра сцены, после того как
 * всё успокоилось.
 */

const TOLERANCE = 2;   // px

/**
 * Смещение центра элемента от центра сцены по вертикали — когда оно
 * держится 300 мс подряд. Двух замеров мало: вставая, обложка на миг
 * проскакивает центр на пару пикселей, и в точке разворота два замера
 * совпадают, хотя движение ещё идёт.
 * @param {import('@playwright/test').Page} page
 * @param {string} selector
 */
const settledOffset = async (page, selector) => {
    const read = () => page.evaluate(sel => {
        const target = document.querySelector(sel);
        const scene = document.querySelector('.scene');
        if (!target || !scene) return null;
        const t = target.getBoundingClientRect();
        const s = scene.getBoundingClientRect();
        return (t.top + t.height / 2) - (s.top + s.height / 2);
    }, selector);
    const window = [];
    for (let i = 0; i < 100; i++) {
        const value = await read();
        window.push(value);
        if (window.length > 4) window.shift();
        const numbers = window.filter(v => v !== null);
        if (numbers.length === 4 && Math.max(...numbers) - Math.min(...numbers) < 0.15) return value;
        await page.waitForTimeout(100);
    }
    return window.at(-1) ?? null;
};

/** Обложка играющего конверта (он стоит лицом к нам). */
const CURRENT = '.slot--current .vinyl__frontside';
/** Корешок конверта в центре (лежит). */
const FOCUSED = '.slot--focused:not(.slot--current) .vinyl__side';

const expectCentered = async (page, selector) => {
    const offset = await settledOffset(page, selector);
    expect(offset, `${selector} смещён от центра на ${offset}px`).not.toBeNull();
    expect(Math.abs(/** @type {number} */ (offset))).toBeLessThanOrEqual(TOLERANCE);
};

test.beforeEach(async ({ page }) => {
    await mockServices(page);
    await page.goto('/');
    await importTracks(page);
});

test('запуск трека и «следующий» — конверт ровно по центру', async ({ page }) => {
    await togglePlay(page);
    await expect.poll(() => state(page)).toMatchObject({ playing: true });
    await expectCentered(page, CURRENT);

    for (let i = 0; i < 3; i++) {
        await page.keyboard.press('n');
        await expectCentered(page, CURRENT);
    }
});

test('продолжить с места: при запуске конверт стоит по центру, диск не раньше конверта', async ({ page }) => {
    // уходим от первого трека, чтобы проверка что-то значила
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await expect.poll(() => state(page)).toMatchObject({ playing: true });
    await togglePlay(page);

    // Следим за каждым кадром после перезагрузки: диск играющего не должен
    // показываться, пока его конверт ещё проявляется.
    await page.addInitScript(() => {
        /** @type {any} */ (window).__discWithoutSleeve = 0;
        const check = () => {
            const slot = document.querySelector('.slot--current');
            const disc = slot?.querySelector('.disc');
            if (disc && slot.classList.contains('slot--loading') && getComputedStyle(disc).visibility === 'visible') {
                /** @type {any} */ (window).__discWithoutSleeve++;
            }
            requestAnimationFrame(check);
        };
        requestAnimationFrame(check);
    });
    await page.reload();
    await expect(page.locator('.slot--current')).toHaveCount(1);
    await expectCentered(page, CURRENT);
    await expect(page.locator(CURRENT)).toHaveCSS('opacity', '1');
    await expect(page.locator('.slot--current .disc')).toHaveCSS('visibility', 'visible');
    expect(await page.evaluate(() => /** @type {any} */ (window).__discWithoutSleeve)).toBe(0);
});

test('поиск и его очистка не сбивают центр', async ({ page }) => {
    await togglePlay(page);
    await expect.poll(() => state(page)).toMatchObject({ playing: true });
    const label = /** @type {string} */ (await page.locator('.slot--current').getAttribute('aria-label'));
    const artist = label.split(' — ')[1] ?? label;

    await page.getByRole('button', { name: 'Поиск по полке' }).click();
    // найден сам играющий — он и остаётся в центре, пока остальные схлопываются
    await page.getByRole('searchbox', { name: 'Поиск по полке' }).fill(artist.slice(0, 4));
    await expectCentered(page, CURRENT);

    await page.getByRole('button', { name: 'Закрыть поиск' }).click();
    await expectCentered(page, CURRENT);
});

test('колесо: полка доводится ровно к конверту', async ({ page }, info) => {
    test.skip(info.project.name === 'mobile', 'колесо — на компьютере');
    const box = /** @type {{ x: number, y: number, width: number, height: number }} */ (await page.locator('.scene').boundingBox());
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 160);
    await expectCentered(page, FOCUSED);
    await page.mouse.wheel(0, -90);
    await expectCentered(page, FOCUSED);
});

test('бросок пальцем: полка доводится ровно к конверту', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'палец — на телефоне');
    const box = /** @type {{ x: number, y: number, width: number, height: number }} */ (await page.locator('.scene').boundingBox());
    const x = box.x + box.width / 2;
    const client = await page.context().newCDPSession(page);
    const touch = (type, y) => client.send('Input.dispatchTouchEvent', {
        type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }],
    });
    // быстрый бросок вверх
    let y = box.y + box.height * 0.7;
    await touch('touchStart', y);
    for (let i = 0; i < 6; i++) { y -= 30; await touch('touchMove', y); }
    await touch('touchEnd', y);
    await expectCentered(page, FOCUSED);
});

test('поворот экрана и «Размер конвертов» — центр на месте', async ({ page }) => {
    await togglePlay(page);
    await expect.poll(() => state(page)).toMatchObject({ playing: true });
    await expectCentered(page, CURRENT);

    const size = page.viewportSize();
    await page.setViewportSize({ width: /** @type {any} */ (size).height, height: /** @type {any} */ (size).width });
    await expectCentered(page, CURRENT);
    await page.setViewportSize(/** @type {any} */ (size));

    await page.getByRole('button', { name: 'Полка и настройки' }).click();
    await page.locator('#library-sheet').getByRole('button', { name: 'Настройки' }).click();
    await page.locator('#settings-sheet label', { hasText: 'Крупные' }).click();
    await page.keyboard.press('Escape');
    await expectCentered(page, CURRENT);
});
