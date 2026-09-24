import { Emitter } from '../../core/Emitter.js';
import { VinylView } from './VinylView.js';

const HIDE_AT = 640;        // чуть позже, чем догасает грань (520 мс)
const STAGGER = 50;         // лесенка при поиске
const REVEAL_STEP = 70;     // лесенка появления
const DECODE_FIRST = 12;    // сколько обложек ждём перед показом

/**
 * Полка: конверты в DOM, их состояния и поиск по ним.
 *
 * Не знает ни про звук, ни про библиотеку: получает треки, отдаёт
 * события 'activate' {id} (тап по конверту или Enter) и 'filter' {visible}.
 */
export class Shelf extends Emitter {
    /** @type {Map<string, VinylView>} */
    #views = new Map();
    /** @type {string[]} */
    #order = [];
    #query = '';
    #settleTimer = 0;

    /**
     * @param {{ list: HTMLElement, scene: HTMLElement, template: HTMLTemplateElement,
     *           scroller: import('./ShelfScroller.js').ShelfScroller,
     *           reducedMotion: () => boolean }} deps
     */
    constructor({ list, scene, template, scroller, reducedMotion }) {
        super();
        this.list = list;
        this.scene = scene;
        this.template = template;
        this.scroller = scroller;
        this.reducedMotion = reducedMotion;
    }

