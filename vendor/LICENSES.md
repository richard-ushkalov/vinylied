# Сторонний код в vendor/

Файлы здесь собраны скриптом `npm run vendor` и коммитятся намеренно:
приложение — статика без сборки и должно работать без сети.

| Файл | Пакет | Лицензия |
|---|---|---|
| `music-metadata.js` | [music-metadata](https://github.com/Borewit/music-metadata) и его зависимости | MIT |
| `chromaprint.js`, `chromaprint.wasm` | [@unimusic/chromaprint](https://github.com/unimusic-app/unimusic-chromaprint) — сборка [Chromaprint](https://github.com/acoustid/chromaprint) в WebAssembly | обёртка MIT, Chromaprint LGPL-2.1 |

Chromaprint распространяется по LGPL-2.1: `chromaprint.wasm` лежит отдельным
файлом и может быть заменён любой совместимой сборкой без изменения приложения.
