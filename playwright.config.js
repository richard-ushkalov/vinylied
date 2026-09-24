import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;

export default defineConfig({
    testDir: 'tests/e2e',
    globalSetup: './tests/e2e/global-setup.js',
    timeout: 60_000,
    expect: { timeout: 10_000 },
    reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
    use: {
        baseURL: `http://127.0.0.1:${PORT}`,
        // service worker включаем только в тесте офлайна: иначе он
        // перехватывал бы запросы раньше моков page.route
        serviceWorkers: 'block',
        launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] },
        trace: 'retain-on-failure',
    },
    projects: [
        { name: 'mobile', use: { ...devices['Pixel 7'] } },
        { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    ],
    webServer: {
        command: `npx http-server . -p ${PORT} -c-1 --silent`,
        url: `http://127.0.0.1:${PORT}`,
        reuseExistingServer: !process.env.CI,
    },
});