    get size() { return this.#order.length; }

    attach() {
        // Боксы слотов тонкие и отодвинуты по Z, поэтому мимо них легко
        // промахнуться. Ловим клик на всей сцене: попал в слот — берём его,
        // не попал — берём центральный.
        this.scene.addEventListener('click', event => {
            if (!this.#order.length) return;
            const slot = /** @type {HTMLElement | null} */ (/** @type {Element} */ (event.target).closest?.('.slot'));
            const id = slot?.dataset.id ?? this.focusedId();
            if (id) this.emit('activate', { id });
        });

        this.list.addEventListener('keydown', event => {
            if (event.key !== 'Enter') return;
            const id = this.focusedId();
            if (!id) return;
            event.preventDefault();
            this.emit('activate', { id });
        });

        // listbox: активный вариант — ближайший к центру
        this.scroller.on('focus', ({ index }) => {
            const id = this.#order[index];
            for (const view of this.#views.values()) view.element.setAttribute('aria-selected', 'false');
            const view = id && this.#views.get(id);
            if (!view) return;
            view.element.setAttribute('aria-selected', 'true');
            this.list.setAttribute('aria-activedescendant', view.element.id);
        });
    }

    /**
     * @param {import('../../library/Track.js').Track[]} tracks
     */
    async add(tracks) {
        if (!tracks.length) return;
        const first = !this.#order.length;
        const added = tracks.map(track => {
            const view = new VinylView(this.template, track);
            // Прячем сразу: иначе конверты появляются голыми, а размытие
            // и наклоны наваливаются потом, одним рывком.
            view.element.classList.add('slot--loading');
            if (this.#query && !track.matches(this.#query)) view.element.classList.add('slot--gone', 'slot--hidden');
            this.#views.set(track.id, view);
            this.#order.push(track.id);
            this.list.append(view.element);
            return view;
        });

        await Promise.all(added.slice(0, DECODE_FIRST).map(view => view.decode()));
        // refresh раскладывает стопку СИНХРОННО — transform и filter уже
        // записаны, ждать кадров не нужно. И нельзя: в свёрнутой вкладке
        // requestAnimationFrame не приходит вовсе, и полка осталась бы невидимой.
        this.scroller.refresh();
        // первая пластинка на пустой полке — сразу по центру, а не доездом
        // через паузу, пока ResizeObserver не успокоится
        if (first) this.scroller.centerOn(0, { instant: true });
        const step = this.reducedMotion() ? 0 : REVEAL_STEP;
        added.forEach((view, index) =>
            setTimeout(() => view.element.classList.remove('slot--loading'), Math.min(index, 20) * step));
        this.emit('filter', { visible: this.visibleIds() });
    }

    /**
     * @param {import('../../library/Track.js').Track} track
     * @param {{ animate?: boolean }} [options]
     */
    update(track, { animate = true } = {}) {
        const view = this.#views.get(track.id);
        if (!view) return;
        view.swap(track, { animate: animate && !this.reducedMotion() });
        // подписи поменялись — трек мог начать (или перестать) подходить под поиск
        if (this.#query) this.filter(this.#query);
    }

    /** @param {string} id */
    remove(id) {
        const view = this.#views.get(id);
        if (!view) return;
        view.destroy();
        this.#views.delete(id);
        this.#order = this.#order.filter(other => other !== id);
        this.scroller.refresh();
        this.emit('filter', { visible: this.visibleIds() });
    }

    clear() {
        for (const view of this.#views.values()) view.destroy();
        this.#views.clear();
        this.#order = [];
        this.list.removeAttribute('aria-activedescendant');
        this.scroller.refresh();
        this.emit('filter', { visible: [] });
    }

    /**
     * @param {string | null} current
     * @param {string | null} previous прежний трек: ему ещё нужно доиграть уход
     */
    setCurrent(current, previous) {
        for (const [id, view] of this.#views) {
            view.element.classList.toggle('slot--current', id === current);
            view.element.classList.toggle('slot--recent', id === previous && id !== current);
            if (id === current) view.element.setAttribute('aria-current', 'true');
            else view.element.removeAttribute('aria-current');
        }
    }

    /**
     * Поиск. Отсеянные конверты уходят вниз и схлопывают своё место,
     * полка закрывается. Класс снимается — и они приезжают обратно.
     * Играющий трек подчиняется поиску так же, как все: он остаётся
     * в панели снизу, а мини-обложка вернёт к нему.
     * @param {string} raw
     */
    filter(raw) {
        const query = raw.trim().toLowerCase();
        this.#query = query;
        let changed = false;

        this.#order.forEach((id, index) => {
            const view = /** @type {VinylView} */ (this.#views.get(id));
            const element = view.element;
            const track = view.track;
            const gone = Boolean(query) && !track?.matches(query);
            if (gone === element.classList.contains('slot--gone')) return;
            changed = true;
            clearTimeout(view.hideTimer);

            if (gone) {
                element.classList.add('slot--gone');
                // Место закрываем, когда конверт УЖЕ ушёл и догас, и лесенкой:
                // если схлопнуть все высоты разом, полка дёргается.
                view.hideTimer = window.setTimeout(() => {
                    if (element.classList.contains('slot--gone')) element.classList.add('slot--hidden');
                }, this.reducedMotion() ? 0 : HIDE_AT + index * STAGGER);
            } else {
                element.classList.remove('slot--hidden');
                void element.offsetWidth;    // вернуть высоту ДО того, как включится переход
                element.classList.remove('slot--gone');
            }
        });

        if (!changed) return;
        this.scroller.refresh();     // сразу: снять отсечение с тех, кто снова нужен
        this.emit('filter', { visible: this.visibleIds() });

        clearTimeout(this.#settleTimer);
        const settle = this.reducedMotion() ? 0 : HIDE_AT + this.#order.length * STAGGER + 120;
        this.#settleTimer = window.setTimeout(() => {
            this.scroller.refresh();
            // И подвести полку к первому найденному: магнит доводил
            // до прежнего индекса — а тот мог сам отсеяться.
            const first = this.#order.findIndex(id => !this.#views.get(id)?.element.classList.contains('slot--gone'));
            if (first >= 0) this.scroller.centerOn(first);
        }, settle);
    }

    /** Треки, которые сейчас видны, в порядке полки. */
    visibleIds() {
        return this.#order.filter(id => !this.#views.get(id)?.element.classList.contains('slot--gone'));
    }

    /** @param {string} id */
    isFiltered(id) {
        return Boolean(this.#views.get(id)?.element.classList.contains('slot--gone'));
    }

    /** @param {string} id @param {{ instant?: boolean }} [options] */
    centerOn(id, options) {
        const index = this.#order.indexOf(id);
        if (index >= 0) this.scroller.centerOn(index, options);
    }

    /** @param {string} id */
    isOnScreen(id) {
        const index = this.#order.indexOf(id);
        return index >= 0 && this.scroller.isOnScreen(index);
    }

    focusedId() {
        return this.#order[this.scroller.focusedIndex] ?? null;
    }

    /** @param {string | null} id */
    discOf(id) {
        return id ? this.#views.get(id)?.disc ?? null : null;
    }
}
