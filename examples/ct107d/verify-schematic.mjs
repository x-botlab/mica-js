/**
 * 校验 ct107d.sch：
 * 1. 解析 → 折网表 → 与 ct107d.netlist.json 逐网络对照；
 * 2. 按原理图建板跑 1 ms，确认所有器件能初始化；
 * 3. 装一段固件走完 `P2 → 74HC138 → 74HC02 → 74HC573 → LED` 链路，确认 D1 点亮、D2–D8 熄灭；
 * 4. 同一段固件按 `Y7 → U7（段码）`、`Y6 → U8（位选）` 逐位扫描，确认 DS1/DS2 的八位各锁存到写入的段码；
 * 5. 再装入原理图 U1 自带的演示固件（`assets/ct107d-demo.bin`），确认 8 位都显示 0xFF（8.8.8.8），
 *    并且走马灯逐位移动、同一时刻只有一颗 LED 点亮。
 *
 * 说明：器件模型没有 P4 端口，`P42/WR` 网络在板级验证时按 J13 的 2-3 位置接 0 V（WR 接地）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import {
  deriveSchematicTopology,
  deviceMetadataSymbol,
  parseDeviceMetadata,
  parseSchematic,
} from '@mica-js/document/schematic';
import { createBoard, createDeviceLibrary } from '@mica-js/sdk';

const PROJECT = dirname(fileURLToPath(import.meta.url));
const CHIP_IDS = [
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
  'push-button',
  'uln2003',
  'vs1838',
];
const MCU_REF = 'xbotlab:iap15f2k61s2';
const LED_REF = 'xbotlab:blue-led';
const DISPLAY_REF = 'xbotlab:seg4';

const loadDefinition = (id) =>
  parseDeviceMetadata(
    JSON.parse(readFileSync(join(PROJECT, 'src', 'devices', id, 'device.json'), 'utf8')),
  );
const loadModule = (id) =>
  import(pathToFileURL(join(PROJECT, 'dist', 'devices', id, 'device.js')).href);

const devices = new Map();
for (const id of CHIP_IDS) {
  devices.set(`xbotlab:${id}`, {
    definition: loadDefinition(id),
    module: await loadModule(id),
  });
}
for (const id of ['iap15f2k61s2', 'blue-led', 'seg4']) {
  devices.set(`xbotlab:${id}`, {
    definition: loadDefinition(id),
    module: await loadModule(id),
  });
}

const schematic = parseSchematic(readFileSync(join(PROJECT, 'ct107d.sch'), 'utf8'));
const provider = {
  getDeviceName: (reference) => devices.get(reference.raw)?.definition.displayName,
  getDeviceSymbol: (reference) => {
    const device = devices.get(reference.raw);
    return device === undefined ? undefined : deviceMetadataSymbol(device.definition);
  },
};
const topology = deriveSchematicTopology(schematic, { devices: provider });

const designatorOf = new Map(
  schematic.sheet.symbols
    .filter((symbol) => symbol.designator)
    .map((symbol) => [symbol.id, symbol.designator]),
);
const actual = new Map();
for (const net of topology.nets) {
  const key = net.name ?? `<anonymous:${net.members.map((member) => member.symbolId).join(',')}>`;
  actual.set(
    key,
    net.members
      .filter((member) => member.kind === 'pin')
      .map((member) => `${designatorOf.get(member.symbolId)}.${member.pinId}`)
      .sort(),
  );
}

const failures = [];
if (topology.danglingWireEnds.length > 0)
  failures.push(`dangling wire ends: ${topology.danglingWireEnds.length}`);

// 器件本体不应重叠（标签与引脚桩不参与）。
const bodies = schematic.sheet.symbols
  .filter((symbol) => symbol.designator)
  .map((symbol) => {
    const bounds = deviceMetadataSymbol(devices.get(symbol.device).definition).bounds;
    return {
      designator: symbol.designator,
      x: symbol.x + bounds.x,
      y: symbol.y + bounds.y,
      width: bounds.width,
      height: bounds.height,
    };
  });
for (let left = 0; left < bodies.length; left += 1) {
  for (let right = left + 1; right < bodies.length; right += 1) {
    const a = bodies[left];
    const b = bodies[right];
    if (
      a.x < b.x + b.width &&
      b.x < a.x + a.width &&
      a.y < b.y + b.height &&
      b.y < a.y + a.height
    ) {
      failures.push(`bodies overlap: ${a.designator} / ${b.designator}`);
    }
  }
}

const expected = new Map(
  Object.entries(JSON.parse(readFileSync(join(PROJECT, 'ct107d.netlist.json'), 'utf8'))),
);
for (const [name, members] of expected) {
  const found = actual.get(name);
  if (found === undefined) failures.push(`missing net ${name}`);
  else if (found.join(',') !== members.join(','))
    failures.push(`net ${name}: expected [${members}] got [${found}]`);
}
for (const [name] of actual) if (!expected.has(name)) failures.push(`unexpected net ${name}`);

const components = schematic.sheet.symbols.filter((symbol) => symbol.designator);
const ledSymbols = components.filter((symbol) => symbol.device === LED_REF);
const brightness = new Map(ledSymbols.map((symbol) => [symbol.id, 0]));
const digitValues = new Map(
  components.filter((symbol) => symbol.device === DISPLAY_REF).map((symbol) => [symbol.id, {}]),
);

/** 拦截器件话题：LED 记亮度、数码管记四位段码，其余原样转发。 */
function instrument(symbol, device) {
  return (context) => {
    const digits = digitValues.get(symbol.id);

    if (symbol.device !== LED_REF && digits === undefined) return device.module.create(context);

    return device.module.create({
      ...context,
      topics: {
        ...context.topics,
        publish(topic, payload) {
          if (topic === 'brightness' && typeof payload === 'number') {
            brightness.set(symbol.id, payload);
          } else if (
            digits !== undefined &&
            topic.startsWith('digit') &&
            typeof payload === 'number'
          ) {
            digits[topic] = payload;
          }
          context.topics.publish(topic, payload);
        },
      },
    });
  };
}

