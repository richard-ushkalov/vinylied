import { createVinylChain } from './vinyl-sound.js';

/**
 * Плеер на AudioBufferSourceNode.
 *
 * Почему не <audio>: у медиаэлемента playbackRate — обычное число, и менять
 * его приходится покадрово, отчего разгон звучит ступеньками. У BufferSource
 * это AudioParam, и движок ведёт его сэмплово-точно — получается настоящая
 * раскрутка диска. Заодно обходится баг WebKit, где createMediaElementSource
 * на blob:-адресе даёт тишину.
 *
 * Плата: источник одноразовый. Пауза — это запомнить позицию и остановить,
 * продолжение — создать новый источник и стартовать со смещения.
 */
export const createPlayer = () => {
    const SPIN_UP   = 0.45;   // секунд на раскрутку
    const SPIN_DOWN = 0.55;   // секунд на остановку
    const SLOW_RATE = 0.1;   // с какой скорости подхватывает
    const STOP_RATE = 0.06;   // экспоненциальная кривая не может дойти до нуля

    const bus = new EventTarget();

    let ctx = null;
    let chain = null;

    let buffer = null;        // декодированный текущий трек
    let source = null;        // живой источник, если играет
    let offset = 0;           // позиция в треке, секунд
    let startedAt = 0;        // ctx.currentTime на момент старта
    let paused = true;
    let stopping = false;     // идёт торможение
    // ДВА разных счётчика. Раньше был один, и playTrack проверял его же,
    // который менял spinDown, — проверка никогда не проходила и новый трек
    // не запускался. Один счётчик не может сторожить две разные вещи.
    let stopToken = 0;        // сторожит отложенную остановку внутри spinDown
    let playToken = 0;        // сторожит playTrack от более свежего запуска
    const buffers = new Map();// кеш декодированных треков (текущий + предзагруженный)

    const emit = type => bus.dispatchEvent(new Event(type));

    // Звук идёт не в динамики напрямую, а через <audio>.
    // Единственная причина: Safari и Firefox показывают Now Playing только
    // когда на странице есть медиаэлемент, который реально играет. Беззвучная
    // подпорка рядом их не убеждала — нужен настоящий источник.
    const speaker = new Audio();
    speaker.autoplay = true;
    // В документе, а не просто в памяти: системная панель привязывается
    // к элементу страницы, оторванный от дерева её может не получить.
    speaker.hidden = true;
    document.body.append(speaker);

    const ensure = async () => {
        if (!ctx) {
            ctx = new AudioContext();
            const out = ctx.createMediaStreamDestination();
            chain = createVinylChain(ctx, out);
            speaker.srcObject = out.stream;
        }
        if (ctx.state === 'suspended') await ctx.resume();
        // srcObject не автостартует так же надёжно, как src
        if (speaker.paused) await speaker.play().catch(() => {});
    };

    /** снимает текущий источник без всяких плавностей */
    const hardStop = () => {
        if (!source) return;
        source.onended = null;
        try { source.stop(); } catch {}
        source.disconnect();
        source = null;
    };

    /** запускает буфер с позиции offset, с раскруткой */
    const spinUp = () => {
        if (!buffer) return;
        hardStop();

        source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(chain.input);

        const now = ctx.currentTime;
        source.playbackRate.setValueAtTime(SLOW_RATE, now);
        source.playbackRate.exponentialRampToValueAtTime(1, now + SPIN_UP);

        source.onended = () => {
            if (stopping) return;   // это наше торможение, им занят spinDown
            // Узел кончился сам — снимаем его СРАЗУ. Иначе следующий playTrack
            // увидит живой source и честно отработает 550 мс торможения уже
            // мёртвого узла, а playbackRate.value у него навсегда застыл
            // на единице — диск крутился бы на полном ходу поверх тишины.
            hardStop();
            paused = true;
            emit('ended');
        };
        source.start(0, offset);

        startedAt = now;
        paused = false;
        stopping = false;
        stopToken++;             // отложенная остановка устарела
        chain.crackleOn();
        emit('playing');
    };

    /** тормозит диск до остановки. Возвращает промис, который ждёт конца */
    const spinDown = () => new Promise(done => {
        if (!source) { done(); return; }

        stopping = true;

        const now = ctx.currentTime;
        const rate = source.playbackRate;
        const from = rate.value;

        // Пока диск тормозит, игла всё ещё движется — но медленнее часов.
        // Пройденное за торможение = интеграл экспоненциальной кривой.
        // Без этой поправки позиция уезжала вперёд, и при возобновлении
        // полоса отскакивала назад.
        const travelled = from * SPIN_DOWN * ((STOP_RATE / from) - 1) / Math.log(STOP_RATE / from);
        offset = Math.min(buffer.duration, position() + travelled);

        rate.cancelScheduledValues(now);
        rate.setValueAtTime(from, now);
        rate.exponentialRampToValueAtTime(STOP_RATE, now + SPIN_DOWN);

        chain.crackleOff(SPIN_DOWN);
        source.stop(now + SPIN_DOWN);

        // Интерфейс замирает СРАЗУ: звук ещё выбегает, но позиция уже
        // зафиксирована, и полосе незачем ползти дальше по часам.
        paused = true;
        emit('pause');

        const mine = ++stopToken;
        setTimeout(() => {
            stopping = false;      // ВСЕГДА, иначе onended навсегда подавлён
            // за время выбега могли запустить заново — тогда источник уже
            // другой, и глушить его нельзя
            if (mine === stopToken) hardStop();
            done();
        }, SPIN_DOWN * 1000);
    });

    const position = () => {
        if (!source || paused) return offset;
        return Math.min(buffer.duration, offset + (ctx.currentTime - startedAt));
    };

    /**
     * Мгновенная скорость воспроизведения: 0 — диск стоит, 1 — номинал.
     *
     * Спрашиваем движок, а не считаем экспоненту заново в JS: рампу он уже
     * ведёт сэмплово-точно, а вторая копия той же кривой рано или поздно
     * разъедется со звуком — забыли сбросить при seek или при конце трека,
     * и диск крутится под молчащий динамик.
     *
     * Врёт параметр только про остановку: экспоненциальная рампа не умеет
     * дойти до нуля и замирает на STOP_RATE. Поэтому «стоим или нет» решаем
     * по своим флагам, а .value читаем только там, где он что-то значит.
     * Имя speed, а не rate: внутри spinDown уже есть локальная rate.
     */
    const speed = () => {
        if (!source) return 0;               // источника нет — крутить нечего
        if (paused && !stopping) return 0;   // пауза уже доехала
        return source.playbackRate.value;    // разгон, ровный ход, выбег
    };

    return {
        /** зовётся из жеста пользователя: будит AudioContext */
        enable: ensure,

        /** декодирует трек заранее, пока играет текущий */
        async preload(src) {
            if (!src || buffers.has(src)) return;
            await ensure();
            try {
                const response = await fetch(src);
                buffers.set(src, await ctx.decodeAudioData(await response.arrayBuffer()));
            } catch { /* не удалось — не беда, декодируем при запуске */ }
        },

        async playTrack(src) {
            await ensure();
            const mine = ++playToken;
            await spinDown();               // прежняя пластинка тормозит до конца
            if (mine !== playToken) return;    // пока тормозили, запустили другой трек

            emit('emptied');

            if (!buffers.has(src)) {
                const response = await fetch(src);
                buffers.set(src, await ctx.decodeAudioData(await response.arrayBuffer()));
            }
            if (mine !== playToken) return;

            buffer = buffers.get(src);

            // держим в памяти только текущий и один предзагруженный:
            // четырёхминутный стерео-трек занимает под 85 МБ
            for (const key of buffers.keys()) {
                if (buffers.size <= 2) break;
                if (key !== src) buffers.delete(key);
            }

            offset = 0;
            spinUp();
        },

        async pause()  { await spinDown(); },
        async resume() { await ensure(); if (paused && buffer) spinUp(); },

        async seek(seconds) {
            if (!buffer) return;
            offset = Math.max(0, Math.min(buffer.duration, seconds));
            chain?.bump();
            // источник пересоздаётся с нового места; раскрутка короткая,
            // чтобы перемотка не звучала как полноценный запуск пластинки
            if (!paused) { hardStop(); spinUp(); }
        },

        scrub: amount => chain?.scrub(amount),

        isPaused: () => paused,
        playbackRate: speed,   // картинке: диск крутится ровно так, как звучит
        currentTime: position,
        duration: () => buffer?.duration ?? 0,
        on: (type, handler) => bus.addEventListener(type, handler),
    };
};
