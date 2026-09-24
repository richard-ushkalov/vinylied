/**
 * Источник «своя полка»: треки из библиотеки, звук — через Player.
 *
 * Контроллер воспроизведения разговаривает с источниками, а не с плеером
 * напрямую. Сейчас источник один; «радио» похожих треков из внешнего
 * сервиса станет вторым — со своим проигрывателем, но тем же интерфейсом.
 */
export class LocalSource {
    /**
     * @param {{ player: import('../../audio/Player.js').Player,
     *           tracks: Map<string, import('../../library/Track.js').Track> }} deps
     */
    constructor({ player, tracks }) {
        this.player = player;
        this.tracks = tracks;
    }

    /** @param {string} id */
    owns(id) { return this.tracks.has(id); }
    /** @param {string} id */
    track(id) { return this.tracks.get(id) ?? null; }

    /** @param {boolean} [willPlay] */
    enable(willPlay) { return this.player.enable(willPlay); }

    /** @param {string} id @param {{ from?: number }} [options] */
    play(id, options) {
        const track = this.tracks.get(id);
        if (!track) return Promise.reject(new Error(`Нет трека ${id}`));
        return this.player.play(track.src, options);
    }

    /** @param {string} id */
    preload(id) {
        const track = this.tracks.get(id);
        if (track) this.player.preload(track.src);
    }

    pause() { return this.player.pause(); }
    resume() { return this.player.resume(); }
    /** @param {number} seconds */
    seek(seconds) { this.player.seek(seconds); }
    stop() { this.player.stop(); }
    /** @param {number} amount */
    scrub(amount) { this.player.scrub(amount); }
    speed() { return this.player.speed(); }
    position() { return this.player.position(); }
    duration() { return this.player.duration(); }
    isPaused() { return this.player.isPaused(); }
    /** @param {string} type @param {(detail: any) => void} handler */
    on(type, handler) { return this.player.on(type, handler); }
}
