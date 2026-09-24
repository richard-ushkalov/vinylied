import { Emitter } from '../core/Emitter.js';

/**
 * Откуда берутся файлы: скрытый <input type=file> и перетаскивание
 * на окно (десктоп). Событие 'files' {files}.
 */
export class FilePicker extends Emitter {
    #input;
    #target;
    #depth = 0;     // dragenter/dragleave приходят и от детей — считаем вложенность

    /** @param {{ input: HTMLInputElement, target: HTMLElement }} deps */
    constructor({ input, target }) {
        super();
        this.#input = input;
        this.#target = target;
    }

    attach() {
        this.#input.addEventListener('change', () => {
            const files = [...(this.#input.files ?? [])];
            this.#input.value = '';     // тот же файл можно будет выбрать снова
            if (files.length) this.emit('files', { files });
        });

        const hasFiles = event => [...(event.dataTransfer?.types ?? [])].includes('Files');
        const target = this.#target;
        target.addEventListener('dragenter', event => {
            if (!hasFiles(event)) return;
            this.#depth++;
            target.classList.add('is-dropping');
        });
        target.addEventListener('dragover', event => {
            if (!hasFiles(event)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
        });
        target.addEventListener('dragleave', () => {
            if (--this.#depth <= 0) { this.#depth = 0; target.classList.remove('is-dropping'); }
        });
        target.addEventListener('drop', event => {
            if (!hasFiles(event)) return;
            event.preventDefault();
            this.#depth = 0;
            target.classList.remove('is-dropping');
            const files = [...(event.dataTransfer?.files ?? [])];
            if (files.length) this.emit('files', { files });
        });
    }

    open() {
        this.#input.click();
    }
}
