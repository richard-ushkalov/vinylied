import { LocalStore } from '../core/LocalStore.js';

const SAVE_EVERY = 5_000;

/**
 * «Продолжить с места»: какой трек стоял и где. Пишем раз в несколько
 * секунд во время игры и в моменты, после которых страницу могут
 * выгрузить без предупреждения: пауза, уход в фон, закрытие.
 */
export class ResumeStore {
    #timer = 0;

    /** @param {LocalStore} [store] */
    constructor(store = new LocalStore('vinilyed:resume')) {
        this.store = store;
    }

    /** @returns {{ id: string, position: number } | null} */
    read() {
        const saved = this.store.read(null);
        return saved && typeof saved.id === 'string' && Number.isFinite(saved.position) ? saved : null;
    }

    /** @param {import('./PlaybackController.js').PlaybackController} controller */
    attach(controller) {
        const save = () => {
            if (controller.current) this.store.write({ id: controller.current, position: controller.position() });
            else this.store.clear();
        };
        controller.on('change', ({ intent }) => {
            save();
            clearInterval(this.#timer);
            if (intent === 'playing') this.#timer = window.setInterval(save, SAVE_EVERY);
        });
        controller.on('seek', save);
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') save();
        });
        addEventListener('pagehide', save);
    }
}
