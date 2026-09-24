import { Emitter } from '../core/Emitter.js';
import { formatTime } from '../core/format.js';

const MIN_QUERY = 3;
// пауза в наборе, после которой ищем; Enter — сразу
const DEBOUNCE = 600;
const CACHE = 30;
const YOUTUBE_WATCH = 'https://www.youtube.com/watch?v=';

/**
 * @typedef {import('../downloads/DownloadServer.js').RemoteTrack} RemoteTrack
 * @typedef {import('../downloads/DownloadServer.js').Source} Source
 */

/**
 * «Найти в сети» под поиском по полке, вкладками Spotify | YouTube.
 * Если на полке ничего не нашлось — сразу список с сервера; если нашлось —
 * одна строка «Нет нужного? Найти в сети», чтобы не заслонять найденное.
 * В строке — «▶» (послушать с сервера, на полку не кладя) и «Добавить».
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
    #note = '';
    #failed = false;
    #timer = 0;
    /** @type {AbortController | null} */
    #request = null;
    /** @type {Map<string, RemoteTrack[]>} */
    #cache = new Map();
    /** @type {Map<string, { add: HTMLButtonElement, listen: HTMLButtonElement }>} кнопки строк по id результата */
    #rows = new Map();

    /**
     * @param {{ root: HTMLElement,
     *           server: import('../downloads/DownloadServer.js').DownloadServer,
     *           downloads: import('../downloads/DownloadQueue.js').DownloadQueue,
     *           previews: import('../downloads/PreviewPlayer.js').PreviewPlayer,
     *           settings: import('../core/Settings.js').Settings,
     *           isOnShelf: (result: RemoteTrack) => boolean }} deps
     */
    constructor({ root, server, downloads, previews, settings, isOnShelf }) {
        super();
        this.#root = root;
        this.server = server;
        this.downloads = downloads;
        this.previews = previews;
        this.settings = settings;
        this.isOnShelf = isOnShelf;
        const $ = selector => /** @type {HTMLElement} */ (root.querySelector(selector));
        this.tabs = $('.suggest__tabs');
        this.more = /** @type {HTMLButtonElement} */ ($('.suggest__more'));
        this.noteText = $('.suggest__note');
        this.list = $('.suggest__list');
    }

    /** @returns {Source} */
    get source() { return this.settings.get('downloadSource'); }

    attach() {
        this.#root.addEventListener('click', event => {
            const target = /** @type {HTMLElement} */ (event.target).closest('[data-action]');
            const result = this.#results?.find(item => item.id === target?.getAttribute('data-id'));
            switch (target?.getAttribute('data-action')) {
                case 'suggest-more':
                    this.#expanded = true;
                    this.#fetch({ fresh: this.#failed });
                    break;
                case 'download':
                    if (result) this.emit('download', { result });
                    break;
                case 'listen':
                    if (result) this.previews.toggle(result);
                    break;
                case 'reveal': {
                    const id = target.getAttribute('data-track');
                    if (id) this.emit('reveal', { id });
                    break;
                }
            }
        });
        this.tabs.addEventListener('change', event => {
            this.settings.set('downloadSource', /** @type {HTMLInputElement} */ (event.target).value);
        });
        this.settings.watch(['downloadSource'], ({ downloadSource }) => {
            const radio = /** @type {HTMLInputElement | null} */ (this.tabs.querySelector(`input[value="${downloadSource}"]`));
            if (radio) radio.checked = true;
            this.#switchSource();
        });

        // Прогресс — только кнопке своей строки: перестраивать список на каждый
        // процент значит терять фокус и дёргать картинки.
        for (const type of ['added', 'progress', 'done', 'failed']) {
            this.downloads.on(type, ({ id }) => {
                const result = this.downloads.get(id)?.result;
                const row = result && this.#rows.get(result.id);
                if (row) this.#paintAdd(row.add, result);
            });
        }
        this.previews.on('state', ({ result, state, message }) => {
            const row = result && this.#rows.get(result.id);
            if (row) this.#paintListen(row.listen, result);
            if (state === 'error' && !this.#root.hidden) {
                this.#note = message;
                this.noteText.textContent = message;
            }
        });
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
            this.#results = this.#cache.get(this.#key(query)) ?? null;
            this.#note = '';
            this.#failed = false;
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

    /** «Найти» на клавиатуре: искать сразу, без паузы, и раскрыть список. */
    searchNow() {
        clearTimeout(this.#timer);
        if (!this.server.enabled || this.#query.length < MIN_QUERY) return;
        this.#expanded = true;
        this.#fetch({ fresh: this.#failed });
    }

    /** Список раскрыт: на полке ничего нет — или попросили сами. */
    get #open() {
        return this.#expanded || this.#local === 0;
    }

    /** @param {string} query */
    #key(query) {
        return `${this.source}:${query.toLowerCase()}`;
    }

    #switchSource() {
        this.#request?.abort();
        this.#results = this.#cache.get(this.#key(this.#query)) ?? null;
        this.#note = '';
        this.#failed = false;
        if (this.#root.hidden || !this.#open) return;
        this.#fetch();
    }

    /** @param {{ fresh?: boolean }} [options] fresh — мимо кеша (повтор после ошибки) */
    async #fetch({ fresh = false } = {}) {
        const query = this.#query;
        const source = this.source;
        const key = this.#key(query);
        if (!fresh && this.#cache.has(key)) {
            this.#results = /** @type {RemoteTrack[]} */ (this.#cache.get(key));
            this.#render();
            return;
        }
        this.#request?.abort();
        const request = new AbortController();
        this.#request = request;
        this.#note = 'Ищу в сети…';
        this.#failed = false;
        this.#render();
        try {
            const results = await this.server.search(query, { source, signal: request.signal });
            this.#cache.set(key, results);
            if (this.#cache.size > CACHE) this.#cache.delete(/** @type {string} */ (this.#cache.keys().next().value));
            if (key !== this.#key(this.#query)) return;
            this.#results = results;
            this.#note = '';
        } catch (error) {
            if (request.signal.aborted) return;
            const failure = /** @type {import('../downloads/DownloadServer.js').DownloadError} */ (error);
            // тот же код прислал запрос новее (с другого устройства) — этот не нужен
            if (failure.code === 'superseded') return;
            this.#failed = true;
            this.#note = failure.message + (failure.timeout
                ? ' — попробуйте ещё раз.'
                : this.server.status === 'offline'
                    ? ' — Мак выключен или нет интернета.'
                    : this.server.status === 'rejected' ? ' — проверьте его в настройках.' : '.');
        }
        this.#render();
    }

    #render() {
        const open = this.#open;
        this.#root.hidden = false;
        this.tabs.hidden = !open;
        // одна кнопка на два случая: раскрыть свёрнутый список или повторить поиск
        this.more.hidden = open && !this.#failed;
        this.more.textContent = open ? 'Искать ещё раз' : 'Нет нужного? Найти в сети';
        this.noteText.textContent = open ? this.#note : '';
        this.#renderList();
    }

    #renderList() {
        this.#rows.clear();
        if (this.#root.hidden || !this.#open) {
            this.list.replaceChildren();
            return;
        }
        // Что уже на полке — не предлагаем (кроме того, что качается сейчас:
        // там строка показывает, как идут дела). Только для Spotify: названия
        // роликов слишком разные, чтобы по ним судить.
        const shown = (this.#results ?? []).filter(result =>
            result.source === 'youtube' || this.downloads.stateOf(result.id) || !this.isOnShelf(result));
        if (this.#results && !shown.length && !this.#note) {
            this.noteText.textContent = this.#results.length ? 'Всё найденное уже на полке.' : 'В сети ничего не нашлось.';
        }
        this.list.replaceChildren(...shown.map(result => this.#row(result)));
    }

    /** @param {RemoteTrack} result */
    #row(result) {
        const li = document.createElement('li');
        li.className = 'suggest__item';
        const name = [result.title, result.artist].filter(Boolean).join(' — ');

        const img = document.createElement('img');
        img.className = 'suggest__cover';
        img.alt = '';
        img.loading = 'lazy';
        img.decoding = 'async';
        if (result.cover) img.src = result.cover;
        let cover = /** @type {HTMLElement} */ (img);
        if (result.source === 'youtube') {
            // превью ролика — ссылкой на YouTube: посмотреть, то ли это
            const link = document.createElement('a');
            link.className = 'suggest__video';
            link.href = `${YOUTUBE_WATCH}${result.id}`;
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
        title.textContent = result.title;
        const meta = document.createElement('span');
        meta.className = 'suggest__meta';
        meta.textContent = [result.artist, result.album, result.duration ? formatTime(result.duration) : '']
            .filter(Boolean).join(' · ');
        text.append(title, meta);

        const listen = document.createElement('button');
        listen.type = 'button';
        listen.className = 'icon-button icon-button--small icon-button--ghost suggest__listen';
        listen.dataset.action = 'listen';
        listen.dataset.id = result.id;
        listen.innerHTML = '<svg aria-hidden="true"><use href="#i-play"/></svg>';
        this.#paintListen(listen, result);

        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'pill-button pill-button--small';
        this.#paintAdd(add, result);

        this.#rows.set(result.id, { add, listen });
        li.append(cover, text, listen, add);
        return li;
    }

    /**
     * ▶ — послушать, ■ — остановить, пока ищется звук — мигает.
     * @param {HTMLButtonElement} button
     * @param {RemoteTrack} result
     */
    #paintListen(button, result) {
        const state = this.previews.stateOf(result.id);
        const name = [result.title, result.artist].filter(Boolean).join(' — ');
        const active = state === 'loading' || state === 'playing';
        button.classList.toggle('suggest__listen--loading', state === 'loading');
        button.setAttribute('aria-pressed', String(active));
        button.setAttribute('aria-label', active ? `Остановить «${name}»` : `Послушать «${name}»`);
        button.querySelector('use')?.setAttribute('href', active ? '#i-stop' : '#i-play');
    }

    /**
     * «Добавить» → проценты → «На полке» (показать конверт) или «Ещё раз».
     * @param {HTMLButtonElement} button
     * @param {RemoteTrack} result
     */
    #paintAdd(button, result) {
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
            button.textContent = state?.state === 'failed' ? 'Ещё раз' : 'Добавить';
            button.setAttribute('aria-label', `Добавить «${name}»`);
        }
    }
}
