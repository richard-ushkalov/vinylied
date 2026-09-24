import { Emitter } from '../core/Emitter.js';

const TIMEOUT = 20_000;
// поиск и поиск звука для прослушивания ждут дольше: Spotify и YouTube не спешат
const SLOW_TIMEOUT = 30_000;
const FILE_TIMEOUT = 5 * 60_000;    // трек на медленном мобильном — это минуты, а не секунды
// Сервер на Маке обновляют руками; запущенный старый не знает новых адресов
const OUTDATED = 'Сервер на Маке старой версии — его нужно обновить';

/**
 * @typedef {'spotify' | 'youtube'} Source
 * @typedef {{ id: string, source: Source, title: string, artist: string, album: string,
 *             duration: number, cover: string | null }} RemoteTrack
 *   результат поиска на сервере; id — трека Spotify или ролика YouTube
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

/**
 * Ошибка, которую можно показать пользователю как есть.
 * offline — сервер не ответил вовсе; timeout — ответил бы, но слишком
 * долго думает (это не «Мак выключен»); code — код ошибки сервера.
 */
export class DownloadError extends Error {
    /** @param {string} message @param {{ status?: number, offline?: boolean, timeout?: boolean, code?: string }} [details] */
    constructor(message, { status = 0, offline = false, timeout = false, code = '' } = {}) {
        super(message);
        this.name = 'DownloadError';
        this.status = status;
        this.offline = offline;
        this.timeout = timeout;
        this.code = code;
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
     * @param {{ source?: Source, signal?: AbortSignal }} [options]
     * @returns {Promise<RemoteTrack[]>}
     */
    async search(query, { source = 'spotify', signal } = {}) {
        const path = `/v1/search?q=${encodeURIComponent(query)}&source=${source}&limit=8`;
        const data = await this.#json(path, { signal, timeout: SLOW_TIMEOUT });
        const results = Array.isArray(data?.results) ? data.results : [];
        // Сервер до 1.1 про источники не знает и на любой вкладке ищет в Spotify.
        // Показать это как ролики YouTube — значит обмануть.
        if (source !== 'spotify' && results.some(item => !item.source)) throw new DownloadError(OUTDATED, { code: 'outdated' });
        return results.map(item => ({ source, ...item }));
    }

    /** @param {RemoteTrack} result @returns {Promise<Job>} */
    start(result) {
        return this.#json('/v1/downloads', { method: 'POST', body: { source: result.source ?? 'spotify', id: result.id } });
    }

    /**
     * Ссылка для предпрослушивания: сервер сразу находит звук и отдаёт
     * одноразовую ссылку — плеер ходит по ней без кода в заголовке.
     * @param {RemoteTrack} result
     * @returns {Promise<string>}
     */
    async preview(result) {
        let data;
        try {
            data = await this.#json('/v1/previews', {
                method: 'POST', body: { source: result.source ?? 'spotify', id: result.id }, timeout: SLOW_TIMEOUT,
            });
        } catch (error) {
            // «нет такого адреса» — значит, прослушивания этот сервер ещё не умеет
            if (error instanceof DownloadError && error.status === 404) throw new DownloadError(OUTDATED, { code: 'outdated' });
            throw error;
        }
        return new URL(data.url, this.url).href;
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
     * @param {{ method?: string, body?: unknown, signal?: AbortSignal, timeout?: number }} [options]
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
        const deadline = AbortSignal.timeout(timeout);
        const signals = [deadline, ...(signal ? [signal] : [])];
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
            // долго думает — жив, просто занят: не пугаем выключенным Маком
            if (deadline.aborted) throw new DownloadError('Сервер долго не отвечает', { timeout: true });
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
            throw new DownloadError(data?.message || `Сервер ответил ошибкой ${response.status}`,
                { status: response.status, code: data?.error ?? '' });
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
