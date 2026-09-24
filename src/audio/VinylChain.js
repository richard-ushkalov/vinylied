/**
 * Виниловая окраска: узкая полоса частот, мягкое насыщение, потрескивание.
 * Источник подключается во вход, выход уже соединён с out.
 *
 * Сам источник здесь не создаётся: им владеет движок, потому что для
 * настоящей раскрутки нужен AudioBufferSourceNode, у которого playbackRate —
 * AudioParam и ведётся автоматикой движка, а не циклом в JS.
 *
 * Все «силы» эффектов (0..1) приходят из настроек. Единица — ровно то
 * звучание, что было до появления настроек.
 */
const OPEN_HZ = 11000;   // фильтр открыт — обычное звучание
const SHUT_HZ = 300;     // фильтр закрыт — глухо, как при прокрутке
const SCRUB_Q = 6;       // подъём на срезе: тот самый диджейский призвук
const CRACKLE = 0.08;    // уровень треска при силе 1
const RAMP = 0.12;       // секунд на перестройку фильтра

export class VinylChain {
    #ctx;
    #lowpass;
    #dry;
    #wet;
    #master;
    #crackle;
    #crackleLevel = 1;
    #scrubDepth = 1;
    #crackling = false;

    /**
     * @param {AudioContext} ctx
     * @param {AudioNode} out куда петь: динамики или MediaStreamDestination
     */
    constructor(ctx, out) {
        this.#ctx = ctx;

        const highpass = ctx.createBiquadFilter();
        highpass.type = 'highpass';
        highpass.frequency.value = 55;          // глубокого низа на пластинке нет

        this.#lowpass = ctx.createBiquadFilter();
        this.#lowpass.type = 'lowpass';
        this.#lowpass.frequency.value = OPEN_HZ; // и цифрового «воздуха» сверху тоже
        this.#lowpass.Q.value = 0.7;

        const shaper = ctx.createWaveShaper();
        const curve = new Float32Array(1024);
        for (let i = 0; i < curve.length; i++) {
            curve[i] = Math.tanh((i / 512 - 1) * 1.6);   // мягкое насыщение вместо стерильности
        }
        shaper.curve = curve;

        // «Тёплый звук» — смесь сухого и насыщенного сигнала
        this.#dry = ctx.createGain();
        this.#wet = ctx.createGain();
        this.#master = ctx.createGain();

        highpass.connect(this.#lowpass);
        this.#lowpass.connect(this.#dry).connect(this.#master);
        this.#lowpass.connect(shaper).connect(this.#wet).connect(this.#master);
        this.#master.connect(out);

        // потрескивание: редкие щелчки, синтезированные здесь же
        const buffer = ctx.createBuffer(1, ctx.sampleRate * 3, ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < data.length; i++) {
            data[i] = Math.random() < 0.0008 ? (Math.random() * 2 - 1) * 0.5 : 0;
        }
        const noise = ctx.createBufferSource();
        noise.buffer = buffer;
        noise.loop = true;
        this.#crackle = ctx.createGain();
        this.#crackle.gain.value = 0;
        noise.connect(this.#crackle).connect(this.#master);
        noise.start();

        this.input = highpass;
        this.setWarmth(1);
    }

    /** @param {number} value 0..1 */
    setVolume(value) {
        this.#ramp(this.#master.gain, value, 0.05);
    }

    /** @param {number} value 0..1, где 0 — насыщение выключено */
    setWarmth(value) {
        this.#dry.gain.value = 1 - value;
        this.#wet.gain.value = value;
    }

    /** @param {number} value 0..1 */
    setCrackleLevel(value) {
        this.#crackleLevel = value;
        if (this.#crackling) this.#ramp(this.#crackle.gain, CRACKLE * value, 0.2);
    }

    /** @param {number} value 0..1 — насколько глохнет звук при прокрутке */
    setScrubDepth(value) {
        this.#scrubDepth = value;
    }

    crackleOn(seconds = 0.6) {
        this.#crackling = true;
        this.#ramp(this.#crackle.gain, CRACKLE * this.#crackleLevel, seconds);
    }

    crackleOff(seconds = 0.4) {
        this.#crackling = false;
        this.#ramp(this.#crackle.gain, 0, seconds);
    }

    /**
     * Закрывает фильтр пропорционально amount (0..1).
     * Частота ведётся экспоненциально — на слух это воспринимается
     * линейно, потому что слух логарифмичен.
     * @param {number} amount
     */
    scrub(amount) {
        const value = Math.max(0, Math.min(1, amount)) * this.#scrubDepth;
        const now = this.#ctx.currentTime;
        const { frequency, Q } = this.#lowpass;

        frequency.cancelScheduledValues(now);
        frequency.setValueAtTime(frequency.value, now);
        frequency.exponentialRampToValueAtTime(OPEN_HZ * (SHUT_HZ / OPEN_HZ) ** value, now + RAMP);

        Q.cancelScheduledValues(now);
        Q.setValueAtTime(Q.value, now);
        Q.linearRampToValueAtTime(0.7 + (SCRUB_Q - 0.7) * value, now + RAMP);
    }

    /** Иглу переставили — короткий всплеск треска. */
    bump() {
        if (!this.#crackleLevel) return;
        const now = this.#ctx.currentTime;
        const { gain } = this.#crackle;
        gain.cancelScheduledValues(now);
        gain.setValueAtTime(0.35 * this.#crackleLevel, now);
        gain.linearRampToValueAtTime(CRACKLE * this.#crackleLevel, now + 0.3);
    }

    /**
     * @param {AudioParam} param
     * @param {number} to
     * @param {number} seconds
     */
    #ramp(param, to, seconds) {
        const now = this.#ctx.currentTime;
        param.cancelScheduledValues(now);
        param.setValueAtTime(param.value, now);
        param.linearRampToValueAtTime(to, now + seconds);
    }
}
