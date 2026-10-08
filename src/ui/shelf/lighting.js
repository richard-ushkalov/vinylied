/**
 * Свет от лампы, которая стоит там же, где камера.
 *
 *   освещённость = комната + (1 − комната) · cos(угла к лампе) · спад
 *
 *  - cos — закон Ламберта: грань, повёрнутая к лампе боком, ловит меньше
 *    света, а отвёрнутая — не ловит вовсе;
 *  - спад — с квадратом расстояния; за единицу взят корешок в центре,
 *    он и есть самое яркое место полки;
 *  - комната — рассеянный свет: отвёрнутая грань не уходит в чёрное.
 *
 * Координаты — как у CSS: y вниз, z к зрителю, центр сцены в нуле.
 * Лампа — в камере, в (0, 0, distance), где distance — perspective сцены.
 *
 *                      ● лампа = камера, z = distance
 *                    ╱ │ ╲
 *                  ╱   │   ╲   у центра — ближе и прямее: ярче
 *       ▭────────▭─────┼─────▭────────▭   полка, z ≈ 0
 *       └ дальше и вкось: темнее ┘
 *
 * Без DOM — проверяется unit-тестами.
 */
const ROOM = 0.32;

/** @param {number} value */
const round = value => Math.round(value * 100) / 100;

/**
 * Во сколько раз притушить каждую видимую грань конверта.
 *
 * Нормали граней — из поворота коробки вокруг X. Поворот «рыбьего глаза»
 * у слота и подъём текущего конверта — вокруг одной оси, поэтому просто
 * складываются в angle. Для rotateX(a) из CSS:
 *   корешок (смотрел на зрителя) → (0, −sin a, cos a);
 *   верх, обложка (смотрел вверх) → (0, −cos a, −sin a);
 *   низ — ровно напротив верха.
 *
 * @param {{ y: number, z: number, angle: number, size: number,
 *           distance: number, strength: number }} slot
 *   y, z — центр слота, px; angle — поворот коробки, рад; size — ширина
 *   обложки, px; distance — где лампа; strength — 0..1, сила света
 * @returns {{ side: number, front: number, back: number }} множители яркости
 */
export const faceLight = ({ y, z, angle, size, distance, strength }) => {
    const sin = Math.sin(angle);
    const cos = Math.cos(angle);
    const reference = distance - size / 2;

    /**
     * @param {number} ny @param {number} nz нормаль грани
     * @param {number} py @param {number} pz центр грани
     */
    const lit = (ny, nz, py, pz) => {
        // от грани к лампе
        const dy = -py;
        const dz = distance - pz;
        const length = Math.hypot(dy, dz) || 1;
        const lambert = Math.max(0, (ny * dy + nz * dz) / length);
        const falloff = Math.min(1, (reference / length) ** 2);
        const light = ROOM + (1 - ROOM) * lambert * falloff;
        return round(1 - strength * (1 - light));
    };

    return {
        // корешок вынесен от центра коробки на полразмера по своей нормали
        side: lit(-sin, cos, y - sin * size / 2, z + cos * size / 2),
        front: lit(-cos, -sin, y, z),
        back: lit(cos, sin, y, z),
    };
};
