import { createScroll } from './scroll.js';
import { createInputReader, readTrack, findCover } from './data.js';
import { createVinyl } from './vinyl.js';
import { createPlayer  } from "./player.js";
import { createProgress } from './progress.js';

const list = document.querySelector('.list');
const scene = document.querySelector('.scene');

const player = createPlayer();
const DEGREES_PER_SECOND = 200;   // 33⅓ оборота в минуту, как у настоящей пластинки
// Шарнир стоит в (-0.52, -0.44) обложки от центра пластинки, длина бруска
// 0.72. Тогда |головка| = size * sqrt(0.9824 - 0.9806*cos(угол - 40.24°)),
// и радиусу 0.44 (внешняя дорожка) отвечает 77°, радиусу 0.17 (край
// этикетки) — 54°. Мерить это через getBoundingClientRect нельзя:
// габарит повёрнутого диска раздут перспективой, числа выходят враньём.
const ARM_START = 77;
const ARM_SWEEP = 23;

let spin = 0;        // накопленный угол диска, градусов
let lastFrame = 0;   // performance.now() прошлого кадра; 0 — диск стоял
// Какую пластинку сейчас крутим. НЕ current: при смене трека current
// переключается на новый слот сразу, а старый ещё полсекунды тормозит —
// и весь его выбег уезжал в новую пластинку, она начинала уже раскрученной.
let spinning = null;
let tonearm = null;   // игла того же конверта

const progress = createProgress({
    root: document.querySelector('.progress'),
    player,
    // Угол КОПИМ по фактической скорости звука, а не считаем из позиции.
    // Позиция идёт по часам контекста и про разгон с торможением не знает —
    // из-за этого диск крутился ровно, пока звук ещё раскручивался.
    // А накопление заодно убирает рывок при перемотке: на вертушке игла
    // переезжает, а пластинка просто крутится дальше.
    onTick: () => {
        const rate = player.playbackRate();
        const now = performance.now();

        // Диск стоит — копить не от чего. И вкладка могла провисеть в фоне:
        // без потолка первый кадр после возврата швырнул бы диск на пол-оборота.
        const dt = rate && lastFrame ? Math.min((now - lastFrame) / 1000, 0.05) : 0;
        lastFrame = rate ? now : 0;

        // % 360 безопасен ТОЛЬКО пока у .disc нет перехода по transform:
        // иначе скачок 359° → 0° проигрался бы как оборот назад.
        spin = (spin + rate * DEGREES_PER_SECOND * dt) % 360;
        spinning?.style.setProperty('--disc-spin', `${spin}deg`);

        // Игла — единственное, что привязано к ПОЗИЦИИ, а не к скорости:
        // на вертушке она и показывает, сколько осталось.
        const part = player.currentTime() / (player.duration() || 1);
        tonearm?.style.setProperty('--arm', `${ARM_START - part * ARM_SWEEP}deg`);
    },
});

let items = [];
let current = null;
let previous = null;   // прежний трек: ему ещё нужно доиграть уход
let intent = 'stopped';   // 'playing' | 'paused' | 'stopped'

const scroll = createScroll(scene, {
    // прокрутка = перемотка, поэтому прикрываем фильтр, как на пульте
    onScrub: amount => player.scrub(amount),
});
scroll.attach();

const createShelf = async files => {
    list.replaceChildren();
    items.forEach(({ track }) => track.dispose());
    items = [];
    current = null;
    previous = null;

    for (const file of files) {
        try {
            const track = await readTrack(file);
            const element = createVinyl(track);

            list.append(element);

            items.push({ track, element });
        } catch (error) { console.error('Error on create: ', error.name, error.message); }
    }

    scroll.refresh();
}

// Боксы слотов тонкие и отодвинуты по Z, поэтому мимо них легко промахнуться.
// Ловим клик на всей сцене: попал в слот — берём его, не попал — берём центральный.
scene.addEventListener('click', event => {
    if (!items.length) return;
    player.enable();     // AudioContext можно будить только из жеста

    const slot = event.target.closest?.('.slot');
    const index = slot ? items.findIndex(item => item.element === slot) : scroll.getFocused();

    if (index >= 0) play(index);
});

const input = createInputReader(document.querySelector('.input'));
input.onChange(async files => { await createShelf(files); hunt(); });

// ── обложки из сети ───────────────────────────────────────────
// Первая попытка сразу после загрузки полки, дальше раз в минуту для тех,
// кому не повезло: сеть могла лежать, а альбом — найтись со второго захода.
const HUNT_EVERY = 60_000;
const MAX_TRIES = 3;

const SWAP_MS = 400;   // столько же, сколько --animation-base-time

// Конверт уезжает, меняем картинку за экраном, конверт возвращается.
const swapCover = (element, url) => {
    element.classList.add('slot--swap');
    setTimeout(() => {
        for (const img of element.querySelectorAll('.vinyl__frontside, .vinyl__backside')) img.src = url;
        element.querySelector('.disc__label')?.style.setProperty('--disc-art', `url("${url}")`);
        element.classList.remove('slot--swap');
    }, SWAP_MS);
};

let hunting = false;

const hunt = async () => {
    if (hunting) return;              // прошлый заход ещё идёт
    hunting = true;
    try {
        for (const { track, element } of items) {
            if (track.hasCover || track.tries >= MAX_TRIES) continue;
            track.tries++;
            const url = await findCover(track);
            if (!url) continue;
            track.hasCover = true;
            swapCover(element, url);
        }
    } finally { hunting = false; }
};

setInterval(hunt, HUNT_EVERY);

