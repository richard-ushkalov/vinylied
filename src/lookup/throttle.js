/**
 * Не чаще одного вызова в interval мс — у бесплатных API жёсткие лимиты
 * (iTunes — около 20 запросов в минуту, AcoustID — 3 в секунду).
 * @param {number} interval
 */
export const throttle = interval => {
    let next = 0;
    return async () => {
        const now = Date.now();
        const wait = Math.max(0, next - now);
        next = Math.max(now, next) + interval;
        if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    };
};
