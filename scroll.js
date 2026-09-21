export const createScroll = viewport => {
    const list = document.querySelector('.list');

    let currentPos = 0;
    let targetPos = 0;
    let snapTimer = 0;

    let frame = 0;

    let currentIndex = 0;

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
        const slots = [...list.children];
        if (!slots.length) return;

        const center = getCenter();
        let nearest = 0, best = Infinity;
        slots.forEach((slot, index) => {
            const rect = slot.getBoundingClientRect();
            const distance = Math.abs(rect.top + rect.height / 2 - center);
            if (distance < best) { best = distance; nearest = index; }
        });

        centerOn(nearest);
    };

    const onWheel = event => {
        if (event.ctrlKey) { return; }

        targetPos -= event.deltaY;
        currentPos = targetPos;

        draw();

        clearTimeout(snapTimer);
        snapTimer = setTimeout(snap, 230);
    };

    const draw = () => {
        list.style.transform = `translateY(${currentPos}px)`;
    };

    const loop = () => {
        currentPos += (targetPos - currentPos) * 0.15;

        if (Math.abs(currentPos - targetPos) < 0.5) {
            currentPos = targetPos;
            frame = 0;
        } else {
            frame = requestAnimationFrame(loop);
        }
        draw();
    }

    const start = () => {
        if (!frame) {
            frame = requestAnimationFrame(loop);
        }
    }

    let layoutTimer = 0;

    const observer = new ResizeObserver(() => {
        clearTimeout(layoutTimer);
        layoutTimer = setTimeout(() => centerOn(currentIndex), 120);
    });

    const observeAll = () => {
        observer.disconnect();
        observer.observe(list);
        for (const slot of list.children) observer.observe(slot);
    };

    return { 
        attach() {
            viewport.addEventListener('wheel', onWheel, { passive: true });
        },
        refresh: observeAll,
        centerOn,
    }
}
