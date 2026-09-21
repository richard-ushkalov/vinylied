/**
 * Виниловая окраска: узкая полоса частот, мягкое насыщение, потрескивание.
 * Возвращает группу узлов — источник подключается во вход, выход уже
 * соединён с колонками.
 *
 * Сам источник здесь не создаётся: им владеет плеер, потому что для
 * настоящей раскрутки нужен AudioBufferSourceNode, у которого playbackRate
 * это AudioParam и ведётся автоматикой движка, а не циклом в JS.
 */
const OPEN_HZ  = 11000;   // фильтр открыт — обычное звучание
const SHUT_HZ  = 420;     // фильтр закрыт — глухо, как при прокрутке
const SCRUB_Q  = 6;       // подъём на срезе: тот самый диджейский призвук

export const createVinylChain = ctx => {
    const highpass = ctx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = 55;          // глубокого низа на пластинке нет

    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = OPEN_HZ;      // и цифрового «воздуха» сверху тоже
    lowpass.Q.value = 0.7;

    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
        const x = i / 512 - 1;
        curve[i] = Math.tanh(x * 1.6);      // мягкое насыщение вместо стерильности
    }
    shaper.curve = curve;

    highpass.connect(lowpass).connect(shaper).connect(ctx.destination);

    // потрескивание: редкие щелчки, синтезированные здесь же
    const buffer = ctx.createBuffer(1, ctx.sampleRate * 3, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
        data[i] = Math.random() < 0.0008 ? (Math.random() * 2 - 1) * 0.5 : 0;
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    noise.loop = true;

    const crackle = ctx.createGain();
    crackle.gain.value = 0;
    noise.connect(crackle).connect(ctx.destination);
    noise.start();

    const ramp = (to, seconds) => {
        const now = ctx.currentTime;
        crackle.gain.cancelScheduledValues(now);
        crackle.gain.setValueAtTime(crackle.gain.value, now);
        crackle.gain.linearRampToValueAtTime(to, now + seconds);
    };

    return {
        input: highpass,
        crackleOn:  (seconds = 0.6) => ramp(0.08, seconds),
        crackleOff: (seconds = 0.4) => ramp(0, seconds),
        /**
         * Закрывает фильтр пропорционально amount (0..1).
         * Частота ведётся экспоненциально — на слух это воспринимается
         * линейно, потому что слух логарифмичен.
         */
        scrub(amount) {
            const value = Math.max(0, Math.min(1, amount));
            const now = ctx.currentTime;
            const target = OPEN_HZ * (SHUT_HZ / OPEN_HZ) ** value;

            lowpass.frequency.cancelScheduledValues(now);
            lowpass.frequency.setValueAtTime(lowpass.frequency.value, now);
            lowpass.frequency.exponentialRampToValueAtTime(target, now + 0.12);

            lowpass.Q.cancelScheduledValues(now);
            lowpass.Q.setValueAtTime(lowpass.Q.value, now);
            lowpass.Q.linearRampToValueAtTime(0.7 + (SCRUB_Q - 0.7) * value, now + 0.12);
        },

        bump() {                              // иголку переставили
            const now = ctx.currentTime;
            crackle.gain.cancelScheduledValues(now);
            crackle.gain.setValueAtTime(0.35, now);
            crackle.gain.linearRampToValueAtTime(0.08, now + 0.3);
        },
    };
};
