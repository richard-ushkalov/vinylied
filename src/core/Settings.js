import { Emitter } from './Emitter.js';
import { LocalStore } from './LocalStore.js';

/**
 * @typedef {{ type: 'enum', values: string[], default: string }
 *         | { type: 'number', min: number, max: number, default: number }
 *         | { type: 'boolean', default: boolean }} Field
 */

/**
 * Схема настроек — единственный источник правды о том, что можно
 * настроить, в каких пределах и что стоит по умолчанию. Значения
 * по умолчанию повторяют поведение приложения до появления настроек.
 * @type {Record<string, Field>}
 */
export const SCHEMA = {
    // вид
    theme:        { type: 'enum', values: ['system', 'dark', 'light'], default: 'system' },
    motion:       { type: 'enum', values: ['system', 'reduce', 'full'], default: 'system' },
    vinylSize:    { type: 'enum', values: ['s', 'm', 'l'], default: 'm' },
    // полка
    edgeBlur:     { type: 'number', min: 0, max: 1, default: 1 },
    motionBlur:   { type: 'number', min: 0, max: 1, default: 1 },
    fisheye:      { type: 'number', min: 0, max: 1, default: 1 },
    haptics:      { type: 'boolean', default: true },
    // звук
    audioMode:    { type: 'enum', values: ['auto', 'vinyl', 'native'], default: 'auto' },
    volume:       { type: 'number', min: 0, max: 1, default: 1 },
    muted:        { type: 'boolean', default: false },
    scrubMuffle:  { type: 'number', min: 0, max: 1, default: 1 },
    crackle:      { type: 'number', min: 0, max: 1, default: 1 },
    warmth:       { type: 'number', min: 0, max: 1, default: 1 },
    spin:         { type: 'number', min: 0, max: 1, default: 1 },
    // воспроизведение
    order:        { type: 'enum', values: ['sequential', 'shuffle'], default: 'sequential' },
    repeat:       { type: 'enum', values: ['all', 'one', 'off'], default: 'all' },
    // сеть
    onlineLookup: { type: 'boolean', default: true },
};

const VERSION = 1;

/**
 * Приводит сырое значение к полю схемы. Всё, что не подходит, —
 * значение по умолчанию: испорченное хранилище не должно ломать запуск.
 * @param {Field} field
 * @param {unknown} value
 */
export const coerce = (field, value) => {
    switch (field.type) {
        case 'enum':
            return field.values.includes(/** @type {string} */ (value)) ? value : field.default;
        case 'number': {
            const n = typeof value === 'number' ? value : Number.NaN;
            return Number.isFinite(n) ? Math.min(field.max, Math.max(field.min, n)) : field.default;
        }
        case 'boolean':
            return typeof value === 'boolean' ? value : field.default;
    }
};

/**
 * Чистая функция: из того, что лежало в хранилище, собирает полный
 * валидный набор настроек. Неизвестные ключи отбрасываются.
 * @param {Record<string, Field>} schema
 * @param {unknown} raw
 * @returns {Record<string, any>}
 */
export const sanitize = (schema, raw) => {
    const values = raw && typeof raw === 'object' && /** @type {any} */ (raw).v === VERSION
        ? /** @type {any} */ (raw).values ?? {}
        : {};
    return Object.fromEntries(Object.entries(schema).map(([key, field]) => [key, coerce(field, values[key])]));
};

/**
 * Настройки пользователя. Меняются на лету: каждый set() сразу
 * сохраняется и рассылает 'change' — подписчики применяют значение
 * без перезагрузки.
 */
export class Settings extends Emitter {
    /** @type {Record<string, any>} */
    #values;

    /**
     * @param {{ store?: { read: Function, write: Function }, schema?: Record<string, Field> }} [options]
     */
    constructor({ store = new LocalStore('vinilyed:settings'), schema = SCHEMA } = {}) {
        super();
        this.store = store;
        this.schema = schema;
        this.#values = sanitize(schema, store.read(null));
    }

    /** @param {string} key */
    get(key) {
        if (!(key in this.schema)) throw new Error(`Неизвестная настройка: ${key}`);
        return this.#values[key];
    }

    /**
     * @param {string} key
     * @param {unknown} value
     */
    set(key, value) {
        const field = this.schema[key];
        if (!field) throw new Error(`Неизвестная настройка: ${key}`);
        const next = coerce(field, value);
        if (next === this.#values[key]) return;
        this.#values[key] = next;
        this.#persist();
        this.emit('change', { key, value: next });
    }

    reset() {
        const before = this.#values;
        this.#values = sanitize(this.schema, null);
        this.#persist();
        for (const key of Object.keys(this.schema)) {
            if (before[key] !== this.#values[key]) this.emit('change', { key, value: this.#values[key] });
        }
    }

    /**
     * Подписка на конкретные ключи. Сразу вызывает обработчик с текущими
     * значениями — так применение настройки живёт в одном месте, а не
     * дублируется «при старте» и «при изменении».
     * @param {string[]} keys
     * @param {(values: Record<string, any>) => void} apply
     */
    watch(keys, apply) {
        const pick = () => Object.fromEntries(keys.map(key => [key, this.get(key)]));
        apply(pick());
        return this.on('change', ({ key }) => { if (keys.includes(key)) apply(pick()); });
    }

    toJSON() {
        return { ...this.#values };
    }

    #persist() {
        this.store.write({ v: VERSION, values: this.#values });
    }
}
