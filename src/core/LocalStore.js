/**
 * JSON в localStorage, который никогда не бросает.
 *
 * Доступ к localStorage может упасть сам по себе: приватный режим Safari,
 * запрет сайтовых данных, переполнение квоты. Для настроек и позиции
 * «продолжить с места» это не повод ронять приложение — просто работаем
 * без памяти.
 */
export class LocalStore {
    /** @param {string} key */
    constructor(key) {
        this.key = key;
    }

    /**
     * @template T
     * @param {T} fallback
     * @returns {T}
     */
    read(fallback) {
        try {
            const raw = localStorage.getItem(this.key);
            return raw === null ? fallback : JSON.parse(raw);
        } catch {
            return fallback;
        }
    }

    /** @param {unknown} value */
    write(value) {
        try {
            localStorage.setItem(this.key, JSON.stringify(value));
        } catch { /* приват-режим или нет места — живём без памяти */ }
    }

    clear() {
        try {
            localStorage.removeItem(this.key);
        } catch {}
    }
}
