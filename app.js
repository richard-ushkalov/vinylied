import { createScroll } from './scroll.js';
import { createInputReader, readTrack, findCover, paletteFrom } from './data.js';
import { createVinyl } from './vinyl.js';
import { createPlayer  } from "./player.js";
import { createProgress } from './progress.js';

const list = document.querySelector('.list');
const scene = document.querySelector('.scene');

const player = createPlayer();
const DEGREES_PER_SECOND = 200;   // 33⅓ оборота в минуту, как у настоящей пластинки

let spin = 0;        // накопленный угол диска, градусов
let lastFrame = 0;   // performance.now() прошлого кадра; 0 — диск стоял
// Какую пластинку сейчас крутим. НЕ current: при смене трека current
// переключается на новый слот сразу, а старый ещё полсекунды тормозит —
// и весь его выбег уезжал в новую пластинку, она начинала уже раскрученной.
let spinning = null;

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
            // Прячем сразу: иначе конверты появляются голыми, а размытие
            // и наклоны наваливаются потом, одним рывком.
            element.classList.add('slot--loading');

            list.append(element);

            items.push({ track, element });
        } catch (error) { console.error('Error on create: ', error.name, error.message); }
    }

    await reveal();
}

// Ждём, пока обложки РЕАЛЬНО декодируются, потом даём scroll.js разложить
// стопку — и только тогда показываем, по одной, лесенкой.
const reveal = async () => {
    await Promise.all(items.map(({ element }) =>
        element.querySelector('.vinyl__frontside')?.decode?.().catch(() => {})));

    // refresh раскладывает стопку СИНХРОННО — transform и filter уже
    // записаны, ждать кадров не нужно. И нельзя: в свёрнутой вкладке
    // requestAnimationFrame не приходит вовсе, и полка осталась бы
    // невидимой до тех пор, пока на неё не посмотрят.
    scroll.refresh();

    items.forEach(({ element }, index) =>
        setTimeout(() => element.classList.remove('slot--loading'), index * 70));
};

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

// Конверт ныряет вниз, меняем всё разом, конверт возвращается.
const swapCover = (element, track, found, palette) => {
    element.classList.add('slot--swap');
    setTimeout(() => {
        for (const img of element.querySelectorAll('.vinyl__frontside, .vinyl__backside')) img.src = found.url;
        element.querySelector('.disc__label')?.style.setProperty('--disc-art', `url("${found.url}")`);

        // Цвет корешка раньше брался только со встроенной обложки — у найденной
        // в сети он так и оставался нейтральным. Теперь разбираем и её.
        if (palette) {
            element.style.setProperty('--spine', palette.spine);
            element.style.setProperty('--spine-text', palette.text);
        }

        // Нашли по имени файла — значит тегам верить нечего: берём подписи с сайта
        if (found.viaFile) {
            track.album = found.album;
            track.artist = found.artist;
            element.querySelector('.vinyl__side__album').textContent = found.album;
        }
        element.classList.remove('slot--swap');
    }, SWAP_MS);
};

// Что уже нашли — помним между запусками. Ключ — имя файла: адреса у
// локальных файлов нет, браузер его не отдаёт (см. ответ про «путь к файлам»).
const MEMORY = 'vinilyed:covers';
const known = (() => {
    try { return JSON.parse(localStorage.getItem(MEMORY)) ?? {}; } catch { return {}; }
})();
const remember = (key, found) => {
    known[key] = found;
    try { localStorage.setItem(MEMORY, JSON.stringify(known)); } catch { /* приват-режим */ }
};

let hunting = false;

const hunt = async () => {
    if (hunting) return;              // прошлый заход ещё идёт
    hunting = true;
    try {
        for (const { track, element } of items) {
            if (track.hasCover || track.tries >= MAX_TRIES) continue;
            track.tries++;
            const found = known[track.file] ?? await findCover(track);
            if (!found) continue;
            remember(track.file, found);
            track.hasCover = true;
            swapCover(element, track, found, await paletteFrom(found.url));
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
    let changed = false;

    for (const { track, element } of items) {
        const gone = Boolean(query) && !matches(track, query);
        if (gone === element.classList.contains('slot--gone')) continue;
        changed = true;

        if (gone) {
            element.classList.add('slot--gone');
            // Место закрываем, только когда конверт уже ушёл вниз, —
            // и одним разом, а не покадрово.
            setTimeout(() => {
                if (element.classList.contains('slot--gone')) element.classList.add('slot--hidden');
            }, SWAP_MS);
        } else {
            element.classList.remove('slot--hidden');
            void element.offsetWidth;    // вернуть высоту ДО того, как включится переход
            element.classList.remove('slot--gone');
        }
    }

    if (changed) setTimeout(() => scroll.refresh(), SWAP_MS + 40);
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
    spin = 0; lastFrame = 0; spinning = null;
});

// звук реально пошёл — вот теперь эта пластинка наша
player.on('playing', () => { spinning = current?.querySelector('.disc') ?? null; });