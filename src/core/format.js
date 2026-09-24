/** Чистые форматтеры для интерфейса. Без DOM — проверяются unit-тестами. */

/**
 * 83 → «1:23», 3725 → «1:02:05». Мусор и отрицательные — «0:00».
 * @param {number} seconds
 */
export const formatTime = seconds => {
    const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = String(total % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
};

/**
 * Русское согласование числа: plural(3, ['трек', 'трека', 'треков']) → «трека».
 * @param {number} n
 * @param {[string, string, string]} forms
 */
export const plural = (n, [one, few, many]) => {
    const mod10 = n % 10, mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
    return many;
};

/** @param {number} n */
export const tracksLabel = n => `${n} ${plural(n, ['трек', 'трека', 'треков'])}`;

/**
 * 312_000_000 → «298 МБ». Двоичные единицы, как у файловых менеджеров.
 * @param {number} bytes
 */
export const formatBytes = bytes => {
    const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
    let value = Math.max(0, bytes || 0), unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
    const digits = value < 10 && unit > 0 ? 1 : 0;
    return `${value.toFixed(digits).replace('.', ',')} ${units[unit]}`;
};

/**
 * Имя файла без расширения и ведущего номера дорожки:
 * «03 - Кино - Группа крови.mp3» → «Кино - Группа крови».
 * @param {string} name
 */
export const baseName = name => (name ?? '')
    .replace(/\.[^.]+$/, '')
    .replace(/^\d+[\s._-]+/, '')
    .trim();
