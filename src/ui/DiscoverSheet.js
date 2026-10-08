import { Emitter } from '../core/Emitter.js';
import { generatedCover } from '../media/Artwork.js';
import { Track } from '../library/Track.js';
import { RemoteTrackList } from './RemoteTrackList.js';

const LIMIT = 25;
// «Добавить все» ищет звук по одному: у сервера 30 поисков в минуту на код
const ADD_ALL_PAUSE = 2500;

/**
 * @typedef {import('./RemoteTrackList.js').Suggestion} Suggestion
 * @typedef {import('./RemoteTrackList.js').ListItem} ListItem
 * @typedef {{ id: string, title: string, artist: string }} Seed
 */

/** @param {number} ms */
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Лист «Похожее»: «На этот трек» — что похоже на играющий, и «Микс дня» —
 * 25 треков, похожих на то, что стоит на полке. Список названий даёт
 * Last.fm, звук ищется на своём сервере, только когда трек хотят
 * послушать или добавить.
 *
 * События: 'download' {result}, 'reveal' {id}.
 */
export class DiscoverSheet extends Emitter {
    #dialog;
    /** @type {'track' | 'mix'} */
    #tab = 'track';
    /** @type {Seed | null} */
    #seed = null;
    /** @type {Map<string, Suggestion[]>} похожие по ключу трека — на сеанс */
    #similar = new Map();
    #request = 0;          // номер последней загрузки: ответ старой не рисуем
    #adding = false;

    /**
     * @param {{ dialog: HTMLDialogElement,
     *           lastfm: import('../discover/LastFmClient.js').LastFmClient,
     *           mix: import('../discover/DailyMix.js').DailyMix,
     *           server: import('../downloads/DownloadServer.js').DownloadServer,
     *           downloads: import('../downloads/DownloadQueue.js').DownloadQueue,
     *           previews: import('../downloads/PreviewPlayer.js').PreviewPlayer,
     *           resolve: (item: Suggestion) => Promise<import('../downloads/DownloadServer.js').RemoteTrack>,
     *           isOnShelf: (item: Suggestion) => boolean,
     *           cover: (item: Suggestion) => Promise<string | null> }} deps
     */
    constructor({ dialog, lastfm, mix, server, downloads, previews, resolve, isOnShelf, cover }) {
        super();
        this.#dialog = dialog;
        this.lastfm = lastfm;
        this.mix = mix;
        this.server = server;
        this.downloads = downloads;
        this.isOnShelf = isOnShelf;
        this.cover = cover;
        const $ = selector => /** @type {HTMLElement} */ (dialog.querySelector(selector));
        this.tabs = $('.discover__tabs');
        this.noteText = $('[data-bind="note"]');
        this.addAllButton = /** @type {HTMLButtonElement} */ ($('[data-action="add-all"]'));
        this.rebuildButton = /** @type {HTMLButtonElement} */ ($('[data-action="rebuild"]'));
        this.list = new RemoteTrackList({ list: $('[data-bind="list"]'), downloads, previews, resolve });
        this.previews = previews;
    }

