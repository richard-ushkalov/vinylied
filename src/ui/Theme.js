import { Emitter } from '../core/Emitter.js';

const THEME_COLORS = { dark: '#000000', light: '#f6f5f2' };

/**
 * Применяет вид из настроек к <html>: data-theme, data-motion, data-size.
 * «Системные» значения следят за системой на лету.
 *
 * Первичная расстановка делается инлайн-скриптом в <head> ещё до
 * отрисовки; здесь — то же самое плюс реакция на изменения.
 *
 * События: 'theme' {theme}, 'motion' {reduced}.
 */
export class Theme extends Emitter {
    #root;
    #settings;
    #light = matchMedia('(prefers-color-scheme: light)');
    #reduce = matchMedia('(prefers-reduced-motion: reduce)');

    /** @param {{ settings: import('../core/Settings.js').Settings, root?: HTMLElement }} deps */
    constructor({ settings, root = document.documentElement }) {
        super();
        this.#settings = settings;
        this.#root = root;
    }

    attach() {
        this.#settings.watch(['theme', 'motion', 'vinylSize'], () => this.#apply());
        this.#light.addEventListener('change', () => this.#apply());
        this.#reduce.addEventListener('change', () => this.#apply());
    }

    get theme() { return this.#root.dataset.theme; }
    get reducedMotion() { return this.#root.dataset.motion === 'reduce'; }

    /** Цвета запасной обложки из токенов текущей темы. */
    coverColors() {
        const style = getComputedStyle(this.#root);
        return {
            bg: style.getPropertyValue('--cover-bg').trim() || '#000',
            fg: style.getPropertyValue('--cover-fg').trim() || '#fff',
        };
    }

    #apply() {
        const s = this.#settings;
        const theme = s.get('theme') === 'system' ? (this.#light.matches ? 'light' : 'dark') : s.get('theme');
        const motion = s.get('motion') === 'system' ? (this.#reduce.matches ? 'reduce' : 'full') : s.get('motion');
        const root = this.#root;
        const themeChanged = root.dataset.theme !== theme;
        const motionChanged = root.dataset.motion !== motion;

        root.dataset.theme = theme;
        root.dataset.motion = motion;
        root.dataset.size = s.get('vinylSize');
        document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLORS[theme]);

        if (themeChanged) this.emit('theme', { theme });
        if (motionChanged) this.emit('motion', { reduced: motion === 'reduce' });
    }
}
