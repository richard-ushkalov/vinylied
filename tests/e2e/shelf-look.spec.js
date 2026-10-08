import { expect, test } from '@playwright/test';
import { fixturePaths, importTracks, mockServices, wheel } from './helpers.js';

/**
 * Свет от камеры и размытие: что считает ShelfScroller и куда пишет.
 * Сами пиксели не сверяем — сверяем числа, по которым CSS их рисует.
 */

/** @param {import('@playwright/test').Page} page @param {Record<string, unknown>} values */
const withSettings = (page, values) => page.addInitScript(json => {
    if (!localStorage.getItem('vinilyed:settings')) localStorage.setItem('vinilyed:settings', json);
}, JSON.stringify({ v: 1, values }));

/** Яркость корешка у каждого видимого слота: [расстояние до центра, яркость]. */
const sideLight = page => page.evaluate(() => {
    const scene = document.querySelector('.scene').getBoundingClientRect();
    const middle = scene.top + scene.height / 2;
    return [...document.querySelectorAll('.slot:not(.slot--culled)')].map(slot => {
        const box = slot.querySelector('.vinyl__side').getBoundingClientRect();
        return [Math.abs(box.top + box.height / 2 - middle), slot.style.getPropertyValue('--lit-side')];
    });
});

test.beforeEach(async ({ page }) => { await mockServices(page); });

test('свет: у центра корешки ярче, к краям темнее', async ({ page }) => {
    await page.goto('/');
    await importTracks(page, fixturePaths());
    // в середину полки: чтобы конверты были и выше, и ниже центра
    await page.locator('.list').focus();
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(800);
    const light = (await sideLight(page)).filter(([, value]) => value).sort((a, b) => a[0] - b[0]);
    expect(light.length).toBeGreaterThan(2);
    expect(Number(light[0][1])).toBeGreaterThan(Number(light.at(-1)[1]));
    // выше центра свет падает на нижнее ребро корешка
    expect(await page.locator('.slot--above').count()).toBeGreaterThan(0);
});

test('свет выключен — переменных нет, грани как есть', async ({ page }) => {
    await withSettings(page, { lighting: 0 });
    await page.goto('/');
    await importTracks(page, fixturePaths());
    await page.waitForTimeout(600);
    const light = await sideLight(page);
    expect(light.every(([, value]) => value === '')).toBe(true);
});

test('размытие слоем: слой включён, грани без фильтра размытия', async ({ page }) => {
    await page.goto('/');
    await importTracks(page, fixturePaths());
    const blur = page.locator('.shelf-blur');
    await expect(blur).toHaveClass(/shelf-blur--on/);
    const filter = await page.locator('.shelf-blur__layer').evaluate(el =>
        getComputedStyle(el).backdropFilter || getComputedStyle(el).webkitBackdropFilter);
    expect(filter).toContain('blur');
    expect(await page.locator('.slot[style*="--face-blur"]').count()).toBe(0);

    // в движении мутнеет и середина, после остановки — снова резкая.
    // Колесо и чтение — в одном синхронном куске: между вызовами из теста
    // успевают пройти кадры, и размытие спадает раньше, чем его прочтёшь.
    expect(await page.evaluate(wheel)).toBeGreaterThan(0);
    await expect.poll(() => blur.evaluate(el => el.style.getPropertyValue('--floor'))).toBe('0');
});

test('размытие по краям выключено — слоя нет совсем', async ({ page }) => {
    await withSettings(page, { edgeBlur: 0 });
    await page.goto('/');
    await importTracks(page, fixturePaths());
    await page.waitForTimeout(600);
    await expect(page.locator('.shelf-blur')).not.toHaveClass(/shelf-blur--on/);
    await expect(page.locator('.shelf-blur')).toBeHidden();
});

test('размытие по граням: фильтр на слотах у краёв, слоя нет', async ({ page }) => {
    await withSettings(page, { blurMode: 'faces' });
    await page.goto('/');
    await importTracks(page, fixturePaths());
    await page.waitForTimeout(600);
    await expect(page.locator('.shelf-blur')).toBeHidden();
    // фильтр размытия доходит до граней — у кого-то из дальних корешков
    await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('.slot[style*="--face-blur"] .vinyl__side')]
        .some(side => getComputedStyle(side).filter.includes('blur')))).toBe(true);
});
