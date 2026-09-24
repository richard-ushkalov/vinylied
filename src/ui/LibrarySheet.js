import { Emitter } from '../core/Emitter.js';
import { formatBytes, tracksLabel } from '../core/format.js';

/**
 * Лист «Полка»: сколько треков и места, добавить, установить, порядок
 * и повтор, проверка обложек, список треков с удалением, очистка.
 *
 * События: 'add', 'settings', 'install', 'recheck', 'clear', 'remove' {id}.
 */
export class LibrarySheet extends Emitter {
    #dialog;
    #frame = 0;

    /**
     * @param {{ dialog: HTMLDialogElement,
     *           library: import('../library/Library.js').Library,
     *           tracks: Map<string, import('../library/Track.js').Track>,
     *           settings: import('../core/Settings.js').Settings,
     *           lookup: import('../lookup/LookupQueue.js').LookupQueue,
     *           install: import('../pwa/InstallPrompt.js').InstallPrompt,
     *           controller: import('../playback/PlaybackController.js').PlaybackController,
     *           canFingerprint: () => boolean }} deps
     */
    constructor({ dialog, library, tracks, settings, lookup, install, controller, canFingerprint }) {
        super();
        this.#dialog = dialog;
        this.library = library;
        this.tracks = tracks;
        this.settings = settings;
        this.lookup = lookup;
        this.install = install;
        this.controller = controller;
        this.canFingerprint = canFingerprint;
        const $ = selector => /** @type {HTMLElement} */ (dialog.querySelector(selector));
        this.stats = $('[data-bind="stats"]');
        this.lookupText = $('[data-bind="lookup"]');
        this.list = $('[data-bind="tracks"]');
        this.installButton = $('[data-action="install"]');
        this.iosHint = $('[data-bind="ios-install"]');
    }

    get isOpen() { return this.#dialog.open; }

    attach() {
        const dialog = this.#dialog;
        dialog.addEventListener('click', event => {
            // тап по затемнению вокруг листа — закрыть
            if (event.target === dialog) { dialog.close(); return; }
            const target = /** @type {HTMLElement} */ (event.target).closest('[data-action]');
            const action = target?.getAttribute('data-action');
            switch (action) {
                case 'close': dialog.close(); break;
                case 'add': this.emit('add'); break;
                case 'install': this.emit('install'); break;
                case 'recheck': this.emit('recheck'); break;
                case 'settings': dialog.close(); this.emit('settings'); break;
                case 'clear':
                    if (confirm('Убрать с полки все треки? Файлы будут удалены из приложения.')) this.emit('clear');
                    break;
                case 'remove': {
                    const id = target.getAttribute('data-id');
                    const track = id && this.tracks.get(id);
                    if (track && confirm(`Убрать «${track.title}» с полки?`)) this.emit('remove', { id });
                    break;
                }
            }
        });

        dialog.addEventListener('change', event => {
            const input = /** @type {HTMLInputElement} */ (event.target);
            if (input.type === 'radio') this.settings.set(input.name, input.value);
        });
        this.settings.watch(['order', 'repeat'], values => {
            for (const [name, value] of Object.entries(values)) {
                const radio = /** @type {HTMLInputElement | null} */ (dialog.querySelector(`input[name="${name}"][value="${value}"]`));
                if (radio) radio.checked = true;
            }
        });

        const refresh = () => this.#schedule();
        for (const type of ['added', 'updated', 'removed', 'cleared']) this.library.on(type, refresh);
        this.lookup.on('progress', () => this.#renderLookup());
        this.install.on('change', () => this.#renderInstall());
        this.controller.on('change', ({ trackChanged }) => { if (trackChanged) refresh(); });
    }

    open() {
        this.render();
        this.#dialog.showModal();
    }

    close() {
        this.#dialog.close();
    }

    render() {
        this.stats.textContent = `${tracksLabel(this.library.size)} · ${formatBytes(this.library.usage())}`;
        this.#renderInstall();
        this.#renderLookup();
        this.#renderTracks();
    }

    /** Библиотека шлёт событие на каждый трек — перерисовываем раз в кадр. */
    #schedule() {
        if (!this.isOpen || this.#frame) return;
        this.#frame = requestAnimationFrame(() => { this.#frame = 0; this.render(); });
    }

    #renderInstall() {
        this.installButton.hidden = !this.install.canPrompt;
        this.iosHint.hidden = !this.install.iosHint;
    }

    #renderLookup() {
        if (!this.settings.get('onlineLookup')) {
            this.lookupText.textContent = 'Поиск в интернете выключен в настройках.';
            return;
        }
        const { checked, total, running } = this.lookup.progress();
        const parts = [`Проверено ${checked} из ${total}${running ? ' — идёт проверка…' : '.'}`];
        if (!this.canFingerprint()) parts.push('Распознавание по звуку выключено: не задан ключ AcoustID.');
        this.lookupText.textContent = parts.join(' ');
    }

    #renderTracks() {
        const items = [...this.tracks.values()].map(track => {
            const li = document.createElement('li');
            if (track.id === this.controller.current) li.className = 'track-list__playing';

            const img = document.createElement('img');
            img.alt = '';
            img.loading = 'lazy';
            img.decoding = 'async';
            img.src = track.cover;

            const text = document.createElement('div');
            text.className = 'track-list__text';
            const title = document.createElement('span');
            title.className = 'track-list__title';
            title.textContent = track.title;
            const meta = document.createElement('span');
            meta.className = 'track-list__meta';
            meta.textContent = [track.artist, track.album].filter(Boolean).join(' · ');
            text.append(title, meta);

            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'icon-button icon-button--small icon-button--ghost';
            remove.dataset.action = 'remove';
            remove.dataset.id = track.id;
            remove.setAttribute('aria-label', `Убрать «${track.title}» с полки`);
            remove.innerHTML = '<svg aria-hidden="true"><use href="#i-close"/></svg>';

            li.append(img, text, remove);
            return li;
        });

        if (!items.length) {
            const empty = document.createElement('li');
            empty.className = 'track-list__empty';
            empty.textContent = 'Пока ни одного трека.';
            items.push(empty);
        }
        this.list.replaceChildren(...items);
    }
}