// ── поиск по полке ────────────────────────────────────────────
// Отсеянные конверты улетают вбок и схлопывают своё место, полка
// закрывается. Класс снимается — и они приезжают обратно.
const search = document.querySelector('.search');

const matches = (track, query) =>
    `${track.title} ${track.album} ${track.artist}`.toLowerCase().includes(query);

search.addEventListener('input', () => {
    const query = search.value.trim().toLowerCase();
    for (const { track, element } of items) {
        element.classList.toggle('slot--gone', Boolean(query) && !matches(track, query));
    }
    // высоты поехали — пересчитать центр и ближайший
    setTimeout(() => scroll.refresh(), SWAP_MS + 40);
});

// рисует по ФАКТУ, ничего не решает и никого не двигает
const render = () => {
    // Вид текущего трека от паузы НЕ зависит: конверт остаётся отъехавшим,
    // пластинка — снаружи. Пауза читается по остановившемуся диску, а по
    // открытому конверту сразу видно, какой трек сейчас выбран.
    items.forEach(({ element }) => {
        element.classList.toggle('slot--current', element === current);
        element.classList.toggle('slot--recent', element === previous);
    });

    if ('mediaSession' in navigator) {
        // НЕ player.isPaused(): при смене src он на миг становится true,
        // и системная панель успевала мигнуть паузой
        const playing = current !== null && intent === 'playing';
        navigator.mediaSession.playbackState =
            current === null ? 'none' : playing ? 'playing' : 'paused';
    }
};

const indexOf = element => items.findIndex(item => item.element === element);

// всегда запускает указанный трек с начала
const start = index => {
    const item = items[index];
    if (!item) return;

    previous = current;
    current = item.element;
    intent = 'playing';

    // декодируем следующий, пока играет этот — переключение станет бесшовным
    const after = items[(index + 1) % items.length];
    if (after && after !== item) player.preload(after.track.src);
    scroll.centerOn(index);
    updateMediaSession(item.track);   // метаданные ДО запуска: панель не мигает
    player.playTrack(item.track.src);
    render();
};

// клик: по играющему — пауза, по стоящему — продолжить, по другому — запустить
const play = index => {
    const item = items[index];
    if (!item) return;

    if (item.element === current) {
        if (intent === 'playing') { intent = 'paused';  player.pause(); }
        else                      { intent = 'playing'; player.resume(); }
        render();
        return;
    }
    start(index);
};

const playNext = () => {
    const next = indexOf(current) + 1;
    start(next < items.length ? next : 0);
};

const playPrev = () => {
    const prev = indexOf(current) - 1;
    start(prev >= 0 ? prev : items.length - 1);
};

// ── системная панель: Now Playing, медиаклавиши, экран блокировки ──
const updateMediaSession = track => {
    if (!('mediaSession' in navigator)) return;

    navigator.mediaSession.metadata = new MediaMetadata({
        title:  track.title,
        artist: track.artist,
        album:  track.album,
        artwork: track.cover
            ? [{ src: track.cover, sizes: '512x512', type: 'image/jpeg' }]
            : [],
    });
};

/**
 * Беззвучный медиаэлемент — якорь для системной панели.
 *
 * Safari и Firefox показывают Now Playing только когда звук идёт через
 * <audio> или <video>. У нас весь звук на Web Audio, медиаэлемента нет —
 * поэтому панель и пропала, когда мы ушли с <audio> ради раскрутки диска.
 * Файл действительно пустой, так что громкость можно оставить обычной:
 * браузер видит настоящее воспроизведение, а слышно ничего не будет.
 */
const silence = () => {
    const rate = 8000, n = rate / 2;          // полсекунды тишины, зациклим
    const buf = new ArrayBuffer(44 + n), v = new DataView(buf);
    const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF'); v.setUint32(4, 36 + n, true); str(8, 'WAVEfmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate, true);
    v.setUint16(32, 1, true); v.setUint16(34, 8, true);
    str(36, 'data'); v.setUint32(40, n, true);
    new Uint8Array(buf, 44).fill(128);        // в 8-битном wav тишина — это 128
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
};

const anchor = new Audio(silence());
anchor.loop = true;

player.on('playing', () => anchor.play().catch(() => {}));
player.on('pause',   () => anchor.pause());
player.on('ended',   () => anchor.pause());

if ('mediaSession' in navigator) {
    // регистрируем ОДИН раз: кнопки системы зовут те же действия, что и интерфейс
    navigator.mediaSession.setActionHandler('play',  () => { intent = 'playing'; player.resume(); render(); });
    navigator.mediaSession.setActionHandler('pause', () => { intent = 'paused'; player.pause(); render(); });
    navigator.mediaSession.setActionHandler('nexttrack',     playNext);
    navigator.mediaSession.setActionHandler('previoustrack', playPrev);
}

['playing', 'pause', 'ended', 'emptied'].forEach(type => player.on(type, render));
player.on('ended', () => {
    progress.wrap();     // трек кончился сам — палочка уходит за край
    playNext();
});

// Новая пластинка начинается с нуля. Прежнюю отпускаем здесь, а не в start():
// 'emptied' приходит уже ПОСЛЕ того, как старая остановилась, так что её выбег
// успевает дорисоваться на своём же диске.
player.on('emptied', () => {
    // Снимаем угол с отпущенной пластинки. Иначе она так и останется
    // повёрнутой, и при повторном запуске дёрнется с 300° на 0°.
    spinning?.style.removeProperty('--disc-spin');
    spin = 0; lastFrame = 0; spinning = null; tonearm = null;
});

// звук реально пошёл — вот теперь эта пластинка наша
player.on('playing', () => {
    spinning = current?.querySelector('.disc') ?? null;
    tonearm  = current?.querySelector('.tonearm') ?? null;
});