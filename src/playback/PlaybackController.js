import { Emitter } from '../core/Emitter.js';

const RESTART_AFTER = 3;   // «назад» позже трёх секунд — к началу трека, как в любом плеере

/**
 * @typedef {'playing' | 'paused' | 'stopped'} Intent
 * @typedef {{ current: string | null, previous: string | null, intent: Intent,
 *             trackChanged: boolean }} Change
 */

/**
 * Единственный, кто решает, что играет. Интерфейс, клавиши и системная
 * панель только просят; полка, панель и трей только рисуют по 'change'.
 *
 * intent — чего хочет пользователь, а не что сейчас делает звук: при
 * смене трека плеер на миг стоит, и системная панель успевала мигнуть
 * паузой. Рисуем по намерению.
 *
 * «Поставленный» трек (cue) — выбран, но ещё не декодирован: так
 * работает «продолжить с места» и смена движка на лету. Первый же
 * запуск стартует с запомненной позиции.
 *
 * События: 'change' Change, 'seek', 'ended' (доиграл сам), 'error' {id, error},
 * 'exhausted' (очередь кончилась при выключенном повторе).
 */
export class PlaybackController extends Emitter {
    /** @type {string | null} */ current = null;
    /** @type {string | null} */ previous = null;
    /** @type {Intent} */ intent = 'stopped';
    /** @type {number | null} */ #cue = null;
    // откуда стартует трек, пока он декодируется: иначе полоса на это
    // время прыгала в ноль и обратно
    /** @type {number | null} */ #starting = null;
    #seekOnStart = false;    // перемотали, пока трек грузился — применить при старте
    #token = 0;
    #failures = 0;

