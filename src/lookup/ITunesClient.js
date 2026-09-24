import { getJson } from './http.js';
import { throttle } from './throttle.js';

/**
 * @typedef {{ trackName?: string, artistName: string, collectionName: string,
 *             artworkUrl100?: string }} ITunesItem
 */

/**
 * iTunes Search API: без ключа, с открытым CORS.
 * Наружу, на серверы Apple, уходят название и исполнитель трека.
 */
export class ITunesClient {
    /** @param {{ fetch?: typeof fetch, interval?: number }} [options] */
    constructor({ fetch, interval = 3100 } = {}) {
        this.fetch = fetch;
        this.wait = throttle(interval);
    }

    /**
     * @param {string} term
     * @param {'song' | 'album'} entity
     * @returns {Promise<ITunesItem[]>}
     */
    async search(term, entity) {
        if (!term?.trim()) return [];
        await this.wait();
        const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term.trim())}`
            + `&entity=${entity}&limit=5`;
        const data = await getJson(url, { fetch: this.fetch });
        return data?.results ?? [];
    }

    /**
     * В ответе миниатюра 100×100; размер зашит прямо в адрес.
     * @param {ITunesItem} item
     * @param {number} [size]
     */
    static artworkUrl(item, size = 600) {
        return item.artworkUrl100?.replace(/\/\d+x\d+bb\./, `/${size}x${size}bb.`) ?? null;
    }

    /** «Song - Single» → «Song»: приписки магазина на корешке не нужны. @param {string} name */
    static cleanAlbum(name) {
        return (name ?? '').replace(/\s+-\s+(Single|EP)$/i, '').trim();
    }
}
