import { DownloadError } from '../downloads/DownloadServer.js';
import { containsAll, same } from '../lookup/Matcher.js';

const RETRY = 800;        // мс: пауза перед повтором вытесненного поиска
const DURATION = 5;       // с: разница длительностей, при которой это ещё тот же трек

/**
 * @typedef {import('../downloads/DownloadServer.js').RemoteTrack} RemoteTrack
 * @typedef {import('../ui/RemoteTrackList.js').Suggestion} Suggestion
 */

/** @param {number} ms */
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Тот же ли это трек: название и исполнитель сходятся (одно содержит
 * другое — «Song» и «Song (Remastered)»), длительность — если известна.
 * @param {RemoteTrack} result
 * @param {Suggestion} item
 */
export const sameTrack = (result, item) =>
    same(result.title, item.title) && same(result.artist, item.artist)
    && (!item.duration || !result.duration || Math.abs(result.duration - item.duration) <= DURATION);

/**
 * Звук для совета «похожее», у которого есть только название: ищем его
 * на своём сервере.
 *
 *  1. Spotify (spotDL) — там названия чистые, сверяем название и
 *     исполнителя;
 *  2. не нашлось или Spotify сломан — YouTube: ролик, в названии которого
 *     есть и трек, и исполнитель, иначе хотя бы трек, иначе первый.
 *     Теги после скачивания всё равно поправит поиск по звуку.
 *
 * Мак выключен или код не подошёл — YouTube не поможет: ошибка сразу.
 * Пользователь в это время ищет в поиске — сервер отвечает «запрос
 * устарел» (побеждает последний поиск кода): повторяем один раз.
 *
 * @param {import('../downloads/DownloadServer.js').DownloadServer} server
 * @param {Suggestion} item
 * @param {{ wait?: (ms: number) => Promise<void> }} [options]
 * @returns {Promise<RemoteTrack>}
 */
export const resolveTrack = async (server, item, { wait = sleep } = {}) => {
    const query = `${item.artist} ${item.title}`;
    /** @param {'spotify' | 'youtube'} source */
    const search = async source => {
        try {
            return await server.search(query, { source });
        } catch (error) {
            if (!(error instanceof DownloadError) || error.code !== 'superseded') throw error;
            await wait(RETRY);
            return server.search(query, { source });
        }
    };

    try {
        const hit = (await search('spotify')).find(result => sameTrack(result, item));
        if (hit) return hit;
    } catch (error) {
        if (!(error instanceof DownloadError) || error.offline || error.status === 401) throw error;
        // остальное — беда самого Spotify или spotDL: дальше YouTube
    }

    const youtube = await search('youtube');
    /** @param {RemoteTrack} result */
    const text = result => `${result.title} ${result.artist}`;
    const hit = youtube.find(result => containsAll(text(result), item.title, item.artist))
        ?? youtube.find(result => containsAll(text(result), item.title))
        ?? youtube[0];
    if (!hit) throw new DownloadError(`Не нашёл «${item.title}» ни в Spotify, ни на YouTube`);
    return hit;
};
