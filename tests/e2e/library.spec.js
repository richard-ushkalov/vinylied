import { expect, test } from '@playwright/test';
import { fixturePaths, importTracks, mockServices } from './helpers.js';

test.beforeEach(async ({ page }) => {
    await mockServices(page);
    await page.goto('/');
});

test('пустая полка предлагает добавить музыку', async ({ page }) => {
    await expect(page.locator('.empty')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Полка пока пустая' })).toBeVisible();
});

test('полка переживает перезагрузку и не принимает дубли', async ({ page }) => {
    await importTracks(page);
    await expect(page.locator('.empty')).toBeHidden();
    await expect(page.locator('.slot[aria-label^="Группа крови"]')).toHaveCount(1);

    await page.reload();
    await expect(page.locator('.slot')).toHaveCount(8);

    await page.setInputFiles('.file-input', fixturePaths().slice(0, 3));
    await expect(page.locator('.status')).toContainText('уже на полке');
    await expect(page.locator('.slot')).toHaveCount(8);
});

test('трек можно убрать с полки, полку — очистить', async ({ page }) => {
    page.on('dialog', dialog => dialog.accept());
    await importTracks(page);

    await page.getByRole('button', { name: 'Полка и настройки' }).click();
    const sheet = page.locator('#library-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet.locator('[data-bind="stats"]')).toContainText('8 треков');

    await sheet.getByRole('button', { name: 'Убрать «Искала» с полки' }).click();
    await expect(page.locator('.slot')).toHaveCount(7);
    await expect(sheet.locator('[data-bind="stats"]')).toContainText('7 треков');

    await sheet.getByRole('button', { name: 'Очистить полку' }).click();
    await expect(page.locator('.slot')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.locator('.empty')).toBeVisible();

    await page.reload();
    await expect(page.locator('.empty')).toBeVisible();
});
