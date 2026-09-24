import { norm } from '../lookup/Matcher.js';

// Разные рипы одной песни расходятся на секунду-другую; концертная версия
// или ремикс — уже на десятки секунд.
const DURATION_TOLERANCE = 2;

/**
 * @typedef {{ title: string, artist: string, duration: number }} Song
 * @typedef {Song & { id: string, record: import('./Library.js').TrackRecord }} Candidate
 */

/**
 * «Та же песня»: название и исполнитель совпадают буква в букву (без
 * регистра и знаков), длительность — с допуском. Без исполнителя не
 * склеиваем: безымянные «Intro» с разных альбомов — разные треки.
 * @param {Song} a
 * @param {Song} b
 */
export const sameSong = (a, b) => {
    const artist = norm(a.artist), title = norm(a.title);
    if (!artist || !title || artist !== norm(b.artist) || title !== norm(b.title)) return false;
    // длительность неизвестна — судим по подписям
    if (!a.duration || !b.duration) return true;
    return Math.abs(a.duration - b.duration) <= DURATION_TOLERANCE;
};

/** @param {Blob} blob */
export const sha256 = async blob => {
    const hash = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
};

/**
 * @template T
 * @param {T[]} items
 * @param {(item: T) => string | number | null} keyOf
 */
const groupIndices = (items, keyOf) => {
    /** @type {Map<string | number, number[]>} */
    const groups = new Map();
    items.forEach((item, index) => {
        const key = keyOf(item);
        if (key === null) return;
        groups.set(key, [...groups.get(key) ?? [], index]);
    });
    return [...groups.values()].filter(indices => indices.length > 1);
};

/** @param {Candidate} track */
const bitrate = track => track.record.size / (track.duration || 1);

/**
 * Кого оставить: играющий → опознанный по сети → лучшего качества → старший.
 * @param {string | null} current
 * @returns {(a: Candidate, b: Candidate) => number}
 */
const better = current => (a, b) =>
    Number(b.id === current) - Number(a.id === current)
    || Number(b.record.lookup?.status === 'found') - Number(a.record.lookup?.status === 'found')
    || bitrate(b) - bitrate(a)
    || a.record.addedAt - b.record.addedAt;

/**
 * Повторы на полке. Два правила:
 *  1. та же песня (sameSong) — хоть другим файлом;
 *  2. тот же файл под другим именем — одинаковый размер и SHA-256.
 *     Хешируем только файлы одного размера: читать всю полку незачем.
 *
 * Правила сцепляются: если A — копия B, а B — та же песня, что C,
 * все трое — одна группа.
 *
 * @template {Candidate} T
 * @param {Iterable<T>} tracks
 * @param {{ current?: string | null, digest?: (blob: Blob) => Promise<string> }} [options]
 * @returns {Promise<{ keep: T, remove: T[] }[]>} группы в порядке полки
 */
export const findDuplicates = async (tracks, { current = null, digest = sha256 } = {}) => {
    const list = [...tracks];
    const parent = list.map((_, index) => index);
    /** @param {number} i @returns {number} */
    const root = i => (parent[i] === i ? i : (parent[i] = root(parent[i])));
    /** @param {number} a @param {number} b */
    const join = (a, b) => { parent[root(a)] = root(b); };

    const songKey = (/** @type {T} */ track) => {
        const artist = norm(track.artist), title = norm(track.title);
        return artist && title ? `${artist}|${title}` : null;
    };
    for (const indices of groupIndices(list, songKey)) {
        for (const [n, i] of indices.entries()) {
            for (const j of indices.slice(n + 1)) if (sameSong(list[i], list[j])) join(i, j);
        }
    }

    for (const indices of groupIndices(list, track => track.record.size)) {
        /** @type {Map<string, number>} */
        const seen = new Map();
        for (const i of indices) {
            const hash = await digest(list[i].record.file);
            const twin = seen.get(hash);
            if (twin === undefined) seen.set(hash, i);
            else join(i, twin);
        }
    }

    /** @type {Map<number, T[]>} */
    const groups = new Map();
    list.forEach((track, index) => {
        const key = root(index);
        groups.set(key, [...groups.get(key) ?? [], track]);
    });
    return [...groups.values()]
        .filter(members => members.length > 1)
        .map(members => {
            const [keep, ...remove] = [...members].sort(better(current));
            return { keep, remove };
        });
};
