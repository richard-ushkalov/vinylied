import { norm } from '../lookup/Matcher.js';
import { throttle } from '../lookup/throttle.js';

const API = 'https://ws.audioscrobbler.com/2.0/';
const TIMEOUT = 15_000;
const ENOUGH = 5;          // меньше похожих — добираем по исполнителю
const ARTISTS = 4;         // у скольких похожих исполнителей берём лучшие треки
const PER_ARTIST = 3;

/**
 * @typedef {import('../ui/RemoteTrackList.js').Suggestion} Suggestion
 * @typedef {'key' | 'busy' | 'offline' | 'failed'} LastFmFailure
 */

/** Ошибка, которую можно показать как есть. */
export class LastFmError extends Error {
    /** @param {string} message @param {LastFmFailure} code */
    constructor(message, code) {
        super(message);
        this.name = 'LastFmError';
        this.code = code;
    }
}

/**
 * Last.fm отдаёт один элемент объектом, а не массивом из одного.
 * @param {unknown} value
 * @returns {any[]}
 */
const list = value => (Array.isArray(value) ? value : value ? [value] : []);

/**
 * @param {any} raw трек из ответа Last.fm
 * @returns {Suggestion | null}
 */
export const toSuggestion = raw => {
    const title = typeof raw?.name === 'string' ? raw.name.trim() : '';
    const artist = (typeof raw?.artist === 'string' ? raw.artist : raw?.artist?.name ?? raw?.artist?.['#text'] ?? '').trim();
    if (!title || !artist) return null;
    return {
        key: `${norm(artist)}|${norm(title)}`,
        title,
        artist,
        album: '',
        // в ответах getSimilar и getTopTracks — секунды
        duration: Math.round(Number(raw.duration)) || 0,
        // картинки треков у Last.fm давно заглушки — обложку ищем отдельно
        cover: null,
    };
};

/**
 * По очереди из каждого списка: похожие разных исполнителей вперемешку,
 * а не первые пять от одного.
 * @template T
 * @param {T[][]} lists
 * @returns {T[]}
 */
export const interleave = lists => {
    const out = [];
    for (let i = 0; lists.some(items => i < items.length); i++) {
        for (const items of lists) if (i < items.length) out.push(items[i]);
    }
    return out;
};

/**
 * Last.fm: «что ещё слушают те, кто слушает это». Официальный API,
 * бесплатный ключ; на входе и на выходе — названия и исполнители, ровно
 * то, что лежит в библиотеке. Наружу уходят только они.
 *
 * Слабое место — новые и редкие треки: у них мало прослушиваний, и
 * похожих Last.fm не знает. Тогда добираем по исполнителю: похожие
 * исполнители и их лучшие треки.
 */
export class LastFmClient {
    /** @param {{ key?: string, fetch?: typeof fetch, interval?: number }} [options] */
    constructor({ key = '', fetch = globalThis.fetch?.bind(globalThis), interval = 250 } = {}) {
        this.key = key;
        this.fetch = fetch;
        // правило Last.fm — не чаще пяти запросов в секунду
        this.wait = throttle(interval);
    }

    /** @param {string} key */
    setKey(key) { this.key = key; }

    get enabled() { return Boolean(this.key); }

    /**
     * Похожие на трек: сначала сами треки, не хватило — по исполнителю.
     * @param {{ artist: string, title: string }} track
     * @param {number} [limit]
     * @returns {Promise<Suggestion[]>}
     */
    async similar({ artist, title }, limit = 30) {
        const data = await this.#call('track.getSimilar', { artist, track: title, limit, autocorrect: 1 });
        const found = list(data?.similartracks?.track).map(toSuggestion).filter(item => item !== null);
        if (found.length >= ENOUGH) return found;
        const more = await this.#byArtist(artist);
        const seen = new Set(found.map(item => item.key));
        return [...found, ...more.filter(item => !seen.has(item.key))];
    }

    /** @param {string} artist @returns {Promise<Suggestion[]>} */
    async #byArtist(artist) {
        const data = await this.#call('artist.getSimilar', { artist, limit: ARTISTS + 2, autocorrect: 1 });
        const names = list(data?.similarartists?.artist).map(item => item?.name).filter(Boolean).slice(0, ARTISTS);
        const lists = [];
        for (const name of names) {
            const top = await this.#call('artist.getTopTracks', { artist: name, limit: PER_ARTIST, autocorrect: 1 });
            lists.push(list(top?.toptracks?.track).map(toSuggestion).filter(item => item !== null));
        }
        return interleave(lists);
    }

    /**
     * @param {string} method
     * @param {Record<string, string | number>} params
     * @returns {Promise<any>} null — Last.fm такого не знает
     */
    async #call(method, params) {
        if (!this.key) throw new LastFmError('Нет ключа Last.fm', 'key');
        await this.wait();
        const query = new URLSearchParams({ method, ...Object.fromEntries(
            Object.entries(params).map(([name, value]) => [name, String(value)])), api_key: this.key, format: 'json' });
        let response;
        try {
            response = await this.fetch(`${API}?${query}`, { signal: AbortSignal.timeout(TIMEOUT) });
        } catch {
            throw new LastFmError('Last.fm не отвечает', 'offline');
        }
        const data = await response.json().catch(() => null);
        switch (data?.error) {
            case undefined: break;
            case 6: return null;                      // нет такого трека или исполнителя
            case 10: case 26: throw new LastFmError('Ключ Last.fm не подошёл', 'key');
            case 29: throw new LastFmError('Last.fm просит подождать минуту', 'busy');
            case 11: case 16: throw new LastFmError('Last.fm сейчас не отвечает', 'offline');
            default: throw new LastFmError(data.message || 'Last.fm ответил ошибкой', 'failed');
        }
        if (!response.ok || !data) throw new LastFmError(`Last.fm ответил ошибкой ${response.status}`, 'failed');
        return data;
    }
}
