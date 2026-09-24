import { Emitter } from '../core/Emitter.js';
import { downscale } from '../media/Artwork.js';
import { extractPalette } from '../media/Palette.js';
import { NetworkError } from './http.js';

const INTERVAL = 60_000;     // повтор для тех, кому не повезло: сеть могла лежать
const MAX_ERRORS = 3;        // непредвиденных ошибок на трек за сессию — дальше не мучаем

/**
 * Проверяет полку в фоне, по одному треку — ВСЕ треки, в том числе
 * со своей обложкой: вшитая бывает чужой или мелкой, а подписи — мусорными.
 *
 * Итог каждой проверки пишется в запись библиотеки, поэтому между
 * запусками ничего не повторяется. Треки, для которых «не нашли» без
 * AcoustID, проверяются заново, когда появится ключ.
 *
 * События: 'progress' {checked, total, running}, 'found' {id}.
 */
export class LookupQueue extends Emitter {
    #timer = 0;
    #running = false;
    /** @type {Map<string, number>} */
    #errors = new Map();

    /**
     * @param {{ library: import('../library/Library.js').Library,
     *           resolver: import('./MetadataResolver.js').MetadataResolver,
     *           settings: import('../core/Settings.js').Settings }} deps
     */
    constructor({ library, resolver, settings }) {
        super();
        this.library = library;
        this.resolver = resolver;
        this.settings = settings;
    }

    start() {
        this.settings.watch(['onlineLookup'], ({ onlineLookup }) => {
            if (onlineLookup) this.schedule(1500);
            else clearTimeout(this.#timer);
            this.#report();
        });
        addEventListener('online', () => this.schedule(500));
        this.library.on('import-end', () => this.schedule(500));
        for (const type of ['added', 'removed', 'cleared']) this.library.on(type, () => this.#report());
    }

    get running() { return this.#running; }

    /** @param {import('../library/Library.js').TrackRecord} record */
    needs(record) {
        const { status, acoustid } = record.lookup ?? {};
        if (!status) return true;
        return status === 'none' && !acoustid && this.resolver.canFingerprint;
    }

    progress() {
        const records = this.library.records();
        const pending = records.filter(record => this.needs(record)).length;
        return { checked: records.length - pending, total: records.length, running: this.#running };
    }

    /** @param {number} delay */
    schedule(delay) {
        clearTimeout(this.#timer);
        this.#timer = window.setTimeout(() => this.run(), delay);
    }

    /** «Проверить заново»: забыть все итоги и пройти полку ещё раз. */
    async recheckAll() {
        this.#errors.clear();
        for (const record of this.library.records()) {
            await this.library.update(record.id, { found: null, lookup: {} });
        }
        this.#report();
        this.schedule(0);
    }

    async run() {
        if (this.#running || !this.settings.get('onlineLookup')) return;
        if (this.library.importing) { this.schedule(INTERVAL / 4); return; }

        this.#running = true;
        this.#report();
        try {
            for (const { id } of this.library.records()) {
                if (!this.settings.get('onlineLookup')) break;
                const record = this.library.get(id);    // могли удалить, пока шли по полке
                if (!record || !this.needs(record) || (this.#errors.get(id) ?? 0) >= MAX_ERRORS) continue;
                try {
                    await this.#check(record);
                } catch (error) {
                    if (error instanceof NetworkError) break;   // сеть легла — остальных позже
                    this.#errors.set(id, (this.#errors.get(id) ?? 0) + 1);
                    console.warn('Поиск метаданных не удался', record.name, error);
                }
                this.#report();
            }
        } finally {
            this.#running = false;
            this.#report();
            if (this.library.records().some(record => this.needs(record))) this.schedule(INTERVAL);
        }
    }

    /** @param {import('../library/Library.js').TrackRecord} record */
    async #check(record) {
        const { match, usedAcoustId } = await this.resolver.resolve(record);
        if (!this.library.get(record.id)) return;
        /** @type {import('../library/Library.js').LookupState} */
        const lookup = { status: match ? 'found' : 'none', acoustid: usedAcoustId, at: Date.now() };
        if (!match) {
            await this.library.update(record.id, { lookup });
            return;
        }

        const cover = match.cover ? await downscale(match.cover).catch(() => match.cover) : null;
        const palette = cover ? await extractPalette(cover) : null;
        await this.library.update(record.id, {
            lookup,
            found: {
                title: match.title,
                artist: match.artist,
                album: match.album,
                cover,
                spine: palette?.spine ?? null,
                spineText: palette?.text ?? null,
                source: match.source,
            },
        });
        this.emit('found', { id: record.id });
    }

    #report() {
        this.emit('progress', this.progress());
    }
}
