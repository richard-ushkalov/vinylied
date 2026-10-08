import { Emitter } from '../core/Emitter.js';
import { formatTime } from '../core/format.js';

const YOUTUBE_WATCH = 'https://www.youtube.com/watch?v=';

/**
 * @typedef {import('../downloads/DownloadServer.js').RemoteTrack} RemoteTrack
 * @typedef {{ key: string, title: string, artist: string, album?: string,
 *             duration: number, cover: string | null }} Suggestion
 *   трек, у которого пока есть только название — совет «послушать похожее»
 * @typedef {RemoteTrack | Suggestion} ListItem
 */

/** @param {ListItem} item */
const keyOf = item => ('id' in item ? item.id : item.key);
/** @param {ListItem} item */
const nameOf = item => [item.title, item.artist].filter(Boolean).join(' — ');

/**
 * Список треков из сети: обложка, название, «▶» и «Добавить». Общий
 * для поиска в сети и листа «Похожее».
 *
 * Строка бывает двух видов:
 *  - результат поиска на сервере — у неё уже есть id звука, ▶ и «Добавить»
 *    работают сразу;
 *  - совет «похожее» — только название. По нажатию сначала ищется звук
 *    (resolve), кнопка в это время — «Ищу…», дальше обычным путём.
 *
 * Прогресс пишется только в кнопки своей строки: перестраивать список на
 * каждый процент значит терять фокус и дёргать картинки.
 *
 * События: 'download' {result}, 'reveal' {id}, 'error' {message}.
 */
export class RemoteTrackList extends Emitter {
    #list;
    /** @type {ListItem[]} */
    #items = [];
    /** @type {Map<string, { add: HTMLButtonElement, listen: HTMLButtonElement, img: HTMLImageElement, item: ListItem }>} */
    #rows = new Map();
    /** @type {Map<string, RemoteTrack>} найденный звук совета, по ключу строки */
    #found = new Map();
    /** @type {Set<string>} строки, для которых сейчас ищется звук */
    #finding = new Set();

    /**
     * @param {{ list: HTMLElement,
     *           downloads: import('../downloads/DownloadQueue.js').DownloadQueue,
     *           previews: import('../downloads/PreviewPlayer.js').PreviewPlayer,
     *           resolve?: (item: Suggestion) => Promise<RemoteTrack> }} deps
     */
    constructor({ list, downloads, previews, resolve }) {
        super();
        this.#list = list;
        this.downloads = downloads;
        this.previews = previews;
        this.resolve = resolve;
    }

