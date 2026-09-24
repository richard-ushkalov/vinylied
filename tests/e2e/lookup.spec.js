import { expect, test } from '@playwright/test';
import { fixturePaths, importTracks, mockServices, withAcoustIdKey } from './helpers.js';

const song = (trackName, artistName, collectionName) => ({
    trackName, artistName, collectionName, artworkUrl100: 'https://example.test/art/100x100bb.jpg',
});

test('iTunes: подписи и обложка меняются — и у трека со своей обложкой тоже', async ({ page }) => {
    await mockServices(page, {
        itunes: url => {
            const term = url.searchParams.get('term') ?? '';
            if (term === 'Кино Группа крови') return [song('Группа крови (Remastered)', 'Кино', 'Группа крови - Single')];
            if (term.includes('Queen')) return [song('Bohemian Rhapsody', 'Queen', 'A Night at the Opera')];
            // на мусор iTunes всё равно что-нибудь вернёт — это нельзя принимать
            return [song('Случайная песня', 'Кто-то', 'Чужой альбом')];
        },
    });
    await page.goto('/');
    await importTracks(page, fixturePaths(['kino-gruppa-krovi.wav', '03 - Queen - Bohemian Rhapsody.wav', 'garbage.wav']));

    const kino = page.locator('.slot').nth(0);
    const before = await kino.locator('.vinyl__frontside').getAttribute('src');
    await expect(kino).toHaveAttribute('aria-label', 'Группа крови (Remastered) — Кино — Группа крови', { timeout: 20_000 });
    await expect.poll(() => kino.locator('.vinyl__frontside').getAttribute('src')).not.toBe(before);

    await expect(page.locator('.slot').nth(1)).toHaveAttribute('aria-label', 'Bohemian Rhapsody — Queen — A Night at the Opera', { timeout: 20_000 });
    // мусорные теги не прошли сверку
    await expect(page.locator('.slot').nth(2)).toHaveAttribute('aria-label', /^asdf/);

    // найденное хранится в библиотеке: после перезапуска и без сети — то же самое
    await page.reload();
    await expect(page.locator('.slot').nth(0)).toHaveAttribute('aria-label', /Remastered/);
});

test('AcoustID: трек узнаётся по звуку, обложка — из Cover Art Archive', async ({ page }) => {
    await withAcoustIdKey(page, 'test-key');
    let first = true;
    const calls = await mockServices(page, {
        acoustid: () => {
            if (!first) return { status: 'ok', results: [] };
            first = false;
            return {
                status: 'ok',
                results: [{ id: 'x', score: 0.94, recordings: [{
                    id: 'rec', title: 'Весна', artists: [{ name: 'Дельфин' }],
                    releasegroups: [{ id: 'rg-1', title: 'Существо', type: 'Album' }],
                }] }],
            };
        },
    });
    await page.goto('/');
    await importTracks(page, fixturePaths(['garbage.wav', 'splin-vykhoda-net.wav']));

    await expect(page.locator('.slot').nth(0)).toHaveAttribute('aria-label', 'Весна — Дельфин — Существо', { timeout: 20_000 });
    expect(calls.images.some(url => url.includes('coverartarchive.org/release-group/rg-1'))).toBe(true);
    // в AcoustID уходит отпечаток и длительность, а не звук
    await expect.poll(() => calls.acoustid.length).toBeGreaterThanOrEqual(2);
    expect(calls.acoustid[0]).toBe('20');
});

test('с выключенным поиском в интернете запросов нет', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('vinilyed:settings',
        JSON.stringify({ v: 1, values: { onlineLookup: false } })));
    const calls = await mockServices(page);
    await page.goto('/');
    await importTracks(page, fixturePaths().slice(0, 2));
    await page.waitForTimeout(2500);
    expect(calls.itunes).toEqual([]);
    expect(calls.acoustid).toEqual([]);
});
