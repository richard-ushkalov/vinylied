import { Emitter } from '../../core/Emitter.js';

const SPIN_UP = 0.45;
const SPIN_DOWN = 0.55;
const SLOW_RATE = 0.1;    // ниже 0.0625 Chrome бросает NotSupportedError
const STEP_MS = 16;
const INSTANT = 0.01;

/**
 * Движок «Надёжный»: трек играет обычным <audio src=blob:> — без Web Audio
 * на пути звука.
 *
 * Зачем он нужен: на iOS Web Audio глохнет, как только гаснет экран или
 * приложение уходит в фон, и подчиняется переключателю «Бесшумно». Звук
 * медиаэлемента iOS ведёт как музыку: играет на заблокированном экране,
 * управляется из Пункта управления. Этот же элемент — сам себе «якорь»
 * для системной сессии.
 *
 * Плата — эффекты. Разгон и торможение остаются: playbackRate шагами при
 * выключенном preservesPitch, тон «плывёт», как у пластинки (ступеньки
 * слышнее, чем у AudioParam, но это честный компромисс). Приглушения при
 * прокрутке и треска нет. Громкость на iOS задаётся только кнопками.
 */
export class ElementEngine extends Emitter {
    /** @type {HTMLAudioElement} */
    #el;
    /** @type {string | null} */
    #src = null;
    #paused = true;
    #ramping = false;
    #wanted = false;       // желаемое состояние элемента — отличает свои паузы от чужих
    #token = 0;            // сторожит play() от более свежего запуска
    #rampTimer = 0;
    #spinUp = SPIN_UP;
    #spinDown = SPIN_DOWN;

    /** @param {{ volumeControl: boolean }} options */
    constructor({ volumeControl }) {
        super();
        this.capabilities = { effects: false, volume: volumeControl };

        const el = new Audio();
        el.preload = 'auto';
        // тон должен плыть вместе со скоростью — иначе это не пластинка
        el.preservesPitch = false;
        /** @type {any} */ (el).webkitPreservesPitch = false;
        el.hidden = true;
        document.body.append(el);
        this.#el = el;

        el.addEventListener('ended', () => {
            this.#wanted = false;
            this.#paused = true;
            this.emit('ended');
        });
        el.addEventListener('pause', () => {
            // своя пауза или естественный конец трека — не прерывание
            if (!this.#wanted || el.ended) return;
            this.#wanted = false;
            this.#paused = true;
            this.emit('pause');
            this.emit('interrupted');
        });
        el.addEventListener('play', () => {
            if (this.#wanted) return;
            this.#wanted = true;
            this.#paused = false;
            this.emit('playing');
            this.emit('resumed');
        });
    }

    /** @param {boolean} [_willPlay] */
    enable(_willPlay = false) {
        return Promise.resolve();
    }

    /**
     * @param {string} src
     * @param {{ from?: number }} [options]
     */
    async play(src, { from = 0 } = {}) {
        const mine = ++this.#token;
        if (!this.#paused) await this.#spinDownAndStop();
        if (mine !== this.#token) return;

        this.emit('emptied');
        const el = this.#el;
        this.#src = src;
        // Позицию задаём фрагментом адреса: так play() вызывается сразу,
        // без ожидания метаданных. На iOS это важно — первый запуск должен
        // случиться в том же жесте пользователя, иначе Safari его запретит.
        el.src = from > 0 ? `${src}#t=${from.toFixed(2)}` : src;
        el.addEventListener('loadedmetadata', () => {
            if (Math.abs(el.currentTime - from) > 1) el.currentTime = from;
        }, { once: true });

        await this.#start();
    }

    async pause() {
        if (this.#paused) return;
        await this.#spinDownAndStop();
    }

    async resume() {
        if (!this.#src || !this.#paused) return;
        await this.#start();
    }

    /** @param {number} seconds */
    seek(seconds) {
        if (!this.#src) return;
        const duration = this.duration();
        this.#el.currentTime = Math.max(0, duration ? Math.min(duration, seconds) : seconds);
    }

    stop() {
        this.#token++;
        this.#cancelRamp();
        this.#wanted = false;
        this.#paused = true;
        this.#el.pause();
        this.#el.removeAttribute('src');
        this.#el.load();
        this.#src = null;
        this.emit('pause');
        this.emit('emptied');
    }

    preload(_src) {}
    scrub(_amount) {}

    speed() {
        if (this.#paused && !this.#ramping) return 0;
        return this.#el.playbackRate;
    }

    position() { return this.#el.currentTime || 0; }

    duration() {
        const { duration } = this.#el;
        return Number.isFinite(duration) ? duration : 0;
    }

    isPaused() { return this.#paused; }

    /** @param {Partial<import('./BufferEngine.js').EngineOptions>} options */
    setOptions({ volume, muted, spin }) {
        if (volume !== undefined) this.#el.volume = volume;
        if (muted !== undefined) this.#el.muted = muted;
        if (spin !== undefined) {
            this.#spinUp = SPIN_UP * spin;
            this.#spinDown = SPIN_DOWN * spin;
        }
    }

    dispose() {
        this.stop();
        this.#el.remove();
    }

    async #start() {
        const el = this.#el;
        const spin = this.#spinUp >= INSTANT && document.visibilityState === 'visible';
        el.playbackRate = spin ? SLOW_RATE : 1;
        this.#wanted = true;
        try {
            await el.play();
        } catch (error) {
            this.#wanted = false;
            this.#paused = true;
            throw error;
        }
        this.#paused = false;
        this.emit('playing');
        if (spin) this.#ramp(SLOW_RATE, 1, this.#spinUp);
    }

    #spinDownAndStop() {
        return new Promise(done => {
            this.#paused = true;
            this.emit('pause');
            const finish = () => {
                this.#wanted = false;
                this.#el.pause();
                done();
            };
            // в фоне кадров нет, а ступеньки никто не увидит — встаём сразу
            if (this.#spinDown < INSTANT || document.visibilityState !== 'visible') {
                this.#cancelRamp();
                finish();
                return;
            }
            this.#ramp(this.#el.playbackRate, SLOW_RATE, this.#spinDown, finish);
        });
    }

    /**
     * Экспоненциальная рампа playbackRate шагами по 16 мс.
     * @param {number} from
     * @param {number} to
     * @param {number} seconds
     * @param {() => void} [then]
     */
    #ramp(from, to, seconds, then) {
        this.#cancelRamp();
        this.#ramping = true;
        const started = performance.now();
        const step = () => {
            const t = Math.min(1, (performance.now() - started) / (seconds * 1000));
            this.#el.playbackRate = from * (to / from) ** t;
            if (t < 1) return;
            this.#cancelRamp();
            then?.();
        };
        this.#rampTimer = window.setInterval(step, STEP_MS);
        step();
    }

    #cancelRamp() {
        clearInterval(this.#rampTimer);
        this.#rampTimer = 0;
        this.#ramping = false;
    }
}
