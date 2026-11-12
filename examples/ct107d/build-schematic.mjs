/**
 * 从 PDF 网表生成 CT107D 原理图（未实现器件忽略，只保留已迁移植物的引脚与内建电源/地/网标）。
 * 生成后删除；产物是 ct107d.sch。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDeviceMetadata, deviceMetadataSymbol } from '@mica-js/document/schematic';

const PROJECT = dirname(fileURLToPath(import.meta.url));
const OUTPUT = join(PROJECT, 'ct107d.sch');

const MCU_REF = 'xbotlab:iap15f2k61s2';
const LED_REF = 'xbotlab:blue-led';
const DISPLAY_REF = 'xbotlab:seg4';
const BUTTON_REF = 'xbotlab:push-button';
const CHIP_REF = (id) => `xbotlab:${id}`;
const CHIPS = [
  '74hc02',
  '74hc138',
  '74hc573',
  '74ls04',
  'at24c02',
  'cx20106a',
  'ds1302',
  'ds18b20',
  'lm386',
  'ne555',
  'pcf8591',
  'uln2003',
  'vs1838',
];

function readDefinition(id) {
  return parseDeviceMetadata(
    JSON.parse(readFileSync(join(PROJECT, 'src', 'devices', id, 'device.json'), 'utf8')),
  );
}

const definitions = new Map();
definitions.set(MCU_REF, readDefinition('iap15f2k61s2'));
definitions.set(LED_REF, readDefinition('blue-led'));
definitions.set(DISPLAY_REF, readDefinition('seg4'));
definitions.set(BUTTON_REF, readDefinition('push-button'));
for (const id of CHIPS) definitions.set(CHIP_REF(id), readDefinition(id));

const symbols = new Map();
for (const [reference, definition] of definitions) {
  symbols.set(reference, deviceMetadataSymbol(definition));
}

// ---- 网表（来自 SCH_硬件原理图V30.pdf 逐页对照）----------------------------------------
// 每项：[位号, 引脚]；未列出的引脚按 NC 处理。
const nets = new Map();
const connect = (net, members) => {
  if (nets.has(net)) throw new Error(`duplicate net ${net}`);
  nets.set(net, members);
};

// 电源
const VCC = [];
const GND = [];
for (let bit = 0; bit < 8; bit += 1) VCC.push([`D${bit + 1}`, 'anode']);
for (const [designator, pins, net] of [
  ['U1', ['VCC'], VCC],
  ['U1', ['GND'], GND],
  ['U4', ['vcc'], VCC],
  ['U4', ['gnd', 'a0', 'a1', 'a2', 'wp'], GND],
  ['U5', ['vcc'], VCC],
  ['U5', ['gnd'], GND],
  ['U6', ['vcc'], VCC],
  ['U6', ['gnd', 'oe'], GND],
  ['U7', ['vcc'], VCC],
  ['U7', ['gnd', 'oe'], GND],
  ['U8', ['vcc'], VCC],
  ['U8', ['gnd', 'oe'], GND],
  ['U9', ['vcc'], VCC],
  ['U9', ['gnd', 'oe'], GND],
  ['U10', ['com'], VCC],
  ['U10', ['gnd'], GND],
  ['U11', ['vcc'], VCC],
  ['U11', ['gnd'], GND],
  ['U14', ['vcc'], VCC],
  ['U14', ['gnd', 'inn'], GND],
  ['U15', ['vcc', 'rst'], VCC],
  ['U15', ['gnd'], GND],
  ['U16', ['vcc'], VCC],
  ['U16', ['gnd', 'ext', 'a0', 'a1', 'a2'], GND],
  ['U18', ['vcc'], VCC],
  ['U18', ['gnd'], GND],
  ['U19', ['vcc'], VCC],
  ['U19', ['gnd'], GND],
  ['U20', ['vcc'], VCC],
  ['U20', ['gnd'], GND],
  ['U24', ['vcc', 'e3'], VCC],
  ['U24', ['gnd', 'e1', 'e2'], GND],
  ['U25', ['vcc'], VCC],
  ['U25', ['gnd'], GND],
]) {
  for (const pin of pins) (net === VCC ? VCC : GND).push([designator, pin]);
}
connect('VCC', VCC);
connect('GND', GND);

// MCU 端口
const mcuPorts = {
  P00: 'P0_0',
  P01: 'P0_1',
  P02: 'P0_2',
  P03: 'P0_3',
  P04: 'P0_4',
  P05: 'P0_5',
  P06: 'P0_6',
  P07: 'P0_7',
  P10: 'P1_0',
  P11: 'P1_1',
  P12: 'P1_2',
  P13: 'P1_3',
  P14: 'P1_4',
  'P15/MOSI': 'P1_5',
  'P16/MISO': 'P1_6',
  'P17/SCK': 'P1_7',
  'P20/SCL': 'P2_0',
  'P21/SDA': 'P2_1',
  P22: 'P2_2',
  P23: 'P2_3',
  P24: 'P2_4',
  P25: 'P2_5',
  P26: 'P2_6',
  P27: 'P2_7',
  'P30/TXD': 'P3_0',
  'P31/RXD': 'P3_1',
  P32: 'P3_2',
  P33: 'P3_3',
  P34: 'P3_4',
  P35: 'P3_5',
  P36: 'P3_6',
  P37: 'P3_7',
};
for (const [net, pin] of Object.entries(mcuPorts)) connect(net, [['U1', pin]]);

// 数据总线：四颗 74HC573
for (let bit = 0; bit < 8; bit += 1) {
  const net = `P0${bit}`;
  for (const designator of ['U6', 'U7', 'U8', 'U9']) nets.get(net).push([designator, `d${bit}`]);
}

// 74HC138 → 74HC02 → 锁存 LE
nets.get('P25').push(['U24', 'a']);
nets.get('P26').push(['U24', 'b']);
nets.get('P27').push(['U24', 'c']);
connect('Y4', [
  ['U24', 'y4'],
  ['U25', 'a4'],
]);
connect('Y5', [
  ['U24', 'y5'],
  ['U25', 'a2'],
]);
connect('Y6', [
  ['U24', 'y6'],
  ['U25', 'a3'],
]);
connect('Y7', [
  ['U24', 'y7'],
  ['U25', 'a1'],
]);
connect('P42/WR', [
  ['U25', 'b1'],
  ['U25', 'b2'],
  ['U25', 'b3'],
  ['U25', 'b4'],
]);
connect('Y4C', [
  ['U25', 'y4'],
  ['U6', 'le'],
]);
connect('Y5C', [
  ['U25', 'y2'],
  ['U9', 'le'],
]);
connect('Y6C', [
  ['U25', 'y3'],
  ['U8', 'le'],
]);
connect('Y7C', [
  ['U25', 'y1'],
  ['U7', 'le'],
]);

// 74HC573 负载
for (let bit = 0; bit < 8; bit += 1)
  connect(`L${bit + 1}`, [
    ['U6', `q${bit}`],
    [`D${bit + 1}`, 'cathode'],
  ]);
const SEGMENTS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'dp'];
for (let bit = 0; bit < 8; bit += 1) connect(SEGMENTS[bit], [['U7', `q${bit}`]]);
for (let bit = 0; bit < 8; bit += 1) connect(`com${bit + 1}`, [['U8', `q${bit}`]]);
// 数码管：两片共用段总线，DS1 取 com1–com4、DS2 取 com5–com8。
for (const segment of SEGMENTS) nets.get(segment).push(['DS1', segment], ['DS2', segment]);
for (let digit = 0; digit < 4; digit += 1) {
  nets.get(`com${digit + 1}`).push(['DS1', `com${digit + 1}`]);
  nets.get(`com${digit + 5}`).push(['DS2', `com${digit + 1}`]);
}
// 按键：S4–S7 是独立按键（J5 的 2-3 短接，直接接地），S8–S19 是 3×4 矩阵键盘。
// 矩阵行为 P30/TXD、P31/RXD、P32、P33，列为 GND、P42/WR、P35、P34；S1 是复位键（VCC → RST）。
const KEY_ROWS = ['P30/TXD', 'P31/RXD', 'P32', 'P33'];
const KEYPAD = [
  { column: 'GND', keys: ['S7', 'S6', 'S5', 'S4'] },
  { column: 'P42/WR', keys: ['S11', 'S10', 'S9', 'S8'] },
  { column: 'P35', keys: ['S15', 'S14', 'S13', 'S12'] },
  { column: 'P34', keys: ['S19', 'S18', 'S17', 'S16'] },
];
for (const { column, keys } of KEYPAD) {
  for (const [row, designator] of keys.entries()) {
    nets.get(column).push([designator, 'a']);
    nets.get(KEY_ROWS[row]).push([designator, 'b']);
  }
}
nets.get('VCC').push(['S1', 'a']);
connect('RST', [['S1', 'b']]);
for (let bit = 0; bit < 7; bit += 1)
  connect(`U9Q${bit}`, [
    ['U9', `q${bit}`],
    ['U10', `in${bit + 1}`],
  ]);
connect('N_SPK', [
  ['U9', 'q7'],
  ['U14', 'inp'],
]);
connect('STEPA', [['U10', 'out1']]);
connect('STEPB', [['U10', 'out2']]);
connect('STEPC', [['U10', 'out3']]);
connect('STEPD', [['U10', 'out4']]);
connect('N_RELAY', [['U10', 'out5']]);
connect('N_MOTOR', [['U10', 'out6']]);
connect('N_BUZZ', [['U10', 'out7']]);
connect('SPK', [['U14', 'out']]);

// IR 链路：J2（1-2、5-6）按短接处理，N_B1/N_B2 并入 N_A1/N_A2
connect('N_A1', [
  ['U11', 'out'],
  ['U18', 'a2'],
]);
connect('N_A2', [['U20', 'out']]);
connect('U18N1', [
  ['U18', 'a1'],
  ['U18', 'y3'],
  ['U18', 'a4'],
]);
connect('U18N2', [
  ['U18', 'y1'],
  ['U18', 'y4'],
]);
connect('U18N3', [
  ['U18', 'y2'],
  ['U18', 'a3'],
  ['U18', 'a5'],
  ['U18', 'a6'],
]);
connect('U18N4', [
  ['U18', 'y5'],
  ['U18', 'y6'],
]);

// 定时、模拟、串行
connect('NET_SIG', [['U15', 'out']]);
nets.get('P13').push(['U19', 'rst']);
nets.get('P23').push(['U19', 'io']);
nets.get('P17/SCK').push(['U19', 'sclk']);
nets.get('P14').push(['U5', 'dq']);
nets.get('P20/SCL').push(['U4', 'scl'], ['U16', 'scl']);
nets.get('P21/SDA').push(['U4', 'sda'], ['U16', 'sda']);
connect('AIN0', [['U16', 'vin0']]);
connect('AIN1', [['U16', 'vin1']]);
connect('AIN2', [['U16', 'vin2']]);
connect('AIN3', [['U16', 'vin3']]);
connect('OUT', [['U16', 'dac']]);

// ---- 布局 -------------------------------------------------------------------------------
/** 演示固件：8 位数码管全亮扫描 + 8 路 LED 走马灯（`firmware/demo.asm`，由 assemble-firmware.mjs 汇编）。 */
const FIRMWARE = { src: 'assets/ct107d-demo.bin', mode: 'file' };
/**
 * 演示板把系统时钟降到 1 MHz：仿真按指令逐条推进，11.0592 MHz 下每个 20 ms 仿真步要跑
 * 22 万条指令，预览会被拖到每秒不到一帧；1 MHz 让扫描与走马灯在预览里保持流畅。
 */
