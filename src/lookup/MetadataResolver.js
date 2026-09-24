import { baseName } from '../core/format.js';
import { AcoustIdClient } from './AcoustIdClient.js';
import { ITunesClient } from './ITunesClient.js';
import { containsAll, same } from './Matcher.js';
import { getImage } from './http.js';

/**
 * @typedef {{ title: string, artist: string, album: string, cover: Blob | null,
 *             source: 'acoustid' | 'itunes' | 'itunes-file' }} Match
 */

/**
 * Узнаёт, что за трек, и находит к нему обложку. Цепочка стратегий,
 * от самой надёжной к самой хрупкой:
 *
 *  1. AcoustID — по звуку. Не зависит ни от тегов, ни от имени файла.
 *     Обложка — из Cover Art Archive, иначе из iTunes по найденному альбому.
 *  2. iTunes по тегам — только если и название, и исполнитель совпали.
 *  3. iTunes по имени файла — только если в имени есть и название,
 *     и исполнитель из ответа.
 *
 * Сетевые сбои (NetworkError) пробрасываются: это «не знаю пока»,
 * а не «не нашёл», — очередь повторит позже.
 */
export class MetadataResolver {
    /**
     * @param {{ acoustId: AcoustIdClient, fingerprinter: import('./Fingerprinter.js').Fingerprinter,
     *           itunes: ITunesClient, coverArt: import('./CoverArtArchive.js').CoverArtArchive,
     *           fetchImage?: (url: string) => Promise<Blob | null> }} deps
     */
    constructor({ acoustId, fingerprinter, itunes, coverArt, fetchImage = getImage }) {
        this.acoustId = acoustId;
        this.fingerprinter = fingerprinter;
        this.itunes = itunes;
        this.coverArt = coverArt;
        this.fetchImage = fetchImage;
    }

    get canFingerprint() { return this.acoustId.enabled; }

    /**
     * @param {import('../library/Library.js').TrackRecord} record
     * @returns {Promise<{ match: Match | null, usedAcoustId: boolean }>}
     */
    async resolve(record) {
        const usedAcoustId = this.canFingerprint;
        if (usedAcoustId) {
            const match = await this.#byFingerprint(record);
            if (match) return { match, usedAcoustId };
        }
        return { match: await this.#byTags(record) ?? await this.#byFileName(record), usedAcoustId };
    }

    /** @param {import('../library/Library.js').TrackRecord} record */
    async #byFingerprint(record) {
        let print;
        try {
            print = await this.fingerprinter.fingerprint(record.file);
        } catch (error) {
            // формат, который браузер не декодирует, — не повод бросать весь поиск
            console.warn('Не удалось снять отпечаток', record.name, error);
            return null;
        }
        const best = AcoustIdClient.pickBest(await this.acoustId.lookup(print));
        if (!best) return null;

        const cover = (best.releaseGroupId && await this.coverArt.front(best.releaseGroupId))
            || await this.#albumCover(best.artist, best.album);
        return { title: best.title, artist: best.artist, album: best.album, cover, source: /** @type {const} */ ('acoustid') };
    }

    /** @param {import('../library/Library.js').TrackRecord} record */
    async #byTags({ tags }) {
        if (!tags.title || !tags.artist) return null;
        const items = await this.itunes.search(`${tags.artist} ${tags.title}`, 'song');
        const hit = items.find(item => same(tags.title, item.trackName) && same(tags.artist, item.artistName));
        return hit ? this.#fromItunes(hit, 'itunes') : null;
    }

    /** @param {import('../library/Library.js').TrackRecord} record */
    async #byFileName({ name }) {
        const clean = baseName(name);
        if (!clean) return null;
        const items = await this.itunes.search(clean, 'song');
        const hit = items.find(item => containsAll(clean, item.trackName, item.artistName));
        return hit ? this.#fromItunes(hit, 'itunes-file') : null;
    }

    /**
     * @param {import('./ITunesClient.js').ITunesItem} item
     * @param {'itunes' | 'itunes-file'} source
     */
    async #fromItunes(item, source) {
        const url = ITunesClient.artworkUrl(item);
        return {
            title: item.trackName ?? '',
            artist: item.artistName,
            album: ITunesClient.cleanAlbum(item.collectionName),
            cover: url ? await this.fetchImage(url) : null,
            source,
        };
    }

    /** @param {string} artist @param {string} album */
    async #albumCover(artist, album) {
        if (!album) return null;
        const items = await this.itunes.search(`${artist} ${album}`, 'album');
        const hit = items.find(item => same(album, item.collectionName) && same(artist, item.artistName));
        const url = hit && ITunesClient.artworkUrl(hit);
        return url ? this.fetchImage(url) : null;
    }
}
