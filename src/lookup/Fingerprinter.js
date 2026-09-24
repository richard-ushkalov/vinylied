const SAMPLE_RATE = 11025;   // на этой частоте Chromaprint работает сам по себе
const MAX_SECONDS = 120;     // как у fpcalc: первых двух минут хватает

/**
 * Акустический отпечаток трека (Chromaprint в WebAssembly).
 *
 * Декодируем через OfflineAudioContext на 11025 Гц: decodeAudioData
 * сразу ресэмплирует под частоту контекста. Четырёхминутный стерео-трек
 * занимает так ~20 МБ вместо ~90 на частоте устройства — для телефона
 * это разница между «работает» и «вкладку убили».
 */
export class Fingerprinter {
    /** @type {Promise<any> | null} */
    #module = null;

    /**
     * @param {Blob} blob
     * @returns {Promise<{ fingerprint: string, duration: number }>}
     */
    async fingerprint(blob) {
        const decoder = new OfflineAudioContext(1, 1, SAMPLE_RATE);
        const audio = await decoder.decodeAudioData(await blob.arrayBuffer());
        const pcm = Fingerprinter.downmix(audio, MAX_SECONDS);
        const M = await this.#load();

        const ctx = M._chromaprint_new(1);          // алгоритм по умолчанию, как у fpcalc
        const data = M._malloc(pcm.length * 2);
        const out = M._malloc(4);
        try {
            M.HEAP16.set(pcm, data >> 1);
            const ok = M._chromaprint_start(ctx, audio.sampleRate, 1)
                && M._chromaprint_feed(ctx, data, pcm.length)
                && M._chromaprint_finish(ctx)
                && M._chromaprint_get_fingerprint(ctx, out);
            if (!ok) throw new Error('Chromaprint не смог посчитать отпечаток');
            const text = M.HEAP32[out >> 2];
            const fingerprint = M.UTF8ToString(text);
            M._free(text);
            return { fingerprint, duration: audio.duration };
        } finally {
            M._free(out);
            M._free(data);
            M._chromaprint_free(ctx);
        }
    }

    /**
     * Сводит каналы в моно 16 бит, не длиннее maxSeconds.
     * @param {{ numberOfChannels: number, length: number, sampleRate: number,
     *           getChannelData(channel: number): Float32Array }} audio
     * @param {number} maxSeconds
     */
    static downmix(audio, maxSeconds) {
        const frames = Math.min(audio.length, Math.floor(maxSeconds * audio.sampleRate));
        const channels = Array.from({ length: audio.numberOfChannels }, (_, c) => audio.getChannelData(c));
        const pcm = new Int16Array(frames);
        for (let i = 0; i < frames; i++) {
            let sum = 0;
            for (const channel of channels) sum += channel[i];
            const sample = Math.max(-1, Math.min(1, sum / channels.length));
            pcm[i] = Math.round(sample * 32767);
        }
        return pcm;
    }

    /** WASM грузится лениво: без ключа AcoustID он не нужен вовсе. */
    #load() {
        this.#module ??= import('../../vendor/chromaprint.js').then(({ default: create }) => create());
        return this.#module;
    }
}
