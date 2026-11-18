/**
 * 生成 CT107D 板面画布 `ct107d.cnv`。
 *
 * 坐标取自 `assets/ct107d-board.webp`（1068×768）的实测像素：
 * - 两个四位数码管的黑色窗口：DS1 (502, 206) 126×60、DS2 (636, 206) 127×60；
 * - 4 个独立按键（S7/S6/S5/S4）在 x≈143 的一列，3×4 矩阵键盘在 x≈202/261/320，
 *   行 y≈491/539/588/637，复位键 S1 在 (379, 540)。
 *
 * 每个按键/数码管的绑定端点按位号从 `legacy/source/ct107d.sch` 里查 symbol id，因此重新
 * 生成原理图后只要位号不变，画布仍然有效。产物只有 `legacy/source/ct107d.cnv`，脚本本身
 * 可重复执行。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT = dirname(fileURLToPath(import.meta.url));
const LEGACY_SOURCE = join(PROJECT, 'legacy', 'source');
const OUTPUT = join(LEGACY_SOURCE, 'ct107d.cnv');
const PACKAGE = 'xbotlab';
const BOARD = { width: 1068, height: 768 };
const IMAGE = '../../assets/ct107d-board.webp';

/** 按键热区：位号 → 中心点（照片像素）。 */
const KEYS = [
  ['S7', 143, 491],
  ['S6', 143, 540],
  ['S5', 143, 588],
  ['S4', 143, 637],
  ['S11', 202, 491],
  ['S10', 202, 539],
  ['S9', 202, 588],
  ['S8', 203, 637],
  ['S15', 261, 491],
  ['S14', 261, 539],
  ['S13', 261, 588],
  ['S12', 261, 637],
  ['S19', 320, 491],
  ['S18', 320, 539],
  ['S17', 320, 588],
  ['S16', 320, 637],
  ['S1', 379, 540],
];
const KEY_SIZE = 40;

/** 数码管窗口：位号 → 左上角与尺寸。 */
const DISPLAYS = [
  ['DS1', 502, 206, 126, 60],
  ['DS2', 636, 206, 127, 60],
];
const DIGIT_PORTS = ['digit1', 'digit2', 'digit3', 'digit4'];

/**
 * LED D1–D8：照片上 R32/R33/R40–R45 下方那排 8 个贴片 LED（丝印 L1–L8），
 * 实测中心 x = 338.5…476.5（间距约 19.7）、y ≈ 319。
 */
const LEDS = [
  ['D1', 338.5],
  ['D2', 358.5],
  ['D3', 378],
  ['D4', 398],
  ['D5', 417.5],
  ['D6', 437],
  ['D7', 457],
  ['D8', 476.5],
];
const LED_SIZE = { width: 18, height: 26 };
const LED_CENTER_Y = 319;

/** 执行器与跳线：照片上的 SP1、K1、J13。 */
const BUZZERS = [['SP1', 718, 390, 60, 60]];
const RELAYS = [['K1', 806, 389, 88, 62]];
const JUMPERS = [['J13', 310, 406, 42, 72]];
const HEADERS = [['J2', 596, 168, 76, 64]];

const schematic = JSON.parse(readFileSync(join(LEGACY_SOURCE, 'ct107d.sch'), 'utf8'));
const symbols = new Map(
  schematic.sheet.symbols
    .filter((symbol) => typeof symbol.designator === 'string')
    .map((symbol) => [symbol.designator, symbol]),
);

function symbolOf(designator) {
  const symbol = symbols.get(designator);
  if (symbol === undefined) throw new Error(`原理图里找不到位号 ${designator}`);
  return symbol.id;
}

let counter = 0;
const nextId = () => `b0a1d000-0000-4000-8000-${(++counter).toString(16).padStart(12, '0')}`;

const widgets = [
  {
    id: nextId(),
    widget: `${PACKAGE}:image`,
    x: 0,
    y: 0,
    width: BOARD.width,
    height: BOARD.height,
    rotation: 0,
    properties: { image: { src: IMAGE, mode: 'file' } },
  },
];

