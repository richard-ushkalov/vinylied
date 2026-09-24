import { baseName } from '../core/format.js';
import { generatedCover, rasterize } from '../media/Artwork.js';

/**
 * Трек, каким его видит интерфейс: запись библиотеки плюс всё, что
 * вычисляется на лету, — адреса Blob'ов, подписи, запасная обложка.
 *
 * Подписи: найденное в сети (AcoustID, iTunes) важнее тегов файла,
 * теги важнее имени файла.
 * Адреса создаются лениво и освобождаются в dispose(): у полки
 * на сотню треков не должно висеть сотни лишних object URL.
 */
export class Track {
    /** Цвета запасной обложки — из текущей темы. */
    static colors = { bg: '#000', fg: '#fff' };

    /** @type {import('./Library.js').TrackRecord} */
    #record;
    /** @type {string | null} */ #src = null;
    /** @type {string | null} */ #coverUrl = null;
    /** @type {Blob | null} */ #coverBlob = null;
    /** @type {string | null} */ #generated = null;
    /** @type {Promise<{ src: string, type: string }> | null} */ #artwork = null;
    /** @type {string | null} */ #artworkUrl = null;

    /** @param {import('./Library.js').TrackRecord} record */
    constructor(record) {
        this.#record = record;
    }

    get id() { return this.#record.id; }
    get record() { return this.#record; }

    get title() {
        return this.#record.found?.title || this.#record.tags.title || baseName(this.#record.name) || 'Без названия';
    }
    get artist() { return this.#record.found?.artist || this.#record.tags.artist || ''; }
    get album() { return this.#record.found?.album || this.#record.tags.album || 'Без альбома'; }
    get duration() { return this.#record.duration || 0; }

    /** адрес аудио для движка */
    get src() {
        this.#src ??= URL.createObjectURL(this.#record.file);
        return this.#src;
    }

    /** найденная обложка важнее вшитой */
    get coverBlob() { return this.#record.found?.cover ?? this.#record.cover ?? null; }
    get hasCover() { return Boolean(this.coverBlob); }

    get cover() {
        const blob = this.coverBlob;
        if (!blob) {
            // буквы — с альбома, а без альбома с названия: «БА» от
            // «Без альбома» на каждой второй обложке ничего не говорило
            const { found, tags } = this.#record;
            const album = found?.album || tags.album || this.title;
            this.#generated ??= generatedCover({ album, artist: this.artist }, Track.colors);
            return this.#generated;
        }
        if (blob !== this.#coverBlob) {
            this.#revokeCover();
            this.#coverBlob = blob;
            this.#coverUrl = URL.createObjectURL(blob);
        }
        return /** @type {string} */ (this.#coverUrl);
    }

    /** Цвет корешка берётся у той обложки, что сейчас на конверте. */
    get spine() {
        const found = this.#record.found;
        return found?.cover ? found.spine : this.#record.spine;
    }
    get spineText() {
        const found = this.#record.found;
        return found?.cover ? found.spineText : this.#record.spineText;
    }

    /** @param {import('./Library.js').TrackRecord} record */
    update(record) {
        this.#record = record;
        this.#generated = null;
        this.#resetArtwork();
    }

    /** Тема сменилась — запасную обложку перерисовать. */
    refreshGenerated() {
        if (this.hasCover) return false;
        this.#generated = null;
        this.#resetArtwork();
        return true;
    }

    /** @param {string} query уже в нижнем регистре */
    matches(query) {
        const { tags, name } = this.#record;
        return `${this.title} ${this.artist} ${this.album} ${tags.title} ${tags.artist} ${tags.album} ${name}`
            .toLowerCase()
            .includes(query);
    }

    /**
     * Картинка для системной панели. Своя обложка — как есть, с настоящим
     * типом; запасная SVG — растеризуется в PNG, иначе Android её не покажет.
     */
    artwork() {
        this.#artwork ??= (async () => {
            const blob = this.coverBlob;
            if (blob) return { src: this.cover, type: blob.type || 'image/jpeg' };
            const png = await rasterize(this.cover);
            this.#artworkUrl = URL.createObjectURL(png);
            return { src: this.#artworkUrl, type: 'image/png' };
        })();
        return this.#artwork;
    }

    dispose() {
        if (this.#src) URL.revokeObjectURL(this.#src);
        this.#src = null;
        this.#revokeCover();
        this.#resetArtwork();
    }

    #revokeCover() {
        if (this.#coverUrl) URL.revokeObjectURL(this.#coverUrl);
        this.#coverUrl = null;
        this.#coverBlob = null;
    }

    #resetArtwork() {
        if (this.#artworkUrl) URL.revokeObjectURL(this.#artworkUrl);
        this.#artworkUrl = null;
        this.#artwork = null;
    }
}