const DEMO_CLOCK = 1_000_000;

const PLACEMENTS = [
  {
    designator: 'U1',
    device: MCU_REF,
    column: 0,
    order: 0,
    properties: { firmware: FIRMWARE, clockFrequency: DEMO_CLOCK },
  },
  { designator: 'U24', device: CHIP_REF('74hc138'), column: 0, order: 1 },
  { designator: 'U25', device: CHIP_REF('74hc02'), column: 0, order: 2 },
  { designator: 'U18', device: CHIP_REF('74ls04'), column: 1, order: 0 },
  { designator: 'U6', device: CHIP_REF('74hc573'), column: 2, order: 0 },
  { designator: 'U7', device: CHIP_REF('74hc573'), column: 2, order: 1 },
  { designator: 'U8', device: CHIP_REF('74hc573'), column: 2, order: 2 },
  { designator: 'U9', device: CHIP_REF('74hc573'), column: 2, order: 3 },
  { designator: 'U10', device: CHIP_REF('uln2003'), column: 3, order: 0 },
  { designator: 'U14', device: CHIP_REF('lm386'), column: 3, order: 1 },
  { designator: 'U11', device: CHIP_REF('cx20106a'), column: 3, order: 2 },
  { designator: 'U20', device: CHIP_REF('vs1838'), column: 3, order: 3 },
  { designator: 'U15', device: CHIP_REF('ne555'), column: 3, order: 4 },
  { designator: 'U4', device: CHIP_REF('at24c02'), column: 4, order: 0 },
  { designator: 'U16', device: CHIP_REF('pcf8591'), column: 4, order: 1 },
  { designator: 'U19', device: CHIP_REF('ds1302'), column: 4, order: 2 },
  { designator: 'U5', device: CHIP_REF('ds18b20'), column: 4, order: 3 },
  ...Array.from({ length: 8 }, (_, index) => ({
    designator: `D${index + 1}`,
    device: LED_REF,
    column: 5,
    order: index,
    properties: { forwardResistance: 1500 },
  })),
  ...['DS1', 'DS2'].map((designator, index) => ({
    designator,
    device: DISPLAY_REF,
    column: 6,
    order: index,
    properties: { forwardResistance: 1500 },
  })),
  { designator: 'S1', device: BUTTON_REF, column: 7, order: 0 },
  ...[
    ['S4', 'S5', 'S6', 'S7'],
    ['S8', 'S9', 'S10', 'S11'],
    ['S12', 'S13', 'S14', 'S15'],
    ['S16', 'S17', 'S18', 'S19'],
  ].flatMap((group, index) =>
    group.map((designator, order) => ({
      designator,
      device: BUTTON_REF,
      column: 8 + index,
      order,
    })),
  ),
];

