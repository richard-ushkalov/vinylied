import { LocalStore } from '../core/LocalStore.js';

const LIMIT = 50;

/**
 * Что играло недавно — id треков, свежие первыми. По ним микс дня
 * выбирает, от чего отталкиваться: от того, что слушают сейчас, а не от
 * всей полки поровну. Живёт только на этом устройстве.
 */
export class PlayHistory {
    #store;
    /** @type {string[]} */
    #ids;

    /** @param {{ store?: LocalStore, limit?: number }} [options] */
    constructor({ store = new LocalStore('vinilyed:history'), limit = LIMIT } = {}) {
        this.#store = store;
        this.limit = limit;
        const saved = store.read([]);
        this.#ids = Array.isArray(saved) ? saved.filter(id => typeof id === 'string') : [];
    }

    /** @param {string} id */
    add(id) {
        if (this.#ids[0] === id) return;
        this.#ids = [id, ...this.#ids.filter(other => other !== id)].slice(0, this.limit);
        this.#store.write(this.#ids);
    }

    /** @returns {readonly string[]} */
    get recent() { return this.#ids; }
}
