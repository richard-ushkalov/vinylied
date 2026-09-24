import { Emitter } from '../core/Emitter.js';

/**
 * «Установить на телефон».
 *
 * Android и десктопный Chrome присылают beforeinstallprompt — его
 * придерживаем и показываем по кнопке. На iOS такого события нет
 * вовсе: там только инструкция «Поделиться → На экран Домой».
 *
 * Событие 'change' — поменялось, что можно показать.
 */
export class InstallPrompt extends Emitter {
    /** @type {any} */
    #deferred = null;
    #platform;

    /** @param {{ platform: import('../core/platform.js').Platform }} deps */
    constructor({ platform }) {
        super();
        this.#platform = platform;
    }

    attach() {
        addEventListener('beforeinstallprompt', event => {
            event.preventDefault();
            this.#deferred = event;
            this.emit('change');
        });
        addEventListener('appinstalled', () => {
            this.#deferred = null;
            this.emit('change');
        });
    }

    get canPrompt() { return Boolean(this.#deferred); }

    /** iPhone в обычном Safari — показать инструкцию. */
    get iosHint() { return this.#platform.ios && !this.#platform.standalone; }

    async prompt() {
        const event = this.#deferred;
        if (!event) return false;
        this.#deferred = null;
        event.prompt();
        const { outcome } = await event.userChoice;
        this.emit('change');
        return outcome === 'accepted';
    }
}
