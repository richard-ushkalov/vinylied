import { Emitter } from '../../core/Emitter.js';

/**
 * Медиаэлемент, за который система держит сессию: уведомление Android,
 * Now Playing на Маке, аудиофокус. Играет, пока играет трек, и стоит,
 * пока трек на паузе, — иначе система видит «играет» там, где тишина,
 * и кнопка в трее переставала что-либо значить.
 *
 * Если элемент остановил не наш код (звонок, другой плеер забрал фокус),
 * это 'interrupted'. Если система сама его вернула — 'resumed'.
 * Свои изменения отличаем по #wanted: его ставим ДО вызова play/pause,
 * поэтому событие от собственного вызова всегда совпадает с желаемым.
 */
export class Anchor extends Emitter {
    #element;
    #wanted = false;

    /** @param {HTMLMediaElement} element */
    constructor(element) {
        super();
        this.#element = element;
        // В документе, а не просто в памяти: системная панель привязывается
        // к элементу страницы, оторванный от дерева её может не получить.
        element.hidden = true;
        document.body.append(element);

        element.addEventListener('pause', () => {
            if (!this.#wanted) return;
            this.#wanted = false;
            this.emit('interrupted');
        });
        element.addEventListener('play', () => {
            if (this.#wanted) return;
            this.#wanted = true;
            this.emit('resumed');
        });
    }

    async play() {
        this.#wanted = true;
        if (this.#element.paused) await this.#element.play().catch(() => {});
    }

    pause() {
        this.#wanted = false;
        if (!this.#element.paused) this.#element.pause();
    }

    dispose() {
        this.pause();
        this.#element.remove();
    }
}
