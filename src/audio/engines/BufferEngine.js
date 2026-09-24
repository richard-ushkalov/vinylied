import { Emitter } from '../../core/Emitter.js';
import { VinylChain } from '../VinylChain.js';
import { CarrierRoute } from '../routes/CarrierRoute.js';
import { StreamRoute } from '../routes/StreamRoute.js';

const SPIN_UP = 0.45;     // секунд на раскрутку при силе 1
const SPIN_DOWN = 0.55;   // секунд на остановку при силе 1
const SLOW_RATE = 0.1;    // с какой скорости подхватывает
const STOP_RATE = 0.06;   // экспоненциальная кривая не может дойти до нуля
const INSTANT = 0.01;     // короче — считаем, что разгона нет

/**
 * Сколько трека проходит игла за t секунд экспоненциальной рампы
 * скорости from → to длиной span. Интеграл from·(to/from)^(τ/span) dτ.
 */
const travel = (from, to, span, t) => {
    if (span < INSTANT || Math.abs(to - from) < 1e-6) return from * t;
    const k = Math.log(to / from);
    return from * span / k * (Math.exp(k * t / span) - 1);
};

/**
 * @typedef {{ volume: number, muted: boolean, crackle: number, warmth: number,
 *             scrubMuffle: number, spin: number }} EngineOptions
 */

/**
 * Движок «Винил»: трек целиком декодируется в AudioBuffer и играет
 * через AudioBufferSourceNode.
 *
 * Почему не <audio>: у медиаэлемента playbackRate — обычное число, и менять
 * его приходится покадрово, отчего разгон звучит ступеньками. У BufferSource
 * это AudioParam, и движок ведёт его сэмплово-точно — получается настоящая
 * раскрутка диска. Заодно обходится баг WebKit, где createMediaElementSource
 * на blob:-адресе даёт тишину.
 *
 * Плата: источник одноразовый. Пауза — это запомнить позицию и остановить,
 * продолжение — создать новый источник и стартовать со смещения.
 * И на iOS Web Audio глохнет при блокировке экрана — для iPhone по
 * умолчанию берётся ElementEngine.
 */
export class BufferEngine extends Emitter {
    capabilities = { effects: true, volume: true };

    /** @type {AudioContext | null} */
    #ctx = null;
    /** @type {VinylChain | null} */
    #chain = null;
    /** @type {CarrierRoute | StreamRoute | null} */
    #route = null;
    #useCarrier;

    /** @type {AudioBuffer | null} */
    #buffer = null;          // декодированный текущий трек
    /** @type {AudioBufferSourceNode | null} */
    #source = null;          // живой источник, если играет
    #offset = 0;             // позиция в треке на момент старта, секунд
    #startedAt = 0;          // ctx.currentTime на момент старта
    #spinUp = SPIN_UP;
    #spinDown = SPIN_DOWN;
    #currentSpinUp = SPIN_UP;  // длина разгона у живого источника
    #paused = true;
    #stopping = false;       // идёт торможение
    // ДВА разных счётчика. Когда был один, playTrack проверял тот же,
    // который менял spinDown, — проверка никогда не проходила и новый трек
    // не запускался. Один счётчик не может сторожить две разные вещи.
    #stopToken = 0;          // сторожит отложенную остановку внутри spinDown
    #playToken = 0;          // сторожит play() от более свежего запуска
    /** @type {Map<string, AudioBuffer>} */
    #buffers = new Map();    // текущий + предзагруженный
    /** @type {EngineOptions} */
    #options = { volume: 1, muted: false, crackle: 1, warmth: 1, scrubMuffle: 1, spin: 1 };

    /** @param {{ useCarrier: boolean }} options */
    constructor({ useCarrier }) {
        super();
        this.#useCarrier = useCarrier;
    }

