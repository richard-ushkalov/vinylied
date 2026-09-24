const SWAP_MS = 400;          // столько же, сколько --dur-base

/**
 * Один конверт на полке. Знает только свою разметку: подписи, обложку,
 * цвет корешка. Состояния (текущий, отсеянный) выставляет Shelf.
 */
export class VinylView {
    /** @type {HTMLLIElement} */
    element;
    /** @type {import('../../library/Track.js').Track | import('../../downloads/PendingTrack.js').PendingTrack} */
    track;
    #swapTimer = 0;

    /**
     * @param {HTMLTemplateElement} template
     * @param {VinylView['track']} track
     */
    constructor(template, track) {
        this.element = /** @type {HTMLLIElement} */ (template.content.firstElementChild.cloneNode(true));
        this.element.dataset.id = track.id;
        this.element.id = `slot-${track.id}`;
        this.front = /** @type {HTMLImageElement} */ (this.element.querySelector('.vinyl__frontside'));
        this.back = /** @type {HTMLImageElement} */ (this.element.querySelector('.vinyl__backside'));
        this.album = this.element.querySelector('.vinyl__side__album');
        this.title = this.element.querySelector('.vinyl__side__title');
        this.label = /** @type {HTMLElement} */ (this.element.querySelector('.disc__label'));
        this.disc = /** @type {HTMLElement} */ (this.element.querySelector('.disc'));
        this.render(track);
    }

    /** @param {VinylView['track']} track */
    render(track) {
        this.track = track;
        this.album.textContent = track.album;
        this.title.textContent = track.title;
        this.element.setAttribute('aria-label', [track.title, track.artist, track.album].filter(Boolean).join(' — '));

        const cover = track.cover;
        if (this.front.getAttribute('src') !== cover) {
            this.front.src = cover;
            this.back.src = cover;
        }
        this.front.alt = `${track.album} — ${track.title}`;
        // на пластинку идёт только этикетка; сам винил чёрный
        this.label.style.setProperty('--disc-art', `url("${cover}")`);

        if (track.spine) {
            this.element.style.setProperty('--spine', track.spine);
            this.element.style.setProperty('--spine-text', track.spineText);
        } else {
            // Цвет корешка НЕ выдумываем: без своей картинки он берёт
            // нейтральный откат из темы. Придуманный цвет выглядел бы как
            // настоящий результат разбора обложки, а это враньё.
            this.element.style.removeProperty('--spine');
            this.element.style.removeProperty('--spine-text');
        }
    }

    /**
     * Конверт ныряет вниз, меняем всё разом, конверт возвращается.
     * @param {import('../../library/Track.js').Track} track
     * @param {{ animate?: boolean }} [options]
     */
    swap(track, { animate = true } = {}) {
        clearTimeout(this.#swapTimer);
        this.track = track;
        if (!animate) { this.render(track); return; }
        this.element.classList.add('slot--swap');
        this.#swapTimer = window.setTimeout(() => {
            this.render(track);
            this.element.classList.remove('slot--swap');
        }, SWAP_MS);
    }

    /**
     * Скачивается: грани проявляются вместе с загрузкой (см. .slot--pending).
     * null — скачано, конверт обычный.
     * @param {number | null} fraction 0..1
     */
    setProgress(fraction) {
        if (fraction === null) {
            this.element.style.removeProperty('--progress');
            this.render(this.track);    // подпись для экранного диктора — без процентов
            return;
        }
        this.element.style.setProperty('--progress', fraction.toFixed(3));
        const { title, artist } = this.track;
        this.element.setAttribute('aria-label',
            `${[title, artist].filter(Boolean).join(' — ')}: скачивается, ${Math.round(fraction * 100)}%`);
    }

    /** Ждём, пока обложка РЕАЛЬНО декодируется. */
    decode() {
        return this.front.decode?.().catch(() => {}) ?? Promise.resolve();
    }

    destroy() {
        clearTimeout(this.#swapTimer);
        this.element.remove();
    }
}
