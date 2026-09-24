import { expect, test } from '@playwright/test';
import { fixturePaths, importTracks, mockServices, state, togglePlay } from './helpers.js';

// здесь service worker нужен по-настоящему
test.use({ serviceWorkers: 'allow' });

test('манифест пригоден для установки и принимает «Поделиться»', async ({ request }) => {
    const manifest = await (await request.get('/manifest.webmanifest')).json();
    expect(manifest.display).toBe('standalone');
    expect(manifest.icons.map(icon => icon.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']));
    expect(manifest.icons.some(icon => icon.purpose === 'maskable')).toBe(true);
    expect(manifest.share_target).toMatchObject({ action: './share', method: 'POST', enctype: 'multipart/form-data' });
    expect(manifest.file_handlers[0].accept['audio/mpeg']).toContain('.mp3');
    for (const icon of manifest.icons) expect((await request.get(`/${icon.src}`)).ok()).toBe(true);
});

test('без сети приложение открывается, полка на месте, музыка играет', async ({ page, context }) => {
    await mockServices(page);
    await page.goto('/');
    await page.evaluate(() => navigator.serviceWorker.ready);
    await expect.poll(() => page.evaluate(async () => {
        const cache = await caches.open('vinilyed-shell-v1');
        return (await cache.keys()).map(request => new URL(request.url).pathname);
    })).toEqual(expect.arrayContaining(['/vendor/music-metadata.js', '/src/main.js', '/styles/vinyl.css']));

    await importTracks(page, fixturePaths().slice(0, 2));
    await context.setOffline(true);
    await page.reload();
    await expect(page.locator('.slot')).toHaveCount(2);
    await togglePlay(page);
    await expect.poll(() => state(page)).toMatchObject({ playing: true, session: 'playing' });
});

test('«Поделиться → Vinilyed» кладёт файл на полку', async ({ page }) => {
    await mockServices(page);
    await page.goto('/');
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();     // теперь страницей управляет service worker
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);

    // так Android отправляет файл из «Поделиться»: multipart POST на share_target
    await page.evaluate(async () => {
        const file = await (await fetch('/tests/fixtures/.generated/zemfira-iskala.wav')).blob();
        const form = new FormData();
        form.append('audio', new File([file], 'zemfira-iskala.wav', { type: 'audio/wav', lastModified: 1 }));
        const response = await fetch('./share', { method: 'POST', body: form });
        if (!response.url.includes('share=1')) throw new Error(`нет редиректа: ${response.url}`);
    });
    await page.goto('/?share=1');
    await expect(page.locator('.slot')).toHaveCount(1);
    await expect(page.locator('.slot')).toHaveAttribute('aria-label', /Искала/);
    await expect(page).toHaveURL(/\/$/);
});
