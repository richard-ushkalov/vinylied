import { describeAcoustIdStatus } from './acoustidStatus.js';

/**
 * @typedef {{ key: string, label: string, type: 'range' | 'switch' | 'choice' | 'text',
 *             options?: [string, string][], hint?: string, needs?: 'effects' | 'volume',
 *             placeholder?: string, hidden?: boolean }} FieldSpec
 */

/**
 * Лист «Настройки». Разметка строится из описания полей, значения —
 * из Settings, и всё применяется сразу, без кнопки «Сохранить».
 */
export class SettingsSheet {
    #dialog;
    #form;
    #settings;
    #player;
    #platform;
    #acoustId;
    /** @type {Map<string, { field: FieldSpec, root: HTMLElement }>} */
    #fields = new Map();

    /**
     * @param {{ dialog: HTMLDialogElement, settings: import('../core/Settings.js').Settings,
     *           player: import('../audio/Player.js').Player,
     *           platform: import('../core/platform.js').Platform,
     *           acoustId: import('../lookup/AcoustIdClient.js').AcoustIdClient }} deps
     */
    constructor({ dialog, settings, player, platform, acoustId }) {
        this.#dialog = dialog;
        this.#form = /** @type {HTMLFormElement} */ (dialog.querySelector('[data-bind="form"]'));
        this.#settings = settings;
        this.#player = player;
        this.#platform = platform;
        this.#acoustId = acoustId;
    }

