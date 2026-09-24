/**
 * Что за платформа — там, где поведение браузеров расходится настолько,
 * что фича-детекцией это не выяснить (аудиофокус Chrome, фоновый звук iOS).
 *
 * @typedef {{ ios: boolean, chromium: boolean, standalone: boolean, touch: boolean }} Platform
 */

/**
 * @param {Partial<Navigator> & { userAgentData?: any, standalone?: boolean }} nav
 * @param {(query: string) => { matches: boolean }} media
 * @returns {Platform}
 */
export const detectPlatform = (nav, media) => {
    const ua = nav.userAgent ?? '';
    // iPadOS 13+ представляется Маком — выдаёт его только тач-экран
    const ios = /iP(hone|od|ad)/.test(ua) || (nav.platform === 'MacIntel' && (nav.maxTouchPoints ?? 0) > 1);
    const chromium = Boolean(nav.userAgentData?.brands?.some(({ brand }) => /Chrom/i.test(brand)));
    const standalone = nav.standalone === true || media('(display-mode: standalone)').matches;
    const touch = media('(pointer: coarse)').matches;
    return { ios, chromium, standalone, touch };
};

export const platform = detectPlatform(globalThis.navigator ?? {}, query =>
    globalThis.matchMedia?.(query) ?? { matches: false });
