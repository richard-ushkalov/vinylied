/**
 * Файлы, пришедшие в приложение снаружи:
 *  - «Поделиться → Vinilyed» на Android (share_target в манифесте):
 *    service worker кладёт присланное в Cache INBOX и открывает приложение;
 *  - «Открыть с помощью Vinilyed» на десктопе (file_handlers + launchQueue).
 */
export const INBOX = 'vinilyed-inbox';

export class Inbox {
    /**
     * Забирает всё, что оставил service worker, и чистит ящик.
     * @returns {Promise<File[]>}
     */
    async take() {
        if (!('caches' in globalThis)) return [];
        const cache = await caches.open(INBOX);
        const files = [];
        for (const request of await cache.keys()) {
            const response = await cache.match(request);
            if (response) {
                const blob = await response.blob();
                const name = decodeURIComponent(response.headers.get('x-file-name') ?? 'track');
                const lastModified = Number(response.headers.get('x-last-modified')) || Date.now();
                files.push(new File([blob], name, { type: blob.type, lastModified }));
            }
            await cache.delete(request);
        }
        return files;
    }

    /** @param {(files: File[]) => void} onFiles */
    listenLaunchQueue(onFiles) {
        const queue = /** @type {any} */ (globalThis).launchQueue;
        queue?.setConsumer(async params => {
            const files = await Promise.all((params.files ?? []).map(handle => handle.getFile()));
            if (files.length) onFiles(files);
        });
    }
}
