/**
 * Что сказать пользователю о ключе AcoustID. Раньше и «ключа нет», и
 * «ключ не приняли» выглядели одинаково — «не задан», и понять, что не
 * так, было невозможно.
 * @param {import('../lookup/AcoustIdClient.js').KeyStatus} status
 */
export const describeAcoustIdStatus = status => ({
    missing: 'Распознавание по звуку выключено: ключ AcoustID не задан (Настройки → Интернет).',
    unverified: 'Распознавание по звуку: ключ задан, проверится при первом поиске.',
    ok: 'Распознавание по звуку работает.',
    rejected: 'AcoustID не принял ключ. Нужен ключ приложения (Applications → New application), '
        + 'а не личный ключ со страницы «API key». Пока обложки ищутся через iTunes.',
})[status];