function buildBoard(firmware, wrVoltage) {
  const library = createDeviceLibrary(
    components.map((symbol) => {
      const device = devices.get(symbol.device);
      return { id: symbol.id, model: device.module.model, create: instrument(symbol, device) };
    }),
  );
  const nets = topology.nets.map((net, index) => ({
    id: `net:${index}`,
    pins: net.members
      .filter((member) => member.kind === 'pin')
      .map((member) => ({ instance: member.symbolId, pin: member.pinId })),
    ...(net.name === 'VCC'
      ? { voltage: 5 }
      : net.name === 'GND'
        ? { voltage: 0 }
        : net.name === 'P42/WR' && wrVoltage !== undefined
          ? { voltage: wrVoltage }
          : {}),
  }));
  const instances = components.map((symbol) => {
    if (symbol.device !== MCU_REF)
      return { id: symbol.id, type: symbol.id, props: symbol.properties ?? {} };
    // 原理图里 `firmware` 是资源引用；板级装配需要真实字节，因此这里用参数覆盖它。
    const rest = { ...(symbol.properties ?? {}) };
    delete rest.firmware;
    return { id: symbol.id, type: symbol.id, props: { ...rest, firmware } };
  });
  const faults = [];
  const board = createBoard(library, { instances, nets });
  board.onDidError((event) => faults.push(event.message));
  return { board, faults };
}

// 1) 空转：所有器件初始化 + 电气网络求解。
const idle = buildBoard(new Uint8Array([0x80, 0xfe]), undefined); // SJMP $
idle.board.runUntil(1_000_000_000);
idle.board.dispose();
if (idle.faults.length > 0) failures.push(`idle board faults: ${idle.faults.join('; ')}`);

// 2) 功能链路：P2 选 Y4、P0 输出 0xFE、取消片选后再改数据，锁存应保持。
//    随后按 Y7→U7（段码）、Y6→U8（位选）逐位扫描 8 个数码管位。
const Y4 = 0x80; // P2.7=1 → 138 的 Y4#，经 74HC02 送 U6 的 LE
const Y6 = 0xc0; // Y6# → U8：位选（com1–com8）
const Y7 = 0xe0; // Y7# → U7：段码（a–dp）

/** MOV P0,#byte / MOV P2,#address / MOV P2,#00H：透明写入后拉低 LE 锁存。 */
const writeLatch = (byte, address) => [
  0x75,
  0x80,
  byte, // MOV P0,#byte
  0x75,
  0xa0,
  address, // MOV P2,#address
  0x75,
  0xa0,
  0x00, // MOV P2,#00H
];

/** 依次写入八个数码管位的段码：0x06、0x5B、0x7F、0x00、0x3F、0x09、0x80、0x01。 */
const DIGIT_CODES = [0x06, 0x5b, 0x7f, 0x00, 0x3f, 0x09, 0x80, 0x01];
const SCAN = DIGIT_CODES.flatMap((code, index) => [
  ...writeLatch(0xff, Y6), // 八位都不选中
  ...writeLatch(code, Y7), // 段码
  ...writeLatch(~(1 << index) & 0xff, Y6), // 只选中第 index + 1 位
]);
const firmware = Uint8Array.from([
  0x75,
  0x94,
  0xff, // MOV P0M0,#0FFH
  0x75,
  0x93,
  0x00, // MOV P0M1,#00H
  0x75,
  0x96,
  0xe0, // MOV P2M0,#0E0H
  0x75,
  0x95,
  0x00, // MOV P2M1,#00H
  ...writeLatch(0xfe, Y4), // D1 低电平 → 经 U6 锁存
  0x75,
  0x80,
  0xff, // MOV P0,#0FFH  ; 数据变化不应影响锁存值
  ...SCAN,
  0x80,
  0xfe, // SJMP $
]);
const running = buildBoard(firmware, 0);
running.board.runUntil(30_000_000_000);
running.board.dispose();
if (running.faults.length > 0)
  failures.push(`functional board faults: ${running.faults.join('; ')}`);

