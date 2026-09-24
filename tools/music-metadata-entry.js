// Точка входа для сборки vendor/music-metadata.js (npm run vendor).
// Браузеру нужны только эти две функции: разбор тегов из Blob и выбор обложки.
export { parseBlob, selectCover } from 'music-metadata';