    /**
     * @param {{ sources: import('./sources/LocalSource.js').LocalSource[],
     *           queue: import('./Queue.js').Queue,
     *           settings: import('../core/Settings.js').Settings }} deps
     */
    constructor({ sources, queue, settings }) {
        super();
        this.sources = sources;
        this.queue = queue;

        settings.watch(['order', 'repeat'], ({ order, repeat }) => {
            queue.setOrder(order, this.current);
            queue.setRepeat(repeat);
        });

        for (const source of sources) {
            const mine = handler => detail => { if (source === this.#source) handler(detail); };
            source.on('ended', mine(() => {
                this.emit('ended');
                this.#advance();
            }));
            // звонок или другой плеер забрал звук — встаём на паузу по-честному
            source.on('interrupted', mine(() => {
                if (this.intent !== 'playing') return;
                this.intent = 'paused';
                source.pause();
                this.#emitChange(false);
            }));
            source.on('playing', mine(() => {
                if (this.#seekOnStart && this.#starting !== null) source.seek(this.#starting);
                this.#seekOnStart = false;
                this.#starting = null;
            }));
            source.on('resumed', mine(() => {
                if (this.intent === 'paused') this.resume();
            }));
            // движок сменили в настройках — тот же трек, та же позиция
            source.on('engine', mine(({ position, playing }) => {
                if (!this.current) return;
                this.#cue = position;
                if (playing) this.play(this.current, { from: position });
            }));
        }
    }

    get track() { return this.current ? this.#sourceOf(this.current)?.track(this.current) ?? null : null; }
    get playing() { return this.intent === 'playing'; }

    position() { return this.#cue ?? this.#starting ?? this.#source?.position() ?? 0; }
    duration() { return this.#source?.duration() || this.track?.duration || 0; }
    speed() { return this.#source?.speed() ?? 0; }

    /**
     * Тап по конверту, кнопка ⏯, пробел.
     * По играющему — пауза, по стоящему — продолжить, по другому — запустить.
     * @param {string | null} [id]
     */
    toggle(id = this.current) {
        id ??= this.queue.next(null);
        if (!id) return;
        if (id !== this.current) { this.play(id); return; }
        if (this.intent === 'playing') this.pause();
        else this.resume();
    }

    /**
     * Всегда запускает трек — с начала или с from.
     * @param {string} id
     * @param {{ from?: number }} [options]
     */
    async play(id, { from = 0 } = {}) {
        const source = this.#sourceOf(id);
        if (!source) return;
        // синхронно, пока действует жест: Safari пускает звук только из него
        source.enable(true);

        const trackChanged = id !== this.current;
        if (trackChanged) {
            this.previous = this.current;
            this.current = id;
        }
        this.intent = 'playing';
        this.#cue = null;
        this.#starting = from;
        this.#seekOnStart = false;
        this.#emitChange(trackChanged);

        const token = ++this.#token;
        try {
            await source.play(id, { from });
        } catch (error) {
            if (token !== this.#token) return;
            this.#starting = null;
            this.emit('error', { id, error });
            // битый файл — к следующему, но не по кругу бесконечно
            if (++this.#failures < this.queue.items.length) {
                this.#advance();
            } else {
                this.#failures = 0;
                this.intent = 'paused';
                this.#emitChange(false);
            }
            return;
        }
        if (token !== this.#token) return;
        this.#failures = 0;

        // декодируем следующий, пока играет этот — переключение станет бесшовным
        const next = this.queue.peek(id);
        if (next && next !== id) this.#sourceOf(next)?.preload(next);
    }

    async pause() {
        if (this.intent !== 'playing') return;
        this.intent = 'paused';
        this.#emitChange(false);
        await this.#source?.pause();
    }

    async resume() {
        if (!this.current) { this.toggle(); return; }
        if (this.#cue !== null || !this.#source?.duration()) {
            this.play(this.current, { from: this.#cue ?? 0 });
            return;
        }
        this.#source.enable(true);
        this.intent = 'playing';
        this.#emitChange(false);
        await this.#source.resume();
    }

    next() {
        const id = this.queue.next(this.current);
        if (id) this.play(id);
    }

    prev() {
        if (this.position() > RESTART_AFTER) { this.seek(0); return; }
        const id = this.queue.prev(this.current);
        if (id) this.play(id);
        else this.seek(0);
    }

    /** @param {number} seconds */
    seek(seconds) {
        const duration = this.duration();
        const target = Math.max(0, duration ? Math.min(duration, seconds) : seconds);
        if (this.#cue !== null) {
            this.#cue = target;
        } else if (this.#starting !== null) {
            // трек ещё декодируется: движку перематывать нечего, запомним
            this.#starting = target;
            this.#seekOnStart = true;
        } else {
            this.#source?.seek(target);
        }
        this.emit('seek', { position: target });
    }

    /** @param {number} delta */
    seekBy(delta) {
        this.seek(this.position() + delta);
    }

    /** @param {number} amount */
    scrub(amount) {
        this.#source?.scrub(amount);
    }

    /**
     * Трек на вертушке, но не играет. Позиция — откуда начнётся запуск.
     * @param {string} id
     * @param {number} [position]
     */
    cue(id, position = 0) {
        if (!this.#sourceOf(id)) return;
        this.#token++;
        this.#source?.stop();
        this.#starting = null;
        const trackChanged = id !== this.current;
        this.previous = trackChanged ? this.current : this.previous;
        this.current = id;
        this.intent = 'paused';
        this.#cue = position;
        this.#emitChange(trackChanged);
    }

    stop() {
        this.#token++;
        this.#source?.stop();
        this.#starting = null;
        this.current = null;
        this.previous = null;
        this.intent = 'stopped';
        this.#cue = null;
        this.#emitChange(true);
    }

    /** Трек удалили с полки. @param {string} id */
    forget(id) {
        if (this.current === id) this.stop();
        if (this.previous === id) this.previous = null;
    }

    /** Видимые треки в порядке полки. @param {string[]} ids */
    setVisible(ids) {
        this.queue.setItems(ids);
    }

    get #source() {
        return this.current ? this.#sourceOf(this.current) : null;
    }

    /** @param {string} id */
    #sourceOf(id) {
        return this.sources.find(source => source.owns(id)) ?? null;
    }

    #advance() {
        const id = this.queue.next(this.current, { auto: true });
        if (id) { this.play(id); return; }
        // Очередь кончилась («без повтора»): последний трек остаётся на
        // вертушке с начала. Сюда же позже подключится «радио».
        this.emit('exhausted');
        if (this.current) this.cue(this.current, 0);
    }

    /** @param {boolean} trackChanged */
    #emitChange(trackChanged) {
        /** @type {Change} */
        const change = { current: this.current, previous: this.previous, intent: this.intent, trackChanged };
        this.emit('change', change);
    }
}
