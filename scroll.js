export const createScroll = (viewport, { onScrub } = {}) => {
    let lastPos = 0;
    let speed = 0;          // px за кадр, сглаженно — им правим размытие
    const list = document.querySelector('.list');

    let currentPos = 0;
    let targetPos = 0;
    let snapTimer = 0;

    let frame = 0;

    let currentIndex = 0;
    let focusedIndex = -1;

    const getCenter = () => { return viewport.getBoundingClientRect().top + viewport.clientHeight / 2; }

    const centerOn = index => {
        const slots = [...list.children];
        if (!slots[index]) return;

        const rect = slots[index].getBoundingClientRect();
        targetPos = currentPos + (getCenter() - (rect.top + rect.height / 2));
        currentIndex = index;
        start();
    };

    const snap = () => {
        updateSlots();
        if (focusedIndex >= 0) centerOn(focusedIndex);
        onScrub?.(0);              // остановились — фильтр открывается
    };

    const onWheel = event => {
        if (event.ctrlKey) { return; }

        targetPos -= event.deltaY;
        currentPos = targetPos;

        draw();

        // насколько закрыть фильтр — по скорости, а не «крутим/не крутим».
        // Чуть подвинул — почти не слышно, гоняешь быстро — уходит в подушку.
        onScrub?.(Math.min(1, Math.abs(event.deltaY) / 150));

        clearTimeout(snapTimer);
        snapTimer = setTimeout(snap, 120);
    };

    // ближайший к центру получает .slot--focused.
    // Классы пишем ТОЛЬКО когда ближайший сменился, а не каждый кадр.
    const FISH_ANGLE = 20;    // градусов наклона у краёв
    const FISH_DEPTH = 140;   // насколько края утопают вглубь
    const FISH_SPREAD = 320;  // на какой дистанции эффект набирает силу
    const MAX_BLUR    = 4;    // px размытия у самых дальних
    const VISIBLE     = FISH_SPREAD * 1.8;   // дальше слот не рисуем вообще

    // один проход: и наклон по расстоянию до центра, и отметка ближайшего
    const updateSlots = () => {
        const slots = [...list.children];
        if (!slots.length) return;

        // насколько быстро едем: сглаживаем, чтобы размытие не дёргалось
        const moved = Math.abs(currentPos - lastPos);
        lastPos = currentPos;
        speed += (moved - speed) * 0.25;
        const rush = Math.min(1, speed / 26);     // 0 — стоим, 1 — быстро

        // ЧИТАЕМ всё сразу и только потом ПИШЕМ. Раньше цикл чередовал
        // getBoundingClientRect и запись стиля — а это заставляет браузер
        // пересчитывать раскладку на КАЖДОМ слоте: двадцать пластинок =
        // двадцать пересчётов в кадр вместо одного. Отсюда и подтормаживало.
        const center = getCenter();
        const rects = slots.map(slot => slot.getBoundingClientRect());

        let nearest = 0, best = Infinity;

        slots.forEach((slot, index) => {
            const rect = rects[index];
            const offset = rect.top + rect.height / 2 - center;

            const distance = Math.abs(offset);
            if (distance < best) { best = distance; nearest = index; }

            // Далеко за экраном — снимаем с отрисовки и больше ничего не считаем.
            // Раньше каждому слоту полки, включая невидимые, покадрово писались
            // transform и filter: на длинной полке это десятки размытий в кадр
            // впустую. Флаг держим в dataset, чтобы не трогать стиль каждый кадр.
            const far = distance > VISIBLE;
            if (far !== (slot.dataset.far === '1')) {
                slot.dataset.far = far ? '1' : '';
                slot.style.visibility = far ? 'hidden' : '';
            }
            if (far) return;

            // рыбий глаз: чем дальше от центра, тем сильнее наклон и утопание
            const t = Math.max(-1, Math.min(1, offset / FISH_SPREAD));
            // Запись в style невалидирует стиль элемента, даже если строка
            // та же самая. Стоим на месте — не трогаем вовсе.
            const transform =
                `translateZ(${-Math.abs(t) * FISH_DEPTH}px) rotateX(${-t * FISH_ANGLE}deg)`;
            if (slot.style.transform !== transform) slot.style.transform = transform;

            // у краёв размывает всегда, в движении — ещё и по центру
            const blur = Math.max(0, (Math.abs(t) + rush * 0.9) * MAX_BLUR - 0.4);
            const value = blur > 0.25 ? `blur(${blur.toFixed(2)}px)` : '';

            // Размытие вешаем на КОНЕЧНЫЕ грани — ни на слот, ни на .vinyl__box.
            // Любой filter принудительно делает элементу transform-style: flat,
            // и всё 3D под ним схлопывается: на слоте пропадала перспектива,
            // на коробке — сами обложки (мерил: 0px высоты вместо 180).
            // Грани и так плоские, им терять нечего.
            // .disc сюда НЕ входит по тому же правилу: внутри у него своя
            // этикетка, и filter отобрал бы у неё 3D-контекст.
            // Возле центра свойство СНИМАЕМ совсем, а не ставим blur(0).
            // Размываем ТОЛЬКО лицевую грань и корешок. Раньше filter считался
            // для всех шести — вчетверо больше работы на каждый слот в кадре,
            // а четыре задние грани почти не видны. Список граней запоминаем
            // на элементе: querySelectorAll каждый кадр тоже не бесплатен.
            if (slot.dataset.blur !== value) {
                slot.dataset.blur = value;
                slot._faces ??= slot.querySelectorAll('.vinyl__frontside, .vinyl__side');
                for (const face of slot._faces) face.style.filter = value;
            }
        });

        if (nearest === focusedIndex) return;
        focusedIndex = nearest;

        // короткий отклик при смене центрального.
        // Работает на Android; iOS Safari и трекпады Mac этого API не имеют.
        navigator.vibrate?.(8);
        slots.forEach((slot, index) =>
            slot.classList.toggle('slot--focused', index === nearest));
    };

    const draw = () => {
        list.style.transform = `translateY(${currentPos}px)`;
        updateSlots();
    };

    const loop = () => {
        currentPos += (targetPos - currentPos) * 0.05;

        const arrived = Math.abs(currentPos - targetPos) < 0.5;
        if (arrived) currentPos = targetPos;

        draw();                   // здесь же пересчитывается speed

        // Держим кадры, пока не доехали ИЛИ пока не осела скорость.
        // Раньше условием было только «доехали»: если стопка уже стояла
        // по центру, цикл выходил на первом кадре и размытие замирало
        // на том значении, что было в момент отпускания колеса.
        frame = (!arrived || speed > 0.2) ? requestAnimationFrame(loop) : 0;
    }

    const start = () => {
        if (!frame) {
            frame = requestAnimationFrame(loop);
        }
    }

    // ── прокрутка пальцем ─────────────────────────────────────────
    // Мышь сюда не пускаем: на десктопе крутят колесом, а перетаскивание
    // мышью только мешало бы клику по конверту.
    const THRESHOLD = 6;     // px, после которых это уже прокрутка, а не клик
    const COAST = 200;       // мс наката после броска

    let dragId = null;
    let dragFrom = 0, dragBase = 0, dragging = false;
    let lastY = 0, lastTime = 0, velocity = 0;
    let swallowClick = false;

    const onPointerDown = event => {
        if (event.pointerType === 'mouse') return;
        dragId = event.pointerId;
        dragFrom = lastY = event.clientY;
        lastTime = event.timeStamp;
        dragBase = currentPos;
        dragging = false;
        velocity = 0;
        clearTimeout(snapTimer);
    };

    const onPointerMove = event => {
        if (event.pointerId !== dragId) return;
        const delta = event.clientY - dragFrom;

        // Захват ставим ТОЛЬКО когда палец реально поехал. Если взять его
        // сразу на pointerdown, браузер перенаправит на viewport и click —
        // и нажатие на конкретный конверт перестанет доходить.
        if (!dragging) {
            if (Math.abs(delta) < THRESHOLD) return;
            dragging = true;
            // Указателя может уже не быть (палец ушёл за окно, событие
            // синтетическое) — тогда просто работаем без захвата.
            try { viewport.setPointerCapture(dragId); } catch {}
        }

        const dt = event.timeStamp - lastTime;
        if (dt > 0) velocity = (event.clientY - lastY) / dt;   // px в мс
        lastY = event.clientY;
        lastTime = event.timeStamp;

        currentPos = targetPos = dragBase + delta;
        draw();
        onScrub?.(Math.min(1, Math.abs(velocity) * 0.6));
    };

    const onPointerUp = event => {
        if (event.pointerId !== dragId) return;
        dragId = null;
        if (!dragging) return;              // это был тап, а не прокрутка
        dragging = false;
        swallowClick = true;                // ...а вот это была прокрутка
        try { viewport.releasePointerCapture(event.pointerId); } catch {}

        targetPos = currentPos + velocity * COAST;   // бросок докатывается
        start();

        clearTimeout(snapTimer);
        snapTimer = setTimeout(snap, 400);
    };

    let layoutTimer = 0;

    const observer = new ResizeObserver(() => {
        // Пересчитать СРАЗУ, а не только через паузу. Отсечение за экраном
        // держит inline visibility на слоте, и снять его может лишь новый
        // проход: без этого конверт, съехавший в кадр после поиска, так
        // и оставался невидимым.
        draw();
        clearTimeout(layoutTimer);
        layoutTimer = setTimeout(() => centerOn(currentIndex), 400);
    });

    const observeAll = () => {
        observer.disconnect();
        observer.observe(list);

        for (const slot of list.children) {
            observer.observe(slot);
            // Сбрасываем отсечение НАСИЛЬНО. Оно живёт в inline-стиле, и снять
            // его может только проход updateSlots — а он считает по текущей
            // раскладке, которая после поиска ещё не устоялась. Слот, уже
            // подходящий под запрос, так и оставался невидимым.
            // Лишние нарисованные слоты дешевле невидимых нужных.
            slot.style.visibility = '';
            delete slot.dataset.far;
        }

        focusedIndex = -1;   // состав полки сменился — прежний индекс не значит ничего
        draw();              // сразу отметить ближайшего, не дожидаясь прокрутки
    };

    return { 
        attach() {
            viewport.addEventListener('wheel', onWheel, { passive: true });

            viewport.addEventListener('pointerdown', onPointerDown);
            viewport.addEventListener('pointermove', onPointerMove);
            viewport.addEventListener('pointerup', onPointerUp);
            viewport.addEventListener('pointercancel', onPointerUp);

            // После протяжки браузер всё равно шлёт click — и полка запускала бы
            // трек, на котором палец случайно остановился. Гасим ровно один.
            // stopImmediatePropagation, а не stopPropagation: слушатель клика
            // висит на этом же элементе, обычная остановка его бы не сняла.
            viewport.addEventListener('click', event => {
                if (!swallowClick) return;
                swallowClick = false;
                event.stopImmediatePropagation();
            }, true);

            // requestAnimationFrame замирает в скрытой вкладке. Если её
            // свернули посреди доводки, запрошенный кадр не придёт, а frame
            // останется занятым — и start() откажется перезапускать цикл:
            // стопка застынет на полпути, размытие — на последнем значении.
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState !== 'visible') return;
                frame = 0;
                start();
            });

            // Клик центрирует ДО того, как слот раскрылся: centerOn меряет
            // положение, которое через миг изменится. Поэтому пересчитываем,
            // когда переход отступов реально закончился.
            // transitionend всплывает, поэтому хватает одного слушателя на списке.
            list.addEventListener('transitionend', event => {
                if (event.propertyName !== 'padding-top') return;
                centerOn(currentIndex);
            });
        },
        refresh: observeAll,
        centerOn,
        getFocused: () => focusedIndex,
    }
}
