#!/usr/bin/env node
/**
 * 无头验证：把 `led8.sch` 折成网表，装载 `../devices` 里 IAP15F2K61S2 与 blue-led 的交付产物，
 * 用 `Project.hex` 的固件跑真实仿真，检查 8 颗 LED 是否按 P2.0 → P2.7 依次点亮。
 *
 * 用法：node verify.mjs [--ms 800] [--quiet]
 *
 * 说明：
 * - 固件属性是「裸二进制」，因此 `Project.bin` 是 `Project.hex` 去掉 Intel HEX 记录后的
 *   字节映像；缺失时脚本会就地转换 `Project.hex`。
 * - 固件的延时子程序是 `DJNZ` 紧循环；节拍点覆盖每个回跳（见 iap15f2k61s2 README），
 *   但节拍块只累加时间与门控，外设推进集中在共享服务块，0.8 s 仿真实测约 1.6 s 墙钟。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  loadLegacyDevice,
  legacyCreateWithFirmware,
} from '../devices/test/support/legacy-device-package.mjs';

const HERE = import.meta.dirname;
const DEVICES_PROJECT = join(HERE, '..', 'devices');
const MCU_PROJECT = DEVICES_PROJECT;
const LED_PROJECT = DEVICES_PROJECT;

const MCU_REF = 'xbotlab:iap15f2k61s2';
const LED_REF = 'xbotlab:blue-led';
const SUPPLY = 5;
const BUDGET_MS = readArgument('--ms', 800);
const QUIET = process.argv.includes('--quiet');
const STEP_MS = 10;

/** 读参数：`--name value`，缺省时回退。 */
function readArgument(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} expects a positive number`);
  return value;
}

/** 优先使用本工程安装的工具链，回退到同目录器件工程的已装依赖。 */
async function loadToolchain() {
  try {
    return {
      document: await import('@mica-js/document/schematic'),
      sdk: await import('@mica-js/sdk'),
    };
  } catch (cause) {
    if (!QUIET)
      console.warn(
        `本工程未安装 @mica-js 工具链，改用器件工程的依赖（${cause.code ?? cause.message}）`,
      );
    const base = pathToFileURL(join(HERE, '..', 'devices', 'node_modules', '@mica-js') + '/');
    return {
      document: await import(new URL('document/dist/schematic/index.js', base)),
      sdk: await import(new URL('sdk/dist/index.js', base)),
    };
  }
}

/** Intel HEX → 裸二进制映像；器件把字节写到 0000H 起的程序存储器。 */
function parseIntelHex(text) {
  const bytes = new Map();
  let base = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith(':')) continue;
    const record = Buffer.from(line.slice(1), 'hex');
    const length = record[0];
    const address = (record[1] << 8) | record[2];
    const type = record[3];
    const payload = record.subarray(4, 4 + length);
    if (type === 0x00) {
      for (let index = 0; index < length; index += 1)
        bytes.set(base + address + index, payload[index]);
    } else if (type === 0x01) break;
    else if (type === 0x02) base = ((payload[0] << 8) | payload[1]) << 4;
    else if (type === 0x04) base = ((payload[0] << 8) | payload[1]) << 16;
  }
  const highest = Math.max(...bytes.keys());
  const image = new Uint8Array(highest + 1);
  for (const [address, value] of bytes) image[address] = value;
  return image;
}

function readFirmware(src) {
  const binary = join(HERE, src);
  if (existsSync(binary)) return new Uint8Array(readFileSync(binary));
  if (!QUIET) console.warn(`${src} 不存在，就地转换 Project.hex`);
  return parseIntelHex(readFileSync(join(HERE, 'Project.hex'), 'utf8'));
}

/** 读取器件产物：统一清单 + 显式旧 simulator 工厂桥。 */
async function loadDevice(project, deviceId) {
  const loaded = await loadLegacyDevice(join(project, 'dist'), deviceId);
  return { manifest: loaded.manifest, module: loaded.module };
}

/** 实例属性：器件清单默认值 + 原理图覆盖；资源引用换成字节。 */
function resolveProperties(symbol, manifest, assets) {
  const values = Object.create(null);
  for (const [key, descriptor] of Object.entries(manifest.properties ?? {})) {
    if (Object.hasOwn(descriptor, 'default')) values[key] = descriptor.default;
  }
  Object.assign(values, symbol.properties);
  const props = Object.create(null);
  for (const [key, value] of Object.entries(values)) {
    if (value !== null && typeof value === 'object' && typeof value.src === 'string') {
      const bytes = assets?.get(value.src);
      if (bytes === undefined) throw new Error(`${symbol.id}.${key} 缺少资源 ${value.src}`);
      props[key] = new Uint8Array(bytes);
    } else {
      props[key] = value;
    }
  }
  return props;
}

const { document: doc, sdk } = await loadToolchain();
const mcu = await loadDevice(MCU_PROJECT, 'iap15f2k61s2');
const led = await loadDevice(LED_PROJECT, 'blue-led');

const schematic = doc.parseSchematic(readFileSync(join(HERE, 'led8.sch'), 'utf8'));
const firmwareSource =
  schematic.sheet.symbols.find((symbol) => symbol.device === MCU_REF)?.properties?.firmware?.src ??
  'Project.bin';
const firmware = readFirmware(firmwareSource);

const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

const components = schematic.sheet.symbols.filter(
  (symbol) => symbol.device === MCU_REF || symbol.device === LED_REF,
);
const ledSymbols = components.filter((symbol) => symbol.device === LED_REF);
const mcuSymbol = components.find((symbol) => symbol.device === MCU_REF);
if (mcuSymbol === undefined) throw new Error('原理图缺少 IAP15F2K61S2');
check(ledSymbols.length === 8, `原理图应有 8 颗蓝色 LED，实际 ${ledSymbols.length}`);

const byDesignator = new Map(components.map((symbol) => [symbol.designator, symbol]));
const assets = new Map([[mcuSymbol.id, new Map([[firmwareSource, firmware]])]]);
const instances = components.map((symbol) => {
  const manifest = symbol.device === MCU_REF ? mcu.manifest : led.manifest;
  const props = resolveProperties(symbol, manifest, assets.get(symbol.id));
  // 旧原理图把固件保存为资源引用；统一模型由工厂包装接收 FirmwareImage。
  if (symbol === mcuSymbol) delete props.firmware;
  return { id: symbol.id, type: symbol.id, props };
});

const pin = (designator, name) => {
  const symbol = byDesignator.get(designator);
  if (symbol === undefined) throw new Error(`原理图缺少位号 ${designator}`);
  return { instance: symbol.id, pin: name };
};
const nets = [
  {
    id: 'vcc',
    voltage: SUPPLY,
    pins: [
      pin('U1', 'VCC'),
      ...ledSymbols.map((symbol) => ({ instance: symbol.id, pin: 'anode' })),
    ],
  },
  { id: 'gnd', voltage: 0, pins: [pin('U1', 'GND')] },
  ...Array.from({ length: 8 }, (_, bit) => ({
    id: `P2_${bit}`,
    pins: [pin('U1', `P2_${bit}`), pin(`D${bit + 1}`, 'cathode')],
  })),
];

// 拓扑检查：P2.0–P2.7 各接一颗 LED 阴极，所有阴极与阳极都有明确网络。
const netOfPin = new Map();
for (const net of nets)
  for (const endpoint of net.pins) netOfPin.set(`${endpoint.instance}/${endpoint.pin}`, net.id);
for (let bit = 0; bit < 8; bit += 1) {
  const cathode = netOfPin.get(`${pin(`D${bit + 1}`, 'cathode').instance}/cathode`);
  check(cathode === `P2_${bit}`, `D${bit + 1} 阴极应在 P2_${bit}，实际 ${cathode ?? '悬空'}`);
  check(
    netOfPin.get(`${pin('U1', `P2_${bit}`).instance}/P2_${bit}`) === `P2_${bit}`,
    `P2.${bit} 未接线`,
  );
  const anode = byDesignator.get(`D${bit + 1}`);
  check(anode !== undefined && netOfPin.has(`${anode.id}/anode`), `D${bit + 1} 阳极未接 VCC`);
}
check(nets[0].pins.length === 9, 'VCC 网络应连接 MCU 电源脚与 8 颗 LED 阳极');
check(nets[1].pins.length === 1, 'GND 网络应连接 MCU 地脚');

const brightness = new Map(ledSymbols.map((symbol) => [symbol.id, 0]));
const library = sdk.createDeviceLibrary([
  {
    id: mcuSymbol.id,
    model: mcu.module.model,
    create: legacyCreateWithFirmware(mcu, firmware),
  },
  ...ledSymbols.map((symbol) => ({
    id: symbol.id,
    model: led.module.model,
    create: (context) =>
      led.module.create({
        ...context,
        topics: {
          ...context.topics,
          publish(topic, payload) {
            if (topic === 'brightness' && typeof payload === 'number') {
              brightness.set(symbol.id, payload);
            }
            context.topics.publish(topic, payload);
          },
        },
      }),
  })),
]);

const board = sdk.createBoard(library, { instances, nets });
const boardErrors = [];
board.onDidError((event) => boardErrors.push(event.message));

const lit = () =>
  ledSymbols.filter((symbol) => brightness.get(symbol.id) > 0.2).map((symbol) => symbol.designator);
const transitions = [];
const started = Date.now();

for (let elapsed = STEP_MS; elapsed <= BUDGET_MS; elapsed += STEP_MS) {
  board.runUntil(elapsed * 1_000_000_000);
  const on = lit();
  const previous = transitions.length === 0 ? [] : transitions[transitions.length - 1].on;
  if (on.join(',') !== previous.join(',')) transitions.push({ ms: elapsed, on });
}

board.dispose();

const seen = new Set(transitions.flatMap((entry) => entry.on));
check(boardErrors.length === 0, `仿真报告错误：${boardErrors.join('; ')}`);
check(transitions.length > 0, '仿真窗口内没有观察到任何 LED 点亮');

for (const entry of transitions) {
  check(
    entry.on.length <= 1,
    `t=${entry.ms} ms 同时点亮 ${entry.on.join(',')}（走马灯应只有一颗）`,
  );
}

const order = [];
for (const entry of transitions) {
  if (entry.on.length !== 1) continue;
  const name = entry.on[0];
  if (order[order.length - 1] !== name) order.push(name);
}
const expectedOrder = Array.from({ length: 8 }, (_, index) => `D${index + 1}`);
const firstCycle = order.slice(0, 8);
check(
  firstCycle.join(',') === expectedOrder.join(','),
  `点亮顺序应为 ${expectedOrder.join(' → ')}，实际 ${order.join(' → ') || '无'}`,
);
check(seen.size === 8, `只观察到 ${seen.size} 颗 LED 点亮：${[...seen].join(',')}`);

const firstOn = new Map();
for (const entry of transitions) {
  for (const name of entry.on) if (!firstOn.has(name)) firstOn.set(name, entry.ms);
}

const expectedBrightness = (symbol) => {
  const props = resolveProperties(symbol, led.manifest, undefined);
  return {
    ohms: props.forwardResistance,
    amps: props.ratedCurrent,
    value: SUPPLY / (props.forwardResistance + 25) / props.ratedCurrent,
  };
};
for (const symbol of ledSymbols) {
  const value = brightness.get(symbol.id);
  if (value <= 0.2) continue;
  const expected = expectedBrightness(symbol);
  check(
    Math.abs(value - expected.value) < 0.01,
    `${symbol.designator} 亮度 ${value.toFixed(4)} 与 5 V/(${expected.ohms} Ω+25 Ω)/${expected.amps * 1000} mA ≈ ${expected.value.toFixed(4)} 不符`,
  );
}

if (!QUIET) {
  console.log('器件：');
  console.log(
    `  U1  ${MCU_REF}  ${firmware.length} 字节固件，${mcu.manifest.properties.clockFrequency.default} Hz`,
  );
  console.log(
    `  D1–D8  ${LED_REF}  ${led.manifest.properties.forwardResistance.default} Ω / ${led.manifest.properties.ratedCurrent.default * 1000} mA`,
  );
  console.log(
    `网表：${nets.length} 个网络，VCC 接 ${nets[0].pins.length} 个引脚，GND 接 ${nets[1].pins.length} 个引脚`,
  );
  console.log('');
  console.log('点亮时间线：');
  for (const entry of transitions) {
    console.log(
      `  t=${String(entry.ms).padStart(4)} ms  ${entry.on.length === 0 ? '—' : entry.on.join(' + ')}`,
    );
  }
  console.log('');
  console.log('首次点亮：');
  for (const name of expectedOrder) {
    const ms = firstOn.get(name);
    console.log(`  ${name}  ${ms === undefined ? '未点亮' : `${ms} ms`}`);
  }
  console.log('');
  console.log(`仿真 ${BUDGET_MS} ms 用时 ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

if (failures.length > 0) {
  console.error('');
  for (const failure of failures) console.error(`✗ ${failure}`);
  process.exitCode = 1;
} else {
  console.log('✓ 8 颗蓝色 LED 均按 P2.0 → P2.7 的走马灯顺序点亮');
}
