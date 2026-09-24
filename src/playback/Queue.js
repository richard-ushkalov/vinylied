/**
 * Порядок воспроизведения. Чистая логика без DOM — проверяется unit-тестами.
 *
 * Элементы — ключи треков в порядке полки, уже с учётом поиска: пока
 * полка отфильтрована, «следующий» ходит только по видимым.
 *
 * order:  'sequential' — как на полке; 'shuffle' — перемешанная перестановка,
 *         которая живёт, пока не кончится (без повторов внутри круга).
 * repeat: 'all' — по кругу; 'one' — трек сам себя, когда доиграл;
 *         'off' — доиграли последний, и стоп.
 */
export class Queue {
    /** @type {string[]} */
    #items = [];
    /** @type {string[]} */
    #shuffled = [];
    #order;
    #repeat;
    #random;

    /**
     * @param {{ order?: 'sequential' | 'shuffle', repeat?: 'all' | 'one' | 'off', random?: () => number }} [options]
     */
    constructor({ order = 'sequential', repeat = 'all', random = Math.random } = {}) {
        this.#order = order;
        this.#repeat = repeat;
        this.#random = random;
    }

    get items() { return this.#items; }
    get order() { return this.#order; }
    get repeat() { return this.#repeat; }

    /**
     * Новый состав. Перестановку не перетряхиваем целиком — иначе каждая
     * буква в поиске меняла бы, что заиграет следующим: ушедшие выпадают,
     * новые встают в случайные места.
     * @param {string[]} ids
     */
    setItems(ids) {
        this.#items = [...ids];
        const alive = new Set(ids);
        const kept = this.#shuffled.filter(id => alive.has(id));
        const known = new Set(kept);
        for (const id of ids) {
            if (known.has(id)) continue;
            kept.splice(Math.floor(this.#random() * (kept.length + 1)), 0, id);
        }
        this.#shuffled = kept;
    }

    /**
     * @param {'sequential' | 'shuffle'} order
     * @param {string | null} [current] с него начнётся новая перестановка
     */
    setOrder(order, current = null) {
        if (order === this.#order) return;
        this.#order = order;
        if (order === 'shuffle') this.#reshuffle(current);
    }

    /** @param {'all' | 'one' | 'off'} repeat */
    setRepeat(repeat) {
        this.#repeat = repeat;
    }

    /**
     * Что играть после current.
     * auto — трек доиграл сам: тогда работает «повтор трека» и «без повтора».
     * Ручной «следующий» по кругу идёт всегда: кнопка не должна молчать.
     * @param {string | null} current
     * @param {{ auto?: boolean }} [options]
     * @returns {string | null}
     */
    next(current, { auto = false } = {}) {
        if (!this.#items.length) return null;
        if (auto && this.#repeat === 'one' && current && this.#items.includes(current)) return current;

        const sequence = this.#sequence();
        const index = current === null ? -1 : sequence.indexOf(current);
        if (index === -1) return sequence[0];
        if (index + 1 < sequence.length) return sequence[index + 1];
        if (auto && this.#repeat === 'off') return null;

        if (this.#order === 'shuffle') {
            this.#reshuffle(null);
            // новый круг не должен начаться с того, что только что доиграло
            if (this.#shuffled[0] === current && this.#shuffled.length > 1) {
                [this.#shuffled[0], this.#shuffled[1]] = [this.#shuffled[1], this.#shuffled[0]];
            }
            return this.#shuffled[0];
        }
        return sequence[0];
    }

    /**
     * @param {string | null} current
     * @returns {string | null}
     */
    prev(current) {
        if (!this.#items.length) return null;
        const sequence = this.#sequence();
        const index = current === null ? -1 : sequence.indexOf(current);
        if (index === -1) return sequence[0];
        if (index > 0) return sequence[index - 1];
        return this.#repeat === 'off' ? null : sequence[sequence.length - 1];
    }

    /**
     * Что, скорее всего, заиграет следующим — для предзагрузки.
     * В отличие от next() ничего не меняет.
     * @param {string | null} current
     */
    peek(current) {
        if (!this.#items.length) return null;
        if (this.#repeat === 'one') return current;
        const sequence = this.#sequence();
        const index = current === null ? -1 : sequence.indexOf(current);
        if (index + 1 < sequence.length) return sequence[index + 1];
        return this.#repeat === 'all' && this.#order === 'sequential' ? sequence[0] : null;
    }

    #sequence() {
        return this.#order === 'shuffle' ? this.#shuffled : this.#items;
    }

    /** Фишер — Йетс; current, если есть, встаёт первым. @param {string | null} current */
    #reshuffle(current) {
        const deck = [...this.#items];
        for (let i = deck.length - 1; i > 0; i--) {
            const j = Math.floor(this.#random() * (i + 1));
            [deck[i], deck[j]] = [deck[j], deck[i]];
        }
        const at = current === null ? -1 : deck.indexOf(current);
        if (at > 0) deck.unshift(...deck.splice(at, 1));
        this.#shuffled = deck;
    }
}
