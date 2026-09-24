/**
 * Собирает сторонний код в vendor/ — чтобы приложение работало без сети
 * и не зависело от CDN. Результат коммитится: сайт остаётся статикой.
 *
 *   npm run vendor
 */
import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

const out = new URL('../vendor/', import.meta.url);
await mkdir(out, { recursive: true });

// music-metadata лениво подгружает парсеры форматов через import().
// Без --splitting esbuild встраивает их в тот же файл — в офлайне
// не окажется, что парсер для .flac так и не был скачан.
await build({
    entryPoints: [new URL('./music-metadata-entry.js', import.meta.url).pathname],
    outfile: new URL('music-metadata.js', out).pathname,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    legalComments: 'eof',
});

// Chromaprint уже собран emscripten'ом под веб: модуль сам находит
// соседний .wasm через import.meta.url, поэтому копируем оба файла рядом.
const dist = new URL('../node_modules/@unimusic/chromaprint/dist/', import.meta.url);
for (const file of ['chromaprint.js', 'chromaprint.wasm']) {
    await copyFile(new URL(file, dist), new URL(file, out));
}

console.log('vendor/ собран');
