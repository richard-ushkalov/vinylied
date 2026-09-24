/**
 * Полоса прогресса внизу экрана.
 *
 * Две особенности, из-за которых код выглядит именно так:
 *
 * 1. У плеера на буфере нет события timeupdate — позицию приходится
 *    опрашивать самим. Делаем это в rAF и ТОЛЬКО пока крутится диск:
 *    встал — цикл гаснет, иначе он жёг бы батарею впустую.
 *
 * 2. Перемотка на буфере — это пересоздание источника. Дёргать её на
 *    каждое движение пальца слишком дорого, поэтому во время протяжки
 *    двигаем только картинку, а seek зовём один раз, когда отпустили.
 */
export const createProgress = ({ root, player, onTick }) => {
    const fill = root.querySelector('.progress__fill');
    const handle = root.querySelector('.progress__handle');

    let frame = 0;
    let dragging = false;
    let wrapping = false;   // идёт перелёт палочки через край
    let moved = false;
    let pointerId = null;

    const show = fraction => {
        const value = Math.max(0, Math.min(1, fraction || 0));
        fill.style.transform = `scaleX(${value})`;
        // Во время перелёта палочку не трогаем: следующий трек может быть
        // уже предзагружен, тогда 'playing' прилетает почти сразу и покадровый
        // show() затёр бы анимацию на первом же кадре.
        if (!wrapping) handle.style.left = `${value * 100}%`;
        root.setAttribute('aria-valuenow', Math.round(value * 100));
    };

    const fromEvent = event => {
        const rect = root.getBoundingClientRect();
        return (event.clientX - rect.left) / rect.width;
    };

    const tick = () => {
        const time = player.currentTime();
        if (!dragging) show(time / (player.duration() || 1));
        onTick?.(time);                  // тем же кадром крутим пластинку
        // Живём по СКОРОСТИ, а не по isPaused(): пауза поднимается в начале
        // торможения, и полсекунды выбега диска мы бы просто не нарисовали.
        frame = player.playbackRate() > 0 ? requestAnimationFrame(tick) : 0;
    };

    const start = () => { if (!frame && player.playbackRate() > 0) frame = requestAnimationFrame(tick); };
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

        setTimeout(() => root.classList.remove('progress--rewind'), 580);
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
    // Слушателя 'pause' здесь нет намеренно: гасить кадры на паузе больше
    // нельзя, иначе диск замрёт на полном ходу вместо выбега. Цикл догорает
    // сам, когда скорость дойдёт до нуля — то есть ровно когда диск встал.
    player.on('ended',   () => { stop(); show(0); });
    // Смена трека: палочка уезжает за правый край, телепортируется за левый
    // и выезжает обратно — вместо того чтобы отматываться через всю полосу.
    const ESCAPE = 16;   // px за край: палочке шириной 3px хватает с запасом

    // Зовётся ТОЛЬКО когда трек доиграл сам. Ручное переключение получает
    // обычную отмотку ниже: перелёт через край — это про «дошли до конца».
    const wrap = () => {
        wrapping = true;
        root.classList.add('progress--wrap');
        // Полосу добиваем до конца, а не гасим: она должна уехать вместе
        // с палочкой, а обнулиться уже за экраном.
        handle.style.left = `calc(100% + ${ESCAPE}px)`;
        fill.style.transform = 'scaleX(1)';

        setTimeout(() => {
            // Телепорт — БЕЗ перехода, иначе палочка проедет обратно по полосе.
            root.classList.remove('progress--wrap');
            handle.style.left = `${-ESCAPE}px`;
            fill.style.transform = 'scaleX(0)';   // без перехода, за экраном

            // Принудительный пересчёт раскладки. Без него браузер схлопнет
            // оба присваивания в одно на конце задачи, перехода не случится,
            // и палочка просто окажется на месте.
            void root.offsetWidth;

            root.classList.add('progress--wrap');
            handle.style.left = '0%';
            setTimeout(() => {
                root.classList.remove('progress--wrap');
                wrapping = false;      // дальше палочку снова ведёт show()
            }, 320);
        }, 320);
    };

    // Ручное переключение: полоса отматывается к началу по всей длине.
    player.on('emptied', () => {
        if (wrapping) return;              // уже летим через край — не мешаем
        root.classList.add('progress--rewind');
        show(0);
        setTimeout(() => root.classList.remove('progress--rewind'), 580);
    });

    show(0);
    return { show, stop, wrap };
};
