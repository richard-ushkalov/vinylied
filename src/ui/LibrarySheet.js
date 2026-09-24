import { Emitter } from '../core/Emitter.js';
import { formatBytes, tracksLabel } from '../core/format.js';
import { findDuplicates } from '../library/duplicates.js';
import { describeAcoustIdStatus } from './acoustidStatus.js';

const LISTED = 6;   // столько повторов называем в подтверждении, дальше — «и ещё N»

/**
 * Лист «Полка»: сколько треков и места, добавить, установить, порядок
 * и повтор, проверка обложек, список треков с удалением, дубликаты, очистка.
 *
 * События: 'add', 'settings', 'install', 'recheck', 'clear', 'remove' {ids}.
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
     *           acoustId: import('../lookup/AcoustIdClient.js').AcoustIdClient }} deps
     */
    constructor({ dialog, library, tracks, settings, lookup, install, controller, acoustId }) {
        super();
        this.#dialog = dialog;
        this.library = library;
        this.tracks = tracks;
        this.settings = settings;
        this.lookup = lookup;
        this.install = install;
        this.controller = controller;
        this.acoustId = acoustId;
        const $ = selector => /** @type {HTMLElement} */ (dialog.querySelector(selector));
        this.stats = $('[data-bind="stats"]');
        this.lookupText = $('[data-bind="lookup"]');
        this.list = $('[data-bind="tracks"]');
        this.dedupeButton = /** @type {HTMLButtonElement} */ ($('[data-action="dedupe"]'));
        this.dedupeText = $('[data-bind="dedupe"]');
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
                    if (track && confirm(`Убрать «${track.title}» с полки?`)) this.emit('remove', { ids: [id] });
                    break;
                }
                case 'dedupe': this.#dedupe(); break;
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
        this.acoustId.on('status', () => this.#renderLookup());
        this.install.on('change', () => this.#renderInstall());
        this.controller.on('change', ({ trackChanged }) => { if (trackChanged) refresh(); });
    }

    open() {
        this.dedupeText.textContent = '';
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
        this.lookupText.textContent = [
            `Проверено ${checked} из ${total}${running ? ' — идёт проверка…' : '.'}`,
            describeAcoustIdStatus(this.acoustId.status),
        ].join(' ');
    }

    /**
     * Ищем повторы, показываем, что уйдёт, и только после согласия убираем.
     * Остаётся лучший из группы: играющий, опознанный, качественнее, старше.
     */
    async #dedupe() {
        const button = this.dedupeButton;
        button.disabled = true;
        this.dedupeText.textContent = 'Ищу дубликаты…';
        try {
            const groups = await findDuplicates(this.tracks.values(), { current: this.controller.current });
            const extra = groups.flatMap(group => group.remove);
            if (!extra.length) {
                this.dedupeText.textContent = 'Дубликатов нет.';
                return;
            }
            const names = extra.slice(0, LISTED).map(track => `• ${[track.title, track.artist].filter(Boolean).join(' — ')}`);
            if (extra.length > LISTED) names.push(`…и ещё ${extra.length - LISTED}`);
            const question = [
                `Найдено дубликатов: ${extra.length}. Убрать их с полки?`,
                '', ...names, '',
                'От каждой песни останется один трек — играющий, опознанный или лучшего качества.',
            ].join('\n');
            if (!confirm(question)) {
                this.dedupeText.textContent = '';
                return;
            }
            const freed = extra.reduce((sum, track) => sum + track.record.size, 0);
            this.emit('remove', { ids: extra.map(track => track.id) });
            this.dedupeText.textContent = `Убрано: ${tracksLabel(extra.length)}, освободилось ${formatBytes(freed)}.`;
        } catch (error) {
            console.error(error);
            this.dedupeText.textContent = 'Не удалось проверить полку.';
        } finally {
            button.disabled = false;
        }
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
