import { Emitter } from '../core/Emitter.js';
import { newId } from '../library/Library.js';
import { DownloadError } from './DownloadServer.js';

const POLL = 700;            // мс между вопросами «как там?» — прогресс виден, сервер не дёргаем
const RETRIES = 5;           // сколько раз подряд прощаем пропавшую сеть
const SERVER_SHARE = 0.9;    // остальное — передача файла на телефон
// Сколько скачиваний идёт одновременно. Сервер разрешает коду три, а
// «Добавить все» из микса дня ставит десятки: остальные ждут здесь, а не
// получают от сервера «слишком много загрузок».
const AT_ONCE = 2;

/**
 * @typedef {import('./DownloadServer.js').RemoteTrack} RemoteTrack
 * @typedef {{ id: string, result: RemoteTrack, state: 'waiting' | 'running' | 'done' | 'failed',
 *             progress: number, stage: string }} Download
 */

/** @param {number} ms */
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Скачивания со своего сервера: задание → опрос → файл.
 *
 * Каждому скачиванию сразу выдаётся id — тот же станет id трека в
 * библиотеке, поэтому заготовка на полке превращается в трек на месте.
 * Одновременно идут не больше AT_ONCE, остальные ждут своей очереди.
 * Общий прогресс только растёт: сервер отдаёт 90%, передача — 10%.
 *
 * События: 'added' {id, result}, 'progress' {id, progress, stage},
 * 'done' {id, result, file}, 'failed' {id, result, message}.
 */
export class DownloadQueue extends Emitter {
    /** @type {Map<string, Download>} */
    #items = new Map();
    /** @type {Download[]} */
    #waiting = [];
    #running = 0;

    /**
     * @param {{ server: import('./DownloadServer.js').DownloadServer, poll?: number,
     *           sleep?: (ms: number) => Promise<void>, atOnce?: number }} deps
     */
    constructor({ server, poll = POLL, sleep = wait, atOnce = AT_ONCE }) {
        super();
        this.server = server;
        this.poll = poll;
        this.sleep = sleep;
        this.atOnce = atOnce;
    }

    /** @param {RemoteTrack} result @returns {string} id будущего трека */
    start(result) {
        const current = this.stateOf(result.id);
        if (current && current.state !== 'failed') return current.id;
        /** @type {Download} */
        const item = { id: newId(), result, state: 'waiting', progress: 0, stage: 'В очереди' };
        this.#items.set(item.id, item);
        this.emit('added', { id: item.id, result });
        this.#waiting.push(item);
        this.#next();
        return item.id;
    }

    #next() {
        while (this.#running < this.atOnce && this.#waiting.length) {
            const item = /** @type {Download} */ (this.#waiting.shift());
            item.state = 'running';
            this.#running++;
            this.#run(item).finally(() => {
                this.#running--;
                this.#next();
            });
        }
    }

    /**
     * Последнее скачивание этого результата поиска — для строки в списке.
     * @param {string} resultId
     */
    stateOf(resultId) {
        let found = null;
        for (const item of this.#items.values()) if (item.result.id === resultId) found = item;
        return found;
    }

    /** @param {string} id */
    get(id) { return this.#items.get(id) ?? null; }

    /** Сколько ещё не легло на полку: идут и ждут очереди. */
    get active() {
        return [...this.#items.values()].filter(item => item.state === 'running' || item.state === 'waiting').length;
    }

    /** @param {Download} item */
    async #run(item) {
        try {
            let job = await this.server.start(item.result);
            let misses = 0;
            while (job.state !== 'done') {
                if (job.state === 'error') throw new DownloadError(job.error || 'Сервер не смог скачать трек');
                this.#progress(item, SERVER_SHARE * job.progress, job.stage);
                await this.sleep(this.poll);
                try {
                    job = await this.server.job(job.id);
                    misses = 0;
                } catch (error) {
                    // сеть моргнула — ещё не повод бросать скачивание
                    if (!(error instanceof DownloadError && error.offline) || ++misses > RETRIES) throw error;
                }
            }
            this.#progress(item, SERVER_SHARE, 'Переношу на телефон');
            const file = await this.server.file(job.id,
                fraction => this.#progress(item, SERVER_SHARE + (1 - SERVER_SHARE) * fraction, 'Переношу на телефон'));
            item.state = 'done';
            this.#progress(item, 1, 'Готово');
            this.emit('done', { id: item.id, result: item.result, file });
        } catch (error) {
            item.state = 'failed';
            const message = error instanceof DownloadError ? error.message : 'Что-то пошло не так';
            if (!(error instanceof DownloadError)) console.error('Скачивание не удалось', error);
            this.emit('failed', { id: item.id, result: item.result, message });
        }
    }

    /** @param {Download} item @param {number} value @param {string} stage */
    #progress(item, value, stage) {
        const progress = Math.max(item.progress, Math.min(value, 1));
        if (progress === item.progress && stage === item.stage) return;
        item.progress = progress;
        item.stage = stage;
        this.emit('progress', { id: item.id, progress, stage });
    }
}
