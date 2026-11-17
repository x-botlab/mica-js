/**
 * 校验 ct107d.sch：
 * 1. 解析 → 折网表 → 与 ct107d.netlist.json 逐网络对照；
 * 2. 按原理图建板跑 1 ms，确认所有器件能初始化；
 * 3. 装一段固件走完 `P2 → 74HC138 → 74HC02 → 74HC573 → LED` 链路，确认 D1 点亮、D2–D8 熄灭；
 * 4. 同一段固件按 `Y7 → U7（段码）`、`Y6 → U8（位选）` 逐位扫描，确认 DS1/DS2 的八位各锁存到写入的段码；
 * 5. 再装入 `assets/ct107d-demo.bin`，确认 8 位都显示 0xFF（8.8.8.8），
 *    并且走马灯逐位移动、同一时刻只有一颗 LED 点亮；
 * 6. 用临时探针/电压源核对 U21（霍尔）、U26（可调放大）与 LD1（红外发射）的接线。
 *
 * 说明（legacy 两脚投影）：原理图里 J13 的 2-3 位置把独立的 `WR` 网络接到 GND；
 * `P42` 是 MCU/键盘独立网络，不再与 WR 合并。J13 的 1-2（WR 跟随 P42）与 J5 的
 * 1-2（S4-S7 接 P44）由融合器件的三针 selector 行为覆盖，本 legacy 脚本只装配
 * 默认 2-3 位置，不声称验证这两种 matrix/memory 模式。
 *
 * 器件来自 `examples/devices/dist/<id>/{package.json, model.js}`（统一器件包），
 * 先运行 `pnpm --filter @mica-js/example-devices build`。旧 `.sch v1` 需要的符号由
 * `legacy/schematic-metadata.mjs` 按清单引脚合成。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveSchematicTopology, parseSchematic } from '@mica-js/document/schematic';
import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import { compileDDL } from '@mica-js/sdk/ddl';
import { loadLegacyDevice, legacyCreateWithFirmware } from './legacy/device-package.mjs';
import { legacyDeviceSymbol, loadDevicePackage } from './legacy/schematic-metadata.mjs';

const PROJECT = dirname(fileURLToPath(import.meta.url));
const DEVICES_PROJECT = join(PROJECT, '..', 'devices');
const MCU_REF = 'xbotlab:iap15f2k61s2';
const LED_REF = 'xbotlab:blue-led';
const DISPLAY_REF = 'xbotlab:seg4';
const IR_EMITTER_REF = 'xbotlab:ir-emitter';

const schematic = parseSchematic(readFileSync(join(PROJECT, 'ct107d.sch'), 'utf8'));
const components = schematic.sheet.symbols.filter((symbol) => symbol.designator);

/** 原理图引用 → 统一器件包（清单 + 旧模型桥 + 合成符号）。 */
const devices = new Map();
for (const reference of new Set(components.map((symbol) => symbol.device))) {
  const id = reference.slice('xbotlab:'.length);
  const { manifest } = loadDevicePackage(DEVICES_PROJECT, id);
  const loaded = await loadLegacyDevice(join(DEVICES_PROJECT, 'dist'), id);
  devices.set(reference, {
    manifest,
    symbol: legacyDeviceSymbol(manifest),
    module: loaded.module,
    package: loaded,
  });
}

