import { expect, test } from '@playwright/test';
import { importTracks, mockServices, state, togglePlay } from './helpers.js';

test.beforeEach(async ({ page }) => {
    await mockServices(page);
    await page.goto('/');
    await importTracks(page);
});

test('поиск оставляет только подходящие конверты', async ({ page }) => {
    await page.getByRole('button', { name: 'Поиск по полке' }).click();
    await page.getByRole('searchbox', { name: 'Поиск по полке' }).fill('земфира');
    await expect(page.locator('.slot:not(.slot--gone)')).toHaveCount(1);
    await expect(page.locator('.slot:not(.slot--gone)')).toHaveAttribute('aria-label', /Искала/);

    await page.getByRole('button', { name: 'Закрыть поиск' }).click();
    await expect(page.locator('.slot--gone')).toHaveCount(0);
});

test('регрессия: играющий трек уходит из поиска целиком, мини-обложка возвращает к нему', async ({ page }) => {
    await togglePlay(page);
    await expect.poll(() => state(page)).toMatchObject({ playing: true });
    const current = page.locator('.slot--current');
    // ищем то, что НЕ играет
    const playing = await current.getAttribute('aria-label');
    const query = playing?.includes('Земфира') ? 'аквариум' : 'земфира';

    await page.getByRole('button', { name: 'Поиск по полке' }).click();
    await page.getByRole('searchbox', { name: 'Поиск по полке' }).fill(query);
    await expect(current).toHaveClass(/slot--gone/);
    // раньше диск играющего трека оставался видимым поверх полки
    await expect.poll(() => current.locator('.disc').evaluate(disc => getComputedStyle(disc).visibility)).toBe('hidden');
    // музыка при этом играет, а в углу панели — её обложка
    expect((await state(page)).playing).toBe(true);
    await expect(page.locator('.dock')).toHaveClass(/dock--cover/);

    await page.getByRole('button', { name: 'Показать играющую пластинку' }).click();
    await expect(page.locator('.dock')).not.toHaveClass(/dock--search/);
    await expect(current).not.toHaveClass(/slot--gone/);
    await expect(page.locator('.dock')).not.toHaveClass(/dock--cover/, { timeout: 5000 });
});

test('«следующий» во время поиска ходит только по найденным', async ({ page }) => {
    await page.getByRole('button', { name: 'Поиск по полке' }).click();
    await page.getByRole('searchbox', { name: 'Поиск по полке' }).fill('а');   // несколько, но не все
    await expect.poll(() => page.locator('.slot:not(.slot--gone)').count()).toBeLessThan(8);
    const visible = await page.locator('.slot:not(.slot--gone)').evaluateAll(slots => slots.map(s => s.getAttribute('aria-label')));
    await togglePlay(page);
    for (let i = 0; i < visible.length + 1; i++) {
        await page.locator('.dock').press('n');
        const current = await page.locator('.slot--current').getAttribute('aria-label');
        expect(visible).toContain(current);
    }
});