const STUB = 40;
const MARGIN = 120;
const GAP_X = 160;
const GAP_Y = 140;

const columns = new Map();
for (const placement of PLACEMENTS) {
  const list = columns.get(placement.column) ?? [];
  list.push(placement);
  columns.set(placement.column, list);
}

// 每列宽度按符号包围盒计算；列内自上而下堆叠。
const columnWidths = new Map();
for (const [index, list] of columns) {
  let width = 0;
  for (const placement of list) {
    const bounds = symbols.get(placement.device).bounds ?? { x: 0, y: 0, width: 80, height: 40 };
    width = Math.max(width, bounds.width);
  }
  columnWidths.set(index, width);
}

const positions = new Map();
let cursorX = MARGIN;
let cursorY = MARGIN + 200; // 顶部留出标签空间
for (const index of [...columns.keys()].sort((a, b) => a - b)) {
  const list = columns.get(index);
  let y = cursorY;
  for (const placement of list) {
    const bounds = symbols.get(placement.device).bounds ?? { x: 0, y: 0, width: 80, height: 40 };
    positions.set(placement.designator, {
      x: cursorX + columnWidths.get(index) / 2,
      y: y + bounds.height / 2,
    });
    y += bounds.height + GAP_Y;
  }
  cursorX += columnWidths.get(index) + GAP_X + STUB * 2 + 220;
}

