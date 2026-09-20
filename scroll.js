export const createScroll = ({ viewport, strip, onFocus, openSpace = 0 }) => {
    const SMOOTHING  = 0.14;    // какую долю остатка проходим за кадр при 60 fps
    const SNAP_DELAY = 130;     // мс тишины, после которых срабатывает магнит
    const EPSILON    = 0.0005;  // ближе этого считаем, что доехали
    const DRAG_SLOP  = 6;       // px: дальше этого жест считается перетаскиванием, а не кликом

    let count = 0;              // сколько конвертов
    let pitch = 0;              // шаг между соседями в пикселях
    let offset = 0;             // сдвиг, чтобы фокусный оказался по центру

    let position = 0;           // где лента СЕЙЧАС, в конвертах (дробное)
    let target   = 0;           // куда она ЕДЕТ, в конвертах
    let focused  = -1;          // Math.round(position) на прошлом кадре

    let frame = 0, lastTime = 0, snapTimer = 0;

    const clamp = value => Math.max(0, Math.min(count - 1, value));

    // ── размеры: считаем редко, никогда не в кадре ──
    const measure = () => {
        const kids = strip.children;
        if (!kids.length) { pitch = 0; return; }

        // offsetTop — положение в РАСКЛАДКЕ, трансформации он не видит.
        // getBoundingClientRect здесь нельзя: draw() сам двигает слоты,
        // и мы бы мерили собственный сдвиг.
        pitch = kids.length > 1
            ? kids[1].offsetTop - kids[0].offsetTop
            : kids[0].offsetHeight;

        offset = viewport.clientHeight / 2 - kids[0].offsetHeight / 2;
    };

    // ── единственное место, где появляются пиксели ──
    const draw = () => {
        strip.style.transform = `translateY(${offset - position * pitch}px)`;

        // раскрытому конверту нужно место. Даём его СДВИГОМ соседей,
        // а не изменением высоты слота: тогда pitch остаётся постоянным.
        if (openSpace) {
            const kids = strip.children;
            for (let i = 0; i < kids.length; i++) {
                const d = i - position;                       // расстояние до центра, дробное
                const side = Math.max(-1, Math.min(1, d));    // -1 сверху, +1 снизу, плавно у центра
                kids[i].style.transform = `translateY(${side * openSpace / 2}px)`;
            }
        }

        const nearest = clamp(Math.round(position));
        if (nearest !== focused) {          // сообщаем только когда реально сменился
            focused = nearest;
            onFocus?.(focused);
        }
    };

    const loop = time => {
        const dt = lastTime ? Math.min((time - lastTime) / 1000, 0.05) : 0;
        lastTime = time;

        // доля пути за ЭТОТ кадр, пересчитанная из доли за кадр при 60 fps
        const k = 1 - (1 - SMOOTHING) ** (60 * dt);
        position += (target - position) * k;

        if (Math.abs(target - position) < EPSILON) {
            position = target;              // дотянули ровно
            frame = 0;                      // и погасили цикл — иначе жжём батарею
        } else {
            frame = requestAnimationFrame(loop);
        }
        draw();
    };

    const start = () => {
        if (frame) return;                  // цикл уже крутится, второй не нужен
        lastTime = 0;
        frame = requestAnimationFrame(loop);
    };

    const scheduleSnap = () => {
        clearTimeout(snapTimer);            // пока крутят — магнит молчит
        snapTimer = setTimeout(() => {
            target = clamp(Math.round(target));
            start();
        }, SNAP_DELAY);
    };

    // ── колесо ──
    const onWheel = event => {
        if (event.ctrlKey) return;          // это щипок для зума, не листание
        if (!pitch) return;

        // deltaMode: 0 пиксели, 1 строки, 2 страницы
        const px = event.deltaY * (event.deltaMode === 1 ? 16
                                 : event.deltaMode === 2 ? viewport.clientHeight
                                 : 1);

        target = clamp(target + px / pitch);
        scheduleSnap();
        start();
    };

    // ── перетаскивание: на телефоне колеса нет ──
    let dragging = false, captured = false;
    let startY = 0, startTarget = 0, moved = 0, pointerId = null;

    const onDown = event => {
        if (!pitch) return;
        dragging = true; captured = false; moved = 0;
        pointerId = event.pointerId;
        startY = event.clientY;
        startTarget = target;
        clearTimeout(snapTimer);
        // ВАЖНО: захват здесь НЕ берём. Он перенацеливает click на viewport,
        // и клики по конвертам перестают доходить. Берём только когда поехали.
    };
    const onMove = event => {
        if (!dragging) return;
        const dy = event.clientY - startY;
        moved = Math.max(moved, Math.abs(dy));

        if (!captured && moved > DRAG_SLOP) {       // это уже протяжка, а не клик
            viewport.setPointerCapture(pointerId);
            captured = true;
        }
        if (!captured) return;                      // ещё в пределах дрожания руки

        target = clamp(startTarget - dy / pitch);
        start();
    };
    const onUp = () => {
        if (!dragging) return;
        dragging = false;
        if (captured) {
            try { viewport.releasePointerCapture(pointerId); } catch {}
            captured = false;
        }
        scheduleSnap();
    };
    // если палец проехал — это была прокрутка, клик гасим на фазе перехвата
    const onClickCapture = event => {
        if (moved > DRAG_SLOP) { event.stopPropagation(); event.preventDefault(); moved = 0; }
    };

    return {
        attach() {
            viewport.addEventListener('wheel', onWheel, { passive: true });
            viewport.addEventListener('pointerdown', onDown);
            viewport.addEventListener('pointermove', onMove);
            viewport.addEventListener('pointerup', onUp);
            viewport.addEventListener('pointercancel', onUp);
            viewport.addEventListener('click', onClickCapture, true);
            addEventListener('resize', () => { measure(); draw(); });
        },
        setCount(n) { count = n; measure(); position = target = 0; focused = -1; draw(); },
        goTo(index) { target = clamp(index); clearTimeout(snapTimer); start(); },
        getFocused: () => focused,
        remeasure: () => { measure(); draw(); },
    };
};
