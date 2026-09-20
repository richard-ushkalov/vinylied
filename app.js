import { parseBlob, selectCover } from 'music-metadata';

const input = document.querySelector('.input');
input.addEventListener('change', async () => {
    const files = [...input.files];

    for (const track of files) {
    const vynil = template.content.firstElementChild.cloneNode(true);
    
    const front = vynil.querySelector('.vinyl__frontside');
    const back = vynil.querySelector('.vinyl__backside');

    const sideAlbum = vynil.querySelector('.vinyl__side__album');
    const sideTrack = vynil.querySelector('.vinyl__side__track');

    const { common } = await parseBlob(track).catch(() => ({ common: {} }));

    const cover = common.picture?.length ? selectCover(common.picture) : null;
    front.src = cover
    ? URL.createObjectURL(new Blob([cover.data], { type: cover.format }))
    : 'img/placeholder.jpg';

    back.src = cover
    ? URL.createObjectURL(new Blob([cover.data], { type: cover.format }))
    : 'img/placeholder.jpg';

    if (cover) {
        const blob = new Blob([cover.data], { type: cover.format });    // ОДИН раз, не два

        const bitmap = await createImageBitmap(blob);
        const spine = extractSpineColor(bitmap);
        bitmap.close();
        if (spine) {
            vynil.style.setProperty('--spine', spine);
            vynil.classList.add('slot--tinted');
            console.log(track.name, spine)
        }
        console.log(track.name, spine)

    }

    sideAlbum.textContent = common?.album;
    sideTrack.textContent = common?.title;

    list.append(vynil);

    vynil.addEventListener('click', () => {
        list.querySelectorAll('.slot--active')
        .forEach(slot => slot.classList.remove('slot--active'));

        playMusic(URL.createObjectURL(track));
        currentIndex = vynil;
    });
}
});

const scene = document.querySelector('.scene');
const list = document.querySelector('.list');

const player = document.querySelector('.player');
const playMusic = (src) => {
    player.src = src;
    player.currentTime = 0;
    player.play();
}

let scroll = 0;
const onWheel = event => {
    console.log(event.deltaY);

    scroll += event.deltaY;
    list.style.transform = `translateX(${scroll}px)`;
};
scene.addEventListener('wheel', onWheel);

let currentIndex = null;

const template = document.getElementById('vynil-template');

player.addEventListener('playing', () => {
    currentIndex?.classList.add('slot--active');
});

player.addEventListener('ended', () => {
    list.querySelectorAll('.slot--active')
        .forEach(slot => slot.classList.remove('slot--active'));
    

    const arr = Array.from(list);
    console.log(arr);
    console.log(arr.indexOf(currentIndex));
});

const extractSpineColor = (img, { size = 32, shift = 6, minScore = 2 } = {}) => {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, size, size);

    let data;
    try { data = ctx.getImageData(0, 0, size, size).data; }
    catch { return null; }                       // чужой домен без crossOrigin

    const buckets = new Map();
    for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const max = Math.max(r, g, b), min = Math.min(r, g, b);

        if (max < 20 || max > 245) continue;     // почти чёрное и почти белое
        const sat = (max - min) / 255;

        const key = `${r >> shift},${g >> shift},${b >> shift}`;
        const bucket = buckets.get(key) ?? { score: 0, r: 0, g: 0, b: 0, n: 0 };
        bucket.score += sat * sat;
        bucket.r += r; bucket.g += g; bucket.b += b; bucket.n++;
        buckets.set(key, bucket);
    }

    const best = [...buckets.values()].sort((a, b) => b.score - a.score)[0];
    if (!best || best.score < minScore) return null;

    return `rgb(${Math.round(best.r/best.n)} ${Math.round(best.g/best.n)} ${Math.round(best.b/best.n)})`;
};