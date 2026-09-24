import { getImage } from './http.js';

/**
 * Cover Art Archive — обложки к релизам MusicBrainz. CORS открыт,
 * ответ — редирект на archive.org.
 */
export class CoverArtArchive {
    /** @param {{ fetch?: typeof fetch }} [options] */
    constructor({ fetch } = {}) {
        this.fetch = fetch;
    }

    /**
     * Лицевая обложка альбома (release group) или null, если её нет.
     * @param {string} releaseGroupId
     */
    front(releaseGroupId) {
        return getImage(`https://coverartarchive.org/release-group/${releaseGroupId}/front-500`, { fetch: this.fetch });
    }
}
