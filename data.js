import { parseBlob, selectCover } from 'music-metadata';

export const createInputReader = input => {
    return {
        onChange: callback => {
            input.addEventListener('change', () => callback([...input.files]));
        }
    };
}


// ── цвет корешка из обложки ──────────────────────────────────
// Берём самый «весомый» цвет: частоту умножаем на насыщенность,
// чтобы небольшое живое пятно побеждало большую серую заливку.
const extractCover = async (blob, { size = 32, shift = 6, minScore = 2 } = {}) => {
    let bitmap;
    try { bitmap = await createImageBitmap(blob); } catch { return null; }

    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, size, size);
    bitmap.close();

    let data;
    try { data = ctx.getImageData(0, 0, size, size).data; } catch { return null; }

    const buckets = new Map();
    for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const max = Math.max(r, g, b), min = Math.min(r, g, b);

        if (max < 18 || max > 252) continue;        // почти чёрное и почти белое
        const sat = (max - min) / 255;

        const key = `${r >> shift},${g >> shift},${b >> shift}`;
        const bucket = buckets.get(key) ?? { score: 0, r: 0, g: 0, b: 0, n: 0 };
        bucket.score += sat * sat;
        bucket.r += r; bucket.g += g; bucket.b += b; bucket.n++;
        buckets.set(key, bucket);
    }

    const best = [...buckets.values()].sort((a, b) => b.score - a.score)[0];
    if (!best || best.score < minScore) return null;

    const r = Math.round(best.r / best.n);
    const g = Math.round(best.g / best.n);
    const b = Math.round(best.b / best.n);

    // Цвет отдаём КАК ЕСТЬ — ничего не подрезаем и не насыщаем.
    // Светлый корешок остаётся светлым, а читаемость чиним текстом.
    const lin = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);

    // 0.18 — точка, где контраст с белым и с чёрным сравниваются (оба ≈4.5:1)
    return { spine: `rgb(${r} ${g} ${b})`, text: luminance > 0.18 ? '#111' : '#fff' };
};

// ── запасная обложка ─────────────────────────────────────────
// Рисуем её сами, когда в файле картинки нет. Нарочно в стиле сцены —
// чёрное поле и белые линии в 1px, как у полосы прокрутки и обводки
// пластинки: сгенерированную обложку должно быть ВИДНО, что она
// сгенерированная, а не выдана за настоящую.
const hash = text => {
    let h = 0;
    for (const ch of text) h = (h * 31 + ch.codePointAt(0)) % 100000;
    return h;
};

const initials = text => text.trim().split(/\s+/).slice(0, 2)
    .map(word => [...word][0] ?? '').join('').toUpperCase() || '?';

const makeCover = ({ album, artist }) => {
    const seed = hash(`${artist}${album}`);
    const angle = seed % 180;                    // наклон штрихов
    const gap = 14 + (seed >> 3) % 10;           // шаг между ними

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
        <rect width="200" height="200" fill="#000"/>
        <g stroke="#fff" stroke-width="1" opacity=".5"
           transform="rotate(${angle} 100 100)">
            ${Array.from({ length: Math.ceil(300 / gap) },
                (_, i) => `<line x1="-50" y1="${-50 + i * gap}" x2="250" y2="${-50 + i * gap}"/>`).join('')}
        </g>
        <circle cx="100" cy="100" r="62" fill="#000" stroke="#fff" stroke-width="1"/>
        <text x="100" y="100" fill="#fff" text-anchor="middle" dominant-baseline="central"
              font-family="system-ui, sans-serif" font-size="44" font-weight="300"
              letter-spacing="2">${initials(album)}</text>
    </svg>`;

    return `data:image/svg+xml,${encodeURIComponent(svg.replace(/\s+/g, ' '))}`;
};

/**
 * Поиск обложки в интернете — iTunes Search API: без ключа, с открытым CORS.
 *
 * ВАЖНО, что это значит: наружу, на серверы Apple, уходят исполнитель
 * и название альбома из его файлов. Поэтому зовётся только для треков,
 * где своей картинки нет, и не больше трёх попыток на трек.
 */
export const findCover = async ({ artist, album }) => {
    if (!album || album === 'Без альбома') return null;

    const term = encodeURIComponent(`${artist} ${album}`.trim());
    const url = `https://itunes.apple.com/search?term=${term}&entity=album&limit=1`;

    try {
        const response = await fetch(url);
        if (!response.ok) return null;
        const { results } = await response.json();
        const art = results?.[0]?.artworkUrl100;
        // в ответе миниатюра 100×100; размер зашит прямо в адрес
        return art ? art.replace(/\/\d+x\d+bb\./, '/600x600bb.') : null;
    } catch { return null; }   // нет сети — не беда, останется своя обложка
};

export const readTrack = async file => {
    const { common } = await parseBlob(file).catch(() => ({ common: {} }));

    const cover = common.picture?.length ? selectCover(common.picture) : null;

    // блоб нужен дважды: как адрес для <img> и как источник для разбора цвета
    const coverBlob = cover ? new Blob([cover.data], { type: cover.format }) : null;
    const coverUrl  = coverBlob ? URL.createObjectURL(coverBlob) : null;
    const palette   = coverBlob ? await extractCover(coverBlob) : null;

    const url = URL.createObjectURL(file);

    const title  = common.title  || file.name.replace(/\.[^.]+$/, '');
    const album  = common.album  || 'Без альбома';
    const artist = common.artist || '';

    return {
        title,
        album,
        artist,
        hasCover: Boolean(coverUrl),   // false — обложка нарисована нами
        tries: 0,                      // сколько раз искали её в сети
        // Своей обложки нет — рисуем запасную. Цвет корешка при этом
        // НЕ выдумываем: он остаётся пустым и берёт нейтральный откат
        // из CSS. Придуманный цвет выглядел бы как настоящий результат
        // разбора картинки, а это враньё.
        cover: coverUrl ?? makeCover({ album, artist }),
        spine: palette?.spine ?? null,
        spineText: palette?.text ?? null,
        src: url,
        dispose() {
            if (coverUrl) URL.revokeObjectURL(coverUrl);   // data: отзывать нечего
            URL.revokeObjectURL(url);
        }
    };
};