import { formatTime } from '../core/format.js';

const KEY_STEP = 5;
const PAGE_STEP = 30;
const ESCAPE = 16;       // px за край: палочке шириной 3px хватает с запасом
const WRAP_MS = 320;

/**
 * Полоса прогресса внизу экрана.
 *
 * 1. У плеера на буфере нет события timeupdate — позицию опрашиваем
 *    сами, в общем FrameLoop и только пока крутится диск.
 * 2. Перемотка на буфере — это пересоздание источника. Во время протяжки
 *    двигаем только картинку, а seek зовём один раз, когда отпустили.
 * 3. На телефоне: зона захвата 40px, при касании линия толще, видно
 *    время — прошло, всего и пузырь над пальцем.
 */
export class ProgressBar {
    #root;
    #fill;
    #handle;
    #elapsed;
    #total;
    #bubble;
    #controller;
    #dragging = false;
    #moved = false;
    #wrapping = false;
    /** @type {number | null} */ #pointerId = null;
    #lastSecond = -1;
    #lastDuration = -1;

    /**
     * @param {{ root: HTMLElement,
     *           controller: import('../playback/PlaybackController.js').PlaybackController }} deps
     */
    constructor({ root, controller }) {
        this.#root = root;
        this.#controller = controller;
        this.#fill = /** @type {HTMLElement} */ (root.querySelector('.progress__fill'));
        this.#handle = /** @type {HTMLElement} */ (root.querySelector('.progress__handle'));
        this.#elapsed = /** @type {HTMLElement} */ (root.querySelector('.progress__time--elapsed'));
        this.#total = /** @type {HTMLElement} */ (root.querySelector('.progress__time--total'));
        this.#bubble = /** @type {HTMLElement} */ (root.querySelector('.progress__bubble'));
    }

