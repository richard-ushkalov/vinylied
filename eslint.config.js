import js from '@eslint/js';
import globals from 'globals';

export default [
    {
        ignores: ['vendor/**', 'node_modules/**', 'test-results/**', 'playwright-report/**', 'tests/fixtures/.generated/**'],
    },
    js.configs.recommended,
    {
        files: ['src/**/*.js'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'module',
            globals: { ...globals.browser },
        },
    },
    {
        // Классический воркер: без модулей, свой глобальный объект
        files: ['sw.js'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'script',
            globals: { ...globals.serviceworker },
        },
    },
    {
        files: ['tools/**/*.{js,mjs}', 'tests/**/*.js', '*.config.js'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'module',
            globals: { ...globals.node, ...globals.browser },
        },
    },
    {
        rules: {
            'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
            'no-empty': ['error', { allowEmptyCatch: true }],
            eqeqeq: ['error', 'always'],
            'prefer-const': 'error',
            'no-var': 'error',
        },
    },
];
