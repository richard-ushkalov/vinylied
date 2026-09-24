/**
 * Работа с картинками обложек: уменьшить, растеризовать, нарисовать
 * запасную. OffscreenCanvas есть не везде (iOS до 16.4) — тогда обычный
 * <canvas>: результат тот же, только на главном потоке.
 */

/** @param {number} width @param {number} height */
export const createCanvas = (width, height) => typeof OffscreenCanvas === 'function'
    ? new OffscreenCanvas(width, height)
    : Object.assign(document.createElement('canvas'), { width, height });

/**
 * @param {OffscreenCanvas | HTMLCanvasElement} canvas
 * @param {string} type
 * @param {number} [quality]
 * @returns {Promise<Blob>}
 */
export const canvasToBlob = (canvas, type, quality) => 'convertToBlob' in canvas
    ? canvas.convertToBlob({ type, quality })
    : new Promise((resolve, reject) => canvas.toBlob(
        blob => blob ? resolve(blob) : reject(new Error('canvas.toBlob вернул пустоту')), type, quality));

/** @param {string} url */
const loadImage = async url => {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image;
};

const COVER_MAX = 600;          // полке больше не нужно: конверт не шире 430px
const KEEP_BELOW = 350_000;     // маленькие и так хороши — не пережимаем

/**
 * Уменьшает обложку до COVER_MAX по большей стороне и пережимает в JPEG.
 * Во вшитых обложках встречаются PNG 3000×3000 по несколько мегабайт —
 * телефон декодировал бы такие для каждого конверта полки.
 * @param {Blob} blob
 * @param {number} [max]
 * @returns {Promise<Blob>}
 */
export const downscale = async (blob, max = COVER_MAX) => {
    const bitmap = await createImageBitmap(blob);
    try {
        const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
        if (scale === 1 && blob.size <= KEEP_BELOW) return blob;
        const width = Math.round(bitmap.width * scale);
        const height = Math.round(bitmap.height * scale);
        const canvas = createCanvas(width, height);
        const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
        ctx.drawImage(bitmap, 0, 0, width, height);
        return await canvasToBlob(canvas, 'image/jpeg', 0.86);
    } finally {
        bitmap.close();
    }
};

/**
 * Растеризует картинку (в том числе SVG) в квадратный PNG. Системные
 * панели — уведомление Android, Now Playing — SVG не показывают.
 * @param {string} url
 * @param {number} [size]
 */
export const rasterize = async (url, size = 512) => {
    const image = await loadImage(url);
    const canvas = createCanvas(size, size);
    const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
    ctx.drawImage(image, 0, 0, size, size);
    return canvasToBlob(canvas, 'image/png');
};

const hash = text => {
    let h = 0;
    for (const ch of text) h = (h * 31 + ch.codePointAt(0)) % 100000;
    return h;
};

const initials = text => text.trim().split(/\s+/).slice(0, 2)
    .map(word => [...word][0] ?? '').join('').toUpperCase() || '?';

const escapeXml = text => text.replace(/[<>&"']/g, ch => `&#${ch.charCodeAt(0)};`);

/**
 * Запасная обложка, когда в файле картинки нет. Нарочно в стиле сцены —
 * ровное поле и линии в 1px, как у полосы прокрутки и обводки пластинки:
 * сгенерированную обложку должно быть ВИДНО, что она сгенерированная,
 * а не выдана за настоящую. Цвета — из темы.
 * @param {{ album: string, artist: string }} track
 * @param {{ bg: string, fg: string }} colors
 */
export const generatedCover = ({ album, artist }, { bg, fg }) => {
    const seed = hash(`${artist}${album}`);
    const angle = seed % 180;                    // наклон штрихов
    const gap = 14 + (seed >> 3) % 10;           // шаг между ними
    const lines = Array.from({ length: Math.ceil(300 / gap) },
        (_, i) => `<line x1="-50" y1="${-50 + i * gap}" x2="250" y2="${-50 + i * gap}"/>`).join('');

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
        <rect width="200" height="200" fill="${bg}"/>
        <g stroke="${fg}" stroke-width="1" opacity=".5" transform="rotate(${angle} 100 100)">${lines}</g>
        <circle cx="100" cy="100" r="62" fill="${bg}" stroke="${fg}" stroke-width="1"/>
        <text x="100" y="100" fill="${fg}" text-anchor="middle" dominant-baseline="central"
              font-family="system-ui, sans-serif" font-size="44" font-weight="300"
              letter-spacing="2">${escapeXml(initials(album))}</text>
    </svg>`;

    return `data:image/svg+xml,${encodeURIComponent(svg.replace(/\s+/g, ' '))}`;
};
