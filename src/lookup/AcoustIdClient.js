import { NetworkError } from './http.js';
import { throttle } from './throttle.js';

const ENDPOINT = 'https://api.acoustid.org/v2/lookup';
const INVALID_KEY = 4;   // код ошибки AcoustID «неверный ключ приложения»

/**
 * @typedef {{ id: string, title?: string, type?: string, secondarytypes?: string[] }} ReleaseGroup
 * @typedef {{ id: string, title?: string, duration?: number,
 *             artists?: { name: string, joinphrase?: string }[],
 *             releasegroups?: ReleaseGroup[] }} Recording
 * @typedef {{ id: string, score: number, recordings?: Recording[] }} AcoustIdResult
 * @typedef {{ title: string, artist: string, album: string, releaseGroupId: string | null,
 *             recordingId: string, score: number }} AcoustIdMatch
 */

/**
 * Альбом для корешка: обычный студийный альбом лучше сборника,
 * концертника и саундтрека; сингл и EP — между ними.
 * @param {ReleaseGroup} group
 */
const groupRank = group => {
    const plain = !group.secondarytypes?.length;
    if (group.type === 'Album' && plain) return 3;
    if ((group.type === 'Single' || group.type === 'EP') && plain) return 2;
    if (group.type === 'Album') return 1;
    return 0;
};

/**
 * JSONP — запасной путь, если браузер не пустит обычный запрос по CORS.
 * AcoustID поддерживает его официально (format=jsonp).
 * @param {string} url
 * @returns {Promise<any>}
 */
const jsonp = url => new Promise((resolve, reject) => {
    const name = `__acoustid${Date.now()}${Math.random().toString(36).slice(2)}`;
    const script = document.createElement('script');
    const scope = /** @type {any} */ (window);
    const cleanup = () => { delete scope[name]; script.remove(); clearTimeout(timer); };
    const timer = setTimeout(() => { cleanup(); reject(new NetworkError('AcoustID: нет ответа')); }, 15_000);
    scope[name] = data => { cleanup(); resolve(data); };
    script.onerror = () => { cleanup(); reject(new NetworkError('AcoustID недоступен')); };
    script.src = `${url}&jsoncallback=${name}`;
    document.head.append(script);
});

/**
 * Распознавание по звуку: отпечаток Chromaprint → AcoustID → записи
 * MusicBrainz. Нужен бесплатный ключ приложения (см. src/config.js).
 * Наружу уходит только отпечаток и длительность — не сам звук.
 */
export class AcoustIdClient {
    #rejected = false;

    /** @param {{ key: string, fetch?: typeof fetch, jsonp?: typeof jsonp }} options */
    constructor({ key, fetch = globalThis.fetch?.bind(globalThis), jsonp: load = jsonp }) {
        this.key = key;
        this.fetch = fetch;
        this.jsonp = load;
        this.wait = throttle(350);
    }

    /** Ключ задан и сервис его не отверг. */
    get enabled() { return Boolean(this.key) && !this.#rejected; }

    /**
     * @param {{ fingerprint: string, duration: number }} print
     * @returns {Promise<AcoustIdResult[]>}
     */
    async lookup({ fingerprint, duration }) {
        if (globalThis.navigator?.onLine === false) throw new NetworkError('Нет сети');
        await this.wait();
        const query = `client=${encodeURIComponent(this.key)}&meta=recordings+releasegroups+compress`
            + `&duration=${Math.round(duration)}&fingerprint=${encodeURIComponent(fingerprint)}`;

        let data;
        try {
            const response = await this.fetch(`${ENDPOINT}?format=json&${query}`, { signal: AbortSignal.timeout(15_000) });
            data = await response.json();
        } catch {
            data = await this.jsonp(`${ENDPOINT}?format=jsonp&${query}`);
        }

        if (data?.status === 'error') {
            if (data.error?.code === INVALID_KEY) {
                this.#rejected = true;
                console.warn('AcoustID отверг ключ — распознавание по звуку выключено до перезапуска');
                return [];
            }
            throw new NetworkError(`AcoustID: ${data.error?.message ?? 'ошибка'}`);
        }
        return data?.results ?? [];
    }

    /**
     * Лучшее совпадение с уверенностью не ниже minScore — или null.
     * @param {AcoustIdResult[]} results
     * @param {number} [minScore]
     * @returns {AcoustIdMatch | null}
     */
    static pickBest(results, minScore = 0.75) {
        const ranked = results
            .filter(result => result.score >= minScore && result.recordings?.length)
            .sort((a, b) => b.score - a.score);

        for (const result of ranked) {
            const recordings = result.recordings
                .filter(recording => recording.title && recording.artists?.length)
                .sort((a, b) => (b.releasegroups?.length ?? 0) - (a.releasegroups?.length ?? 0));
            const recording = recordings[0];
            if (!recording) continue;

            const artist = recording.artists.map(a => `${a.name}${a.joinphrase ?? ''}`).join('').trim();
            const group = [...(recording.releasegroups ?? [])].sort((a, b) => groupRank(b) - groupRank(a))[0];
            return {
                title: recording.title,
                artist,
                album: group?.title ?? '',
                releaseGroupId: group?.id ?? null,
                recordingId: recording.id,
                score: result.score,
            };
        }
        return null;
    }
}
