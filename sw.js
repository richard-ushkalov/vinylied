/**
 * Service worker: делает приложение офлайновым и принимает «Поделиться».
 *
 * Стратегия для своих файлов — сначала сеть (с таймаутом), потом кеш.
 * Так правки в коде подхватываются без ручного поднятия версии кеша,
 * а без сети всё открывается из кеша. Чужие адреса (iTunes, AcoustID,
 * обложки) идут мимо: поиск обложек и так работает только онлайн.
 *
 * Список SHELL обновляется командой `npm run precache`; unit-тест
 * проверяет, что в нём нет пропусков, — иначе без сети не хватило бы
 * модуля, который браузер при первом заходе ещё не успел закешировать.
 */
const CACHE = 'vinilyed-shell-v1';
const INBOX = 'vinilyed-inbox';     // то же имя — в src/library/Inbox.js
const TIMEOUT = 3000;

// precache:start
const SHELL = [
    './',
    './index.html',
    './manifest.webmanifest',
    './icons/apple-touch-icon.png',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './icons/icon-maskable-512.png',
    './icons/icon-maskable.svg',
    './icons/icon.svg',
    './src/audio/Player.js',
    './src/audio/VinylChain.js',
    './src/audio/engines/BufferEngine.js',
    './src/audio/engines/ElementEngine.js',
    './src/audio/routes/Anchor.js',
    './src/audio/routes/CarrierRoute.js',
    './src/audio/routes/StreamRoute.js',
    './src/audio/silence.js',
    './src/config.js',
    './src/core/Emitter.js',
    './src/core/FrameLoop.js',
    './src/core/LocalStore.js',
    './src/core/Settings.js',
    './src/core/format.js',
    './src/core/platform.js',
    './src/library/Database.js',
    './src/library/Inbox.js',
    './src/library/Library.js',
    './src/library/Track.js',
    './src/lookup/AcoustIdClient.js',
    './src/lookup/CoverArtArchive.js',
    './src/lookup/Fingerprinter.js',
    './src/lookup/ITunesClient.js',
    './src/lookup/LookupQueue.js',
    './src/lookup/Matcher.js',
    './src/lookup/MetadataResolver.js',
    './src/lookup/http.js',
    './src/lookup/throttle.js',
    './src/main.js',
    './src/media/Artwork.js',
    './src/media/Palette.js',
    './src/media/TagReader.js',
    './src/playback/DiscSpinner.js',
    './src/playback/MediaSessionBridge.js',
    './src/playback/PlaybackController.js',
    './src/playback/Queue.js',
    './src/playback/ResumeStore.js',
    './src/playback/sources/LocalSource.js',
    './src/pwa/InstallPrompt.js',
    './src/pwa/registerServiceWorker.js',
    './src/ui/Dock.js',
    './src/ui/EmptyState.js',
    './src/ui/FilePicker.js',
    './src/ui/Hotkeys.js',
    './src/ui/LibrarySheet.js',
    './src/ui/ProgressBar.js',
    './src/ui/SettingsSheet.js',
    './src/ui/StatusLine.js',
    './src/ui/Theme.js',
    './src/ui/shelf/Shelf.js',
    './src/ui/shelf/ShelfScroller.js',
    './src/ui/shelf/VinylView.js',
    './styles/base.css',
    './styles/controls.css',
    './styles/dock.css',
    './styles/layout.css',
    './styles/progress.css',
    './styles/sheet.css',
    './styles/shelf.css',
    './styles/tokens.css',
    './styles/vinyl.css',
    './vendor/chromaprint.js',
    './vendor/chromaprint.wasm',
    './vendor/music-metadata.js',
];
// precache:end

self.addEventListener('install', event => {
    event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const keep = new Set([CACHE, INBOX]);
        for (const key of await caches.keys()) {
            if (!keep.has(key)) await caches.delete(key);
        }
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', event => {
    const { request } = event;
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;

    if (request.method === 'POST' && url.pathname.endsWith('/share')) {
        event.respondWith(receiveShare(request));
        return;
    }
    if (request.method !== 'GET') return;
    event.respondWith(networkFirst(event, request));
});

/**
 * @param {FetchEvent} event
 * @param {Request} request
 */
async function networkFirst(event, request) {
    const cache = await caches.open(CACHE);
    // любая навигация внутри приложения — это index.html (share, ?параметры)
    const key = request.mode === 'navigate' ? './index.html' : request;

    const network = fetch(request).then(response => {
        if (response.ok && response.type === 'basic') {
            const copy = response.clone();
            event.waitUntil(cache.put(key, copy));
        }
        return response;
    });
    // сеть думает дольше таймаута — отдаём кеш, а она пусть обновит его в фоне
    event.waitUntil(network.catch(() => {}));

    const timeout = new Promise(resolve => setTimeout(resolve, TIMEOUT, null));
    try {
        const response = await Promise.race([network, timeout]);
        if (response) return response;
    } catch { /* сети нет — идём в кеш */ }

    const cached = await cache.match(key, { ignoreSearch: true });
    return cached ?? network;
}

/**
 * «Поделиться → Vinilyed» (share_target в манифесте). Файлы кладём
 * в отдельный кеш-ящик и открываем приложение — оно заберёт их само.
 * @param {Request} request
 */
async function receiveShare(request) {
    const data = await request.formData();
    const files = data.getAll('audio').filter(item => typeof item !== 'string');
    const cache = await caches.open(INBOX);
    const stamp = Date.now();
    await Promise.all(files.map((file, index) => cache.put(
        `./inbox/${stamp}-${index}`,
        new Response(file, {
            headers: {
                'content-type': file.type || 'application/octet-stream',
                'x-file-name': encodeURIComponent(file.name),
                'x-last-modified': String(file.lastModified || stamp),
            },
        }),
    )));
    return Response.redirect('./?share=1', 303);
}