    attach() {
        const root = this.#root;
        root.addEventListener('pointerdown', this.#onDown);
        root.addEventListener('pointermove', this.#onMove);
        root.addEventListener('pointerup', this.#onUp);
        root.addEventListener('pointercancel', this.#onUp);
        root.addEventListener('keydown', this.#onKey);
        this.#show(0);
    }

    /** Кадр FrameLoop: полоса идёт за звуком. */
    tick = () => {
        const duration = this.#controller.duration();
        const position = this.#controller.position();
        if (!this.#dragging) this.#show(duration ? position / duration : 0);
        this.#label(position, duration);
    };

    /**
     * Трек кончился сам: палочка не отматывается назад, а уходит за правый
     * край, телепортируется за левый и выезжает оттуда.
     */
    wrap() {
        this.#wrapping = true;
        const root = this.#root;
        root.classList.add('progress--wrap');
        // полосу добиваем до конца: она уезжает вместе с палочкой
        this.#handle.style.left = `calc(100% + ${ESCAPE}px)`;
        this.#fill.style.transform = 'scaleX(1)';

        setTimeout(() => {
            // Телепорт — БЕЗ перехода, иначе палочка проедет обратно по полосе
            root.classList.remove('progress--wrap');
            this.#handle.style.left = `${-ESCAPE}px`;
            this.#fill.style.transform = 'scaleX(0)';
            // Принудительный пересчёт: без него браузер схлопнет оба
            // присваивания в одно, и перехода не случится
            void root.offsetWidth;
            root.classList.add('progress--wrap');
            this.#handle.style.left = '0%';
            setTimeout(() => {
                root.classList.remove('progress--wrap');
                this.#wrapping = false;
            }, WRAP_MS);
        }, WRAP_MS);
    }

    /** Ручное переключение: полоса плавно отматывается к началу. */
    rewind() {
        if (this.#wrapping) return;
        this.#root.classList.add('progress--rewind');
        this.#show(0);
        setTimeout(() => this.#root.classList.remove('progress--rewind'), 580);
    }

    /** @param {number} fraction */
    #show(fraction) {
        const value = Math.max(0, Math.min(1, fraction || 0));
        this.#fill.style.transform = `scaleX(${value})`;
        // Во время перелёта палочку не трогаем: следующий трек может быть
        // уже предзагружен, и покадровый show() затёр бы анимацию.
        if (!this.#wrapping) this.#handle.style.left = `${value * 100}%`;
    }

    /** Подписи и ARIA — раз в секунду, а не каждый кадр. */
    #label(position, duration) {
        const second = Math.floor(position);
        const whole = Math.round(duration);
        if (second === this.#lastSecond && whole === this.#lastDuration) return;
        this.#lastSecond = second;
        this.#lastDuration = whole;
        this.#elapsed.textContent = formatTime(position);
        this.#total.textContent = duration ? formatTime(duration) : '';
        this.#root.setAttribute('aria-valuemax', String(whole));
        this.#root.setAttribute('aria-valuenow', String(Math.min(second, whole)));
        this.#root.setAttribute('aria-valuetext', `${formatTime(position)} из ${formatTime(duration)}`);
    }

    /** @param {PointerEvent} event */
    #fraction(event) {
        const rect = this.#root.getBoundingClientRect();
        return Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    }

    /** Пузырь со временем — над пальцем или курсором. @param {number} fraction */
    #preview(fraction) {
        this.#root.style.setProperty('--x', `${(fraction * 100).toFixed(2)}%`);
        this.#bubble.textContent = formatTime(fraction * this.#controller.duration());
    }

    /** @param {PointerEvent} event */
    #onDown = event => {
        if (!this.#controller.duration()) return;
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        this.#dragging = true;
        this.#moved = false;
        this.#pointerId = event.pointerId;
        this.#root.setPointerCapture(event.pointerId);
        this.#root.classList.add('progress--active', 'progress--rewind');
        this.#controller.scrub(0.8);     // фильтр прикрывается — мы «в перемотке»
        if (event.pointerType !== 'mouse') navigator.vibrate?.(5);

        const fraction = this.#fraction(event);
        this.#show(fraction);
        this.#preview(fraction);
    };

    /** @param {PointerEvent} event */
    #onMove = event => {
        const fraction = this.#fraction(event);
        if (!this.#dragging) {
            if (event.pointerType === 'mouse' && this.#controller.duration()) this.#preview(fraction);
            return;
        }
        // поехали пальцем — переход мешает: картинка должна идти за ним один в один
        if (!this.#moved) { this.#moved = true; this.#root.classList.remove('progress--rewind'); }
        this.#show(fraction);
        this.#preview(fraction);
    };

    /** @param {PointerEvent} event */
    #onUp = event => {
        if (!this.#dragging || event.pointerId !== this.#pointerId) return;
        this.#dragging = false;
        try { this.#root.releasePointerCapture(event.pointerId); } catch {}
        this.#root.classList.remove('progress--active');

        if (this.#moved) this.#root.classList.add('progress--rewind');   // после протяжки — доводка
        this.#controller.seek(this.#fraction(event) * this.#controller.duration());
        this.#controller.scrub(0);       // фильтр плавно открывается на новом месте
        setTimeout(() => this.#root.classList.remove('progress--rewind'), 580);
    };

    /** @param {KeyboardEvent} event */
    #onKey = event => {
        const c = this.#controller;
        const steps = {
            ArrowRight: event.shiftKey ? PAGE_STEP : KEY_STEP,
            ArrowUp: KEY_STEP,
            ArrowLeft: -(event.shiftKey ? PAGE_STEP : KEY_STEP),
            ArrowDown: -KEY_STEP,
            PageUp: PAGE_STEP,
            PageDown: -PAGE_STEP,
        };
        if (event.key in steps) c.seekBy(steps[event.key]);
        else if (event.key === 'Home') c.seek(0);
        else if (event.key === 'End') c.seek(Math.max(0, c.duration() - 1));
        else return;
        // своя обработка — глобальные горячие клавиши не должны сработать второй раз
        event.preventDefault();
    };
}