// ---- 生成图元 ---------------------------------------------------------------------------
let counter = 0;
const nextId = () => `c7d00000-0000-4000-8000-${(++counter).toString(16).padStart(12, '0')}`;

const sheetSymbols = [];
const sheetWires = [];
const netOfPin = new Map();
for (const [net, members] of nets) {
  for (const [designator, pin] of members) {
    const key = `${designator}/${pin}`;
    if (netOfPin.has(key)) throw new Error(`pin ${key} on two nets`);
    netOfPin.set(key, net);
  }
}

const placedPins = new Set();

function outwardSide(anchor) {
  return anchor.side ?? 'left';
}

function labelRotation(side) {
  return side === 'left' ? 180 : side === 'right' ? 0 : side === 'top' ? 90 : 270;
}

function powerRotation(side, kind) {
  if (kind === 'power')
    return side === 'left' ? 270 : side === 'right' ? 90 : side === 'top' ? 0 : 180;
  return side === 'left' ? 90 : side === 'right' ? 270 : side === 'top' ? 180 : 0;
}

for (const placement of PLACEMENTS) {
  const { designator, device } = placement;
  const symbol = symbols.get(device);
  const position = positions.get(designator);
  const properties = placement.properties;
  sheetSymbols.push({
    id: nextId(),
    device,
    designator,
    x: position.x,
    y: position.y,
    rotation: 0,
    ...(properties === undefined ? {} : { properties }),
  });

  for (const [pinId, anchor] of Object.entries(symbol.pins)) {
    const key = `${designator}/${pinId}`;
    const net = netOfPin.get(key);
    if (net === undefined) continue;
    const side = outwardSide(anchor);
    const pinPoint = { x: position.x + anchor.x, y: position.y + anchor.y };
    const delta =
      side === 'left'
        ? { x: -STUB, y: 0 }
        : side === 'right'
          ? { x: STUB, y: 0 }
          : side === 'top'
            ? { x: 0, y: -STUB }
            : { x: 0, y: STUB };
    const end = { x: pinPoint.x + delta.x, y: pinPoint.y + delta.y };
    sheetWires.push({ id: nextId(), points: [pinPoint, end] });
    placedPins.add(key);
    if (net === 'VCC' || net === 'GND') {
      sheetSymbols.push({
        id: nextId(),
        device: net === 'VCC' ? 'builtin:power' : 'builtin:ground',
        net,
        x: end.x,
        y: end.y,
        rotation: powerRotation(side, net === 'VCC' ? 'power' : 'ground'),
      });
    } else {
      sheetSymbols.push({
        id: nextId(),
        device: 'builtin:label',
        net,
        x: end.x,
        y: end.y,
        rotation: labelRotation(side),
      });
    }
  }
}

const document = { version: 1, sheet: { symbols: sheetSymbols, wires: sheetWires, junctions: [] } };
writeFileSync(OUTPUT, `${JSON.stringify(document, null, 2)}\n`);

const netlist = Object.fromEntries(
  [...nets].map(([name, members]) => [
    name,
    members.map(([designator, pin]) => `${designator}.${pin}`).sort(),
  ]),
);
writeFileSync(join(PROJECT, 'ct107d.netlist.json'), `${JSON.stringify(netlist, null, 2)}\n`);

// ---- 自检 -------------------------------------------------------------------------------
const unplaced = [];
for (const [reference, definition] of definitions) {
  for (const pin of Object.keys(definition.pins)) {
    for (const placement of PLACEMENTS) {
      if (placement.device !== reference) continue;
      if (!placedPins.has(`${placement.designator}/${pin}`))
        unplaced.push(`${placement.designator}/${pin}`);
    }
  }
}
const netSummary = [...nets].map(([name, members]) => `${name}(${members.length})`);
console.log('symbols', sheetSymbols.length, 'wires', sheetWires.length);
console.log('nets', nets.size);
console.log('NC pins', unplaced.length);
console.log(unplaced.join(', '));
console.log(netSummary.join(' '));
