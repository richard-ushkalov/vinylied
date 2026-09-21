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

export const readTrack = async file => {
    const { common } = await parseBlob(file).catch(() => ({ common: {} }));

    const cover = common.picture?.length ? selectCover(common.picture) : null;

    // блоб нужен дважды: как адрес для <img> и как источник для разбора цвета
    const coverBlob = cover ? new Blob([cover.data], { type: cover.format }) : null;
    const coverUrl  = coverBlob ? URL.createObjectURL(coverBlob) : null;
    const palette   = coverBlob ? await extractCover(coverBlob) : null;

    const url = URL.createObjectURL(file);

    return {
        title: common.title || 'Title',
        album: common.album || 'Album',
        artist: common.artist || '',
        cover: coverUrl,
        spine: palette?.spine ?? null,
        spineText: palette?.text ?? null,
        src: url,
        dispose() {
            if (coverUrl) URL.revokeObjectURL(coverUrl);
            URL.revokeObjectURL(url);
        }
    };
};