const leds = [...ledSymbols].sort((left, right) => left.designator.localeCompare(right.designator));
const expectedBrightness = 5 / (1500 + 25) / 0.02;
const functionalBrightness = new Map(brightness);
for (const [index, symbol] of leds.entries()) {
  const value = brightness.get(symbol.id);
  if (index === 0) {
    if (!(Math.abs(value - expectedBrightness) < 0.005)) {
      failures.push(
        `${symbol.designator} 亮度 ${value.toFixed(4)}，期望约 ${expectedBrightness.toFixed(4)}（Y4→Y4C→U6 锁存 0xFE）`,
      );
    }
  } else if (!(value < 0.01)) {
    failures.push(`${symbol.designator} 不应点亮，实际亮度 ${value.toFixed(4)}`);
  }
}

const firstLed = leds[0];
const ds1 = digitValues.get(components.find((symbol) => symbol.designator === 'DS1').id) ?? {};
const ds2 = digitValues.get(components.find((symbol) => symbol.designator === 'DS2').id) ?? {};
const functionalDs1 = { ...ds1 };
const functionalDs2 = { ...ds2 };
for (const [designator, values, codes] of [
  ['DS1', functionalDs1, DIGIT_CODES.slice(0, 4)],
  ['DS2', functionalDs2, DIGIT_CODES.slice(4)],
]) {
  for (const [index, code] of codes.entries()) {
    const name = `digit${index + 1}`;
    if (values[name] !== code)
      failures.push(`${designator} ${name} 段码 ${values[name]}，期望 0x${code.toString(16)}`);
  }
}

// 3) 原理图自带的演示固件：8 位全亮扫描 + 走马灯。
const demoBytes = new Uint8Array(readFileSync(join(PROJECT, 'assets', 'ct107d-demo.bin')));
if (demoBytes.length === 0)
  failures.push('assets/ct107d-demo.bin 是空文件（先运行 node assemble-firmware.mjs）');
const demo = buildBoard(demoBytes, 0);
demo.board.runUntil(120_000_000_000); // 120 ms：约 8 个走马灯步
if (demo.faults.length > 0) failures.push(`demo board faults: ${demo.faults.join('; ')}`);

const demoDs1 = digitValues.get(components.find((symbol) => symbol.designator === 'DS1').id) ?? {};
const demoDs2 = digitValues.get(components.find((symbol) => symbol.designator === 'DS2').id) ?? {};
for (const [designator, values] of [
  ['DS1', demoDs1],
  ['DS2', demoDs2],
]) {
  for (const name of ['digit1', 'digit2', 'digit3', 'digit4']) {
    if (values[name] !== 0xff) {
      failures.push(`${designator} ${name} 段码 ${values[name]}，演示固件应全亮（0xFF）`);
    }
  }
}

const litNow = () =>
  [...brightness]
    .filter(([, value]) => value > 0.1)
    .map(([id]) => designatorOf.get(id) ?? id)
    .sort();
/** 采样 16 × 10 ms，记录每一刻点亮的 LED。 */
const trail = [];
for (let step = 0; step < 16; step += 1) {
  demo.board.runUntil(demo.board.time + 10_000_000_000);
  trail.push(litNow());
}
demo.board.dispose();
const seen = new Set();
for (const lit of trail) {
  if (lit.length > 1) failures.push(`同一时刻点亮了多颗 LED：${lit.join(',')}`);
  if (lit.length === 1) seen.add(lit[0]);
}
for (const symbol of leds) {
  if (!seen.has(symbol.designator)) failures.push(`走马灯没有轮到 ${symbol.designator}`);
}

console.log(
  `symbols ${schematic.sheet.symbols.length}  wires ${schematic.sheet.wires.length}  nets ${topology.nets.length}`,
);
console.log(
  `placements ${components.length}  dangling ${topology.danglingWireEnds.length}  faults ${idle.faults.length + running.faults.length}`,
);
console.log(
  `D1 brightness ${(functionalBrightness.get(firstLed.id) ?? 0).toFixed(4)}  others ${leds
    .slice(1)
    .map((symbol) => (functionalBrightness.get(symbol.id) ?? 0).toFixed(2))
    .join(' ')}`,
);
console.log(`DS1 ${JSON.stringify(functionalDs1)}  DS2 ${JSON.stringify(functionalDs2)}`);
console.log(
  `demo firmware ${demoBytes.length} 字节  走马灯 ${trail.map((lit) => lit[0] ?? '-').join(' → ')}`,
);

if (failures.length > 0) {
  for (const failure of failures) console.error(`✗ ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    '✓ 网表一致；Y4 锁存点亮 D1；Y7/Y6 扫描写入八位段码；演示固件显示 8.8.8.8 并逐位走马灯',
  );
}
