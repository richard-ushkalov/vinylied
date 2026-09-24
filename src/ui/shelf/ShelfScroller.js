import { Emitter } from '../../core/Emitter.js';

const FISH_ANGLE = 20;          // градусов наклона у краёв при силе 1
const FISH_DEPTH = 140;         // насколько края утопают вглубь
const FISH_SPREAD = 320;        // на какой дистанции эффект набирает силу
const MAX_BLUR = 4;             // px размытия у самых дальних
const VISIBLE = FISH_SPREAD * 1.8;   // дальше слот не рисуем вообще
const RUSH_SPEED = 1560;        // px/с, при которых размытие в движении максимальное
const EASE = 0.16;              // секунд: постоянная времени доводки
const THRESHOLD = 6;            // px, после которых это уже прокрутка, а не тап
const PROJECT_MS = 220;         // на сколько вперёд «долетает» бросок
const WHEEL_SNAP_MS = 140;      // пауза колеса, после которой полка доводится

/**
 * Первый индекс, где sorted[i] >= value.
 * @param {number[]} sorted
 * @param {number} value
 */
const lowerBound = (sorted, value) => {
    let lo = 0, hi = sorted.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sorted[mid] < value) lo = mid + 1; else hi = mid;
    }
    return lo;
};

/**
 * @typedef {{ edgeBlur: number, motionBlur: number, fisheye: number,
 *             haptics: boolean, reduced: boolean }} ScrollerOptions
 */

/**
 * Прокрутка полки: колесо, палец, клавиши, доводка к ближайшему конверту,
 * «рыбий глаз» и размытие.
 *
 * Производительность — главное здесь, это покадровый код:
 *  - геометрия слотов берётся из offsetTop/offsetHeight и КЕШИРУЕТСЯ;
 *    пересчёт — только когда ResizeObserver сообщил, что раскладка
 *    изменилась. Раньше каждый кадр звал getBoundingClientRect у ВСЕХ
 *    слотов;
 *  - обновляется только видимое окно (двоичный поиск по кешу), остальные
 *    отсечены классом и не трогаются;
 *  - в стиль пишем только изменившееся: запись невалидирует стиль,
 *    даже если строка та же самая;
 *  - доводка идёт по времени, а не по кадрам: на 120 Гц полка больше
 *    не едет вдвое быстрее, чем на 60.
 *
 * События: 'focus' {index} — сменился ближайший к центру; 'move' — кадр.
 */
export class ShelfScroller extends Emitter {
    #viewport;
    #list;
    #onScrub;

    /** @type {HTMLElement[]} */ #slots = [];
    /** @type {number[]} */ #centers = [];
    #listTop = 0;             // верх списка без сдвига, в координатах окна
    #viewCenter = 0;          // середина сцены, в координатах окна
    #dirty = true;

    #pos = 0;
    #target = 0;
    #lastPos = 0;
    #speed = 0;               // px/с, сглаженно — им правим размытие
    #frame = 0;
    #lastTime = 0;
    #focused = -1;
    #anchor = 0;              // кого держать по центру при изменении раскладки
    /** @type {Set<number> | null} */ #drawn = null;   // null — отсечь заново всех

    /** @type {WeakMap<HTMLElement, string>} */ #transforms = new WeakMap();
    /** @type {WeakMap<HTMLElement, string>} */ #blurs = new WeakMap();
    /** @type {WeakMap<HTMLElement, NodeListOf<HTMLElement>>} */ #faces = new WeakMap();

    /** @type {ScrollerOptions} */
    #options = { edgeBlur: 1, motionBlur: 1, fisheye: 1, haptics: true, reduced: false };

    // палец
    /** @type {number | null} */ #dragId = null;
    #dragFrom = 0;
    #dragBase = 0;
    #dragging = false;
    #lastY = 0;
    #lastMoveTime = 0;
    #velocity = 0;            // px/мс
    #swallowClick = false;
    #snapTimer = 0;
    #layoutTimer = 0;

    /**
     * @param {{ viewport: HTMLElement, list: HTMLElement, onScrub?: (amount: number) => void }} deps
     */
    constructor({ viewport, list, onScrub }) {
        super();
        this.#viewport = viewport;
        this.#list = list;
        this.#onScrub = onScrub ?? (() => {});
    }