for (const [designator, cx, cy] of KEYS) {
  widgets.push({
    id: nextId(),
    widget: `${PACKAGE}:button`,
    x: cx - KEY_SIZE / 2,
    y: cy - KEY_SIZE / 2,
    width: KEY_SIZE,
    height: KEY_SIZE,
    rotation: 0,
    properties: { color: '#38bdf8ff', radius: 8 },
    bindings: { press: { symbol: symbolOf(designator), port: 'press' } },
  });
}

for (const [designator, x, y, width, height] of DISPLAYS) {
  const symbol = symbolOf(designator);
  widgets.push({
    id: nextId(),
    widget: `${PACKAGE}:segment`,
    x,
    y,
    width,
    height,
    rotation: 0,
    properties: { color: '#ff3b30ff', background: '#0b0d0eff' },
    bindings: Object.fromEntries(DIGIT_PORTS.map((port) => [port, { symbol, port }])),
  });
}

for (const [designator, cx] of LEDS) {
  widgets.push({
    id: nextId(),
    widget: `${PACKAGE}:led-indicator`,
    x: cx - LED_SIZE.width / 2,
    y: LED_CENTER_Y - LED_SIZE.height / 2,
    width: LED_SIZE.width,
    height: LED_SIZE.height,
    rotation: 0,
    properties: { color: '#ff4d4fff' },
    bindings: { brightness: { symbol: symbolOf(designator), port: 'brightness' } },
  });
}

for (const [designator, cx, cy, width, height] of BUZZERS) {
  widgets.push({
    id: nextId(),
    widget: `${PACKAGE}:buzzer`,
    x: cx - width / 2,
    y: cy - height / 2,
    width,
    height,
    rotation: 0,
    properties: { color: '#f59e0bff', label: designator },
    bindings: { active: { symbol: symbolOf(designator), port: 'active' } },
  });
}

for (const [designator, cx, cy, width, height] of RELAYS) {
  widgets.push({
    id: nextId(),
    widget: `${PACKAGE}:relay`,
    x: cx - width / 2,
    y: cy - height / 2,
    width,
    height,
    rotation: 0,
    properties: { color: '#f59e0bff', label: designator },
    bindings: { energized: { symbol: symbolOf(designator), port: 'energized' } },
  });
}

for (const [designator, cx, cy, width, height] of JUMPERS) {
  const symbol = symbolOf(designator);
  widgets.push({
    id: nextId(),
    widget: `${PACKAGE}:jumper`,
    x: cx - width / 2,
    y: cy - height / 2,
    width,
    height,
    rotation: 0,
    properties: { color: '#22c55eff', label: designator, channels: 1, closed1: true },
    bindings: {
      state1: { symbol, port: 'closedState' },
      closed1: { symbol, port: 'control' },
    },
  });
}

for (const [designator, cx, cy, width, height] of HEADERS) {
  const symbol = symbolOf(designator);
  widgets.push({
    id: nextId(),
    widget: `${PACKAGE}:jumper`,
    x: cx - width / 2,
    y: cy - height / 2,
    width,
    height,
    rotation: 0,
    properties: {
      color: '#22c55eff',
      label: designator,
      label1: '1-3',
      label2: '2-4 / 4-6',
      channels: 2,
      fixed1: true,
      closed1: true,
      closed2: true,
    },
    bindings: {
      state2: { symbol, port: 'closedState2' },
      closed2: { symbol, port: 'control2' },
    },
  });
}

const document = { version: 1, schematic: 'ct107d.sch', widgets };
writeFileSync(OUTPUT, `${JSON.stringify(document, null, 2)}\n`);
console.log(
  'widgets',
  widgets.length,
  `（按键 ${KEYS.length}、数码管 ${DISPLAYS.length}、LED ${LEDS.length}、蜂鸣器 ${BUZZERS.length}、继电器 ${RELAYS.length}、跳线 J13 ${JUMPERS.length}、跳线 J2 ${HEADERS.length}、背景图 1）`,
);
