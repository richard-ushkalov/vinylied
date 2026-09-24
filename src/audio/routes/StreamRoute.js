import { Anchor } from './Anchor.js';

/**
 * Маршрут для Safari и Firefox.
 *
 * Звук идёт не в динамики напрямую, а через <audio>: Safari и Firefox
 * показывают Now Playing только когда на странице есть медиаэлемент,
 * который реально играет. Беззвучная подпорка рядом их не убеждала —
 * нужен настоящий источник.
 */
export class StreamRoute {
    /** @param {AudioContext} ctx */
    constructor(ctx) {
        const out = ctx.createMediaStreamDestination();
        const element = new Audio();
        element.srcObject = out.stream;
        this.anchor = new Anchor(element);
        this.destination = out;
    }

    play() { return this.anchor.play(); }
    pause() { this.anchor.pause(); }
    /** @param {string} type @param {(detail: any) => void} handler */
    on(type, handler) { return this.anchor.on(type, handler); }
    dispose() { this.anchor.dispose(); }
}