    /**
     * Будит AudioContext — зовётся синхронно из жеста пользователя.
     * willPlay: жест ведёт к воспроизведению — сразу запускаем «якорь»,
     * пока жест ещё действует (Safari пускает звук только из него).
     * @param {boolean} [willPlay]
     */
    enable(willPlay = false) {
        if (!this.#ctx) this.#create();
        if (willPlay) this.#route.play();
        return this.#ctx.state === 'suspended' ? this.#ctx.resume() : Promise.resolve();
    }

    /**
     * Запускает src с позиции from. Прежняя пластинка сначала тормозит.
     * @param {string} src
     * @param {{ from?: number }} [options]
     */
    async play(src, { from = 0 } = {}) {
        await this.enable(true);
        const mine = ++this.#playToken;
        await this.#spinDownAndWait();             // прежняя пластинка тормозит до конца
        if (mine !== this.#playToken) return;     // пока тормозили, запустили другой трек

        this.emit('emptied');

        let buffer;
        try {
            buffer = await this.#decode(src);
        } catch (error) {
            if (mine === this.#playToken) {
                this.#buffer = null;
                this.#route.pause();
            }
            throw error;
        }
        if (mine !== this.#playToken) return;

        this.#buffer = buffer;
        // держим в памяти только текущий и один предзагруженный:
        // четырёхминутный стерео-трек занимает под 85 МБ
        for (const key of this.#buffers.keys()) {
            if (this.#buffers.size <= 2) break;
            if (key !== src) this.#buffers.delete(key);
        }

        this.#offset = Math.max(0, Math.min(buffer.duration, from));
        await this.#route.play();
        this.#startSource();
    }

    async pause() {
        if (this.#paused) return;
        await this.#spinDownAndWait();
        // «якорь» останавливаем, когда выбег доиграл: тормозящий звук
        // в Safari идёт через него же
        if (this.#paused) this.#route?.pause();
    }

    async resume() {
        if (!this.#buffer || !this.#paused) return;
        await this.enable(true);
        await this.#route.play();
        this.#startSource();
    }

    /** @param {number} seconds */
    seek(seconds) {
        if (!this.#buffer) return;
        this.#offset = Math.max(0, Math.min(this.#buffer.duration, seconds));
        this.#chain?.bump();
        // источник пересоздаётся с нового места
        if (!this.#paused) { this.#hardStop(); this.#startSource({ short: true }); }
    }

    /** Отпускает трек целиком: удалили с полки или очистили её. */
    stop() {
        this.#playToken++;
        this.#stopToken++;
        this.#hardStop();
        this.#buffer = null;
        this.#offset = 0;
        this.#paused = true;
        this.#stopping = false;
        this.#route?.pause();
        this.emit('pause');
        this.emit('emptied');
    }

    /** Декодирует трек заранее, пока играет текущий. @param {string} src */
    async preload(src) {
        if (!src || this.#buffers.has(src) || !this.#ctx) return;
        try { await this.#decode(src); } catch { /* не беда — декодируем при запуске */ }
    }

    /** @param {number} amount 0..1 */
    scrub(amount) { this.#chain?.scrub(amount); }

    /**
     * Мгновенная скорость воспроизведения: 0 — диск стоит, 1 — номинал.
     *
     * Спрашиваем движок, а не считаем экспоненту заново в JS: рампу он уже
     * ведёт сэмплово-точно, а вторая копия той же кривой рано или поздно
     * разъедется со звуком.
     *
     * Врёт параметр только про остановку: экспоненциальная рампа не умеет
     * дойти до нуля и замирает на STOP_RATE. Поэтому «стоим или нет» решаем
     * по своим флагам, а .value читаем только там, где он что-то значит.
     */
    speed() {
        if (!this.#source) return 0;
        if (this.#paused && !this.#stopping) return 0;
        return this.#source.playbackRate.value;
    }

    position() {
        if (!this.#source || this.#paused || !this.#buffer) return this.#offset;
        // Во время разгона игла идёт медленнее часов — учитываем это,
        // иначе полоса убегала бы вперёд на четверть секунды.
        const elapsed = this.#ctx.currentTime - this.#startedAt;
        const span = this.#currentSpinUp;
        const moved = elapsed < span
            ? travel(SLOW_RATE, 1, span, elapsed)
            : travel(SLOW_RATE, 1, span, span) + (elapsed - span);
        return Math.min(this.#buffer.duration, this.#offset + moved);
    }

    duration() { return this.#buffer?.duration ?? 0; }
    isPaused() { return this.#paused; }

    /** @param {Partial<EngineOptions>} options */
    setOptions(options) {
        Object.assign(this.#options, options);
        this.#spinUp = SPIN_UP * this.#options.spin;
        this.#spinDown = SPIN_DOWN * this.#options.spin;
        if (!this.#chain) return;
        this.#chain.setVolume(this.#options.muted ? 0 : this.#options.volume);
        this.#chain.setCrackleLevel(this.#options.crackle);
        this.#chain.setWarmth(this.#options.warmth);
        this.#chain.setScrubDepth(this.#options.scrubMuffle);
    }

    dispose() {
        this.stop();
        this.#route?.dispose();
        this.#ctx?.close();
        this.#ctx = null;
    }

    #create() {
        this.#ctx = new AudioContext();
        this.#route = this.#useCarrier ? new CarrierRoute(this.#ctx) : new StreamRoute(this.#ctx);
        this.#chain = new VinylChain(this.#ctx, this.#route.destination);
        this.#route.on('interrupted', () => this.emit('interrupted'));
        this.#route.on('resumed', () => this.emit('resumed'));
        this.setOptions({});
    }

    /** @param {string} src */
    async #decode(src) {
        const cached = this.#buffers.get(src);
        if (cached) return cached;
        const response = await fetch(src);
        const buffer = await this.#ctx.decodeAudioData(await response.arrayBuffer());
        this.#buffers.set(src, buffer);
        return buffer;
    }

    /** снимает текущий источник без всяких плавностей */
    #hardStop() {
        if (!this.#source) return;
        this.#source.onended = null;
        try { this.#source.stop(); } catch {}
        this.#source.disconnect();
        this.#source = null;
    }

    /** запускает буфер с позиции offset, с раскруткой */
    #startSource({ short = false } = {}) {
        if (!this.#buffer) return;
        this.#hardStop();

        const source = this.#ctx.createBufferSource();
        source.buffer = this.#buffer;
        source.connect(this.#chain.input);

        // перемотка раскручивается коротко, чтобы не звучать как запуск пластинки
        const span = short ? this.#spinUp / 3 : this.#spinUp;
        const now = this.#ctx.currentTime;
        if (span < INSTANT) {
            source.playbackRate.setValueAtTime(1, now);
        } else {
            source.playbackRate.setValueAtTime(SLOW_RATE, now);
            source.playbackRate.exponentialRampToValueAtTime(1, now + span);
        }
        this.#currentSpinUp = span;

        source.onended = () => {
            if (this.#stopping) return;   // это наше торможение, им занят spinDown
            // Узел кончился сам — снимаем его СРАЗУ. Иначе следующий play()
            // увидит живой source и честно отработает торможение уже
            // мёртвого узла, а диск крутился бы на полном ходу поверх тишины.
            this.#hardStop();
            this.#offset = this.#buffer?.duration ?? 0;
            this.#paused = true;
            this.emit('ended');
        };
        source.start(0, this.#offset);
        this.#source = source;

        this.#startedAt = now;
        this.#paused = false;
        this.#stopping = false;
        this.#stopToken++;             // отложенная остановка устарела
        this.#chain.crackleOn();
        this.emit('playing');
    }

    /** тормозит диск до остановки и ждёт конца выбега */
    #spinDownAndWait() {
        return new Promise(done => {
            if (!this.#source || this.#paused) { done(); return; }

            this.#stopping = true;
            const now = this.#ctx.currentTime;
            const rate = this.#source.playbackRate;
            const from = Math.max(rate.value, STOP_RATE);
            const span = this.#spinDown;

            // Пока диск тормозит, игла всё ещё движется — но медленнее часов.
            // Без этой поправки позиция уезжала вперёд, и при возобновлении
            // полоса отскакивала назад.
            this.#offset = Math.min(this.#buffer.duration, this.position() + travel(from, STOP_RATE, span, span));

            // Интерфейс замирает СРАЗУ: звук ещё выбегает, но позиция уже
            // зафиксирована, и полосе незачем ползти дальше по часам.
            this.#paused = true;
            this.emit('pause');

            if (span < INSTANT) {
                this.#stopping = false;
                this.#hardStop();
                this.#chain.crackleOff(0.05);
                done();
                return;
            }

            rate.cancelScheduledValues(now);
            rate.setValueAtTime(from, now);
            rate.exponentialRampToValueAtTime(STOP_RATE, now + span);
            this.#chain.crackleOff(span);
            this.#source.stop(now + span);

            const mine = ++this.#stopToken;
            setTimeout(() => {
                // за время выбега могли запустить заново — тогда источник уже
                // другой, и глушить его нельзя
                if (mine === this.#stopToken) {
                    this.#stopping = false;   // иначе onended навсегда подавлен
                    this.#hardStop();
                }
                done();
            }, span * 1000);
        });
    }
}
