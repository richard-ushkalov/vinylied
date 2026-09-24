/**
 * Обновляет список SHELL в sw.js: всё, что нужно приложению без сети
 * (npm run precache). Unit-тест сверяет список с диском.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const DIRS = ['src', 'styles', 'vendor', 'icons'];
const SKIP = /\.(md|d\.ts)$/;

const walk = async dir => {
    const entries = await readdir(new URL(`${dir}/`, root), { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory()) files.push(...await walk(path));
        else if (!SKIP.test(entry.name)) files.push(path);
    }
    return files;
};

export const shellFiles = async () => {
    const files = (await Promise.all(DIRS.map(walk))).flat().sort();
    return ['./', './index.html', './manifest.webmanifest', ...files.map(file => `./${file}`)];
};

if (import.meta.url === `file://${process.argv[1]}`) {
    const sw = new URL('sw.js', root);
    const source = await readFile(sw, 'utf8');
    const list = (await shellFiles()).map(file => `    '${file}',`).join('\n');
    const next = source.replace(
        /\/\/ precache:start\n[\s\S]*?\/\/ precache:end/,
        `// precache:start\nconst SHELL = [\n${list}\n];\n// precache:end`,
    );
    await writeFile(sw, next);
    console.log(`sw.js: ${list.split('\n').length} файлов в SHELL`);
}
