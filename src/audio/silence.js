/**
 * Беззвучный WAV: 8 бит, моно. Нужен как «несущий» медиаэлемент —
 * см. routes/CarrierRoute.js.
 *
 * Тишина в 8-битном PCM — это 0x80, а не ноль: формат беззнаковый,
 * ноль в нём — крайнее отрицательное значение, то есть щелчок.
 *
 * @param {number} seconds
 * @param {number} [sampleRate]
 * @returns {Uint8Array<ArrayBuffer>}
 */
export const makeSilentWav = (seconds, sampleRate = 8000) => {
    const samples = Math.round(seconds * sampleRate);
    const bytes = new Uint8Array(44 + samples);
    const view = new DataView(bytes.buffer);
    const ascii = (offset, text) => [...text].forEach((ch, i) => { bytes[offset + i] = ch.charCodeAt(0); });

    ascii(0, 'RIFF');
    view.setUint32(4, 36 + samples, true);
    ascii(8, 'WAVE');
    ascii(12, 'fmt ');
    view.setUint32(16, 16, true);          // размер блока fmt
    view.setUint16(20, 1, true);           // PCM
    view.setUint16(22, 1, true);           // моно
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate, true);  // байт в секунду: 1 канал × 1 байт
    view.setUint16(32, 1, true);           // байт на кадр
    view.setUint16(34, 8, true);           // бит на сэмпл
    ascii(36, 'data');
    view.setUint32(40, samples, true);
    bytes.fill(0x80, 44);
    return bytes;
};
