/**
 * Сеть для поиска метаданных. Главное различие, которое здесь проводится:
 * «сервис ответил, что не знает» против «до сервиса не достучались».
 * Первое — окончательный ответ; второе — NetworkError, трек проверим позже.
 */
export class NetworkError extends Error {
    /** @param {string} message @param {unknown} [cause] */
    constructor(message, cause) {
        super(message, { cause });
        this.name = 'NetworkError';
    }
}

const TIMEOUT = 15_000;

/**
 * @param {string} url
 * @param {{ fetch?: typeof fetch, notFound?: number[] }} [options]
 * @returns {Promise<Response | null>} null — сервис честно ответил «нет такого»
 */
export const request = async (url, { fetch: doFetch = globalThis.fetch, notFound = [404] } = {}) => {
    if (globalThis.navigator?.onLine === false) throw new NetworkError('Нет сети');
    let response;
    try {
        response = await doFetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
    } catch (error) {
        throw new NetworkError(`Запрос не прошёл: ${url}`, error);
    }
    if (notFound.includes(response.status)) return null;
    // 429 и 5xx — сервис занят или лежит: это не «не нашли», пробуем позже
    if (!response.ok) throw new NetworkError(`HTTP ${response.status}: ${url}`);
    return response;
};

/** @param {string} url @param {{ fetch?: typeof fetch }} [options] */
export const getJson = async (url, options) => {
    const response = await request(url, options);
    return response ? response.json() : null;
};

/**
 * Картинку скачиваем Blob'ом — чтобы обложка жила в библиотеке
 * и показывалась без сети.
 * @param {string} url @param {{ fetch?: typeof fetch }} [options]
 */
export const getImage = async (url, options) => {
    const response = await request(url, options);
    if (!response) return null;
    const blob = await response.blob();
    return blob.type.startsWith('image/') ? blob : null;
};