    /** @returns {{ title: string, fields: FieldSpec[] }[]} */
    #sections() {
        const ios = this.#platform.ios;
        return [
            {
                title: 'Вид',
                fields: [
                    { key: 'theme', label: 'Тема', type: 'choice',
                      options: [['system', 'Как в системе'], ['dark', 'Тёмная'], ['light', 'Светлая']] },
                    { key: 'motion', label: 'Анимации', type: 'choice',
                      options: [['system', 'Как в системе'], ['reduce', 'Меньше'], ['full', 'Полные']] },
                    { key: 'vinylSize', label: 'Размер конвертов', type: 'choice',
                      options: [['s', 'Мелкие'], ['m', 'Средние'], ['l', 'Крупные']] },
                ],
            },
            {
                title: 'Полка',
                fields: [
                    { key: 'edgeBlur', label: 'Размытие по краям', type: 'range',
                      hint: 'На слабых телефонах лучше уменьшить — полка станет плавнее.' },
                    { key: 'motionBlur', label: 'Размытие в движении', type: 'range' },
                    { key: 'fisheye', label: 'Рыбий глаз', type: 'range' },
                    { key: 'haptics', label: 'Вибрация при прокрутке', type: 'switch',
                      hidden: !('vibrate' in navigator) },
                ],
            },
            {
                title: 'Звук',
                fields: [
                    { key: 'audioMode', label: 'Режим звука', type: 'choice',
                      options: [['auto', 'Авто'], ['vinyl', 'Винил'], ['native', 'Надёжный']],
                      hint: ios
                          ? 'Авто на iPhone — «Надёжный»: играет на заблокированном экране. В «Виниле» все эффекты, но iOS останавливает звук при блокировке.'
                          : 'Авто — «Винил» со всеми эффектами. «Надёжный» — обычный плеер: меньше памяти, эффекты упрощены.' },
                    { key: 'volume', label: 'Громкость', type: 'range', needs: 'volume' },
                    { key: 'scrubMuffle', label: 'Приглушение при прокрутке', type: 'range', needs: 'effects' },
                    { key: 'crackle', label: 'Треск пластинки', type: 'range', needs: 'effects' },
                    { key: 'warmth', label: 'Тёплый звук', type: 'range', needs: 'effects' },
                    { key: 'spin', label: 'Разгон и торможение', type: 'range',
                      hint: '0% — пластинка стартует и останавливается мгновенно.' },
                ],
            },
            {
                title: 'Интернет',
                fields: [
                    { key: 'onlineLookup', label: 'Искать обложки и названия', type: 'switch',
                      hint: 'Наружу уходит отпечаток звука (AcoustID) и названия треков (iTunes). Сама музыка никуда не отправляется.' },
                    { key: 'acoustidKey', label: 'Ключ AcoustID', type: 'text', placeholder: 'встроенный',
                      hint: 'Ключ приложения: acoustid.org → Applications → New application. '
                          + 'Личный ключ со страницы «API key» не подойдёт. Пусто — встроенный ключ.' },
                ],
            },
        ];
    }

    attach() {
        this.#build();

        this.#dialog.addEventListener('click', event => {
            if (event.target === this.#dialog) { this.#dialog.close(); return; }
            const action = /** @type {HTMLElement} */ (event.target).closest('[data-action]')?.getAttribute('data-action');
            if (action === 'close') this.#dialog.close();
            if (action === 'reset' && confirm('Вернуть все настройки как было?')) this.#settings.reset();
        });

        // ползунки — сразу по ходу, текст — когда дописали, остальное — по выбору
        this.#form.addEventListener('input', event => this.#commit(/** @type {HTMLInputElement} */ (event.target), false));
        this.#form.addEventListener('change', event => this.#commit(/** @type {HTMLInputElement} */ (event.target), true));
        this.#form.addEventListener('submit', event => event.preventDefault());

        this.#settings.on('change', ({ key }) => this.#sync(key));
        this.#player.on('engine', () => this.#availability());
        this.#acoustId.on('status', () => this.#keyStatus());
    }

    /** @param {'keys'} [section] */
    open(section) {
        for (const key of this.#fields.keys()) this.#sync(key);
        this.#availability();
        this.#keyStatus();
        this.#dialog.showModal();
        if (section) this.#form.querySelector(`[data-section="${section}"]`)?.scrollIntoView({ block: 'start' });
    }

    /**
     * @param {HTMLInputElement} input
     * @param {boolean} final 'change', а не 'input'
     */
    #commit(input, final) {
        const entry = this.#fields.get(input.name);
        if (!entry) return;
        const { field } = entry;
        if (field.type === 'text') {
            if (final) this.#settings.set(field.key, input.value.trim());
            return;
        }
        if (field.type === 'range') this.#settings.set(field.key, Number(input.value) / 100);
        else if (field.type === 'switch') this.#settings.set(field.key, input.checked);
        else if (input.checked) this.#settings.set(field.key, input.value);
    }

    /** @param {string} key */
    #sync(key) {
        const entry = this.#fields.get(key);
        if (!entry) return;
        const { field, root } = entry;
        const value = this.#settings.get(key);
        if (field.type === 'range') {
            const input = /** @type {HTMLInputElement} */ (root.querySelector('input'));
            const percent = Math.round(value * 100);
            if (Number(input.value) !== percent) input.value = String(percent);
            input.style.setProperty('--fill', `${percent}%`);
            /** @type {HTMLOutputElement} */ (root.querySelector('output')).value = `${percent}%`;
        } else if (field.type === 'switch') {
            /** @type {HTMLInputElement} */ (root.querySelector('input')).checked = value;
        } else if (field.type === 'text') {
            const input = /** @type {HTMLInputElement} */ (root.querySelector('input'));
            if (document.activeElement !== input) input.value = value;
        } else {
            const radio = /** @type {HTMLInputElement | null} */ (root.querySelector(`input[value="${value}"]`));
            if (radio) radio.checked = true;
        }
    }

    /** Состояние ключа — прямо под полем, где его меняют. */
    #keyStatus() {
        const note = this.#fields.get('acoustidKey')?.root.querySelector('[data-bind="key-status"]');
        if (note) note.textContent = describeAcoustIdStatus(this.#acoustId.status);
    }

    /** Что недоступно в выбранном режиме звука — видно, но неактивно, с причиной. */
    #availability() {
        const caps = this.#player.capabilities;
        for (const { field, root } of this.#fields.values()) {
            if (!field.needs) continue;
            const available = caps[field.needs];
            root.classList.toggle('field--disabled', !available);
            for (const input of root.querySelectorAll('input')) input.disabled = !available;
            const note = /** @type {HTMLElement | null} */ (root.querySelector('[data-bind="unavailable"]'));
            if (note) note.hidden = available;
        }
    }

    #build() {
        /** @type {HTMLElement[]} */
        const nodes = this.#sections().map(section => {
            const fieldset = document.createElement('fieldset');
            fieldset.className = 'settings__section';
            const legend = document.createElement('legend');
            legend.className = 'sheet__subtitle';
            legend.textContent = section.title;
            fieldset.append(legend);
            for (const field of section.fields) {
                if (field.hidden) continue;
                const root = this.#control(field);
                this.#fields.set(field.key, { field, root });
                fieldset.append(root);
            }
            return fieldset;
        });
        nodes.push(this.#keys());
        this.#form.replaceChildren(...nodes);
    }

    /** @param {FieldSpec} field */
    #control(field) {
        const id = `setting-${field.key}`;
        let root;
        if (field.type === 'range') {
            root = document.createElement('div');
            root.className = 'field';
            const label = document.createElement('label');
            label.className = 'field__label';
            label.htmlFor = id;
            const text = document.createElement('span');
            text.textContent = field.label;
            const output = document.createElement('output');
            output.className = 'field__value';
            output.htmlFor.add(id);
            label.append(text, output);
            const input = document.createElement('input');
            Object.assign(input, { id, name: field.key, type: 'range', min: '0', max: '100', step: '1', className: 'range' });
            root.append(label, input);
        } else if (field.type === 'text') {
            root = document.createElement('div');
            root.className = 'field';
            const label = document.createElement('label');
            label.className = 'field__label';
            label.htmlFor = id;
            label.textContent = field.label;
            const input = document.createElement('input');
            Object.assign(input, {
                id, name: field.key, type: 'text', className: 'text-input', maxLength: 32,
                autocomplete: 'off', spellcheck: false, placeholder: field.placeholder ?? '',
            });
            input.setAttribute('autocapitalize', 'off');
            input.setAttribute('autocorrect', 'off');
            const status = document.createElement('p');
            status.className = 'field__hint field__status';
            status.dataset.bind = 'key-status';
            status.setAttribute('aria-live', 'polite');
            root.append(label, input, status);
        } else if (field.type === 'switch') {
            root = document.createElement('div');
            root.className = 'field';
            const label = document.createElement('label');
            label.className = 'switch';
            const text = document.createElement('span');
            text.textContent = field.label;
            const input = document.createElement('input');
            Object.assign(input, { id, name: field.key, type: 'checkbox' });
            input.setAttribute('role', 'switch');
            label.append(text, input);
            root.append(label);
        } else {
            root = document.createElement('fieldset');
            root.className = 'segmented field';
            const legend = document.createElement('legend');
            legend.className = 'field__label';
            legend.textContent = field.label;
            root.append(legend);
            for (const [value, text] of field.options ?? []) {
                const label = document.createElement('label');
                const input = document.createElement('input');
                Object.assign(input, { type: 'radio', name: field.key, value });
                const span = document.createElement('span');
                span.textContent = text;
                label.append(input, span);
                root.append(label);
            }
        }

        /** @type {[string, boolean][]} */
        const hints = [];
        if (field.hint) hints.push([field.hint, false]);
        if (field.needs) {
            hints.push([field.needs === 'volume'
                ? 'На iPhone громкость — только кнопками телефона.'
                : 'Недоступно в режиме «Надёжный».', true]);
        }
        for (const [text, unavailable] of hints) {
            const hint = document.createElement('p');
            hint.className = 'field__hint';
            hint.textContent = text;
            if (unavailable) { hint.dataset.bind = 'unavailable'; hint.hidden = true; }
            root.append(hint);
        }
        return root;
    }

    #keys() {
        const section = document.createElement('section');
        section.className = 'settings__section';
        section.dataset.section = 'keys';
        section.setAttribute('aria-labelledby', 'keys-title');
        const title = document.createElement('h3');
        title.id = 'keys-title';
        title.className = 'sheet__subtitle';
        title.textContent = 'Клавиши';
        const list = document.createElement('dl');
        list.className = 'keys';
        /** @type {[string[], string][]} */
        const rows = [
            [['Пробел', 'K'], 'Играть / пауза'],
            [['←', '→'], 'Перемотка на 5 с (с Shift — 30 с)'],
            [['↑', '↓'], 'Соседняя пластинка'],
            [['Home', 'End'], 'Первая / последняя пластинка'],
            [['Enter'], 'Играть выбранную'],
            [['N', 'P'], 'Следующий / предыдущий трек'],
            [['S'], 'Перемешать'],
            [['R'], 'Повтор: полки → трека → выкл.'],
            [['M'], 'Без звука'],
            [['/'], 'Поиск'],
            [['Esc'], 'Закрыть поиск или окно'],
            [['?'], 'Эта справка'],
        ];
        for (const [keys, text] of rows) {
            const dt = document.createElement('dt');
            keys.forEach((key, index) => {
                const kbd = document.createElement('kbd');
                kbd.textContent = key;
                dt.append(kbd);
                if (index < keys.length - 1) dt.append(' ');
            });
            const dd = document.createElement('dd');
            dd.textContent = text;
            list.append(dt, dd);
        }
        section.append(title, list);
        return section;
    }
}
