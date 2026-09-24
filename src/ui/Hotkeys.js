/**
 * @typedef {{ keys: string[], run: (event: KeyboardEvent) => void, label?: string,
 *             hint?: string, allowInFields?: boolean }} Binding
 */

/**
 * Кто сам обрабатывает какие клавиши — там глобальные не срабатывают:
 *  - в полях ввода и открытых окнах — никакие (буквы — это текст);
 *  - на кнопках и ссылках — Пробел и Enter (это нажатие);
 *  - на ползунках и радиокнопках — стрелки и Home/End (это значение).
 */
const TYPING = 'input:not([type="range"], [type="radio"], [type="checkbox"]), textarea, select, [contenteditable], dialog[open]';
const PRESSABLE = 'button, a[href], summary, [role="button"], input[type="checkbox"], label';
const ADJUSTABLE = '[role="slider"], input[type="range"], input[type="radio"]';
const PRESS_KEYS = new Set([' ', 'Enter']);
const ADJUST_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);

/**
 * Горячие клавиши. Декларативная карта: клавиша → действие.
 *
 * Ключи сравниваются и по event.key, и по event.code — так «K» работает
 * и в русской раскладке (там на этой клавише «Л»).
 * Не срабатывают: с Ctrl/⌘/Alt (это клавиши браузера), при фокусе в поле
 * ввода или на элементе, который сам обрабатывает клавишу, и если событие
 * уже обработано (defaultPrevented).
 */
export class Hotkeys {
    /** @param {Binding[]} bindings */
    constructor(bindings) {
        this.bindings = bindings;
    }

    attach() {
        document.addEventListener('keydown', this.#onKey);
    }

    /** @param {KeyboardEvent} event */
    #onKey = event => {
        if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
        const binding = this.bindings.find(b => b.keys.some(key => Hotkeys.matches(event, key)));
        if (!binding || (!binding.allowInFields && Hotkeys.#owned(event))) return;
        event.preventDefault();
        binding.run(event);
    };

    /** Клавишу обработает сам элемент в фокусе. @param {KeyboardEvent} event */
    static #owned(event) {
        const target = event.target;
        if (!(target instanceof Element)) return false;
        if (target.closest(TYPING)) return true;
        if (PRESS_KEYS.has(event.key) && target.closest(PRESSABLE)) return true;
        return ADJUST_KEYS.has(event.key) && Boolean(target.closest(ADJUSTABLE));
    }

    /**
     * «Space», «KeyK», «ArrowLeft», «Shift+Slash» и просто символ «/».
     * @param {KeyboardEvent} event
     * @param {string} key
     */
    static matches(event, key) {
        // одиночный символ: регистр и Shift уже «внутри» символа
        if ([...key].length === 1) return event.key === key;
        const shift = key.startsWith('Shift+');
        const name = shift ? key.slice(6) : key;
        // у стрелок Shift — модификатор шага, а не другая клавиша
        if (shift !== event.shiftKey && !name.startsWith('Arrow')) return false;
        return event.code === name || event.key === name || (name === 'Space' && event.key === ' ');
    }
}
