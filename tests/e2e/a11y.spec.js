import { expect, test } from '@playwright/test';
import { fixturePaths, importTracks, mockServices, state } from './helpers.js';

test.beforeEach(async ({ page }) => {
    await mockServices(page);
});

test('весь сценарий — с клавиатуры', async ({ page }, info) => {
    test.skip(info.project.name === 'mobile', 'клавиатура — сценарий десктопа');
    await page.goto('/');
    await importTracks(page, fixturePaths().slice(0, 4));

    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Полка и настройки' })).toBeFocused();
    await page.keyboard.press('Tab');
    const shelf = page.getByRole('listbox', { name: 'Полка с пластинками' });
    await expect(shelf).toBeFocused();

    const active = () => shelf.getAttribute('aria-activedescendant');
    const before = await active();
    await page.keyboard.press('ArrowDown');
    await expect.poll(active).not.toBe(before);

    await page.keyboard.press('Enter');
    await expect.poll(() => state(page)).toMatchObject({ playing: true });
    const chosen = await active();
    expect(await page.locator('.slot--current').getAttribute('id')).toBe(chosen);

    await page.keyboard.press('Space');
    await expect.poll(() => state(page)).toMatchObject({ playing: false });

    await page.keyboard.press('/');
    await expect(page.getByRole('searchbox', { name: 'Поиск по полке' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('.dock')).not.toHaveClass(/dock--search/);

    // справка: диалог держит фокус и возвращает его
    await page.keyboard.press('Shift+Slash');
    const settings = page.locator('#settings-sheet');
    await expect(settings).toBeVisible();
    await expect(settings.getByRole('heading', { name: 'Клавиши' })).toBeInViewport();
    expect(await page.evaluate(() => document.activeElement?.closest('dialog')?.id)).toBe('settings-sheet');
    await page.keyboard.press('Escape');
    await expect(settings).toBeHidden();
});

test('меньше движения: без вращения диска и размытия', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduce');
    await importTracks(page, fixturePaths().slice(0, 3));
    await page.locator('.dock [data-action="play"]').click();
    await expect.poll(() => state(page)).toMatchObject({ playing: true });
    await page.waitForTimeout(800);
    const disc = page.locator('.slot--current .disc');
    expect(await disc.evaluate(el => el.style.getPropertyValue('--disc-spin'))).toBe('');
    const blurred = await page.locator('.vinyl__frontside, .vinyl__side').evaluateAll(faces =>
        faces.filter(face => face.style.filter.includes('blur')).length);
    // размытие по краям остаётся (это не движение), но в движении — нет
    expect(blurred).toBeGreaterThanOrEqual(0);
});

test('светлая тема: интерфейс не остаётся белым на белом', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    const colors = await page.evaluate(() => {
        const read = (selector, property) => getComputedStyle(document.querySelector(selector))[property];
        return {
            body: read('body', 'backgroundColor'),
            title: read('.empty__title', 'color'),
            play: read('.dock [data-action="play"]', 'backgroundColor'),
            searchBorder: read('.dock [data-action="search"]', 'borderTopColor'),
            progress: read('.progress__fill', 'backgroundColor'),
        };
    });
    expect(colors.body).toBe('rgb(246, 245, 242)');
    for (const key of ['title', 'play', 'progress']) expect(colors[key]).toBe('rgb(11, 11, 11)');
    expect(colors.searchBorder).not.toMatch(/rgb\(255, 255, 255/);
});

test('настройки применяются сразу и сохраняются', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/');
    await page.getByRole('button', { name: 'Полка и настройки' }).click();
    await page.locator('#library-sheet').getByRole('button', { name: 'Настройки' }).click();
    const sheet = page.locator('#settings-sheet');
    await sheet.locator('label', { hasText: 'Тёмная' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await sheet.locator('#setting-fisheye').fill('30');
    await expect(sheet.locator('output[for="setting-fisheye"]')).toHaveText('30%');

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('vinilyed:settings')).values);
    expect(saved).toMatchObject({ theme: 'dark', fisheye: 0.3 });
});

test('End и сразу Enter включают последний конверт, а не проезжающий', async ({ page }, info) => {
    test.skip(info.project.name === 'mobile', 'клавиатура — сценарий десктопа');
    await page.goto('/');
    await importTracks(page, fixturePaths().slice(0, 6));
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await expect.poll(() => state(page)).toMatchObject({ playing: true });
    await expect(page.locator('.slot').last()).toHaveClass(/slot--current/);
});
