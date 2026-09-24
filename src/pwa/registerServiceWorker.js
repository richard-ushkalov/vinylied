/**
 * Регистрирует service worker — он и делает приложение офлайновым.
 * Обновления приходят сами: воркер берёт свежие файлы из сети, когда
 * она есть (см. sw.js), так что ни версий, ни «перезагрузите» не нужно.
 */
export const registerServiceWorker = async () => {
    if (!('serviceWorker' in navigator)) return null;
    try {
        return await navigator.serviceWorker.register('./sw.js', { scope: './' });
    } catch (error) {
        console.warn('Service worker не зарегистрирован — офлайн работать не будет', error);
        return null;
    }
};
