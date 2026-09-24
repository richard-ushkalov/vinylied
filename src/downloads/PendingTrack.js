import { generatedCover } from '../media/Artwork.js';
import { Track } from '../library/Track.js';

/**
 * Заготовка конверта на полке, пока трек качается. Для VinylView она
 * выглядит как Track: подписи и обложка — из результата поиска
 * (обложку отдаёт Spotify по своему адресу), корешок — нейтральный.
 * Когда файл скачан, на её место встаёт настоящий Track с тем же id.
 */
export class PendingTrack {
    spine = null;
    spineText = null;

    /**
     * @param {string} id
     * @param {import('./DownloadServer.js').RemoteTrack} result
     */
    constructor(id, result) {
        this.id = id;
        this.result = result;
        this.cover = result.cover || generatedCover({ album: result.album || result.title, artist: result.artist }, Track.colors);
    }

    get title() { return this.result.title; }
    get artist() { return this.result.artist; }
    get album() { return this.result.album || 'Без альбома'; }
    get duration() { return this.result.duration; }

    /** @param {string} query уже в нижнем регистре */
    matches(query) {
        return `${this.title} ${this.artist} ${this.album}`.toLowerCase().includes(query);
    }

    dispose() {}
}
