/**
 * Минимальная шина событий поверх EventTarget.
 *
 * on() возвращает функцию отписки — так подписчику не нужно хранить
 * ссылку на обёртку, которую мы создали вокруг его обработчика.
 */
export class Emitter extends EventTarget {
    /**
     * @param {string} type
     * @param {(detail: any) => void} handler
     * @returns {() => void} отписка
     */
    on(type, handler) {
        const listener = event => handler(/** @type {CustomEvent} */ (event).detail);
        this.addEventListener(type, listener);
        return () => this.removeEventListener(type, listener);
    }

    /**
     * @param {string} type
     * @param {any} [detail]
     */
    emit(type, detail) {
        this.dispatchEvent(new CustomEvent(type, { detail }));
    }
}
