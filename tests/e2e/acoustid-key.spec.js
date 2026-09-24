import { expect, test } from '@playwright/test';
import { fixturePaths, importTracks, mockServices } from './helpers.js';

const openSettings = async page => {
    await page.getByRole('button', { name: 'Полка и настройки' }).click();
    await page.locator('#library-sheet').getByRole('button', { name: 'Настройки' }).click();
};

test('ключ из настроек: работает — так и написано', async ({ page }) => {
    const calls = await mockServices(page);
    await page.route('**/src/config.js', route => route.fulfill({
        contentType: 'text/javascript', body: "export const ACOUSTID_KEY = '';",
    }));
    await page.goto('/');
    await openSettings(page);
    const status = page.locator('#settings-sheet [data-bind="key-status"]');
    await expect(status).toContainText('ключ AcoustID не задан');

    await page.getByLabel('Ключ AcoustID').fill('AppKey01');
    await page.getByLabel('Ключ AcoustID').press('Tab');
    await expect(status).toContainText('проверится при первом поиске');
    await page.keyboard.press('Escape');

    await importTracks(page, fixturePaths().slice(0, 1));
    await expect.poll(() => calls.acoustid.length, { timeout: 20_000 }).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Полка и настройки' }).click();
    await expect(page.locator('#library-sheet [data-bind="lookup"]')).toContainText('Распознавание по звуку работает');

    await page.reload();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('vinilyed:settings')).values.acoustidKey)).toBe('AppKey01');
});

test('AcoustID не принял ключ — видно, почему, и поиск идёт через iTunes', async ({ page }) => {
    const calls = await mockServices(page, {
        acoustid: () => ({ status: 'error', error: { code: 4, message: 'invalid API key' } }),
    });
    await page.route('**/src/config.js', route => route.fulfill({
        contentType: 'text/javascript', body: "export const ACOUSTID_KEY = 'UserKey123';",
    }));
    await page.goto('/');
    await importTracks(page, fixturePaths().slice(0, 2));
    await expect.poll(() => calls.itunes.length, { timeout: 20_000 }).toBeGreaterThan(0);

    await page.getByRole('button', { name: 'Полка и настройки' }).click();
    await expect(page.locator('#library-sheet [data-bind="lookup"]')).toContainText('AcoustID не принял ключ');
    // после отказа сервис больше не дёргаем
    expect(calls.acoustid.length).toBe(1);
});
