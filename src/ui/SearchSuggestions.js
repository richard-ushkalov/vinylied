import { Emitter } from '../core/Emitter.js';
import { formatTime } from '../core/format.js';

const MIN_QUERY = 2;
const DEBOUNCE = 350;
const CACHE = 20;

/**
 * @typedef {import('../downloads/DownloadServer.js').RemoteTrack} RemoteTrack
 */

/**
 * «Скачать из сети» под поиском по полке. Если на полке ничего не
 * нашлось — сразу список с сервера; если нашлось — одна строка
 * «Нет нужного? Найти в сети», чтобы не заслонять найденное.
 * Без кода доступа панели нет совсем.
 *
 * События: 'download' {result}, 'reveal' {id} — показать скачанный конверт.
 */
export class SearchSuggestions extends Emitter {
    #root;
    #query = '';
    #local = 0;
    #expanded = false;
    /** @type {RemoteTrack[] | null} */
    #results = null;
    /** @type {string} */
    #note = '';
    #timer = 0;
    /** @type {AbortController | null} */
    #request = null;
    /** @type {Map<string, RemoteTrack[]>} */
    #cache = new Map();
    /** @type {Map<string, HTMLButtonElement>} кнопки строк по id результата */
    #buttons = new Map();

    /**
     * @param {{ root: HTMLElement,
     *           server: import('../downloads/DownloadServer.js').DownloadServer,
     *           downloads: import('../downloads/DownloadQueue.js').DownloadQueue,
     *           isOnShelf: (result: RemoteTrack) => boolean }} deps
     */
    constructor({ root, server, downloads, isOnShelf }) {
        super();
        this.#root = root;
        this.server = server;
        this.downloads = downloads;
        this.isOnShelf = isOnShelf;
        const $ = selector => /** @type {HTMLElement} */ (root.querySelector(selector));
        this.more = /** @type {HTMLButtonElement} */ ($('[data-action="suggest-more"]'));
        this.noteText = $('.suggest__note');
        this.list = $('.suggest__list');
    }

    attach() {
        this.#root.addEventListener('click', event => {
            const target = /** @type {HTMLElement} */ (event.target).closest('[data-action]');
            switch (target?.getAttribute('data-action')) {
                case 'suggest-more':
                    this.#expanded = true;
                    this.#fetch();
                    break;
                case 'download': {
                    const result = this.#results?.find(item => item.id === target.getAttribute('data-id'));
                    if (result) this.emit('download', { result });
                    break;
                }
                case 'reveal': {
                    const id = target.getAttribute('data-track');
                    if (id) this.emit('reveal', { id });
                    break;
                }
            }
        });
        // Прогресс — только кнопке своей строки: перестраивать список на каждый
        // процент значит терять фокус и дёргать картинки.
        for (const type of ['added', 'progress', 'done', 'failed']) {
            this.downloads.on(type, ({ id }) => {
                const result = this.downloads.get(id)?.result;
                const button = result && this.#buttons.get(result.id);
                if (button) this.#paint(button, result);
            });
        }
        this.server.on('status', () => { if (!this.server.enabled) this.setQuery(''); });
    }

    /**
     * @param {string} raw что введено в поиск
     * @param {{ localMatches?: number }} [options] сколько нашлось на полке
     */
    setQuery(raw, { localMatches = 0 } = {}) {
        const query = raw.trim();
        this.#local = localMatches;
        clearTimeout(this.#timer);
        if (query !== this.#query) {
            this.#request?.abort();
            this.#results = this.#cache.get(query.toLowerCase()) ?? null;
            this.#note = '';
        }
        this.#query = query;
        if (!query) this.#expanded = false;

        if (!this.server.enabled || query.length < MIN_QUERY) {
            this.#root.hidden = true;
            return;
        }
        if (this.#open) this.#timer = window.setTimeout(() => this.#fetch(), this.#results ? 0 : DEBOUNCE);
        this.#render();
    }

    /** Список раскрыт: на полке ничего нет — или попросили сами. */
    get #open() {
        return this.#expanded || this.#local === 0;
    }

    async #fetch() {
        const query = this.#query;
        const key = query.toLowerCase();
        if (this.#cache.has(key)) {
            this.#results = /** @type {RemoteTrack[]} */ (this.#cache.get(key));
            this.#render();
            return;
        }
        this.#request?.abort();
        const request = new AbortController();
        this.#request = request;
        this.#note = 'Ищу в сети…';
        this.#render();
        try {
            const results = await this.server.search(query, { signal: request.signal });
            this.#cache.set(key, results);
            if (this.#cache.size > CACHE) this.#cache.delete(/** @type {string} */ (this.#cache.keys().next().value));
            if (query !== this.#query) return;
            this.#results = results;
            this.#note = '';
        } catch (error) {
            if (request.signal.aborted) return;
            this.#note = /** @type {Error} */ (error).message + (this.server.status === 'offline'
                ? ' — Мак выключен или нет интернета.'
                : this.server.status === 'rejected' ? ' — проверьте его в настройках.' : '.');
        }
        this.#render();
    }

    #render() {
        const open = this.#open;
        this.#root.hidden = false;
        this.more.hidden = open;
        this.noteText.textContent = open ? this.#note : '';
        this.#renderList();
    }

    #renderList() {
        this.#buttons.clear();
        if (this.#root.hidden || !this.#open) {
            this.list.replaceChildren();
            return;
        }
        // Что уже на полке — не предлагаем. Кроме того, что качается или
        // скачано сейчас: там строка показывает, как идут дела.
        const shown = (this.#results ?? []).filter(result => this.downloads.stateOf(result.id) || !this.isOnShelf(result));
        if (this.#results && !shown.length && !this.#note) {
            this.noteText.textContent = this.#results.length ? 'Всё найденное уже на полке.' : 'В сети ничего не нашлось.';
        }
        this.list.replaceChildren(...shown.map(result => this.#row(result)));
    }

    /** @param {RemoteTrack} result */
    #row(result) {
        const li = document.createElement('li');
        li.className = 'suggest__item';

        const img = document.createElement('img');
        img.className = 'suggest__cover';
        img.alt = '';
        img.loading = 'lazy';
        img.decoding = 'async';
        if (result.cover) img.src = result.cover;

        const text = document.createElement('div');
        text.className = 'suggest__text';
        const title = document.createElement('span');
        title.className = 'suggest__title';
        title.textContent = result.title;
        const meta = document.createElement('span');
        meta.className = 'suggest__meta';
        meta.textContent = [result.artist, result.album, result.duration ? formatTime(result.duration) : '']
            .filter(Boolean).join(' · ');
        text.append(title, meta);

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'pill-button pill-button--small';
        this.#paint(button, result);
        this.#buttons.set(result.id, button);
        li.append(img, text, button);
        return li;
    }

    /**
     * Кнопка строки по состоянию скачивания: «Скачать» → проценты →
     * «На полке» (показать конверт) или «Ещё раз».
     * @param {HTMLButtonElement} button
     * @param {RemoteTrack} result
     */
    #paint(button, result) {
        const state = this.downloads.stateOf(result.id);
        const name = [result.title, result.artist].filter(Boolean).join(' — ');
        delete button.dataset.action;
        button.disabled = false;
        if (state?.state === 'running') {
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
            button.dataset.id = result.id;
            button.textContent = state?.state === 'failed' ? 'Ещё раз' : 'Скачать';
            button.setAttribute('aria-label', `Скачать «${name}»`);
        }
    }
}
