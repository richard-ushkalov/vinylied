import { Emitter } from '../core/Emitter.js';

const SEARCH_DEBOUNCE = 120;

/**
 * Нижняя панель: что играет, мини-обложка, ⏯, поиск, «добавить».
 *
 * События: 'toggle', 'add', 'reveal' (показать играющий конверт),
 * 'search' {query}, 'submit' {query} — «Найти» на клавиатуре.
 */
export class Dock extends Emitter {
    #root;
    #searchTimer = 0;

    /** @param {HTMLElement} root */
    constructor(root) {
        super();
        this.#root = root;
        const $ = selector => /** @type {HTMLElement} */ (root.querySelector(selector));
        this.cover = /** @type {HTMLButtonElement} */ ($('.dock__cover'));
        this.coverImage = /** @type {HTMLImageElement} */ ($('.dock__cover img'));
        this.title = $('.dock__title');
        this.meta = $('.dock__meta');
        this.form = /** @type {HTMLFormElement} */ ($('.search'));
        this.input = /** @type {HTMLInputElement} */ ($('.search__input'));
        this.playButton = $('[data-action="play"]');
        this.playIcon = /** @type {SVGUseElement} */ (this.playButton.querySelector('use'));
        this.searchButton = $('[data-action="search"]');
    }

    get searching() { return this.#root.classList.contains('dock--search'); }

    attach() {
        this.#root.addEventListener('click', event => {
            const target = /** @type {HTMLElement} */ (event.target).closest('[data-action]');
            switch (target?.getAttribute('data-action')) {
                case 'play': this.emit('toggle'); break;
                case 'add': this.emit('add'); break;
                case 'reveal': this.emit('reveal'); break;
                case 'search': this.openSearch(); break;
                case 'search-close': this.closeSearch(); break;
            }
        });

        this.input.addEventListener('input', () => {
            clearTimeout(this.#searchTimer);
            this.#searchTimer = window.setTimeout(() => this.emit('search', { query: this.input.value }), SEARCH_DEBOUNCE);
        });
        // «Найти» на клавиатуре — искать сразу, без паузы, и спрятать клавиатуру
        this.form.addEventListener('submit', event => {
            event.preventDefault();
            clearTimeout(this.#searchTimer);
            this.emit('search', { query: this.input.value });
            this.emit('submit', { query: this.input.value });
            this.input.blur();
        });
        this.input.addEventListener('keydown', event => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            this.closeSearch();
        });
        this.setTrack(null);
    }

    /** @param {import('../library/Track.js').Track | null} track */
    setTrack(track) {
        this.#root.classList.toggle('dock--idle', !track);
        this.title.textContent = track ? track.title : 'Выберите пластинку';
        this.meta.textContent = track ? [track.artist, track.album].filter(Boolean).join(' · ') : '';
        if (track && this.coverImage.getAttribute('src') !== track.cover) this.coverImage.src = track.cover;
    }

    /** @param {boolean} playing */
    setPlaying(playing) {
        this.playIcon.setAttribute('href', playing ? '#i-pause' : '#i-play');
        this.playButton.setAttribute('aria-label', playing ? 'Пауза' : 'Играть');
    }

    /**
     * Мини-обложка «уезжает в угол», когда играющий конверт вне кадра.
     * @param {boolean} shown
     */
    setCoverShown(shown) {
        if (this.#root.classList.contains('dock--cover') === shown) return;
        this.#root.classList.toggle('dock--cover', shown);
        this.cover.tabIndex = shown ? 0 : -1;
    }

    openSearch() {
        this.#root.classList.add('dock--search');
        this.form.hidden = false;
        this.searchButton.setAttribute('aria-expanded', 'true');
        this.input.focus();
    }

    closeSearch() {
        if (!this.searching) return;
        clearTimeout(this.#searchTimer);
        this.input.value = '';
        this.emit('search', { query: '' });
        this.#root.classList.remove('dock--search');
        this.form.hidden = true;
        this.searchButton.setAttribute('aria-expanded', 'false');
        this.searchButton.focus();
    }
}
