import { Emitter } from '../core/Emitter.js';
import { BufferEngine } from './engines/BufferEngine.js';
import { ElementEngine } from './engines/ElementEngine.js';

const EVENTS = ['playing', 'pause', 'ended', 'emptied', 'interrupted', 'resumed'];
const OPTION_KEYS = ['volume', 'muted', 'crackle', 'warmth', 'scrubMuffle', 'spin'];

/**
 * Фасад над движками. Остальное приложение не знает, каким способом
 * сейчас звучит трек: у обоих движков один интерфейс, события
 * пробрасываются как есть.
 *
 * Режим выбирается настройкой audioMode: «Авто» — ElementEngine на iOS
 * (фон и экран блокировки важнее эффектов), BufferEngine везде ещё.
 */
export class Player extends Emitter {
    /** @type {BufferEngine | ElementEngine} */
    #engine;
    /** @type {(() => void)[]} */
    #unbind = [];
    #mode = '';

    /**
     * @param {{ settings: import('../core/Settings.js').Settings,
     *           platform: import('../core/platform.js').Platform }} deps
     */
    constructor({ settings, platform }) {
        super();
        this.settings = settings;
        this.platform = platform;

        settings.watch(['audioMode'], ({ audioMode }) => this.#select(audioMode));
        settings.watch(OPTION_KEYS, options => this.#engine.setOptions(options));
    }

    /** Какой движок выбран: 'vinyl' | 'native'. */
    get mode() { return this.#mode; }
    get capabilities() { return this.#engine.capabilities; }

    /** @param {boolean} [willPlay] */
    enable(willPlay) {
        if (willPlay) this.#prepareSession();
        return this.#engine.enable(willPlay);
    }

    /** @param {string} src @param {{ from?: number }} [options] */
    play(src, options) { return this.#engine.play(src, options); }
    pause() { return this.#engine.pause(); }
    resume() { return this.#engine.resume(); }
    /** @param {number} seconds */
    seek(seconds) { this.#engine.seek(seconds); }
    stop() { this.#engine.stop(); }
    /** @param {string} src */
    preload(src) { return this.#engine.preload(src); }
    /** @param {number} amount */
    scrub(amount) { this.#engine.scrub(amount); }
    speed() { return this.#engine.speed(); }
    position() { return this.#engine.position(); }
    duration() { return this.#engine.duration(); }
    isPaused() { return this.#engine.isPaused(); }

    /** @param {string} setting */
    #resolve(setting) {
        if (setting === 'vinyl' || setting === 'native') return setting;
        return this.platform.ios ? 'native' : 'vinyl';
    }

    /** @param {string} setting */
    #select(setting) {
        const mode = this.#resolve(setting);
        if (mode === this.#mode) return;
        const previous = this.#engine;
        this.#mode = mode;

        this.#engine = mode === 'native'
            ? new ElementEngine({ volumeControl: !this.platform.ios })
            : new BufferEngine({ useCarrier: this.platform.chromium });
        this.#engine.setOptions(Object.fromEntries(OPTION_KEYS.map(key => [key, this.settings.get(key)])));

        this.#unbind.forEach(off => off());
        this.#unbind = EVENTS.map(type => this.#engine.on(type, detail => this.emit(type, detail)));

        if (previous) {
            const position = previous.position();
            const playing = !previous.isPaused();
            previous.dispose();
            // Контроллер перезапустит текущий трек на новом движке с той же позиции
            this.emit('engine', { position, playing });
        }
    }

    /**
     * Safari 17+: сессия «воспроизведение» — звук не глохнет от
     * переключателя «Бесшумно» и продолжается в фоне.
     */
    #prepareSession() {
        const session = /** @type {any} */ (navigator).audioSession;
        if (session && session.type !== 'playback') {
            try { session.type = 'playback'; } catch {}
        }
    }
}
