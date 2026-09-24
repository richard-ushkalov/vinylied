/**
 * Геометрия полки как чистая модель: где стоит каждый конверт.
 *
 * Раньше раскладку делал браузер (flex и анимированные отступы), а JS
 * догонял её, двигая список к центру, посчитанному ОДИН раз. Пока текущий
 * конверт раздувался на 400 мс, цель уже была неверна, и полка «не успевала»
 * или вставала мимо центра, а доводки по transitionend и ResizeObserver
 * только добавляли рывков. Теперь позиции считаются здесь, в тех же числах,
 * что и камера, — и центр по определению совпадает.
 *
 * Слот — место в стопке. Его высота складывается из двух анимируемых долей:
 *  - expand:   0 — обычный конверт лежит; 1 — текущий встал вертикально;
 *  - presence: 1 — виден; 0 — отсеян поиском и схлопнут.
 * Высота обычного слота — 2/7 обложки, текущего — целая обложка: ровно та
 * геометрия, что раньше задавали отступы size/7 и size/2.
 *
 * Без DOM — проверяется unit-тестами.
 */
const NORMAL = 2 / 7;
const CURRENT = 1;
const EASE = 0.12;          // с: постоянная времени сглаживания
const SETTLE = 0.001;       // доля, ближе которой считаем, что доехали

/**
 * @typedef {{ id: string, expand: number, expandTo: number,
 *             presence: number, presenceTo: number, presenceAt: number }} Item
 */

/**
 * Первый индекс, где sorted[i] >= value.
 * @param {number[]} sorted
 * @param {number} value
 */
export const lowerBound = (sorted, value) => {
    let lo = 0, hi = sorted.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sorted[mid] < value) lo = mid + 1; else hi = mid;
    }
    return lo;
};

export class ShelfLayout {
    /** @type {Item[]} */
    #items = [];
    /** @type {Map<string, Item>} */
    #byId = new Map();
    /** @type {Map<string, number>} */
    #index = new Map();
    #size = 0;
    #time = 0;
    /** @type {number[]} */
    #centers = [];
    #dirty = true;
    #ease;

    /** @param {{ ease?: number }} [options] */
    constructor({ ease = EASE } = {}) {
        this.#ease = ease;
    }

    get size() { return this.#size; }
    get length() { return this.#items.length; }

    /** Размер обложки в px (--vinyl-size). @param {number} size */
    setMetrics(size) {
        if (size === this.#size) return false;
        this.#size = size;
        this.#dirty = true;
        return true;
    }

    /**
     * Новый состав в порядке полки. Состояние уже знакомых конвертов
     * сохраняется — добавление трека не сбрасывает раскрытый текущий.
     * @param {string[]} ids
     */
    setItems(ids) {
        this.#items = ids.map(id => this.#byId.get(id)
            ?? { id, expand: 0, expandTo: 0, presence: 1, presenceTo: 1, presenceAt: 0 });
        this.#byId = new Map(this.#items.map(item => [item.id, item]));
        this.#index = new Map(ids.map((id, i) => [id, i]));
        this.#dirty = true;
    }

    /** @param {string} id */
    indexOf(id) { return this.#index.get(id) ?? -1; }
    /** @param {number} index */
    idAt(index) { return this.#items[index]?.id ?? null; }

    /**
     * @param {string | null} id текущий трек (его конверт встаёт)
     * @param {{ instant?: boolean }} [options]
     */
    setCurrent(id, { instant = false } = {}) {
        for (const item of this.#items) {
            item.expandTo = item.id === id ? 1 : 0;
            if (instant) item.expand = item.expandTo;
        }
        this.#dirty = true;
    }

    /**
     * @param {string} id
     * @param {boolean} present
     * @param {{ delay?: number, instant?: boolean }} [options] delay — мс до начала схлопывания
     */
    setPresent(id, present, { delay = 0, instant = false } = {}) {
        const item = this.#byId.get(id);
        if (!item) return;
        item.presenceTo = present ? 1 : 0;
        item.presenceAt = this.#time + delay / 1000;
        if (instant) item.presence = item.presenceTo;
        this.#dirty = true;
    }

    /** Логически виден (цель, а не текущая анимация). @param {number} index */
    isPresent(index) { return this.#items[index]?.presenceTo === 1; }

    /** Насколько слот сейчас раскрыт по высоте, 0..1. @param {number} index */
    presenceAt(index) { return this.#items[index]?.presence ?? 0; }

    /**
     * Шаг анимации. Сглаживание экспоненциальное и зависит только от
     * времени: на 60 и на 120 Гц результат одинаковый.
     * @param {number} dt секунды
     * @param {{ instant?: boolean }} [options]
     * @returns {boolean} ещё анимируется
     */
    step(dt, { instant = false } = {}) {
        this.#time += dt;
        const k = instant ? 1 : 1 - Math.exp(-dt / this.#ease);
        let animating = false;
        for (const item of this.#items) {
            if (item.expand !== item.expandTo) {
                item.expand += (item.expandTo - item.expand) * k;
                if (Math.abs(item.expandTo - item.expand) < SETTLE) item.expand = item.expandTo;
                this.#dirty = true;
            }
            if (item.presence !== item.presenceTo) {
                if (this.#time >= item.presenceAt || instant) {
                    item.presence += (item.presenceTo - item.presence) * k;
                    if (Math.abs(item.presenceTo - item.presence) < SETTLE) item.presence = item.presenceTo;
                    this.#dirty = true;
                }
            }
            animating ||= item.expand !== item.expandTo || item.presence !== item.presenceTo;
        }
        return animating;
    }

    /** Центры слотов по порядку. Не убывают — годятся для двоичного поиска. */
    centers() {
        if (!this.#dirty) return this.#centers;
        const centers = new Array(this.#items.length);
        let top = 0;
        this.#items.forEach((item, i) => {
            const height = item.presence * this.#size * (NORMAL + item.expand * (CURRENT - NORMAL));
            centers[i] = top + height / 2;
            top += height;
        });
        this.#centers = centers;
        this.#dirty = false;
        return centers;
    }

    /** @param {string} id */
    centerOf(id) {
        const index = this.indexOf(id);
        return index < 0 ? null : this.centers()[index];
    }

    /**
     * Ближайший к координате y видимый конверт — или -1, если видимых нет.
     * @param {number} y
     */
    nearest(y) {
        const centers = this.centers();
        const around = lowerBound(centers, y);
        let best = -1, distance = Infinity;
        // схлопнутые стоят вплотную к соседям, поэтому идём в обе стороны,
        // пока не найдём видимых
        for (let i = around; i < centers.length; i++) {
            if (!this.isPresent(i)) continue;
            if (centers[i] - y < distance) { best = i; distance = centers[i] - y; }
            break;
        }
        for (let i = around - 1; i >= 0; i--) {
            if (!this.isPresent(i)) continue;
            if (y - centers[i] < distance) best = i;
            break;
        }
        return best;
    }

    /**
     * Индексы, чьи центры лежат в [from, to].
     * @param {number} from
     * @param {number} to
     * @returns {[number, number]} первый и последний (last < first — пусто)
     */
    range(from, to) {
        const centers = this.centers();
        return [lowerBound(centers, from), lowerBound(centers, to + 1e-6) - 1];
    }
}
