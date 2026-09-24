import { parseBlob, selectCover } from '../../vendor/music-metadata.js';
import { downscale } from './Artwork.js';
import { extractPalette } from './Palette.js';

/**
 * @typedef {{ title: string, artist: string, album: string, duration: number,
 *             cover: Blob | null, spine: string | null, spineText: string | null }} Tags
 */

/**
 * Читает теги и обложку из аудиофайла. Зовётся один раз — при добавлении
 * на полку; результат хранится в библиотеке, при запуске ничего заново
 * не разбирается.
 */
export class TagReader {
    /**
     * @param {Blob} file
     * @returns {Promise<Tags>}
     */
    async read(file) {
        // битый или экзотический файл — не повод не класть его на полку
        const parsed = await parseBlob(file).catch(() => null);
        /** @type {Record<string, any>} */
        const common = parsed?.common ?? {};
        const format = parsed?.format ?? {};

        const picture = common.picture?.length ? selectCover(common.picture) : null;
        let cover = null;
        if (picture) {
            const raw = new Blob([/** @type {BlobPart} */ (picture.data)], { type: picture.format });
            cover = await downscale(raw).catch(() => null);
        }
        const palette = cover ? await extractPalette(cover) : null;

        return {
            title: common.title?.trim() || '',
            artist: common.artist?.trim() || '',
            album: common.album?.trim() || '',
            duration: Number.isFinite(format.duration) ? format.duration : 0,
            cover,
            spine: palette?.spine ?? null,
            spineText: palette?.text ?? null,
        };
    }
}
