import { Emitter } from '../core/Emitter.js';

/** Экран пустой полки. Событие 'add'. */
export class EmptyState extends Emitter {
    #root;

    /** @param {HTMLElement} root */
    constructor(root) {
        super();
        this.#root = root;
        this.install = /** @type {HTMLElement} */ (root.querySelector('.empty__install'));
        root.querySelector('[data-action="add"]')?.addEventListener('click', () => this.emit('add'));
    }

    /** @param {boolean} shown */
    toggle(shown) {
        this.#root.hidden = !shown;
    }

    /** На iOS вне установленного приложения — подсказка про «На экран Домой». @param {boolean} shown */
    setInstallHint(shown) {
        this.install.hidden = !shown;
    }
}
