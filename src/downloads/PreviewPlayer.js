import { Emitter } from '../core/Emitter.js';
import { makeSilentWav } from '../audio/silence.js';

/**
 * @typedef {import('./DownloadServer.js').RemoteTrack} RemoteTrack
 * @typedef {'loading' | 'playing' | 'paused' | 'stopped' | 'error'} PreviewState
 */

/**
 * Предпрослушивание: трек играет прямо с сервера и на полку не ложится.
 * Свой отдельный <audio> — плеер полки со всеми его эффектами не трогаем.
 *
 * iOS разрешает звук только в том же нажатии, а ссылку сервер готовит
 * секунды. Поэтому в самом нажатии элемент «отпирается» тишиной, а
 * настоящий звук подставляется, когда ссылка готова.
 *
 * События: 'state' {result, state, message?}.
 */
export class PreviewPlayer extends Emitter {
    /** @type {HTMLAudioElement} */
    #audio;
    /** @type {RemoteTrack | null} */
    #current = null;
    /** @type {PreviewState} */
    #state = 'stopped';
    /** @type {string | null} */
    #silence = null;

    /**
     * @param {{ server: import('./DownloadServer.js').DownloadServer,
     *           createAudio?: () => HTMLAudioElement }} deps
     */
    constructor({ server, createAudio = () => new Audio() }) {
        super();
        this.server = server;
        this.#audio = createAudio();
        this.#audio.preload = 'auto';
        // события «отпирающей» тишины не в счёт — только настоящего звука
        const real = () => Boolean(this.#current) && this.#audio.getAttribute('src') !== this.#silence;
        this.#audio.addEventListener('playing', () => { if (real()) this.#set('playing'); });
        this.#audio.addEventListener('pause', () => { if (real() && this.#state === 'playing') this.#set('paused'); });
        this.#audio.addEventListener('ended', () => { if (real()) this.stop(); });
        this.#audio.addEventListener('error', () => { if (real()) this.#fail('Не получилось проиграть трек'); });
    }

    get current() { return this.#current; }
    get state() { return this.#state; }

    /** @param {string} resultId */
    stateOf(resultId) {
        return this.#current?.id === resultId ? this.#state : 'stopped';
    }

    /**
     * Кнопка строки: не играет — включить, играет — остановить, на паузе — дальше.
     * @param {RemoteTrack} result
     */
    toggle(result) {
        const state = this.stateOf(result.id);
        if (state === 'stopped' || state === 'error') this.play(result);
        else if (state === 'paused') this.resume();
        else this.stop();
    }

    /** @param {RemoteTrack} result */
    async play(result) {
        this.stop();
        this.#current = result;
        this.#set('loading');
        this.#unlock();
        let url;
        try {
            url = await this.server.preview(result);
        } catch (error) {
            if (this.#current === result) this.#fail(/** @type {Error} */ (error).message);
            return;
        }
        if (this.#current !== result) return;       // пока ждали, нажали другое
        this.#audio.src = url;
        this.#audio.play().catch(error => {
            if (this.#current === result && error?.name !== 'AbortError') this.#fail('Браузер не дал включить звук');
        });
    }

    resume() {
        if (this.#state === 'paused') this.#audio.play().catch(() => {});
    }

    pause() {
        if (this.#state === 'playing') this.#audio.pause();
    }

    stop() {
        const result = this.#current;
        if (!result) return;
        this.#current = null;
        this.#audio.pause();
        this.#audio.removeAttribute('src');
        this.#audio.load();
        this.#state = 'stopped';
        this.emit('state', { result, state: 'stopped' });
    }

    /** Отпираем элемент в том же нажатии — иначе iOS не пустит звук потом. */
    #unlock() {
        this.#silence ??= URL.createObjectURL(new Blob([makeSilentWav(0.1)], { type: 'audio/wav' }));
        this.#audio.src = this.#silence;
        this.#audio.play().catch(() => {});
    }

    /** @param {string} message */
    #fail(message) {
        const result = this.#current;
        this.#current = null;
        this.#audio.pause();
        this.#state = 'error';
        this.emit('state', { result, state: 'error', message });
    }

    /** @param {PreviewState} state */
    #set(state) {
        if (state === this.#state) return;
        this.#state = state;
        this.emit('state', { result: this.#current, state });
    }
}
