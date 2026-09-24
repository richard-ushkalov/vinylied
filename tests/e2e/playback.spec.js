import { expect, test } from '@playwright/test';
import { fixturePaths, importTracks, mockServices, state, togglePlay } from './helpers.js';

test.beforeEach(async ({ page }) => {
    await mockServices(page);
    await page.goto('/');
    await importTracks(page, fixturePaths().slice(0, 3));
});

test('⏯ запускает и ставит на паузу; трей видит настоящее состояние', async ({ page }) => {
    await togglePlay(page);
    await expect.poll(() => state(page)).toMatchObject({ playing: true, session: 'playing' });
    const playing = await state(page);
    expect(playing.sessionTitle).toBe(playing.title);
    // Chromium: звук идёт в динамики, а сессию держит «несущий» <audio> —
    // НЕ MediaStream: такой Chrome считает разовым звуком без контролов
    expect(playing.audio).toEqual([{ paused: false, loop: true, stream: false }]);

    await togglePlay(page);
    await expect.poll(() => state(page)).toMatchObject({ playing: false, session: 'paused' });
    // после выбега «якорь» тоже стоит — иначе система думала бы, что играет
    await expect.poll(async () => (await state(page)).audio[0].paused).toBe(true);
});

test('звонок или чужой плеер (пауза якоря не нами) ставит приложение на паузу', async ({ page }) => {
    await togglePlay(page);
    await expect.poll(() => state(page)).toMatchObject({ playing: true });
    await page.evaluate(() => document.querySelector('audio').pause());
    await expect.poll(() => state(page)).toMatchObject({ playing: false, session: 'paused' });
});

test('следующий и предыдущий с клавиатуры', async ({ page }) => {
    await togglePlay(page);
    await expect.poll(() => state(page)).toMatchObject({ playing: true });
    const first = (await state(page)).title;
    await page.keyboard.press('n');
    await expect.poll(async () => (await state(page)).title).not.toBe(first);
    await page.keyboard.press('p');
    await expect.poll(async () => (await state(page)).title).toBe(first);
});

test('продолжить с места: после перезапуска тот же трек и позиция', async ({ page }) => {
    await togglePlay(page);
    await expect.poll(() => state(page)).toMatchObject({ playing: true });
    const title = (await state(page)).title;
    await page.locator('.progress').focus();
    await page.keyboard.press('Home');
    for (let i = 0; i < 2; i++) await page.keyboard.press('ArrowRight');   // +5 с за нажатие
    await expect.poll(async () => (await state(page)).position).toBeGreaterThanOrEqual(10);
    await togglePlay(page);                              // пауза — позиция записана

    await page.reload();
    await expect(page.locator('.slot--current')).toHaveCount(1);
    const restored = await state(page);
    expect(restored.title).toBe(title);
    expect(restored.playing).toBe(false);
    expect(restored.position).toBeGreaterThanOrEqual(10);

    await togglePlay(page);
    await expect.poll(() => state(page)).toMatchObject({ playing: true });
    expect((await state(page)).position).toBeGreaterThanOrEqual(10);
});

test('повтор трека: доигравший трек начинается заново', async ({ page }) => {
    await page.getByRole('button', { name: 'Полка и настройки' }).click();
    await page.locator('#library-sheet label', { hasText: 'Трека' }).click();
    await page.keyboard.press('Escape');

    await togglePlay(page);
    await expect.poll(() => state(page)).toMatchObject({ playing: true });
    const title = (await state(page)).title;
    await page.locator('.progress').focus();
    await page.keyboard.press('End');                    // за секунду до конца
    await expect.poll(async () => (await state(page)).position, { timeout: 8000 }).toBeLessThan(3);
    expect((await state(page)).title).toBe(title);
});

test('режим «Надёжный»: трек играет обычным <audio src>', async ({ page }) => {
    await page.getByRole('button', { name: 'Полка и настройки' }).click();
    await page.locator('#library-sheet').getByRole('button', { name: 'Настройки' }).click();
    await page.locator('#settings-sheet label', { hasText: 'Надёжный' }).click();
    // в этом режиме эффекты недоступны — это видно в настройках
    await expect(page.locator('#setting-crackle')).toBeDisabled();
    await page.keyboard.press('Escape');

    await togglePlay(page);
    await expect.poll(() => state(page)).toMatchObject({ playing: true, session: 'playing' });
    const { audio } = await state(page);
    expect(audio).toEqual([{ paused: false, loop: false, stream: false }]);
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await state(page)).position).toBeGreaterThanOrEqual(4);
});
