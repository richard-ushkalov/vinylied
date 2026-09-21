/**
 * Полоса прогресса внизу экрана.
 *
 * Две особенности, из-за которых код выглядит именно так:
 *
 * 1. У плеера на буфере нет события timeupdate — позицию приходится
 *    опрашивать самим. Делаем это в rAF и ТОЛЬКО пока играет:
 *    на паузе цикл гасится, иначе он жёг бы батарею впустую.
 *
 * 2. Перемотка на буфере — это пересоздание источника. Дёргать её на
 *    каждое движение пальца слишком дорого, поэтому во время протяжки
 *    двигаем только картинку, а seek зовём один раз, когда отпустили.
 */
export const createProgress = ({ root, player }) => {
    const fill = root.querySelector('.progress__fill');
    const handle = root.querySelector('.progress__handle');

    let frame = 0;
    let dragging = false;
    let moved = false;
    let pointerId = null;

    const show = fraction => {
        const value = Math.max(0, Math.min(1, fraction || 0));
        fill.style.transform = `scaleX(${value})`;
        handle.style.left = `${value * 100}%`;
        root.setAttribute('aria-valuenow', Math.round(value * 100));
    };

    const fromEvent = event => {
        const rect = root.getBoundingClientRect();
        return (event.clientX - rect.left) / rect.width;
    };

    const tick = () => {
        if (!dragging) show(player.currentTime() / (player.duration() || 1));
        frame = player.isPaused() ? 0 : requestAnimationFrame(tick);
    };

    const start = () => { if (!frame && !player.isPaused()) frame = requestAnimationFrame(tick); };
    const stop  = () => { cancelAnimationFrame(frame); frame = 0; };

    root.addEventListener('pointerdown', event => {
        if (!player.duration()) return;
        dragging = true;
        pointerId = event.pointerId;
        root.setPointerCapture(pointerId);
        moved = false;
        player.scrub(0.8);          // фильтр прикрывается — мы «в перемотке»

        // одиночный клик: палочка доезжает плавно, а не телепортируется
        root.classList.add('progress--rewind');
        show(fromEvent(event));
    });

    root.addEventListener('pointermove', event => {
        if (!dragging) return;
        // поехали пальцем — переход мешает, снимаем: картинка должна
        // следовать за курсором один в один
        if (!moved) { moved = true; root.classList.remove('progress--rewind'); }
        show(fromEvent(event));                  // только картинка, без перемотки
    });

    const release = event => {
        if (!dragging) return;
        dragging = false;
        try { root.releasePointerCapture(pointerId); } catch {}

        if (moved) root.classList.add('progress--rewind');   // после протяжки — доводка
        player.seek(fromEvent(event) * player.duration());
        player.scrub(0);            // фильтр плавно открывается на новом месте
        setTimeout(() => root.classList.remove('progress--rewind'), 450);
        start();
    };
    root.addEventListener('pointerup', release);
    root.addEventListener('pointercancel', release);

    // с клавиатуры: стрелки по пять секунд
    root.addEventListener('keydown', event => {
        const step = event.key === 'ArrowRight' ? 5 : event.key === 'ArrowLeft' ? -5 : 0;
        if (!step) return;
        event.preventDefault();
        player.seek(player.currentTime() + step);
    });

    player.on('playing', () => {
        // переход снимаем сразу: дальше полоса обновляется покадрово,
        // и transition только заставлял бы её отставать
        root.classList.remove('progress--rewind');
        show(player.currentTime() / (player.duration() || 1));
        start();
    });
    player.on('pause',   stop);
    player.on('ended',   () => { stop(); show(0); });
    // При смене трека полоса не прыгает, а отматывается: включаем переход
    // разово классом и снимаем его, чтобы он не мешал покадровым обновлениям.
    player.on('emptied', () => {
        root.classList.add('progress--rewind');
        show(0);
        setTimeout(() => root.classList.remove('progress--rewind'), 450);
    });

    show(0);
    return { show, stop };
};