    attach() {
        this.#list.addEventListener('click', event => {
            const target = /** @type {HTMLElement} */ (event.target).closest('[data-action]');
            if (!target) return;
            const row = this.#rows.get(target.getAttribute('data-key') ?? '');
            switch (target.getAttribute('data-action')) {
                case 'listen':
                    if (row) this.#ready(row.item).then(result => { if (result) this.previews.toggle(result); });
                    break;
                case 'download':
                    if (row) this.#ready(row.item).then(result => { if (result) this.emit('download', { result }); });
                    break;
                case 'reveal': {
                    const id = target.getAttribute('data-track');
                    if (id) this.emit('reveal', { id });
                    break;
                }
            }
        });
        for (const type of ['added', 'progress', 'done', 'failed']) {
            this.downloads.on(type, ({ id }) => {
                const result = this.downloads.get(id)?.result;
                if (result) this.#repaint(result);
            });
        }
        this.previews.on('state', ({ result }) => { if (result) this.#repaint(result); });
    }

    /** @param {ListItem[]} items */
    render(items) {
        this.#items = items;
        this.#rows.clear();
        this.#list.replaceChildren(...items.map(item => this.#row(item)));
    }

    get items() { return this.#items; }

    /**
     * Обложка нашлась позже — подставить в строку, не перестраивая список.
     * @param {string} key
     * @param {string} cover
     */
    setCover(key, cover) {
        const row = this.#rows.get(key);
        if (!row) return;
        row.item.cover = cover;
        row.img.src = cover;
    }

    /**
     * Звук строки: свой у результата поиска, найденный — у совета.
     * @param {ListItem} item
     * @returns {RemoteTrack | null}
     */
    soundOf(item) {
        return 'id' in item ? item : this.#found.get(item.key) ?? null;
    }

    /**
     * Звук для строки — найти, если его ещё нет. Не нашёлся — null и
     * событие 'error' с объяснением.
     * @param {ListItem} item
     * @returns {Promise<RemoteTrack | null>}
     */
    async #ready(item) {
        const known = this.soundOf(item);
        if (known) return known;
        if (!this.resolve || 'id' in item) return null;
        const key = item.key;
        if (this.#finding.has(key)) return null;
        this.#finding.add(key);
        this.#paint(key);
        try {
            const result = await this.resolve(item);
            this.#found.set(key, result);
            return result;
        } catch (error) {
            this.emit('error', { message: /** @type {Error} */ (error).message });
            return null;
        } finally {
            this.#finding.delete(key);
            this.#paint(key);
        }
    }

    /**
     * Найти звук для строки заранее — для «Добавить все».
     * @param {ListItem} item
     */
    ready(item) { return this.#ready(item); }

    /** @param {RemoteTrack} result */
    #repaint(result) {
        for (const [key, row] of this.#rows) {
            if (this.soundOf(row.item)?.id === result.id) this.#paint(key);
        }
    }

    /** @param {string} key */
    #paint(key) {
        const row = this.#rows.get(key);
        if (!row) return;
        this.#paintListen(row.listen, row.item);
        this.#paintAdd(row.add, row.item);
    }

    /** @param {ListItem} item */
    #row(item) {
        const key = keyOf(item);
        const li = document.createElement('li');
        li.className = 'suggest__item';
        const name = nameOf(item);

        const img = document.createElement('img');
        img.className = 'suggest__cover';
        img.alt = '';
        img.loading = 'lazy';
        img.decoding = 'async';
        if (item.cover) img.src = item.cover;
        let cover = /** @type {HTMLElement} */ (img);
        if ('id' in item && item.source === 'youtube') {
            // превью ролика — ссылкой на YouTube: посмотреть, то ли это
            const link = document.createElement('a');
            link.className = 'suggest__video';
            link.href = `${YOUTUBE_WATCH}${item.id}`;
            link.target = '_blank';
            link.rel = 'noopener';
            link.setAttribute('aria-label', `Открыть «${name}» на YouTube`);
            link.append(img);
            cover = link;
        }

        const text = document.createElement('div');
        text.className = 'suggest__text';
        const title = document.createElement('span');
        title.className = 'suggest__title';
        title.textContent = item.title;
        const meta = document.createElement('span');
        meta.className = 'suggest__meta';
        meta.textContent = [item.artist, item.album, item.duration ? formatTime(item.duration) : '']
            .filter(Boolean).join(' · ');
        text.append(title, meta);

        const listen = document.createElement('button');
        listen.type = 'button';
        listen.className = 'icon-button icon-button--small icon-button--ghost suggest__listen';
        listen.dataset.action = 'listen';
        listen.dataset.key = key;
        listen.innerHTML = '<svg aria-hidden="true"><use href="#i-play"/></svg>';

        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'pill-button pill-button--small';

        this.#rows.set(key, { add, listen, img, item });
        this.#paintListen(listen, item);
        this.#paintAdd(add, item);
        li.append(cover, text, listen, add);
        return li;
    }

    /**
     * ▶ — послушать, ■ — остановить, пока ищется звук — мигает.
     * @param {HTMLButtonElement} button
     * @param {ListItem} item
     */
    #paintListen(button, item) {
        const sound = this.soundOf(item);
        const state = sound ? this.previews.stateOf(sound.id) : null;
        const name = nameOf(item);
        const loading = state === 'loading' || this.#finding.has(keyOf(item));
        const active = loading || state === 'playing';
        button.classList.toggle('suggest__listen--loading', loading);
        button.setAttribute('aria-pressed', String(active));
        button.setAttribute('aria-label', active ? `Остановить «${name}»` : `Послушать «${name}»`);
        button.querySelector('use')?.setAttribute('href', active ? '#i-stop' : '#i-play');
    }

    /**
     * «Добавить» → «Ищу…» → «Жду» → проценты → «На полке» (показать
     * конверт) или «Ещё раз».
     * @param {HTMLButtonElement} button
     * @param {ListItem} item
     */
    #paintAdd(button, item) {
        const key = keyOf(item);
        const sound = this.soundOf(item);
        const state = sound ? this.downloads.stateOf(sound.id) : null;
        const name = nameOf(item);
        delete button.dataset.action;
        button.dataset.key = key;
        button.disabled = false;
        if (this.#finding.has(key)) {
            button.disabled = true;
            button.textContent = 'Ищу…';
            button.setAttribute('aria-label', `«${name}»: ищу звук`);
        } else if (state?.state === 'waiting') {
            button.disabled = true;
            button.textContent = 'Жду';
            button.setAttribute('aria-label', `«${name}»: в очереди на скачивание`);
        } else if (state?.state === 'running') {
            const percent = Math.round(state.progress * 100);
            button.disabled = true;
            button.textContent = `${percent}%`;
            button.setAttribute('aria-label', `«${name}»: ${state.stage.toLowerCase()}, ${percent}%`);
        } else if (state?.state === 'done') {
            button.dataset.action = 'reveal';
            button.dataset.track = state.id;
            button.textContent = 'На полке';
            button.setAttribute('aria-label', `Показать «${name}» на полке`);
        } else {
            button.dataset.action = 'download';
            button.textContent = state?.state === 'failed' ? 'Ещё раз' : 'Добавить';
            button.setAttribute('aria-label', `Добавить «${name}»`);
        }
    }
}
