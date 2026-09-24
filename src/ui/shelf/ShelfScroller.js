import { Emitter } from '../../core/Emitter.js';
import { ShelfLayout } from './ShelfLayout.js';

const FISH_ANGLE = 20;          // градусов наклона у краёв при силе 1
const FISH_DEPTH = 140;         // насколько края утопают вглубь
const FISH_SPREAD = 320;        // на какой дистанции эффект набирает силу
const MAX_BLUR = 4;             // px размытия у самых дальних
const VISIBLE = FISH_SPREAD * 1.8;   // дальше слот не рисуем вообще
const RUSH_SPEED = 1560;        // px/с, при которых размытие в движении максимальное
const EASE = 0.14;              // с: постоянная времени камеры
const THRESHOLD = 6;            // px, после которых это уже прокрутка, а не тап
const PROJECT_MS = 220;         // на сколько вперёд «долетает» бросок
const WHEEL_SNAP_MS = 140;      // пауза колеса, после которой полка доводится

/**
 * @typedef {{ edgeBlur: number, motionBlur: number, fisheye: number,
 *             haptics: boolean, reduced: boolean }} ScrollerOptions
 * @typedef {{ transform: string, blur: string, culled: boolean, hidden: boolean }} SlotState
 */

/**
 * Камера над полкой: прокрутка колесом и пальцем, доводка к конверту,
 * «рыбий глаз», размытие.
 *
 * Геометрию считает ShelfLayout, а здесь — только камера и отрисовка:
 *  - pos — координата модели, которая сейчас в центре сцены;
 *  - в режиме follow цель камеры = центр выбранного конверта, и она
 *    пересчитывается КАЖДЫЙ кадр из той же модели, что двигает конверты.
 *    Пока текущий конверт раскрывается, камера едет вместе с ним и
 *    заканчивает ровно по центру — без доводок «вдогонку»;
 *  - конверты стоят абсолютно, каждому пишется один transform. Раскладка
 *    страницы при прокрутке не меняется вовсе, и ничего не нужно мерить:
 *    ни getBoundingClientRect, ни offsetTop в покадровом коде нет;
 *  - обновляется только видимое окно (двоичный поиск по центрам), в стиль
 *    пишется только изменившееся;
 *  - всё сглаживание — по времени, а не по кадрам.
 *
 * События: 'focus' {id} — сменился ближайший к центру; 'move' — кадр.
 */
export class ShelfScroller extends Emitter {
    #viewport;
    #probe;
    #onScrub;
    #layout = new ShelfLayout();

    /** @type {string[]} */ #ids = [];
    /** @type {Map<string, HTMLElement>} */ #elements = new Map();
    /** @type {WeakMap<HTMLElement, SlotState>} */ #state = new WeakMap();
    /** @type {WeakMap<HTMLElement, NodeListOf<HTMLElement>>} */ #faces = new WeakMap();
    /** @type {Set<string> | null} */ #drawn = null;    // null — пройти всех

    #pos = 0;
    /** @type {string | null} */ #follow = null;         // за кем едет камера
    #lastPos = 0;
    #speed = 0;               // px/с, сглаженно — им правим размытие
    #frame = 0;
    #lastTime = 0;
    #viewHeight = 0;
    /** @type {string | null} */ #focused = null;

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

    /**
     * @param {{ viewport: HTMLElement, probe: HTMLElement, onScrub?: (amount: number) => void }} deps
     *   viewport — сцена; probe — невидимый элемент шириной var(--vinyl-size)
     */
    constructor({ viewport, probe, onScrub }) {
        super();
        this.#viewport = viewport;
        this.#probe = probe;
        this.#onScrub = onScrub ?? (() => {});
    }