    get isOpen() { return this.#dialog.open; }

    attach() {
        this.list.attach();
        this.list.on('download', event => this.emit('download', event));
        this.list.on('reveal', event => {
            this.#dialog.close();
            this.emit('reveal', event);
        });
        this.list.on('error', ({ message }) => this.#setNote(message));
        this.previews.on('state', ({ state, message }) => {
            if (state === 'error' && this.isOpen) this.#setNote(message);
        });

        this.#dialog.addEventListener('click', event => {
            if (event.target === this.#dialog) { this.#dialog.close(); return; }
            const action = /** @type {HTMLElement} */ (event.target).closest('[data-action]')?.getAttribute('data-action');
            if (action === 'close') this.#dialog.close();
            if (action === 'add-all') this.#addAll();
            if (action === 'rebuild') this.#load({ fresh: true });
        });
        this.tabs.addEventListener('change', event => {
            this.#tab = /** @type {'track' | 'mix'} */ (/** @type {HTMLInputElement} */ (event.target).value);
            this.#load();
        });
        // закрыли лист — и прослушивание вместе с ним
        this.#dialog.addEventListener('close', () => this.previews.stop());

        this.mix.on('progress', ({ done, total }) => {
            if (this.#tab === 'mix' && this.isOpen) this.#setNote(`Собираю микс дня… ${done + 1} из ${total}`);
        });
        this.mix.on('cover', ({ key, cover }) => this.list.setCover(key, cover));
    }

    /**
     * Открыть: играет трек — сразу похожие на него, иначе микс дня.
     * @param {{ track: Seed | null }} options
     */
    open({ track }) {
        this.#seed = track;
        this.#tab = track ? 'track' : 'mix';
        const radio = /** @type {HTMLInputElement | null} */ (this.tabs.querySelector(`input[value="${this.#tab}"]`));
        if (radio) radio.checked = true;
        if (!this.isOpen) this.#dialog.showModal();
        this.#load();
    }

    close() { this.#dialog.close(); }

    /** @param {{ fresh?: boolean }} [options] */
    async #load({ fresh = false } = {}) {
        const request = ++this.#request;
        this.rebuildButton.hidden = this.#tab !== 'mix';
        this.#render([]);
        try {
            const items = this.#tab === 'mix' ? await this.#loadMix(fresh) : await this.#loadSimilar(fresh);
            if (request !== this.#request) return;
            this.#render(items);
        } catch (error) {
            if (request !== this.#request) return;
            this.#setNote(/** @type {Error} */ (error).message);
        }
    }

    /** @param {boolean} fresh @returns {Promise<Suggestion[]>} */
    async #loadSimilar(fresh) {
        const seed = this.#seed;
        if (!seed) {
            this.#setNote('Ничего не играет — включите пластинку или откройте микс дня.');
            return [];
        }
        if (!seed.artist) {
            this.#setNote(`Не с чем сравнить: у «${seed.title}» нет исполнителя.`);
            return [];
        }
        const key = seed.id;
        let items = fresh ? undefined : this.#similar.get(key);
        if (!items) {
            this.#setNote(`Ищу похожее на «${seed.title}»…`);
            items = (await this.lastfm.similar(seed)).filter(item => !this.isOnShelf(item)).slice(0, LIMIT);
            this.#similar.set(key, items);
            this.#fillCovers(items, this.#request);
        }
        this.#setNote(items.length
            ? `Похожее на «${seed.title}» — по данным Last.fm.`
            : `Last.fm не знает ничего похожего на «${seed.title}» — или всё это уже на полке.`);
        return items;
    }

    /** @param {boolean} fresh @returns {Promise<Suggestion[]>} */
    async #loadMix(fresh) {
        const current = fresh ? null : this.mix.current;
        if (!current) this.#setNote('Собираю микс дня…');
        const mix = current ?? await this.mix.rebuild();
        const artists = [...new Set(mix.seeds.map(seed => seed.artist))].join(', ');
        this.#setNote(mix.items.length
            ? `Собран сегодня по трекам: ${artists}.`
            : 'Last.fm не нашёл ничего нового — всё похожее уже на полке.');
        // что успели добавить с утра — уже на полке, не предлагаем
        return mix.items.filter(item => !this.isOnShelf(item) || this.#downloading(item));
    }

    /** @param {ListItem} item */
    #downloading(item) {
        const sound = this.list.soundOf(item);
        return Boolean(sound && this.downloads.stateOf(sound.id));
    }

    /**
     * Обложки «На этот трек» — по одной, пока список тот же (у iTunes лимит).
     * @param {Suggestion[]} items
     * @param {number} request
     */
    async #fillCovers(items, request) {
        for (const item of items) {
            if (item.cover) continue;
            const cover = await this.cover(item).catch(() => null);
            // лист закрыли или перешли к другому треку — дальше не ищем
            if (request !== this.#request || !this.isOpen) return;
            if (!cover) continue;
            item.cover = cover;
            this.list.setCover(item.key, cover);
        }
    }

    /** @param {Suggestion[]} items */
    #render(items) {
        // пока своей обложки нет — запасная, как у конверта без картинки
        const shown = items.map(item => item.cover ? item : {
            ...item, cover: generatedCover({ album: item.title, artist: item.artist }, Track.colors),
        });
        this.list.render(shown);
        this.addAllButton.hidden = !items.length;
    }

    /** @param {string} text */
    #setNote(text) {
        this.noteText.textContent = text;
    }

    /**
     * Всё из списка — на полку: по одному ищем звук и ставим в очередь
     * скачивания (одновременно качается не больше двух). Мак пропал или
     * код не подошёл — останавливаемся, а не перебираем весь список.
     */
    async #addAll() {
        if (this.#adding) return;
        this.#adding = true;
        this.addAllButton.disabled = true;
        const items = [...this.list.items];
        let added = 0;
        try {
            for (const item of items) {
                if (this.#downloading(item)) continue;
                this.addAllButton.textContent = `Добавляю ${added + 1} из ${items.length}…`;
                const known = Boolean(this.list.soundOf(item));
                const result = await this.list.ready(item);
                if (result) {
                    this.emit('download', { result });
                    added++;
                }
                if (this.server.status === 'offline' || this.server.status === 'rejected') break;
                if (!known) await sleep(ADD_ALL_PAUSE);
            }
        } finally {
            this.#adding = false;
            this.addAllButton.disabled = false;
            this.addAllButton.textContent = 'Добавить все';
        }
    }
}