    get focusedIndex() { return this.#focused; }

    /** @param {Partial<ScrollerOptions>} options */
    configure(options) {
        Object.assign(this.#options, options);
        this.#drawn = null;
        this.#draw();
    }

    attach() {
        const viewport = this.#viewport;
        viewport.addEventListener('wheel', this.#onWheel, { passive: true });
        viewport.addEventListener('pointerdown', this.#onPointerDown);
        viewport.addEventListener('pointermove', this.#onPointerMove);
        viewport.addEventListener('pointerup', this.#onPointerUp);
        viewport.addEventListener('pointercancel', this.#onPointerUp);

        // После протяжки браузер всё равно шлёт click — и полка запускала бы
        // трек, на котором палец случайно остановился. Гасим ровно один.
        // stopImmediatePropagation: слушатель клика висит на этом же элементе.
        viewport.addEventListener('click', event => {
            if (!this.#swallowClick) return;
            this.#swallowClick = false;
            event.stopImmediatePropagation();
        }, true);

        // requestAnimationFrame замирает в скрытой вкладке. Если её свернули
        // посреди доводки, кадр не придёт, а frame останется занятым —
        // и start() откажется перезапускать цикл.
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState !== 'visible') return;
            this.#frame = 0;
            this.#dirty = true;
            this.#start();
        });

        // Клик центрирует ДО того, как слот раскрылся: centerOn меряет
        // положение, которое через миг изменится. Поэтому доводим ещё раз,
        // когда переход отступов реально закончился.
        this.#list.addEventListener('transitionend', event => {
            if (event.propertyName === 'padding-top') this.centerOn(this.#anchor);
        });

        this.#observer.observe(viewport);
    }

    /** Состав полки сменился: перемерить, снять отсечение, отметить ближайшего. */
    refresh() {
        this.#observer.disconnect();
        this.#observer.observe(this.#viewport);
        this.#observer.observe(this.#list);
        for (const slot of this.#list.children) this.#observer.observe(slot);
        this.#dirty = true;
        this.#drawn = null;
        this.#focused = -1;
        this.#draw();
    }

    /**
     * @param {number} index
     * @param {{ instant?: boolean }} [options]
     */
    centerOn(index, { instant = false } = {}) {
        if (this.#dirty) this.#measure();
        const center = this.#centers[index];
        if (center === undefined) return;
        this.#anchor = index;
        this.#target = this.#viewCenter - this.#listTop - center;
        if (instant || this.#options.reduced) {
            this.#pos = this.#target;
            this.#draw();
        } else {
            this.#start();
        }
    }

    /**
     * Соседний видимый конверт — для стрелок.
     * @param {number} delta +1 вниз, −1 вверх
     */
    step(delta) {
        const from = this.#focused >= 0 ? this.#focused : this.#anchor;
        for (let i = from + delta; i >= 0 && i < this.#slots.length; i += delta) {
            if (this.#usable(i)) { this.centerOn(i); return; }
        }
    }

    /** @param {'first' | 'last'} edge */
    jump(edge) {
        const order = [...this.#slots.keys()];
        if (edge === 'last') order.reverse();
        const index = order.find(i => this.#usable(i));
        if (index !== undefined) this.centerOn(index);
    }

    /**
     * Виден ли конверт в кадре — для мини-обложки в панели.
     * @param {number} index
     */
    isOnScreen(index) {
        if (this.#dirty) this.#measure();
        const center = this.#centers[index];
        if (center === undefined || !this.#usable(index)) return false;
        const offset = this.#listTop + this.#pos + center - this.#viewCenter;
        return Math.abs(offset) < this.#viewport.clientHeight * 0.42;
    }

    #observer = new ResizeObserver(() => {
        // Пересчитать СРАЗУ, а не только через паузу: иначе конверт,
        // съехавший в кадр после поиска, так и оставался отсечённым.
        this.#dirty = true;
        this.#drawn = null;
        this.#draw();
        clearTimeout(this.#layoutTimer);
        this.#layoutTimer = window.setTimeout(() => this.centerOn(this.#anchor), 400);
    });

    /** @param {number} index */
    #usable(index) {
        const slot = this.#slots[index];
        return Boolean(slot) && !slot.classList.contains('slot--gone');
    }

    #measure() {
        this.#slots = /** @type {HTMLElement[]} */ ([...this.#list.children]);
        const view = this.#viewport.getBoundingClientRect();
        this.#viewCenter = view.top + this.#viewport.clientHeight / 2;
        // у списка только translateY, а он в плоскости z=0 перспективой
        // не искажается — значит, верх без сдвига = верх минус сдвиг
        this.#listTop = this.#list.getBoundingClientRect().top - this.#pos;
        this.#centers = this.#slots.map(slot => slot.offsetTop + slot.offsetHeight / 2);
        this.#dirty = false;
    }

    #start() {
        if (!this.#frame) this.#frame = requestAnimationFrame(this.#loop);
    }

    #loop = (/** @type {number} */ now) => {
        const dt = this.#lastTime ? Math.min(0.05, (now - this.#lastTime) / 1000) : 1 / 60;
        this.#lastTime = now;

        if (!this.#dragging) {
            const k = this.#options.reduced ? 1 : 1 - Math.exp(-dt / EASE);
            this.#pos += (this.#target - this.#pos) * k;
            if (Math.abs(this.#target - this.#pos) < 0.5) this.#pos = this.#target;
        }
        this.#draw(dt);

        // Держим кадры, пока не доехали ИЛИ пока не осела скорость: иначе
        // размытие замирало бы на значении момента отпускания.
        const busy = this.#pos !== this.#target || this.#speed > 12;
        this.#frame = busy ? requestAnimationFrame(this.#loop) : 0;
        if (!busy) this.#lastTime = 0;
    };

    /** @param {number} [dt] секунд с прошлого кадра */
    #draw(dt = 1 / 60) {
        if (this.#dirty) this.#measure();
        this.#list.style.transform = `translateY(${this.#pos}px)`;

        const moved = Math.abs(this.#pos - this.#lastPos);
        this.#lastPos = this.#pos;
        const k = 1 - Math.exp(-dt / 0.07);
        this.#speed += (moved / dt - this.#speed) * k;

        const slots = this.#slots;
        if (!slots.length) return;

        const { edgeBlur, motionBlur, fisheye, reduced } = this.#options;
        const rush = reduced ? 0 : Math.min(1, this.#speed / RUSH_SPEED) * motionBlur;
        const angle = FISH_ANGLE * fisheye;
        const depth = FISH_DEPTH * fisheye;

        // offset_i = base + centers[i]: смещение центра слота от середины сцены
        const base = this.#listTop + this.#pos - this.#viewCenter;
        const first = lowerBound(this.#centers, -VISIBLE - base);
        const last = lowerBound(this.#centers, VISIBLE - base) - 1;

        // Отсекаем ушедших из окна (или всех, если окно неизвестно) и
        // возвращаем пришедших. Классы трогаем только у тех, чьё состояние
        // сменилось: даже «пустой» remove переписывает атрибут.
        const previous = this.#drawn;
        const drawn = new Set();
        for (let i = first; i <= last; i++) drawn.add(i);
        for (const i of previous ?? slots.keys()) {
            if (!drawn.has(i)) slots[i]?.classList.add('slot--culled');
        }
        this.#drawn = drawn;

        let nearest = -1, best = Infinity;
        for (let i = first; i <= last; i++) {
            const slot = slots[i];
            if (!previous?.has(i)) slot.classList.remove('slot--culled');
            const offset = base + this.#centers[i];
            const distance = Math.abs(offset);
            if (distance < best && this.#usable(i)) { best = distance; nearest = i; }

            // рыбий глаз: чем дальше от центра, тем сильнее наклон и утопание
            const t = Math.max(-1, Math.min(1, offset / FISH_SPREAD));
            const transform = `translateZ(${(-Math.abs(t) * depth).toFixed(1)}px) rotateX(${(-t * angle).toFixed(2)}deg)`;
            if (this.#transforms.get(slot) !== transform) {
                this.#transforms.set(slot, transform);
                slot.style.transform = transform;
            }

            // У краёв размывает всегда, в движении — ещё и по центру.
            // Фильтр — на КОНЕЧНЫЕ грани: любой filter делает элементу
            // transform-style: flat, и на слоте пропадала бы перспектива,
            // на коробке — сами обложки. И только на лицевую грань и корешок:
            // четыре задние грани почти не видны, а размытие дорогое.
            const blur = Math.max(0, (Math.abs(t) * edgeBlur + rush * 0.9) * MAX_BLUR - 0.4);
            const filter = blur > 0.25 ? `blur(${blur.toFixed(2)}px)` : '';
            if ((this.#blurs.get(slot) ?? '') !== filter) {
                this.#blurs.set(slot, filter);
                let faces = this.#faces.get(slot);
                if (!faces) {
                    faces = slot.querySelectorAll('.vinyl__frontside, .vinyl__side');
                    this.#faces.set(slot, faces);
                }
                for (const face of faces) face.style.filter = filter;
            }
        }

        if (nearest >= 0 && nearest !== this.#focused) {
            slots[this.#focused]?.classList.remove('slot--focused');
            slots[nearest].classList.add('slot--focused');
            const initial = this.#focused === -1;
            this.#focused = nearest;
            // короткий отклик при смене центрального — только Android:
            // iOS Safari этого API не имеет
            // и только после первого касания — иначе Chrome ругается в консоль
            if (!initial && this.#options.haptics && navigator.userActivation?.hasBeenActive) navigator.vibrate?.(8);
            this.emit('focus', { index: nearest });
        }
        this.emit('move');
    }

    #snap = () => {
        this.#dirty = true;
        this.#draw();
        if (this.#focused >= 0) this.centerOn(this.#focused);
        this.#onScrub(0);              // остановились — фильтр открывается
    };

    /** @param {WheelEvent} event */
    #onWheel = event => {
        if (event.ctrlKey) return;     // щипок трекпада — это масштаб, не наше
        const delta = event.deltaMode === 1 ? event.deltaY * 40 : event.deltaY;
        this.#target -= delta;
        this.#pos = this.#target;
        this.#draw();
        this.#start();                  // чтобы размытие в движении оседало

        // насколько закрыть фильтр — по скорости, а не «крутим/не крутим»:
        // чуть подвинул — почти не слышно, гоняешь быстро — уходит в подушку
        this.#onScrub(Math.min(1, Math.abs(delta) / 150));

        clearTimeout(this.#snapTimer);
        this.#snapTimer = window.setTimeout(this.#snap, WHEEL_SNAP_MS);
    };

    // Мышь сюда не пускаем: на десктопе крутят колесом, а перетаскивание
    // мышью только мешало бы клику по конверту.
    /** @param {PointerEvent} event */
    #onPointerDown = event => {
        if (event.pointerType === 'mouse') return;
        this.#dragId = event.pointerId;
        this.#dragFrom = this.#lastY = event.clientY;
        this.#lastMoveTime = event.timeStamp;
        this.#dragBase = this.#pos;
        this.#dragging = false;
        this.#velocity = 0;
        this.#target = this.#pos;       // палец поймал полку на ходу
        clearTimeout(this.#snapTimer);
    };

    /** @param {PointerEvent} event */
    #onPointerMove = event => {
        if (event.pointerId !== this.#dragId) return;
        const delta = event.clientY - this.#dragFrom;

        // Захват ставим ТОЛЬКО когда палец реально поехал. Если взять его
        // сразу, браузер перенаправит на сцену и click — и нажатие на
        // конкретный конверт перестанет доходить.
        if (!this.#dragging) {
            if (Math.abs(delta) < THRESHOLD) return;
            this.#dragging = true;
            try { this.#viewport.setPointerCapture(event.pointerId); } catch {}
        }

        const dt = event.timeStamp - this.#lastMoveTime;
        if (dt > 0) {
            // сглаживаем: одно дёрганое событие не должно решать бросок
            const v = (event.clientY - this.#lastY) / dt;
            this.#velocity = this.#velocity * 0.4 + v * 0.6;
        }
        this.#lastY = event.clientY;
        this.#lastMoveTime = event.timeStamp;

        this.#pos = this.#target = this.#dragBase + delta;
        this.#draw();
        this.#start();
        this.#onScrub(Math.min(1, Math.abs(this.#velocity) * 0.6));
    };

    /** @param {PointerEvent} event */
    #onPointerUp = event => {
        if (event.pointerId !== this.#dragId) return;
        this.#dragId = null;
        if (!this.#dragging) return;           // это был тап, а не прокрутка
        this.#dragging = false;
        this.#swallowClick = true;             // ...а вот это была прокрутка
        try { this.#viewport.releasePointerCapture(event.pointerId); } catch {}

        // Палец замер перед отпусканием — броска нет
        const still = event.timeStamp - this.#lastMoveTime > 80;
        const projected = this.#pos + (still ? 0 : this.#velocity * PROJECT_MS);

        // Бросок сразу выбирает конверт, у которого он «остановится»,
        // вместо броска и отдельной доводки через паузу
        if (this.#dirty) this.#measure();
        const want = this.#viewCenter - this.#listTop - projected;
        let index = -1, best = Infinity;
        const around = lowerBound(this.#centers, want);
        for (let i = Math.max(0, around - 8); i < Math.min(this.#slots.length, around + 8); i++) {
            if (!this.#usable(i)) continue;
            const distance = Math.abs(this.#centers[i] - want);
            if (distance < best) { best = distance; index = i; }
        }
        if (index >= 0) this.centerOn(index);
        else this.#start();

        clearTimeout(this.#snapTimer);
        this.#snapTimer = window.setTimeout(() => this.#onScrub(0), 260);
    };
}