const provider = {
  getDeviceName: (reference) => devices.get(reference.raw)?.manifest.displayName,
  getDeviceSymbol: (reference) => devices.get(reference.raw)?.symbol,
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
const bodies = components.map((symbol) => {
  const bounds = devices.get(symbol.device).symbol.bounds;
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

const ledSymbols = components.filter((symbol) => symbol.device === LED_REF);
const brightness = new Map(ledSymbols.map((symbol) => [symbol.id, 0]));
const digitValues = new Map(
  components.filter((symbol) => symbol.device === DISPLAY_REF).map((symbol) => [symbol.id, {}]),
);
/** 红外发射管的载波状態：由 `carrier` 话题记录。 */
const carrierStates = new Map(
  components
    .filter((symbol) => symbol.device === IR_EMITTER_REF)
    .map((symbol) => [symbol.id, false]),
);

/** 拦截器件话题：LED 记亮度、数码管记四位段码、红外发射记载波，其余原样转发。 */
function instrument(symbol, device, firmware) {
  // 原理图里 `firmware` 是资源引用，实例属性只保留可校验的属性；固件按字节注入工厂上下文。
  const create =
    symbol.device === MCU_REF
      ? legacyCreateWithFirmware(device.package, firmware)
      : device.module.create;

  return (context) => {
    const digits = digitValues.get(symbol.id);
    const carrier = symbol.device === IR_EMITTER_REF;

    if (symbol.device !== LED_REF && digits === undefined && !carrier) return create(context);

    return create({
      ...context,
      topics: {
        ...context.topics,
        publish(topic, payload) {
          if (topic === 'brightness' && typeof payload === 'number') {
            brightness.set(symbol.id, payload);
          } else if (topic === 'carrier' && typeof payload === 'boolean') {
            carrierStates.set(symbol.id, payload);
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

function buildBoard(firmware, extras = []) {
  const entries = components.map((symbol) => {
    const device = devices.get(symbol.device);
    return {
      id: symbol.id,
      model: device.module.model,
      create: instrument(symbol, device, firmware),
    };
  });
  const netList = topology.nets.map((net, index) => ({
    id: `net:${index}`,
    name: net.name,
    pins: net.members
      .filter((member) => member.kind === 'pin')
      .map((member) => ({ instance: member.symbolId, pin: member.pinId })),
  }));
  const netByName = new Map(
    netList.filter((net) => net.name !== undefined).map((net) => [net.name, net]),
  );
  const instances = components.map((symbol) => {
    const props = { ...(symbol.properties ?? {}) };
    // `firmware` 是资源引用，不属于 DDL 属性；板级装配走 `legacyCreateWithFirmware`。
    if (symbol.device === MCU_REF) delete props.firmware;
    return { id: symbol.id, type: symbol.id, props };
  });
  // 附加只在校验板上存在的探针/电压源；它们不属于 `ct107d.sch`。
  for (const extra of extras) {
    entries.push({ id: extra.id, model: extra.model, create: extra.create });
    instances.push({ id: extra.id, type: extra.id, props: extra.props ?? {} });
    for (const [name, pin] of Object.entries(extra.nets ?? {})) {
      const target = netByName.get(name);
      if (target === undefined) {
        const created = { id: `net:extra:${name}`, name, pins: [{ instance: extra.id, pin }] };
        netList.push(created);
        netByName.set(name, created);
      } else target.pins.push({ instance: extra.id, pin });
    }
  }
  // `createBoard` 的网络只接受 id/pins/voltage；`name` 是校验脚本内部索引，不传给板。
  const nets = netList.map((net) => ({
    id: net.id,
    pins: net.pins,
    ...(net.name === 'VCC' ? { voltage: 5 } : net.name === 'GND' ? { voltage: 0 } : {}),
  }));
  const faults = [];
  const board = createBoard(createDeviceLibrary(entries), { instances, nets });
  board.onDidError((event) => faults.push(event.message));
  return { board, faults };
}

// 1) 空转：所有器件初始化 + 电气网络求解。
const idle = buildBoard(new Uint8Array([0x80, 0xfe])); // SJMP $
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

/** 依次写入八个数码管位的段码（共阳驱动码）：0、1、2、3、4、5、6、7。 */
const DIGIT_CODES = [0xc0, 0xf9, 0xa4, 0xb0, 0x99, 0x92, 0x82, 0xf8];
/** MOV R7,#0 / DJNZ R7,$：256 × 4 个 1T 周期，12 MHz 下约 85 µs，覆盖默认 50 µs 稳定窗口。 */
const SETTLE_DELAY = [0x7f, 0x00, 0xdf, 0xfe];
const SCAN = DIGIT_CODES.flatMap((code, index) => [
  ...writeLatch(0x00, Y6), // 八位都不选中（共阳：位选全低）
  ...writeLatch(code, Y7), // 段码
  ...writeLatch(1 << index, Y6), // 只选中第 index + 1 位
  ...SETTLE_DELAY, // 保持选中，等待 seg4 的稳定窗口提交段码
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
const running = buildBoard(firmware);
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
    // 段码端口按「点亮的段」编码，共阳驱动码因此取反。
    const expected = ~code & 0xff;
    if (values[name] !== expected)
      failures.push(
        `${designator} ${name} 段码 ${values[name]}，期望 0x${expected.toString(16)}（驱动码 0x${code.toString(16)}）`,
      );
  }
}

// 3) 原理图自带的演示固件：8 位全亮扫描 + 走马灯。
const demoBytes = new Uint8Array(readFileSync(join(PROJECT, 'assets', 'ct107d-demo.bin')));
if (demoBytes.length === 0)
  failures.push('assets/ct107d-demo.bin 是空文件（先运行 node assemble-firmware.mjs）');
const demo = buildBoard(demoBytes);
/**
 * 采样步长与 Playground 画布预览一致（2 ms）。74HC573 的 LE 脉冲只有几百 µs，
 * 电气网络只在推进边界求解；步长拉到 10 ms 时大部分脉冲落在两次采样之间，
 * 走马灯会看起来卡住——这是采样粒度问题，不是固件行为。
 */
const SAMPLE_PS = 2_000_000_000;
for (let step = 0; step < 60; step += 1) demo.board.runUntil(demo.board.time + SAMPLE_PS); // 120 ms 预热
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
/** 采样 250 × 2 ms（约 4 个走马灯周期），记录每一刻点亮的 LED。 */
const trail = [];
for (let step = 0; step < 250; step += 1) {
  demo.board.runUntil(demo.board.time + SAMPLE_PS);
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

// 4) 扩展器件接线：霍尔（U21）、可调放大前端（U26）与红外发射支路（LD1）。
//    三者的板外端口在基准图纸上落到尚未建模的 J3/J7 排针，因此用临时探针与电压源
//    核对 `N_HALL`、`IN+`/`IN-`、`AIN2` 与 `N_A2` 的连通性；这些附加实例只存在于
//    本次校验板，不写入 `ct107d.sch`。
const probeModel = await compileDDL(
  `device TestProbe {
     pin y;
     output channel voltage: number(capacity: 8, overflow: Overflow.drop_oldest);
     pure fn voltageOf(sampled: number?) -> number {
       if sampled == none {
         return -1;
       }
       return sampled;
     }
     derived sampledVoltage: number = voltageOf(y.sample.voltage);
     process start {
       voltage.send(sampledVoltage);
     }
     process changed on sampledVoltage {
       voltage.send(sampledVoltage);
     }
   }`,
);
/** 固定分压电压源：p 的电压 = 5 V × lowOhms / (highOhms + lowOhms)。 */
const sourceModel = async (highOhms, lowOhms) =>
  compileDDL(`device TestSource {
     pin p = [
       resistor(to: vcc, resistance: ${highOhms}),
       resistor(to: gnd, resistance: ${lowOhms})
     ];
     pin vcc;
     pin gnd;
   }`);
const sourceInPlus = await sourceModel(4000, 1000); // 1.0 V
const sourceInMinus = await sourceModel(4100, 900); // 0.9 V
const sourceNA2 = await sourceModel(500, 4500); // 4.5 V

const probeReadings = new Map();
const isProbe = (model) => model === probeModel;
const extras = [
  { id: 'probe_hall', net: 'N_HALL', pin: 'y' },
  { id: 'probe_ain2', net: 'AIN2', pin: 'y' },
  { id: 'source_in_plus', net: 'IN+', pin: 'p', supply: true, model: sourceInPlus },
  { id: 'source_in_minus', net: 'IN-', pin: 'p', supply: true, model: sourceInMinus },
  // `N_A2` 在 J2 不插跳线帽时悬空；这里用 4.5 V 源把发射支路驱动到高电平。
  { id: 'source_n_a2', net: 'N_A2', pin: 'p', supply: true, model: sourceNA2 },
].map((extra) => {
  const model = extra.model ?? probeModel;
  return {
    id: extra.id,
    model,
    props: {},
    nets:
      extra.supply === undefined
        ? { [extra.net]: extra.pin }
        : { [extra.net]: extra.pin, VCC: 'vcc', GND: 'gnd' },
    create: isProbe(model)
      ? () => ({
          sync(batch) {
            const entry = probeReadings.get(extra.id) ?? {};
            for (const message of batch.outputs.voltage ?? []) entry.voltage = message.value;
            probeReadings.set(extra.id, entry);
          },
          dispose() {},
        })
      : () => ({ sync() {}, dispose() {} }),
  };
});

const extension = buildBoard(new Uint8Array([0x80, 0xfe]), extras);
extension.board.runUntil(5_000_000_000); // 5 ms：覆盖 lm324 的 10 µs 采样周期
if (extension.faults.length > 0)
  failures.push(`extension board faults: ${extension.faults.join('; ')}`);

const hall = components.find((symbol) => symbol.device === 'xbotlab:hall');
const lm324 = components.find((symbol) => symbol.device === 'xbotlab:lm324');
const emitter = components.find((symbol) => symbol.device === IR_EMITTER_REF);
if (hall === undefined) failures.push('原理图缺少霍尔（U21）实例');
if (lm324 === undefined) failures.push('原理图缺少可调放大前端（U26）实例');
if (emitter === undefined) failures.push('原理图缺少红外发射管（LD1）实例');

// 霍尔：默认磁场 0 mT → 开漏释放，`N_HALL` 悬空（电压 none → -1）；磁场达吸合点后拉低。
const hallVoltage = () => probeReadings.get('probe_hall')?.voltage ?? 0;
if (hallVoltage() !== -1) failures.push(`N_HALL 在释放状态应为悬空（-1），实际 ${hallVoltage()}`);
extension.board.topics.publish('setField', 20);
extension.board.runUntil(extension.board.time + 5_000_000_000);
if (!(hallVoltage() >= 0 && hallVoltage() < 0.1))
  failures.push(`U21 吸合后 N_HALL 应被拉低，实际 ${hallVoltage().toFixed(3)} V`);

// lm324：IN+ = 1.0 V、IN- = 0.9 V，默认滑臂 gain = 21 → AIN2 ≈ 2.1 V。
const aIn2 = () => probeReadings.get('probe_ain2')?.voltage ?? -1;
if (!(Math.abs(aIn2() - 2.1) < 0.15))
  failures.push(`U26 默认增益下 AIN2 应约 2.1 V，实际 ${aIn2().toFixed(3)} V`);
extension.board.topics.publish('setWiper', 1); // 增益 2001 → 200 V，被电源轨夹到 5 V
extension.board.runUntil(extension.board.time + 5_000_000_000);
if (!(aIn2() > 4.5))
  failures.push(`U26 最大增益下 AIN2 应饱和到电源轨，实际 ${aIn2().toFixed(3)} V`);

// 红外发射：`N_A2` 的 4.5 V 应让 LD1 的 mod 判定为高，载波开启。
const emitterCarrier = emitter === undefined ? undefined : carrierStates.get(emitter.id);
if (emitterCarrier !== true) failures.push('N_A2 为高时 LD1 的载波应为开启');
extension.board.dispose();

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
  `U21 N_HALL ${hallVoltage().toFixed(3)} V（吸合）  U26 AIN2 ${aIn2().toFixed(3)} V（最大增益）  LD1 carrier ${String(emitterCarrier)}`,
);
console.log(
  `demo firmware ${demoBytes.length} 字节  走马灯 ${trail.map((lit) => lit[0] ?? '-').join(' → ')}`,
);

if (failures.length > 0) {
  for (const failure of failures) console.error(`✗ ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    '✓ 网表一致；Y4 锁存点亮 D1；Y7/Y6 扫描写入八位段码；演示固件显示 8.8.8.8 并逐位走马灯；U21/U26/LD1 接线可观测',
  );
}
