/**
 * Сверка ответов сервисов с тем, что мы знаем о треке.
 *
 * iTunes на ЛЮБОЙ запрос вернёт свой лучший вариант и никогда не скажет
 * «не нашёл»: спросишь «asdf» — получишь чью-то случайную обложку.
 * Поэтому каждый ответ обязан пройти сверку.
 */

/** Только буквы и цифры, в нижнем регистре. @param {string | undefined | null} text */
export const norm = text => (text ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * «То же самое» — когда одна строка содержит другую: «Trilogy» против
 * «Trilogy (Deluxe)» пройдёт, «Trilogy» против «Thriller» — нет.
 * @param {string | undefined} a
 * @param {string | undefined} b
 */
export const same = (a, b) => {
    const x = norm(a), y = norm(b);
    return Boolean(x && y) && (x.includes(y) || y.includes(x));
};

/**
 * Встречаются ли ВСЕ части в строке (имени файла).
 * @param {string} haystack
 * @param {...(string | undefined)} parts
 */
export const containsAll = (haystack, ...parts) => {
    const h = norm(haystack);
    return parts.every(part => {
        const p = norm(part);
        return Boolean(p) && h.includes(p);
    });
};
