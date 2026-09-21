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
    let generation = 0;       // счётчик команд: отложенное действие проверяет, актуально ли оно
    const buffers = new Map();// кеш декодированных треков (текущий + предзагруженный)

    const emit = type => bus.dispatchEvent(new Event(type));

    const ensure = async () => {
        if (!ctx) {
            ctx = new AudioContext();
            chain = createVinylChain(ctx);
        }
        if (ctx.state === 'suspended') await ctx.resume();
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

        source.onended = () => { if (!stopping) { paused = true; emit('ended'); } };
        source.start(0, offset);

        startedAt = now;
        paused = false;
        stopping = false;
        generation++;            // всё, что было запланировано раньше, устарело
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

        const mine = ++generation;
        setTimeout(() => {
            stopping = false;      // ВСЕГДА, иначе onended навсегда подавлён
                                   // и автопереход на следующий трек умирает
            // За время выбега могли нажать «играть» — тогда источник уже
            // другой, и глушить его нельзя.
            if (mine !== generation) { done(); return; }
            hardStop();
            done();
        }, SPIN_DOWN * 1000);
    });

    const position = () => {
        if (!source || paused) return offset;
        return Math.min(buffer.duration, offset + (ctx.currentTime - startedAt));
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
            const mine = ++generation;
            await spinDown();               // прежняя пластинка тормозит до конца
            if (mine !== generation) return;   // пока тормозили, нажали другое

            emit('emptied');

            if (!buffers.has(src)) {
                const response = await fetch(src);
                buffers.set(src, await ctx.decodeAudioData(await response.arrayBuffer()));
            }
            if (mine !== generation) return;

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
        currentTime: position,
        duration: () => buffer?.duration ?? 0,
        on: (type, handler) => bus.addEventListener(type, handler),
    };
};
