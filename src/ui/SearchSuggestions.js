import { Emitter } from '../core/Emitter.js';
import { RemoteTrackList } from './RemoteTrackList.js';

const MIN_QUERY = 3;
// пауза в наборе, после которой ищем; Enter — сразу
const DEBOUNCE = 600;
const CACHE = 30;

/**
 * @typedef {import('../downloads/DownloadServer.js').RemoteTrack} RemoteTrack
 * @typedef {import('../downloads/DownloadServer.js').Source} Source
 */

/**
 * «Найти в сети» под поиском по полке, вкладками Spotify | YouTube.
 * Если на полке ничего не нашлось — сразу список с сервера; если нашлось —
 * одна строка «Нет нужного? Найти в сети», чтобы не заслонять найденное.
 * В строке — «▶» (послушать с сервера, на полку не кладя) и «Добавить»
 * (строки рисует RemoteTrackList). Без кода доступа панели нет совсем.
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
        this.rows = new RemoteTrackList({ list: $('.suggest__list'), downloads, previews });
    }

    /** @returns {Source} */
    get source() { return this.settings.get('downloadSource'); }

    attach() {
        this.rows.attach();
        this.rows.on('download', event => this.emit('download', event));
        this.rows.on('reveal', event => this.emit('reveal', event));
        this.more.addEventListener('click', () => {
            this.#expanded = true;
            this.#fetch({ fresh: this.#failed });
        });
        this.tabs.addEventListener('change', event => {
            this.settings.set('downloadSource', /** @type {HTMLInputElement} */ (event.target).value);
        });
        this.settings.watch(['downloadSource'], ({ downloadSource }) => {
            const radio = /** @type {HTMLInputElement | null} */ (this.tabs.querySelector(`input[value="${downloadSource}"]`));
            if (radio) radio.checked = true;
            this.#switchSource();
        });

        this.previews.on('state', ({ result, state, message }) => {
            // ошибка прослушивания — в заметку, если это наша строка
            if (state === 'error' && !this.#root.hidden && this.#results?.some(item => item.id === result?.id)) {
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
        if (this.#root.hidden || !this.#open) {
            this.rows.render([]);
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
        this.rows.render(shown);
    }
}