    get focusedId() { return this.#focused; }

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

        // requestAnimationFrame замирает в скрытой вкладке: если её свернули
        // посреди доводки, занятый frame не дал бы перезапустить цикл
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState !== 'visible') return;
            this.#frame = 0;
            this.#lastTime = 0;
            this.#start();
        });

        // Размер обложки зависит от размера сцены (container query) и от
        // настройки «Размер конвертов». Меряем его по пробнику — это
        // единственный замер, и он не покадровый.
        const observer = new ResizeObserver(() => this.#measure());
        observer.observe(this.#probe);
        observer.observe(viewport);
        this.#measure();
    }

    /**
     * Новый состав полки в её порядке.
     * @param {{ id: string, element: HTMLElement }[]} entries
     */
    setItems(entries) {
        this.#ids = entries.map(entry => entry.id);
        this.#elements = new Map(entries.map(entry => [entry.id, entry.element]));
        this.#layout.setItems(this.#ids);
        this.#drawn = null;
        if (this.#follow && !this.#elements.has(this.#follow)) this.#follow = null;
        if (this.#focused && !this.#elements.has(this.#focused)) this.#focused = null;
        this.#draw();
        this.#start();
    }

    /**
     * @param {string | null} id
     * @param {{ instant?: boolean }} [options]
     */
    setCurrent(id, { instant = false } = {}) {
        this.#layout.setCurrent(id, { instant: instant || this.#options.reduced });
        this.#settle(instant);
    }

    /**
     * @param {string} id
     * @param {boolean} present
     * @param {{ delay?: number, instant?: boolean }} [options]
     */
    setPresent(id, present, { delay = 0, instant = false } = {}) {
        const now = instant || this.#options.reduced;
        this.#layout.setPresent(id, present, { delay: now ? 0 : delay, instant: now });
        this.#settle(instant);
    }

    /**
     * Держать конверт по центру — сейчас и пока раскладка меняется.
     * @param {string} id
     * @param {{ instant?: boolean }} [options]
     */
    follow(id, { instant = false } = {}) {
        if (!this.#elements.has(id)) return;
        this.#follow = id;
        this.#updateFocus();
        this.#settle(instant);
    }

    /**
     * Соседний видимый конверт — для стрелок.
     * @param {number} delta +1 вниз, −1 вверх
     */
    step(delta) {
        const from = this.#layout.indexOf(this.#follow ?? this.#focused ?? '');
        for (let i = from + delta; i >= 0 && i < this.#ids.length; i += delta) {
            if (this.#layout.isPresent(i)) { this.follow(this.#ids[i]); return; }
        }
    }

    /** @param {'first' | 'last'} edge */
    jump(edge) {
        const order = [...this.#ids.keys()];
        if (edge === 'last') order.reverse();
        const index = order.find(i => this.#layout.isPresent(i));
        if (index !== undefined) this.follow(this.#ids[index]);
    }

    /**
     * Виден ли конверт в кадре — для мини-обложки в панели.
     * @param {string} id
     */
    isOnScreen(id) {
        const index = this.#layout.indexOf(id);
        if (index < 0 || !this.#layout.isPresent(index)) return false;
        return Math.abs(this.#layout.centers()[index] - this.#pos) < this.#viewHeight * 0.42;
    }

    /** Как далеко конверт от центра — чтобы проявлять полку от середины. @param {string} id */
    distanceTo(id) {
        const center = this.#layout.centerOf(id);
        return center === null ? Infinity : Math.abs(center - this.#pos);
    }

    #measure() {
        const size = this.#probe.offsetWidth;
        this.#viewHeight = this.#viewport.clientHeight;
        const before = this.#layout.size;
        if (!size || !this.#layout.setMetrics(size)) { this.#draw(); return; }
        // поворот экрана и смена размера — без поездки: камера остаётся
        // над тем же местом полки
        if (this.#follow) this.#pos = /** @type {number} */ (this.#layout.centerOf(this.#follow));
        else if (before) this.#pos *= size / before;
        this.#drawn = null;
        this.#draw();
    }

    /** @param {boolean} instant */
    #settle(instant) {
        if (instant || this.#options.reduced) {
            this.#layout.step(0, { instant: true });
            if (this.#follow) this.#pos = /** @type {number} */ (this.#layout.centerOf(this.#follow));
            this.#draw();
        }
        this.#start();
    }

    #start() {
        if (!this.#frame) this.#frame = requestAnimationFrame(this.#loop);
    }

    #loop = (/** @type {number} */ now) => {
        const dt = this.#lastTime ? Math.min(0.05, (now - this.#lastTime) / 1000) : 1 / 60;
        this.#lastTime = now;
        const reduced = this.#options.reduced;

        const animating = this.#layout.step(dt, { instant: reduced });
        let moving = false;
        if (this.#follow && !this.#dragging) {
            // цель — из модели ЭТОГО кадра, а не запомненная когда-то
            const target = /** @type {number} */ (this.#layout.centerOf(this.#follow));
            const k = reduced ? 1 : 1 - Math.exp(-dt / EASE);
            this.#pos += (target - this.#pos) * k;
            if (Math.abs(target - this.#pos) < 0.25) this.#pos = target;
            moving = this.#pos !== target;
        }
        this.#draw(dt);

        // Держим кадры, пока что-то движется ИЛИ не осела скорость: иначе
        // размытие замирало бы на значении момента отпускания
        const busy = animating || moving || this.#dragging || this.#speed > 12;
        this.#frame = busy ? requestAnimationFrame(this.#loop) : 0;
        if (!busy) this.#lastTime = 0;
    };

    /** @param {number} [dt] секунд с прошлого кадра */
    #draw(dt = 1 / 60) {
        const moved = Math.abs(this.#pos - this.#lastPos);
        this.#lastPos = this.#pos;
        this.#speed += (moved / dt - this.#speed) * (1 - Math.exp(-dt / 0.07));

        const ids = this.#ids;
        if (!ids.length || !this.#layout.size) { this.emit('move'); return; }

        const { edgeBlur, motionBlur, fisheye, reduced } = this.#options;
        const rush = reduced ? 0 : Math.min(1, this.#speed / RUSH_SPEED) * motionBlur;
        const angle = FISH_ANGLE * fisheye;
        const depth = FISH_DEPTH * fisheye;
        const centers = this.#layout.centers();
        const [first, last] = this.#layout.range(this.#pos - VISIBLE, this.#pos + VISIBLE);

        // Уходящих из окна отсекаем (всех, если окно неизвестно), пришедших
        // рисуем. Классы трогаем только при смене: даже «пустой» remove
        // переписывает атрибут.
        const drawn = new Set();
        for (let i = first; i <= last; i++) drawn.add(ids[i]);
        for (const id of this.#drawn ?? ids) {
            if (!drawn.has(id)) this.#write(this.#elements.get(id), { culled: true });
        }
        this.#drawn = drawn;

        for (let i = first; i <= last; i++) {
            const element = this.#elements.get(ids[i]);
            const offset = centers[i] - this.#pos;

            // рыбий глаз: чем дальше от центра, тем сильнее наклон и утопание
            const t = Math.max(-1, Math.min(1, offset / FISH_SPREAD));
            const transform = `translate3d(0, ${offset.toFixed(2)}px, ${(-Math.abs(t) * depth).toFixed(1)}px)`
                + ` rotateX(${(-t * angle).toFixed(2)}deg)`;

            // У краёв размывает всегда, в движении — ещё и по центру.
            // Фильтр — только на лицевую грань и корешок: любой filter на
            // слоте или коробке делает transform-style: flat и схлопывает 3D.
            const amount = Math.max(0, (Math.abs(t) * edgeBlur + rush * 0.9) * MAX_BLUR - 0.4);
            const blur = amount > 0.25 ? `blur(${amount.toFixed(2)}px)` : '';

            // отсеянный и уже схлопнутый — не рисуем
            const hidden = !this.#layout.isPresent(i) && this.#layout.presenceAt(i) < 0.02;
            this.#write(element, { culled: false, transform, blur, hidden });
        }

        this.#updateFocus();
        this.emit('move');
    }

    /**
     * Пишет в элемент только изменившееся.
     * @param {HTMLElement | undefined} element
     * @param {Partial<SlotState>} next
     */
    #write(element, next) {
        if (!element) return;
        const state = this.#state.get(element) ?? { transform: '', blur: '', culled: false, hidden: false };
        if (next.culled !== undefined && next.culled !== state.culled) {
            element.classList.toggle('slot--culled', next.culled);
            state.culled = next.culled;
        }
        if (next.hidden !== undefined && next.hidden !== state.hidden) {
            element.classList.toggle('slot--hidden', next.hidden);
            state.hidden = next.hidden;
        }
        if (next.transform !== undefined && next.transform !== state.transform) {
            element.style.transform = next.transform;
            state.transform = next.transform;
        }
        if (next.blur !== undefined && next.blur !== state.blur) {
            let faces = this.#faces.get(element);
            if (!faces) {
                faces = element.querySelectorAll('.vinyl__frontside, .vinyl__side');
                this.#faces.set(element, faces);
            }
            for (const face of faces) face.style.filter = next.blur;
            state.blur = next.blur;
        }
        this.#state.set(element, state);
    }

    /**
     * Выбранный конверт — тот, к которому едет камера, а пока её ведёт
     * палец или колесо — ближайший к центру. Иначе «End» и сразу «Enter»
     * включали конверт, который в этот миг проезжал через центр.
     */
    #updateFocus() {
        const index = this.#layout.nearest(this.#pos);
        const id = this.#follow ?? (index >= 0 ? this.#ids[index] : null);
        if (id === this.#focused) return;
        if (this.#focused) this.#elements.get(this.#focused)?.classList.remove('slot--focused');
        if (id) this.#elements.get(id)?.classList.add('slot--focused');
        const initial = this.#focused === null;
        this.#focused = id;
        // короткий отклик при смене центрального — только Android (у iOS
        // нет API) и только после первого касания, иначе Chrome ругается
        if (!initial && id && this.#options.haptics && navigator.userActivation?.hasBeenActive) {
            navigator.vibrate?.(8);
        }
        this.emit('focus', { id });
    }

    /** Доводка к ближайшему к точке y конверту. @param {number} y */
    #snapTo(y) {
        const index = this.#layout.nearest(y);
        if (index >= 0) this.follow(this.#ids[index]);
        else this.#start();
    }

    /** @param {WheelEvent} event */
    #onWheel = event => {
        if (event.ctrlKey) return;     // щипок трекпада — это масштаб, не наше
        const delta = event.deltaMode === 1 ? event.deltaY * 40 : event.deltaY;
        this.#follow = null;
        this.#pos += delta;
        this.#draw();
        this.#start();

        // насколько закрыть фильтр — по скорости, а не «крутим/не крутим»:
        // чуть подвинул — почти не слышно, гоняешь быстро — уходит в подушку
        this.#onScrub(Math.min(1, Math.abs(delta) / 150));

        clearTimeout(this.#snapTimer);
        this.#snapTimer = window.setTimeout(() => {
            this.#snapTo(this.#pos);
            this.#onScrub(0);          // остановились — фильтр открывается
        }, WHEEL_SNAP_MS);
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
            this.#follow = null;       // палец поймал полку на ходу
            this.#dragBase = this.#pos;
            this.#dragFrom = event.clientY;
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

        // палец вниз — полка вниз, то есть камера вверх
        this.#pos = this.#dragBase - (event.clientY - this.#dragFrom);
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

        // Бросок сразу выбирает конверт, у которого он «остановится».
        // Палец замер перед отпусканием — броска нет.
        const still = event.timeStamp - this.#lastMoveTime > 80;
        this.#snapTo(this.#pos - (still ? 0 : this.#velocity * PROJECT_MS));

        clearTimeout(this.#snapTimer);
        this.#snapTimer = window.setTimeout(() => this.#onScrub(0), 260);
    };
}
