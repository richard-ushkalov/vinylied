import { createScroll } from './scroll.js';
import { createInputReader, readTrack } from './data.js';
import { createVinyl } from './vinyl.js';
import { createPlayer  } from "./player.js";

const list = document.querySelector('.list');
const scene = document.querySelector('.scene');

const player = createPlayer();

let items = [];
let current = null;

const scroll = createScroll({
    viewport: scene,
    strip: list,
    openSpace: 500,
    onFocus: index => {
        items.forEach(({ element }, i) =>
            element.classList.toggle('slot--focused', i === index));
    },
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

            const index = items.length;
            element.addEventListener('click', () => {
                scroll.goTo(index);
                current = element;
                player.playTrack(track.src);
            });

            items.push({ track, element });
        } catch (error) { console.error('Error on create: ', error.name, error.message); }
    }
    scroll.setCount(items.length);
}

const input = createInputReader(document.querySelector('.input'));
input.onChange(createShelf);

const render = () => {
    items.forEach(({ element }) => element.classList.toggle('slot--active', element === current && !player.isPaused()));
};

const playNext = () => {
    const index = items.findIndex(({ element }) => element === current);
    const next = items[index + 1] ?? items[0];

    current = next.element;
    player.playTrack(next.track.src);
};

['playing', 'pause', 'ended', 'emptied'].forEach(type => player.on(type, render));
player.on('ended', playNext);