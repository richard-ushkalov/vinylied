import { Emitter } from '../core/Emitter.js';

const TIMEOUT = 20_000;
const FILE_TIMEOUT = 5 * 60_000;    // трек на медленном мобильном — это минуты, а не секунды

/**
 * @typedef {{ id: string, title: string, artist: string, album: string,
 *             duration: number, cover: string | null }} RemoteTrack
 *   результат поиска на сервере; id — id трека Spotify
 * @typedef {{ id: string, state: 'queued' | 'running' | 'done' | 'error',
 *             progress: number, stage: string, error?: string,
 *             file?: { name: string, size: number } }} Job
 * @typedef {'off' | 'unknown' | 'ok' | 'rejected' | 'offline'} ServerStatus
 *   off — нет кода; unknown — ещё не спрашивали; ok — сервер ответил;
 *   rejected — код не подошёл; offline — сервер не отвечает (Мак выключен, нет сети)
 */

/**
 * AbortSignal.any есть с iOS 17.4 — на старых iPhone собираем сами.
 * @param {AbortSignal[]} signals
 */
const anySignal = signals => {
    if (AbortSignal.any) return AbortSignal.any(signals);
    const controller = new AbortController();
    for (const signal of signals) {
        if (signal.aborted) { controller.abort(signal.reason); break; }
        signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
    }
    return controller.signal;
};

/** Ошибка, которую можно показать пользователю как есть. */
export class DownloadError extends Error {
    /** @param {string} message @param {{ status?: number, offline?: boolean }} [details] */
    constructor(message, { status = 0, offline = false } = {}) {
        super(message);
        this.name = 'DownloadError';
        this.status = status;
        this.offline = offline;
    }
}

/**
 * Клиент сервера скачивания (server/ в репозитории, на Маке владельца).
 * Каждый запрос — с кодом доступа. Статус соединения — событием
 * 'status': по нему настройки и панель поиска объясняют, что не так.
 */
export class DownloadServer extends Emitter {
    /** @type {ServerStatus} */
    #status = 'off';

    /**
     * @param {{ settings: import('../core/Settings.js').Settings, fallback: string,
     *           fetch?: typeof fetch }} deps
     *   fallback — встроенный адрес сервера (src/config.js)
     */
    constructor({ settings, fallback, fetch = globalThis.fetch.bind(globalThis) }) {
        super();
        this.settings = settings;
        this.fallback = fallback;
        this.fetch = fetch;
        this.#status = this.enabled ? 'unknown' : 'off';
    }

    attach() {
        this.settings.on('change', ({ key }) => {
            if (key === 'downloadCode' || key === 'downloadServer') this.#setStatus(this.enabled ? 'unknown' : 'off');
        });
    }

    get url() { return this.settings.get('downloadServer') || this.fallback; }
    get code() { return this.settings.get('downloadCode'); }
    get enabled() { return Boolean(this.code && this.url); }
    get status() { return this.#status; }

    /** Есть ли связь и подходит ли код. Ошибки не бросает — всё в статусе. */
    async check() {
        if (!this.enabled) return this.#status;
        await this.#json('/v1/health').catch(() => {});
        return this.#status;
    }

    /**
     * @param {string} query
     * @param {{ signal?: AbortSignal }} [options]
     * @returns {Promise<RemoteTrack[]>}
     */
    async search(query, { signal } = {}) {
        const data = await this.#json(`/v1/search?q=${encodeURIComponent(query)}&limit=8`, { signal });
        return Array.isArray(data?.results) ? data.results : [];
    }

    /** @param {string} trackId @returns {Promise<Job>} */
    start(trackId) {
        return this.#json('/v1/downloads', { method: 'POST', body: { id: trackId } });
    }

    /** @param {string} jobId @param {{ signal?: AbortSignal }} [options] @returns {Promise<Job>} */
    job(jobId, { signal } = {}) {
        return this.#json(`/v1/downloads/${jobId}`, { signal });
    }

    /**
     * Скачанный трек. Читаем потоком, чтобы показывать и эту часть пути.
     * @param {string} jobId
     * @param {(fraction: number) => void} [onProgress]
     * @returns {Promise<File>}
     */
    async file(jobId, onProgress = () => {}) {
        const response = await this.#request(`/v1/downloads/${jobId}/file`, { timeout: FILE_TIMEOUT });
        const total = Number(response.headers.get('Content-Length')) || 0;
        const type = response.headers.get('Content-Type')?.split(';')[0] || 'audio/mp4';
        const name = decodeURIComponent(response.headers.get('X-Filename') || '') || `track.${type === 'audio/mpeg' ? 'mp3' : 'm4a'}`;

        /** @type {BlobPart[]} */
        const chunks = [];
        const reader = response.body?.getReader();
        if (reader) {
            let received = 0;
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
                received += value.byteLength;
                if (total) onProgress(Math.min(received / total, 1));
            }
        } else {
            chunks.push(await response.blob());
        }
        onProgress(1);
        return new File(chunks, name, { type, lastModified: Date.now() });
    }

    /**
     * @param {string} path
     * @param {{ method?: string, body?: unknown, signal?: AbortSignal }} [options]
     */
    async #json(path, options) {
        const response = await this.#request(path, options);
        return response.json();
    }

    /**
     * @param {string} path
     * @param {{ method?: string, body?: unknown, signal?: AbortSignal, timeout?: number }} [options]
     */
    async #request(path, { method = 'GET', body, signal, timeout = TIMEOUT } = {}) {
        if (!this.enabled) throw new DownloadError('Нет кода доступа к серверу загрузки');
        const signals = [AbortSignal.timeout(timeout), ...(signal ? [signal] : [])];
        let response;
        try {
            response = await this.fetch(`${this.url}${path}`, {
                method,
                headers: {
                    Authorization: `Bearer ${this.code}`,
                    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
                },
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: anySignal(signals),
                cache: 'no-store',
            });
        } catch (error) {
            // отменили сами (новый запрос в поиске) — это не «сервер лежит»
            if (signal?.aborted) throw error;
            this.#setStatus('offline');
            throw new DownloadError('Сервер загрузки недоступен', { offline: true });
        }
        if (response.status === 401) {
            this.#setStatus('rejected');
            throw new DownloadError('Код доступа не подошёл', { status: 401 });
        }
        this.#setStatus('ok');
        if (!response.ok) {
            const data = await response.json().catch(() => null);
            throw new DownloadError(data?.message || `Сервер ответил ошибкой ${response.status}`, { status: response.status });
        }
        return response;
    }

    /** @param {ServerStatus} status */
    #setStatus(status) {
        if (status === this.#status) return;
        this.#status = status;
        this.emit('status', { status });
    }
}

/** @param {ServerStatus} status */
export const describeServerStatus = status => ({
    off: 'Скачивание выключено: нет кода доступа.',
    unknown: 'Проверяю связь с сервером…',
    ok: 'Сервер на связи.',
    rejected: 'Код не подошёл — попросите новый у владельца сервера.',
    offline: 'Сервер недоступен: Мак выключен или нет интернета.',
})[status];
