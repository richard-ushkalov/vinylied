const SEEK_STEP = 10;

/**
 * Системная панель: уведомление Android, Now Playing на Маке, экран
 * блокировки и Пункт управления iPhone, медиаклавиши.
 *
 * Только отражает контроллер и передаёт ему команды — своего
 * состояния не держит.
 */
export class MediaSessionBridge {
    /** @param {{ controller: import('./PlaybackController.js').PlaybackController }} deps */
    constructor({ controller }) {
        this.controller = controller;
        this.session = 'mediaSession' in navigator ? navigator.mediaSession : null;
    }

    attach() {
        const { session, controller } = this;
        if (!session) return;

        // Регистрируем ОДИН раз: кнопки системы зовут те же действия, что и интерфейс
        const handlers = {
            play: () => controller.resume(),
            pause: () => controller.pause(),
            // «стоп» из шторки Android — это пауза: полку при этом не сбрасываем
            stop: () => controller.pause(),
            nexttrack: () => controller.next(),
            previoustrack: () => controller.prev(),
            seekto: details => controller.seek(details.seekTime ?? 0),
            seekbackward: details => controller.seekBy(-(details.seekOffset || SEEK_STEP)),
            seekforward: details => controller.seekBy(details.seekOffset || SEEK_STEP),
        };
        for (const [action, handler] of Object.entries(handlers)) {
            try {
                session.setActionHandler(/** @type {MediaSessionAction} */ (action), handler);
            } catch { /* действие не поддерживается этим браузером */ }
        }

        controller.on('change', ({ trackChanged, intent }) => {
            if (trackChanged) this.#metadata();
            // НЕ по состоянию плеера: при смене трека он на миг стоит,
            // и системная панель успевала мигнуть паузой
            session.playbackState = !controller.current ? 'none' : intent === 'playing' ? 'playing' : 'paused';
            this.#position();
        });
        controller.on('seek', () => this.#position());
        for (const source of controller.sources) {
            source.on('playing', () => this.#position());
            source.on('pause', () => this.#position());
        }
    }

    /** Трек обновили (нашлась обложка, поправились подписи). */
    refresh() {
        this.#metadata();
    }

    async #metadata() {
        const { session, controller } = this;
        const track = controller.track;
        if (!track) { session.metadata = null; return; }

        // Метаданные ставим сразу, до запуска звука — иначе панель мигает.
        // Своя обложка есть синхронно; запасную растеризуем и досылаем.
        const set = artwork => {
            if (controller.track !== track) return;
            session.metadata = new MediaMetadata({ title: track.title, artist: track.artist, album: track.album, artwork });
        };
        if (track.hasCover) {
            set([{ src: track.cover, type: track.coverBlob?.type || 'image/jpeg' }]);
            return;
        }
        set([]);
        const art = await track.artwork().catch(() => null);
        if (art) set([{ src: art.src, type: art.type, sizes: '512x512' }]);
    }

    #position() {
        const { session, controller } = this;
        if (!session.setPositionState) return;
        const duration = controller.duration();
        if (!controller.current || !duration) return;
        try {
            session.setPositionState({
                duration,
                playbackRate: 1,
                position: Math.min(duration, Math.max(0, controller.position())),
            });
        } catch { /* позиция на миг вышла за длительность при смене трека */ }
    }
}
