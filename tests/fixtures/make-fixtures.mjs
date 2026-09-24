/**
 * Генерирует тестовые WAV-файлы: тон нужной частоты, при желании —
 * ID3-теги (UTF-8, ID3v2.4) и вшитая PNG-обложка. Бинарники в репозиторий
 * не кладём — собираем при запуске тестов в tests/fixtures/.generated.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});
const crc32 = bytes => {
    let c = 0xffffffff;
    for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
};

/** Однотонный PNG с полосой — чтобы цвет корешка было из чего взять. */
export const makePng = (size, [r, g, b]) => {
    const raw = Buffer.alloc((size * 3 + 1) * size);
    for (let y = 0; y < size; y++) {
        const row = y * (size * 3 + 1);
        raw[row] = 0;
        for (let x = 0; x < size; x++) {
            const stripe = y > size * 0.6 && y < size * 0.75;
            raw.set(stripe ? [240, 240, 240] : [r, g, b], row + 1 + x * 3);
        }
    }
    const chunk = (type, data) => {
        const out = Buffer.alloc(12 + data.length);
        out.writeUInt32BE(data.length, 0);
        out.write(type, 4, 'ascii');
        data.copy(out, 8);
        out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
        return out;
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(size, 0);
    header.writeUInt32BE(size, 4);
    header.set([8, 2, 0, 0, 0], 8);   // 8 бит, RGB
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
    ]);
};

const syncsafe = n => Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);

const frame = (id, body) => Buffer.concat([Buffer.from(id, 'ascii'), syncsafe(body.length), Buffer.alloc(2), body]);
const textFrame = (id, text) => frame(id, Buffer.concat([Buffer.from([3]), Buffer.from(text, 'utf8')]));

export const makeId3 = ({ title, artist, album, cover }) => {
    const frames = [];
    if (title) frames.push(textFrame('TIT2', title));
    if (artist) frames.push(textFrame('TPE1', artist));
    if (album) frames.push(textFrame('TALB', album));
    if (cover) {
        frames.push(frame('APIC', Buffer.concat([
            Buffer.from([0]), Buffer.from('image/png\0', 'ascii'), Buffer.from([3, 0]), cover,
        ])));
    }
    const body = Buffer.concat(frames);
    return Buffer.concat([Buffer.from('ID3', 'ascii'), Buffer.from([4, 0, 0]), syncsafe(body.length), body]);
};

export const makeWav = ({ seconds = 20, frequency = 440, sampleRate = 8000, id3 = null }) => {
    const samples = Math.round(seconds * sampleRate);
    const data = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) {
        const envelope = Math.min(1, i / 400, (samples - i) / 400);
        data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * frequency * i / sampleRate) * 9000 * envelope), i * 2);
    }
    const fmt = Buffer.alloc(16);
    fmt.writeUInt16LE(1, 0); fmt.writeUInt16LE(1, 2); fmt.writeUInt32LE(sampleRate, 4);
    fmt.writeUInt32LE(sampleRate * 2, 8); fmt.writeUInt16LE(2, 12); fmt.writeUInt16LE(16, 14);
    const chunk = (id, body) => {
        const pad = body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0);
        const head = Buffer.alloc(8);
        head.write(id, 0, 'ascii');
        head.writeUInt32LE(body.length, 4);
        return Buffer.concat([head, body, pad]);
    };
    const chunks = [chunk('fmt ', fmt), chunk('data', data)];
    if (id3) chunks.push(chunk('id3 ', id3));
    const body = Buffer.concat([Buffer.from('WAVE', 'ascii'), ...chunks]);
    const riff = Buffer.alloc(8);
    riff.write('RIFF', 0, 'ascii');
    riff.writeUInt32LE(body.length, 4);
    return Buffer.concat([riff, body]);
};

/** Набор для тестов и скриншотов. */
export const FIXTURES = [
    { file: 'kino-gruppa-krovi.wav', frequency: 220, tags: { title: 'Группа крови', artist: 'Кино', album: 'Группа крови' }, color: [200, 40, 40] },
    { file: 'aquarium-rock-n-roll.wav', frequency: 262, tags: { title: 'Рок-н-ролл мёртв', artist: 'Аквариум', album: 'Радио Африка' }, color: [30, 90, 200] },
    { file: '03 - Queen - Bohemian Rhapsody.wav', frequency: 294 },
    { file: 'garbage.wav', frequency: 330, tags: { title: 'asdf', artist: 'qwerty' } },
    { file: 'dolphin-vesna.wav', frequency: 349, tags: { title: 'Весна', artist: 'Дельфин', album: 'Существо' }, color: [40, 160, 90] },
    { file: 'zemfira-iskala.wav', frequency: 392, tags: { title: 'Искала', artist: 'Земфира', album: 'Прости меня моя любовь' }, color: [230, 190, 40] },
    { file: 'splin-vykhoda-net.wav', frequency: 440, tags: { title: 'Выхода нет', artist: 'Сплин', album: 'Раздвоение личности' } },
    { file: 'bi2-polkovnik.wav', frequency: 494, tags: { title: 'Полковнику никто не пишет', artist: 'Би-2', album: 'Би-2' }, color: [120, 60, 170] },
];

export const makeFixtures = async (dir, { seconds = 20 } = {}) => {
    await mkdir(dir, { recursive: true });
    const paths = [];
    for (const { file, frequency, tags, color } of FIXTURES) {
        const id3 = tags ? makeId3({ ...tags, cover: color ? makePng(96, color) : null }) : null;
        const path = `${dir}/${file}`;
        await writeFile(path, makeWav({ seconds, frequency, id3 }));
        paths.push(path);
    }
    return paths;
};

if (import.meta.url === `file://${process.argv[1]}`) {
    const dir = new URL('./.generated', import.meta.url).pathname;
    console.log((await makeFixtures(dir)).join('\n'));
}
