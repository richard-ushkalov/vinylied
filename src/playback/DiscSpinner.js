const DEGREES_PER_SECOND = 200;   // 33⅓ оборота в минуту, как у настоящей пластинки
const MAX_STEP = 0.05;            // потолок шага: вкладка могла провисеть в фоне

/**
 * Вращение пластинки.
 *
 * Угол КОПИМ по фактической скорости звука, а не считаем из позиции.
 * Позиция идёт по часам и про разгон с торможением не знает — из-за этого
 * диск крутился ровно, пока звук ещё раскручивался. Накопление заодно
 * убирает рывок при перемотке: на вертушке игла переезжает, а пластинка
 * просто крутится дальше.
 *
 * Крутим ту пластинку, на которой РЕАЛЬНО пошёл звук, а не current:
 * при смене трека current переключается сразу, а старый диск ещё
 * полсекунды тормозит — и весь его выбег уезжал в новую пластинку.
 */
export class DiscSpinner {
    #angle = 0;
    #last = 0;
    /** @type {HTMLElement | null} */
    #disc = null;

    /**
     * @param {{ speed: () => number, disc: () => HTMLElement | null, still: () => boolean }} deps
     *   speed — мгновенная скорость звука 0..1; disc — диск текущего трека;
     *   still — «меньше движения»: диск не вращается вовсе
     */
    constructor({ speed, disc, still }) {
        this.speed = speed;
        this.disc = disc;
        this.still = still;
    }

    /** Звук реально пошёл — вот теперь эта пластинка наша. */
    grab() {
        this.#disc = this.disc();
    }

    /**
     * Новая пластинка начинается с нуля. Прежнюю отпускаем по 'emptied':
     * он приходит уже ПОСЛЕ того, как старая остановилась, так что её
     * выбег успевает дорисоваться на своём же диске.
     */
    release() {
        this.#disc?.style.removeProperty('--disc-spin');
        this.#angle = 0;
        this.#last = 0;
        this.#disc = null;
    }

    /** @param {number} now */
    tick = now => {
        const rate = this.speed();
        const dt = rate && this.#last ? Math.min((now - this.#last) / 1000, MAX_STEP) : 0;
        this.#last = rate ? now : 0;
        if (this.still()) return;

        // % 360 безопасен ТОЛЬКО пока у .disc нет перехода по transform:
        // иначе скачок 359° → 0° проигрался бы как оборот назад.
        this.#angle = (this.#angle + rate * DEGREES_PER_SECOND * dt) % 360;
        this.#disc?.style.setProperty('--disc-spin', `${this.#angle}deg`);
    };
}
