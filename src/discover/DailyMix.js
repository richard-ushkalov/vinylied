import { Emitter } from '../core/Emitter.js';
import { LocalStore } from '../core/LocalStore.js';
import { norm } from '../lookup/Matcher.js';

const SEEDS = 5;           // от скольких треков полки отталкиваемся
const FROM_RECENT = 3;     // из них — недавно игранных, если такие есть
const RECENT_POOL = 15;    // «недавно» — это последние столько
const PER_SEED = 15;       // похожих на каждое семя
const LIMIT = 25;          // треков в миксе

/**
 * @typedef {import('../ui/RemoteTrackList.js').Suggestion} Suggestion
 * @typedef {{ id: string, title: string, artist: string }} Seedable
 * @typedef {{ day: string, built: number, seeds: { title: string, artist: string }[],
 *             items: Suggestion[] }} Mix
 *   built — когда собран: по нему видно, что микс за это время не пересобрали
 */

/** Сегодняшняя дата по местному времени: 2026-10-08. @param {Date} [date] */
export const dayOf = (date = new Date()) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

/** FNV-1a: из строки — 32-битное число. @param {string} text */
const hash = text => {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
    return h >>> 0;
};

/** Случайные числа от зерна (mulberry32): один день — одна и та же выборка. @param {number} seed */
const random = seed => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/**
 * @template T
 * @param {T[]} items
 * @param {() => number} rand
 */
const shuffle = (items, rand) => {
    for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
};

/**
 * От каких треков полки строить микс сегодня. Детерминированно по дате:
 * открыл приложение дважды за день — те же семена.
 *  - сначала из недавно игранных (что слушают сейчас);
 *  - добивка — случайные со всей полки;
 *  - только с исполнителем (без него Last.fm не с чем сравнить);
 *  - один трек на исполнителя — иначе микс был бы весь про одного.
 * @template {Seedable} T
 * @param {T[]} tracks
 * @param {{ day: string, recent?: readonly string[], count?: number }} options
 * @returns {T[]}
 */
export const pickSeeds = (tracks, { day, recent = [], count = SEEDS }) => {
    const known = tracks.filter(track => norm(track.artist) && norm(track.title));
    const byId = new Map(known.map(track => [track.id, track]));
    const rand = random(hash(day));
    /** @type {T[]} */
    const picked = [];
    const artists = new Set();
    /** @param {T} track */
    const take = track => {
        const artist = norm(track.artist);
        if (artists.has(artist)) return;
        artists.add(artist);
        picked.push(track);
    };

    const played = recent.slice(0, RECENT_POOL).map(id => byId.get(id)).filter(track => track !== undefined);
    for (const track of shuffle(played, rand)) {
        if (picked.length >= Math.min(FROM_RECENT, count)) break;
        take(track);
    }
    for (const track of shuffle([...known], rand)) {
        if (picked.length >= count) break;
        take(track);
    }
    return picked;
};

/**
 * Похожие от всех семян — по очереди из каждого списка, без повторов и
 * без того, что уже стоит на полке.
 * @param {Suggestion[][]} lists
 * @param {{ limit?: number, isOnShelf?: (item: Suggestion) => boolean }} [options]
 */
export const mergeMix = (lists, { limit = LIMIT, isOnShelf = () => false } = {}) => {
    const queues = lists.map(items => [...items]);
    const seen = new Set();
    /** @type {Suggestion[]} */
    const mix = [];
    while (mix.length < limit && queues.some(queue => queue.length)) {
        for (const queue of queues) {
            const item = queue.shift();
            if (!item || seen.has(item.key) || isOnShelf(item)) continue;
            seen.add(item.key);
            mix.push(item);
            if (mix.length >= limit) break;
        }
    }
    return mix;
};

/**
 * Микс дня: раз в день — 25 треков, похожих на то, что стоит на полке.
 * Собирается с телефона (Last.fm), Мак для этого не нужен — он нужен,
 * только чтобы послушать или скачать. Готовый микс хранится до конца
 * дня, обложки к нему подтягиваются потом и тоже сохраняются.
 *
 * События: 'progress' {done, total}, 'ready' {mix}, 'cover' {key, cover}.
 */
export class DailyMix extends Emitter {
    #store;
    /** @type {Promise<Mix> | null} */
    #building = null;

    /**
     * @param {{ lastfm: import('./LastFmClient.js').LastFmClient,
     *           tracks: () => Seedable[],
     *           history: import('./PlayHistory.js').PlayHistory,
     *           isOnShelf: (item: Suggestion) => boolean,
     *           cover?: (item: Suggestion) => Promise<string | null>,
     *           store?: LocalStore, today?: () => string }} deps
     */
    constructor({ lastfm, tracks, history, isOnShelf, cover = async () => null,
        store = new LocalStore('vinilyed:mix'), today = () => dayOf() }) {
        super();
        this.lastfm = lastfm;
        this.tracks = tracks;
        this.history = history;
        this.isOnShelf = isOnShelf;
        this.cover = cover;
        this.today = today;
        this.#store = store;
    }

    /** Сегодняшний микс, если уже собран. @returns {Mix | null} */
    get current() {
        const mix = /** @type {Mix | null} */ (this.#store.read(null));
        return mix?.day === this.today() && Array.isArray(mix.items) ? mix : null;
    }

    get building() { return this.#building !== null; }

    /** Сегодняшний микс: из памяти, а нет — собрать. */
    get() {
        return Promise.resolve(this.current ?? this.rebuild());
    }

    /** Собрать заново (кнопка «Собрать заново» и первый раз за день). */
    rebuild() {
        this.#building ??= this.#build().finally(() => { this.#building = null; });
        return this.#building;
    }

    /** @returns {Promise<Mix>} */
    async #build() {
        const day = this.today();
        const seeds = pickSeeds(this.tracks(), { day, recent: this.history.recent });
        if (!seeds.length) throw new Error('Не из чего собрать: на полке нет треков с исполнителем.');
        /** @type {Suggestion[][]} */
        const lists = [];
        for (const [i, seed] of seeds.entries()) {
            this.emit('progress', { done: i, total: seeds.length });
            try {
                lists.push(await this.lastfm.similar(seed, PER_SEED));
            } catch (error) {
                // ключ не подошёл или нет связи — дальше спрашивать бесполезно
                const code = /** @type {import('./LastFmClient.js').LastFmError} */ (error).code;
                if (code === 'key' || code === 'offline' || code === 'busy') throw error;
                lists.push([]);
            }
        }
        /** @type {Mix} */
        const mix = {
            day,
            built: Date.now(),
            seeds: seeds.map(({ title, artist }) => ({ title, artist })),
            items: mergeMix(lists, { isOnShelf: this.isOnShelf }),
        };
        this.#store.write(mix);
        this.emit('ready', { mix });
        this.#fillCovers(mix);
        return mix;
    }

    /** Обложки — потом и по одной: у iTunes лимит 20 запросов в минуту. @param {Mix} mix */
    async #fillCovers(mix) {
        for (const item of mix.items) {
            if (item.cover) continue;
            const cover = await this.cover(item).catch(() => null);
            // пока искали, микс собрали заново — этот уже не нужен
            if (this.current?.built !== mix.built) return;
            if (!cover) continue;
            item.cover = cover;
            this.#store.write(mix);
            this.emit('cover', { key: item.key, cover });
        }
    }
}
