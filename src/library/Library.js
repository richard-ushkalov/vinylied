import { Emitter } from '../core/Emitter.js';
import { TRACKS } from './Database.js';

/**
 * @typedef {{ title: string, artist: string, album: string, cover: Blob | null,
 *             spine: string | null, spineText: string | null, source: string }} Found
 * @typedef {{ status?: 'found' | 'none', acoustid?: boolean, at?: number }} LookupState
 * @typedef {{
 *   id: string, key: string, name: string, type: string, size: number, addedAt: number,
 *   file: Blob, duration: number,
 *   tags: { title: string, artist: string, album: string },
 *   cover: Blob | null, spine: string | null, spineText: string | null,
 *   found: Found | null, lookup: LookupState
 * }} TrackRecord
 */

const AUDIO_EXT = /\.(mp3|m4a|m4b|aac|flac|ogg|oga|opus|wav|wave|aif|aiff|webm|weba|alac|caf)$/i;

/** randomUUID есть только в защищённом контексте — на http по локальной сети его нет */
export const newId = () => globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** @param {File} file */
export const isAudio = file => file.type.startsWith('audio/') || AUDIO_EXT.test(file.name);

/**
 * Ключ повторов: тот же файл, выбранный второй раз, узнаётся по имени,
 * размеру и дате изменения.
 * @param {{ name: string, size: number, lastModified?: number }} file
 */
export const keyOf = file => `${file.name}|${file.size}|${file.lastModified ?? 0}`;

/**
 * Полка как данные. Файлы КОПИРУЮТСЯ в IndexedDB: браузер не отдаёт
 * путь к файлу и не пускает к нему повторно, а на Android нет и выбора
 * папки. Копия — единственный способ, чтобы полка пережила перезапуск
 * и работала без сети. Цена — место на устройстве.
 *
 * События: 'added' {record}, 'updated' {record}, 'removed' {id}, 'cleared',
 * 'progress' {done, total, name}, 'import-start' {total},
 * 'import-end' {added, skipped, failed, quota}.
 */
export class Library extends Emitter {
    /** @type {Map<string, TrackRecord>} */
    #records = new Map();
    /** @type {Promise<unknown>} */
    #queue = Promise.resolve();
    importing = false;
    // Хранилище недоступно (запрет сайтовых данных, редкие приватные режимы) —
    // полка живёт только в памяти: не сохранится, но играть можно.
    persistent = true;

    /**
     * @param {{ db: import('./Database.js').Database,
     *           reader: import('../media/TagReader.js').TagReader }} deps
     */
    constructor({ db, reader }) {
        super();
        this.db = db;
        this.reader = reader;
    }

    async load() {
        let all;
        try {
            all = /** @type {TrackRecord[]} */ (await this.db.all(TRACKS));
        } catch (error) {
            this.persistent = false;
            throw error;
        }
        all.sort((a, b) => a.addedAt - b.addedAt);
        this.#records = new Map(all.map(record => [record.id, record]));
        return this.records();
    }

    get size() { return this.#records.size; }

    /** @returns {TrackRecord[]} */
    records() { return [...this.#records.values()]; }

    /** @param {string} id */
    get(id) { return this.#records.get(id); }

    /**
     * Добавляет файлы на полку. Импорты идут строго по очереди: два выбора
     * подряд раньше перемешивались и дрались за одну полку.
     *
     * Вместо File можно передать { file, id } — с заранее выданным id:
     * так скачанный трек занимает место своей заготовки на полке.
     * @param {(File | { file: File, id: string })[]} items
     * @returns {Promise<TrackRecord[]>}
     */
    import(items) {
        const entries = items.map(item => ('file' in item ? item : { file: item }));
        const run = this.#queue.then(() => this.#import(entries));
        this.#queue = run.catch(() => {});
        return run;
    }

    /**
     * @param {string} id
     * @param {Partial<TrackRecord>} patch
     */
    async update(id, patch) {
        const record = this.#records.get(id);
        if (!record) return null;
        const next = { ...record, ...patch };
        if (this.persistent) await this.db.put(TRACKS, next);
        this.#records.set(id, next);
        this.emit('updated', { record: next });
        return next;
    }

    /** @param {string} id */
    async remove(id) {
        if (this.persistent) await this.db.delete(TRACKS, id);
        this.#records.delete(id);
        this.emit('removed', { id });
    }

    async clear() {
        if (this.persistent) await this.db.clear(TRACKS);
        this.#records.clear();
        this.emit('cleared');
    }

    /** Сколько места занимает полка, байт. */
    usage() {
        let bytes = 0;
        for (const record of this.#records.values()) {
            bytes += record.size + (record.cover?.size ?? 0) + (record.found?.cover?.size ?? 0);
        }
        return bytes;
    }

    /** @param {{ file: File, id?: string }[]} files */
    async #import(files) {
        const audio = files.filter(({ file }) => isAudio(file));
        const total = audio.length;
        const keys = new Set([...this.#records.values()].map(record => record.key));
        /** @type {TrackRecord[]} */
        const added = [];
        let skipped = files.length - total, failed = 0, quota = false;

        this.importing = true;
        this.emit('import-start', { total });
        try {
            for (const [index, { file, id }] of audio.entries()) {
                this.emit('progress', { done: index, total, name: file.name });
                const key = keyOf(file);
                if (keys.has(key)) { skipped++; continue; }
                try {
                    const record = await this.#createRecord(file, key, id);
                    if (this.persistent) await this.db.put(TRACKS, record);
                    this.#records.set(record.id, record);
                    keys.add(key);
                    added.push(record);
                    this.emit('added', { record });
                } catch (error) {
                    failed++;
                    if (/** @type {DOMException} */ (error)?.name === 'QuotaExceededError') { quota = true; break; }
                    console.error('Не удалось добавить', file.name, error);
                }
            }
        } finally {
            this.importing = false;
            this.emit('import-end', { added: added.length, skipped, failed, quota });
        }

        // Просим браузер не вытеснять полку при нехватке места. Для
        // установленного приложения Chrome и Safari обычно соглашаются.
        if (added.length && this.persistent) navigator.storage?.persist?.().catch(() => {});
        return added;
    }

    /**
     * @param {File} file
     * @param {string} key
     * @param {string} [id]
     * @returns {Promise<TrackRecord>}
     */
    async #createRecord(file, key, id = newId()) {
        const tags = await this.reader.read(file);
        // Копия содержимого, а не ссылка на File: на Android файл из
        // выбора может жить во временном хранилище и пропасть после сессии.
        const copy = new Blob([await file.arrayBuffer()], { type: file.type });
        return {
            id,
            key,
            name: file.name,
            type: file.type,
            size: file.size,
            addedAt: Date.now(),
            file: copy,
            duration: tags.duration,
            tags: { title: tags.title, artist: tags.artist, album: tags.album },
            cover: tags.cover,
            spine: tags.spine,
            spineText: tags.spineText,
            found: null,
            lookup: {},
        };
    }
}
