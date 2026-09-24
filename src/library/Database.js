/**
 * Тонкая промис-обёртка над IndexedDB. Одна база, одно хранилище треков;
 * аудио хранится прямо в записях как Blob — так его не надо собирать
 * из кусков, а браузер держит большие Blob'ы отдельными файлами на диске.
 */
const NAME = 'vinilyed';
const VERSION = 1;
export const TRACKS = 'tracks';

export class Database {
    /** @type {Promise<IDBDatabase> | null} */
    #opening = null;

    /** @param {string} [name] */
    constructor(name = NAME) {
        this.name = name;
    }

    open() {
        this.#opening ??= new Promise((resolve, reject) => {
            const request = indexedDB.open(this.name, VERSION);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(TRACKS)) {
                    const store = db.createObjectStore(TRACKS, { keyPath: 'id' });
                    // имя|размер|дата — чтобы один и тот же файл не лёг на полку дважды
                    store.createIndex('key', 'key', { unique: true });
                }
            };
            request.onsuccess = () => {
                const db = request.result;
                // другая вкладка обновляет схему — отпускаем, а не блокируем её
                db.onversionchange = () => db.close();
                resolve(db);
            };
            request.onerror = () => reject(request.error);
        });
        return this.#opening;
    }

    /** @param {string} store @returns {Promise<any[]>} */
    all(store) {
        return this.#run(store, 'readonly', s => s.getAll());
    }

    /** @param {string} store @param {IDBValidKey} key */
    get(store, key) {
        return this.#run(store, 'readonly', s => s.get(key));
    }

    /** @param {string} store @param {any} value */
    put(store, value) {
        return this.#run(store, 'readwrite', s => s.put(value));
    }

    /** @param {string} store @param {IDBValidKey} key */
    delete(store, key) {
        return this.#run(store, 'readwrite', s => s.delete(key));
    }

    /** @param {string} store */
    clear(store) {
        return this.#run(store, 'readwrite', s => s.clear());
    }

    /**
     * Результат отдаём по oncomplete транзакции, а не по onsuccess запроса:
     * только тогда запись действительно на диске.
     * @param {string} store
     * @param {IDBTransactionMode} mode
     * @param {(store: IDBObjectStore) => IDBRequest} fn
     */
    async #run(store, mode, fn) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(store, mode);
            const request = fn(tx.objectStore(store));
            tx.oncomplete = () => resolve(request.result);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error ?? new DOMException('Транзакция прервана', 'AbortError'));
        });
    }
}
