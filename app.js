import { createScroll } from './scroll.js';
import { createInputReader, readTrack } from './data.js';
import { createVinyl } from './vinyl.js';
import { createPlayer  } from "./player.js";
import { createProgress } from './progress.js';

const list = document.querySelector('.list');
const scene = document.querySelector('.scene');

const player = createPlayer();
const progress = createProgress({ root: document.querySelector('.progress'), player });

let items = [];
let current = null;
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
input.onChange(createShelf);

// рисует по ФАКТУ, ничего не решает и никого не двигает
const render = () => {
    // НЕ player.isPaused(): при смене src он на миг становится true,
    // и конверт успевал дёрнуться в состояние паузы и обратно
    const playing = current !== null && intent === 'playing';

    items.forEach(({ element }) => {
        element.classList.toggle('slot--active', element === current && playing);
        element.classList.toggle('slot--paused', element === current && !playing);
    });

    if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState =
            current === null ? 'none' : playing ? 'playing' : 'paused';
    }
};

const indexOf = element => items.findIndex(item => item.element === element);

// всегда запускает указанный трек с начала
const start = index => {
    const item = items[index];
    if (!item) return;

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
player.on('ended', playNext);