import { Anchor } from './Anchor.js';
import { makeSilentWav } from '../silence.js';

/**
 * Маршрут для Chromium (Chrome, Edge, Samsung Internet; Android и десктоп).
 *
 * Звук идёт прямо в динамики, а сессию держит «несущий» <audio> с
 * зацикленной тишиной. Почему не <audio srcObject={MediaStream}>, как в
 * Safari: Chrome помечает такой плеер как kOneShot (WebMediaPlayerMS),
 * а сессия из одних таких неуправляемая — ни уведомления на Android,
 * ни кнопок в Now Playing на Маке.
 *
 * Несущему нужно две вещи: не быть muted и длиться дольше 5 секунд —
 * короче Chrome считает звук «разовым» и полный аудиофокус не берёт.
 */
export class CarrierRoute {
    /** @param {AudioContext} ctx */
    constructor(ctx) {
        const wav = new Blob([makeSilentWav(10)], { type: 'audio/wav' });
        const element = new Audio(URL.createObjectURL(wav));
        element.loop = true;
        element.preload = 'auto';
        this.anchor = new Anchor(element);
        this.destination = ctx.destination;
    }

    play() { return this.anchor.play(); }
    pause() { this.anchor.pause(); }
    /** @param {string} type @param {(detail: any) => void} handler */
    on(type, handler) { return this.anchor.on(type, handler); }
    dispose() { this.anchor.dispose(); }
}
