import { expect, test } from '@playwright/test';
import { fixturePaths, importTracks, mockServices, state, togglePlay } from './helpers.js';

test.beforeEach(async ({ page }) => {
    await mockServices(page);
    await page.goto('/');
    await importTracks(page, fixturePaths().slice(0, 2));
    await togglePlay(page);
    await expect.poll(() => state(page)).toMatchObject({ playing: true });
});

test('тап по полосе перематывает туда, куда попал палец', async ({ page }) => {
    const bar = page.locator('.progress');
    const box = await bar.boundingBox();
    // зона захвата — 40px: попадаем не в саму линию, а выше неё
    await page.mouse.click(box.x + box.width * 0.5, box.y + 8);
    await expect.poll(async () => (await state(page)).position).toBeGreaterThanOrEqual(9);
    expect((await state(page)).position).toBeLessThanOrEqual(12);
});

test('протяжка показывает время над пальцем и перематывает при отпускании', async ({ page }) => {
    const bar = page.locator('.progress');
    const box = await bar.boundingBox();
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width * 0.2, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.8, y, { steps: 8 });
    await expect(bar).toHaveClass(/progress--active/);
    await expect(page.locator('.progress__bubble')).toHaveText(/^0:1[5-7]$/);
    await page.mouse.up();
    await expect(bar).not.toHaveClass(/progress--active/);
    await expect.poll(async () => (await state(page)).position).toBeGreaterThanOrEqual(15);
});

test('перемотка, пока трек ещё грузится, не теряется', async ({ page }) => {
    await page.keyboard.press('n');                        // следующий — снова загрузка
    await page.locator('.progress').focus();
    await page.keyboard.press('End');
    await expect.poll(async () => (await state(page)).position).toBeGreaterThanOrEqual(15);
});
