import { Emitter } from '../../core/Emitter.js';
import { VinylView } from './VinylView.js';

const HIDE_AT = 640;        // чуть позже, чем догасает грань (520 мс)
const STAGGER = 50;         // лесенка при поиске
const REVEAL_STEP = 70;     // лесенка появления
const MAX_STEPS = 14;       // дальше лесенка не растёт — длинная полка не ждёт секундами
const DECODE_FIRST = 12;    // сколько ближайших обложек ждём перед показом

/**
 * Полка: конверты в DOM, их состояния и поиск по ним. Где конверт стоит,
 * решают ShelfLayout и ShelfScroller; здесь — что на полке и в каком виде.
 *
 * Не знает ни про звук, ни про библиотеку: получает треки, отдаёт
 * события 'activate' {id} (тап по конверту или Enter), 'pending' {id}
 * (то же, но по конверту, который ещё качается) и 'filter' {visible}.
 *
 * Заготовки (addPending) — конверты скачиваемых треков. Играть их нельзя,
 * поэтому в visibleIds их нет; поиск их не прячет — их только что просили.
 */
export class Shelf extends Emitter {
    /** @type {Map<string, VinylView>} */
    #views = new Map();
    /** @type {string[]} */
    #order = [];
    #query = '';
    /** @type {string | null} */
    #current = null;
    /** @type {Set<string>} */
    #pending = new Set();

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
            const id = slot?.dataset.id ?? this.scroller.focusedId;
            if (id) this.#activate(id);
        });

        this.list.addEventListener('keydown', event => {
            if (event.key !== 'Enter') return;
            const id = this.scroller.focusedId;
            if (!id) return;
            event.preventDefault();
            this.#activate(id);
        });

        // listbox: активный вариант — ближайший к центру
        let selected = /** @type {HTMLElement | null} */ (null);
        this.scroller.on('focus', ({ id }) => {
            selected?.setAttribute('aria-selected', 'false');
            selected = (id && this.#views.get(id)?.element) || null;
            if (!selected) { this.list.removeAttribute('aria-activedescendant'); return; }
            selected.setAttribute('aria-selected', 'true');
            this.list.setAttribute('aria-activedescendant', selected.id);
        });
    }

    /**
     * @param {import('../../library/Track.js').Track[]} tracks
     * @param {{ focus?: string | null }} [options] focus — кого сразу поставить
     *   в центр (при запуске — трек «продолжить с места»)
     */
    async add(tracks, { focus = null } = {}) {
        // скачанный трек встаёт на место своей заготовки
        for (const track of tracks) if (this.#pending.has(track.id)) this.#adopt(track);
        tracks = tracks.filter(track => !this.#views.has(track.id));
        if (!tracks.length) {
            this.emit('filter', { visible: this.visibleIds() });
            return;
        }
        const first = !this.#order.length;
        const added = tracks.map(track => {
            const view = new VinylView(this.template, track);
            // Прячем сразу: иначе конверты появляются голыми, а размытие
            // и наклоны наваливаются потом, одним рывком.
            view.element.classList.add('slot--loading');
            this.#views.set(track.id, view);
            this.#order.push(track.id);
            this.list.append(view.element);
            return view;
        });
        this.#sync();

        for (const view of added) {
            if (this.#query && !view.track.matches(this.#query)) {
                view.element.classList.add('slot--gone');
                this.scroller.setPresent(view.track.id, false, { instant: true });
            }
        }
        const anchor = focus ?? (first ? tracks[0].id : null);
        if (anchor) this.scroller.follow(anchor, { instant: true });

        // Проявляем от центра к краям: сначала то, на что смотрят, —
        // а не по порядку, где трек №25 ждал бы полторы секунды.
        const byDistance = [...added].sort((a, b) =>
            this.scroller.distanceTo(a.track.id) - this.scroller.distanceTo(b.track.id));
        await Promise.all(byDistance.slice(0, DECODE_FIRST).map(view => view.decode()));
        const step = this.reducedMotion() ? 0 : REVEAL_STEP;
        byDistance.forEach((view, rank) =>
            setTimeout(() => view.element.classList.remove('slot--loading'), Math.min(rank, MAX_STEPS) * step));
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

    /**
     * Конверт скачиваемого трека: встаёт в конец полки прозрачным, камера
     * едет к нему, дальше он проявляется вместе с загрузкой (setPending).
     * @param {import('../../downloads/PendingTrack.js').PendingTrack} track
     */
    addPending(track) {
        if (this.#views.has(track.id)) return;
        const view = new VinylView(this.template, track);
        view.element.classList.add('slot--pending');
        view.setProgress(0);
        this.#views.set(track.id, view);
        this.#order.push(track.id);
        this.#pending.add(track.id);
        this.list.append(view.element);
        this.#sync();
        this.scroller.follow(track.id);
    }

    /** @param {string} id @param {number} fraction 0..1 */
    setPending(id, fraction) {
        if (this.#pending.has(id)) this.#views.get(id)?.setProgress(fraction);
    }

    /** @param {string} id */
    isPending(id) {
        return this.#pending.has(id);
    }

    /**
     * Скачать не вышло: заготовка уходит, как отсеянный поиском конверт,
     * и её место схлопывается.
     * @param {string} id
     */
    dropPending(id) {
        const view = this.#views.get(id);
        if (!view || !this.#pending.has(id)) return;
        view.element.classList.add('slot--gone');
        this.scroller.setPresent(id, false, { delay: HIDE_AT });
        setTimeout(() => this.remove(id), HIDE_AT + 700);
    }

    /** @param {string} id */
    remove(id) {
        const view = this.#views.get(id);
        if (!view) return;
        view.destroy();
        this.#views.delete(id);
        this.#pending.delete(id);
        this.#order = this.#order.filter(other => other !== id);
        this.#sync();
        this.emit('filter', { visible: this.visibleIds() });
    }

    clear() {
        for (const view of this.#views.values()) view.destroy();
        this.#views.clear();
        this.#pending.clear();
        this.#order = [];
        this.#current = null;
        this.list.removeAttribute('aria-activedescendant');
        this.#sync();
        this.emit('filter', { visible: [] });
    }

    /**
     * @param {string | null} current
     * @param {string | null} previous прежний трек: ему ещё нужно доиграть уход
     * @param {{ instant?: boolean }} [options] instant — при запуске: без анимации
     */
    setCurrent(current, previous, { instant = false } = {}) {
        this.#current = current;
        for (const [id, view] of this.#views) {
            view.element.classList.toggle('slot--current', id === current);
            view.element.classList.toggle('slot--recent', id === previous && id !== current);
            if (id === current) view.element.setAttribute('aria-current', 'true');
            else view.element.removeAttribute('aria-current');
        }
        this.scroller.setCurrent(current, { instant });
    }

    /**
     * Поиск. Отсеянные конверты уходят вниз, и их место схлопывается,
     * когда они уже догасли. Играющий трек подчиняется поиску так же, как
     * все: он остаётся в панели снизу, а мини-обложка вернёт к нему.
     * @param {string} raw
     */
    filter(raw) {
        const query = raw.trim().toLowerCase();
        this.#query = query;
        let rank = 0;
        let changed = false;

        for (const id of this.#order) {
            if (this.#pending.has(id)) continue;
            const view = /** @type {VinylView} */ (this.#views.get(id));
            const element = view.element;
            const gone = Boolean(query) && !view.track.matches(query);
            if (gone === element.classList.contains('slot--gone')) continue;
            changed = true;
            element.classList.toggle('slot--gone', gone);
            // Место закрываем, когда конверт УЖЕ ушёл, и лесенкой: если
            // схлопнуть всё разом, полка дёргается. Возвращаем — сразу.
            this.scroller.setPresent(id, !gone, {
                delay: gone ? HIDE_AT + Math.min(rank++, MAX_STEPS) * STAGGER : 0,
            });
        }
        if (!changed) return;

        // Камера держит того, кто остался: играющий, иначе тот, что был
        // в центре, иначе первый найденный. Она едет вместе со схлопыванием,
        // и никаких «подвести полку, когда всё уляжется» больше не нужно.
        const visible = this.visibleIds();
        // заготовка скачивания в visibleIds не входит, но поиск её не прячет —
        // если смотрели на неё, на ней и остаёмся
        const stays = (/** @type {string | null} */ id) => Boolean(id) && (visible.includes(id) || this.#pending.has(id));
        const keep = [this.#current, this.scroller.focusedId].find(stays) ?? visible[0];
        if (keep) this.scroller.follow(keep);
        this.emit('filter', { visible });
    }

    /** Треки, которые сейчас видны и готовы играть, в порядке полки. */
    visibleIds() {
        return this.#order.filter(id =>
            !this.#pending.has(id) && !this.#views.get(id)?.element.classList.contains('slot--gone'));
    }

    /** @param {string} id */
    isFiltered(id) {
        return Boolean(this.#views.get(id)?.element.classList.contains('slot--gone'));
    }

    /** @param {string} id @param {{ instant?: boolean }} [options] */
    follow(id, options) {
        this.scroller.follow(id, options);
    }

    /** @param {string} id */
    isOnScreen(id) {
        return this.scroller.isOnScreen(id);
    }

    /** Трек в центре — если его можно играть (заготовка скачивания — нельзя). */
    focusedId() {
        const id = this.scroller.focusedId;
        return id && !this.#pending.has(id) ? id : null;
    }

    /** @param {string | null} id */
    discOf(id) {
        return id ? this.#views.get(id)?.disc ?? null : null;
    }

    /** @param {string} id */
    #activate(id) {
        this.emit(this.#pending.has(id) ? 'pending' : 'activate', { id });
    }

    /**
     * Заготовка стала треком: подписи и обложка — уже из файла, прозрачность
     * снимается. Под текущий поиск трек заново не проверяем: его только что
     * скачали по этому поиску, и он не должен тут же исчезнуть.
     * @param {import('../../library/Track.js').Track} track
     */
    #adopt(track) {
        const view = /** @type {VinylView} */ (this.#views.get(track.id));
        this.#pending.delete(track.id);
        view.render(track);
        view.element.classList.remove('slot--pending');
        view.setProgress(null);
    }

    #sync() {
        this.scroller.setItems(this.#order.map(id => ({ id, element: /** @type {VinylView} */ (this.#views.get(id)).element })));
    }
}
