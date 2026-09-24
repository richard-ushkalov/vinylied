const HOLD = 4000;

/**
 * Строка статуса над панелью (aria-live): «Добавляю 3 из 12…»,
 * «Нашёл обложку: …». Короткие сообщения гаснут сами.
 */
export class StatusLine {
    #element;
    #timer = 0;

    /** @param {HTMLElement} element */
    constructor(element) {
        this.#element = element;
    }

    /**
     * @param {string} text
     * @param {{ sticky?: boolean }} [options] sticky — висит, пока не сменят
     */
    show(text, { sticky = false } = {}) {
        clearTimeout(this.#timer);
        this.#element.textContent = text;
        if (!sticky) this.#timer = window.setTimeout(() => this.clear(), HOLD);
    }

    clear() {
        clearTimeout(this.#timer);
        this.#element.textContent = '';
    }
}
