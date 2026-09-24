/**
 * Один requestAnimationFrame на всех, кто рисует «по ходу звука»:
 * полоса прогресса, вращение диска.
 *
 * Крутится только пока active() говорит «да» — встал диск, цикл гаснет
 * сам и не жжёт батарею. requestAnimationFrame замирает в скрытой
 * вкладке, поэтому при возвращении цикл перезапускается принудительно:
 * иначе занятый frame навсегда отказал бы start().
 */
export class FrameLoop {
    /** @type {Set<(now: number) => void>} */
    #subscribers = new Set();
    #frame = 0;
    #active;

    /** @param {() => boolean} active */
    constructor(active) {
        this.#active = active;
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState !== 'visible') return;
            this.#frame = 0;
            this.start();
        });
    }

    /**
     * @param {(now: number) => void} fn
     * @returns {() => void} отписка
     */
    add(fn) {
        this.#subscribers.add(fn);
        return () => this.#subscribers.delete(fn);
    }

    start() {
        if (!this.#frame) this.#frame = requestAnimationFrame(this.#tick);
    }

    /** Один кадр вне цикла: показать состояние, когда звук стоит. */
    once() {
        const now = performance.now();
        for (const fn of this.#subscribers) fn(now);
    }

    #tick = (/** @type {number} */ now) => {
        for (const fn of this.#subscribers) fn(now);
        this.#frame = this.#active() ? requestAnimationFrame(this.#tick) : 0;
    };
}
