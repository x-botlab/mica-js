/**
 * 固件联调：把一个或多个 Intel HEX（或裸 `.bin`）装进 `ct107d.sch` 整板跑联合仿真，
 * 打印板面可观测输出（LED 亮度、数码管段码、锁存器/译码器话题、串行器件话题）。
 *
 * 与 `verify-schematic.mjs` 一样装载 `dist/devices/<id>/device.js`，因此先跑 `mica build`。
 * 与它的区别是固件由命令行给出，而不是用 `assets/` 里自带的演示固件。
 *
 * 用法：
 *   node verify-firmware.mjs <hex|bin> [<hex|bin> ...] [选项]
 *
 * 选项：
 *   --ms=<n>            每个固件的仿真时长（毫秒），默认 200
 *   --step=<n>          推进步长（毫秒），默认 2（与 Playground 画布预览一致）
 *   --clock=<hz>        MCU 时钟，默认 11059200；原理图里是 12000000
 *   --execution=<mode>  执行模式：precise（默认，逐指令求解）或 throughput（预览一致的批量推进）
 *   --quantum=<ps>      CPU 可见性量子（`cpuQuantum`），默认 10000000 = 10 us；
 *                       只用于 throughput，且当前实现只校验不使用
 *   --press=<位号>@<起始 ms>[:<持续 ms>]
 *                       注入按键，可重复；例如 `--press=S9@300:150`
 *   --temp=<℃>          注入 DS18B20 环境温度
 *   --ain0..3=<0..1>    注入 PCF8591 模拟输入，`--ain=<v>` 表示四路同值
 *   --without=<id,...>  从整板移除器件（定位总线冲突时用）
 *   --no-pullups        不给 GPIO 加外部上拉
 *
 * 准双向口的上拉：STC15 靠内部弱上拉把释放的引脚拉到高电平，而器件模型按合同把「释放」
 * 实现为高阻、原理图里也没有实现电阻，因此默认给 23 根 GPIO 各补一个 10 kΩ 外部上拉。
 *
 * 默认用 `precise`：官方固件的 I²C（10.0/11.0/12.0/14.0）与 1-Wire（9.0/10.0/…）都是软件
 * 位冲击，`throughput` 把几十条指令合并成一段后只发布段末电平，字节会错位（见
 * docs/official-firmware-simulation.md 的问题 3）。`--execution=throughput --step=2`
 * 用于复现 Playground 预览的可见性行为。
 *
 * 需要 Node ≥ 22：DDL 编译器依赖 `Object.groupBy`。
 *
 * 固件来自仓库根的 `dist/代码/*.zip`，解压后取 `Objects/*.hex`：
 *   unzip -q -o "dist/代码/1.0 led.zip" -d /tmp/ct107d-firmware
 */
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  deriveSchematicTopology,
  deviceMetadataSymbol,
  parseDeviceMetadata,
  parseSchematic,
} from '@mica-js/document/schematic';
import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import { compileDDL } from '@mica-js/sdk/ddl';
import { performance } from 'node:perf_hooks';

const PROJECT = dirname(fileURLToPath(import.meta.url));

const options = {
  ms: 200,
  step: 2,
  clock: 11059200,
  execution: 'precise',
  quantum: undefined,
  pullups: true,
  presses: [],
  temperature: undefined,
  ain: {},
  without: new Set(),
};
const hexFiles = [];
for (const argument of process.argv.slice(2)) {
  const match = /^--(ms|step|clock|quantum)=(.+)$/.exec(argument);
  const press = /^--press=([^@]+)@(\d+)(?::(\d+))?$/.exec(argument);
  const ain = /^--(ain[0-3]?)=(.+)$/.exec(argument);
  const temp = /^--temp=(.+)$/.exec(argument);
  const execution = /^--execution=(throughput|precise)$/.exec(argument);
  if (match !== null) options[match[1]] = Number(match[2]);
  else if (execution !== null) options.execution = execution[1];
  else if (press !== null)
    options.presses.push({
      designator: press[1],
      start: Number(press[2]),
      duration: Number(press[3] ?? 150),
    });
  else if (temp !== null) options.temperature = Number(temp[1]);
  else if (ain !== null) options.ain[ain[1]] = Number(ain[2]);
  else if (argument === '--no-pullups') options.pullups = false;
  else if (argument.startsWith('--without='))
    options.without = new Set(argument.slice('--without='.length).split(','));
  else hexFiles.push(argument);
}

/** Intel HEX（记录类型 00/01/02/04）→ 从 0000H 起的裸二进制。 */
function parseIntelHex(text) {
  const bytes = new Map();
  let base = 0;
  let highest = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith(':')) continue;
    const record = Buffer.from(line.slice(1), 'hex');
    const length = record[0];
    const address = record.readUInt16BE(1);
    const type = record[3];
    const data = record.subarray(4, 4 + length);
    if (type === 0x00) {
      for (let index = 0; index < length; index += 1) {
        const offset = base + address + index;
        bytes.set(offset, data[index]);
        if (offset + 1 > highest) highest = offset + 1;
      }
    } else if (type === 0x01) break;
    else if (type === 0x02) base = data.readUInt16BE(0) * 16;
    else if (type === 0x04) base = data.readUInt16BE(0) * 65536;
  }
  const image = new Uint8Array(highest);
  for (const [offset, value] of bytes) image[offset] = value;
  return image;
}

const CHIP_IDS = [
  '74hc02',
  '74hc138',
  '74hc573',
  '74ls04',
  'at24c02',
  'buzzer',
  'cx20106a',
  'ds1302',
  'ds18b20',
  'jumper',
  'jumper-2x3',
  'lm386',
  'ne555',
  'pcf8591',
  'push-button',
  'relay',
  'uln2003',
  'vs1838',
  'blue-led',
  'seg4',
  'iap15f2k61s2',
];

const loadDefinition = (id) =>
  parseDeviceMetadata(
    JSON.parse(readFileSync(join(PROJECT, 'src', 'devices', id, 'device.json'), 'utf8')),
  );
const loadModule = (id) =>
  import(pathToFileURL(join(PROJECT, 'dist', 'devices', id, 'device.js')).href);

const devices = new Map();
for (const id of CHIP_IDS) {
  devices.set(`xbotlab:${id}`, { definition: loadDefinition(id), module: await loadModule(id) });
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
const components = schematic.sheet.symbols
  .filter((symbol) => symbol.designator)
  .filter(
    (symbol) =>
      options.without.size === 0 || !options.without.has(symbol.device.replace(/^xbotlab:/, '')),
  );
const designatorOf = new Map(components.map((symbol) => [symbol.id, symbol.designator]));
const deviceOf = new Map(components.map((symbol) => [symbol.id, symbol.device]));
const MCU_REF = 'xbotlab:iap15f2k61s2';

const asText = (payload) => {
  if (typeof payload === 'string') return payload;
  if (payload instanceof Uint8Array) return Buffer.from(payload).toString('latin1');
  if (payload !== null && typeof payload === 'object' && typeof payload.length === 'number')
    return Buffer.from(payload.slice()).toString('latin1');
  return String(payload);
};

/** 每颗器件的话题历史：topic → { count, last }。 */
const captured = new Map();
/** 每颗器件的话题变化序列（只记 latch / code / digit 等有意义的）：topic → [{ at, value }]。 */
const history = new Map();
/** 每颗器件的输入通道：channel → { send(value) }，用于注入按键与传感器读数。 */
const inputsOf = new Map();
let now = 0;

const TRAILED = new Set([
  'latch',
  'code',
  'digit1',
  'digit2',
  'digit3',
  'digit4',
  'datetime',
  'dump',
]);

function instrument(symbol, device) {
  const topics = new Map();
  const trails = new Map();
  captured.set(symbol.id, topics);
  history.set(symbol.id, trails);

  return (context) => {
    inputsOf.set(symbol.id, context.inputs);
    const wrapped = {
      ...context,
      topics: {
        ...context.topics,
        publish(topic, payload) {
          const entry = topics.get(topic) ?? { count: 0, last: undefined, first: undefined };
          entry.count += 1;
          entry.first ??= payload;
          entry.last = payload;
          topics.set(topic, entry);
          if (TRAILED.has(topic)) {
            const trail = trails.get(topic) ?? [];
            if (trail.length === 0 || trail.at(-1).value !== payload)
              trail.push({ at: now, value: payload });
            trails.set(topic, trail);
          }
          context.topics.publish(topic, payload);
        },
      },
    };
    return device.module.create(wrapped);
  };
}

const pullUpModel = await compileDDL(
  `device PullUp(resistance: number default 10000) {
     assert resistance >= 0.001 && resistance <= 1_000_000_000;
     pin a = [resistor(to: b, resistance: resistance)];
     pin b;
   }`,
);

function buildBoard(firmware) {
  const present = new Set(components.map((symbol) => symbol.id));
  const nets = topology.nets.map((net, index) => ({
    id: `net:${index}`,
    name: net.name,
    pins: net.members
      .filter((member) => member.kind === 'pin' && present.has(member.symbolId))
      .map((member) => ({ instance: member.symbolId, pin: member.pinId })),
    ...(net.name === 'VCC' ? { voltage: 5 } : net.name === 'GND' ? { voltage: 0 } : {}),
  }));
  const instances = components.map((symbol) => {
    const rest = { ...(symbol.properties ?? {}) };
    if (symbol.device === MCU_REF) {
      delete rest.firmware;
      return {
        id: symbol.id,
        type: symbol.id,
        props: { ...rest, clockFrequency: options.clock, firmware },
      };
    }
    return { id: symbol.id, type: symbol.id, props: rest };
  });
  const entries = components.map((symbol) => {
    const device = devices.get(symbol.device);
    return { id: symbol.id, model: device.module.model, create: instrument(symbol, device) };
  });

  if (options.pullups) {
    // STC15 准双向口用内部弱上拉把释放的引脚拉到高电平；器件模型按合同「释放 = 高阻」，
    // 原理图又没有实现电阻。整板联调时用外部 10 kΩ 补上这条内部通路。
    const wanted = [
      'P00',
      'P01',
      'P02',
      'P03',
      'P04',
      'P05',
      'P06',
      'P07',
      'P13',
      'P14',
      'P17/SCK',
      'P20/SCL',
      'P21/SDA',
      'P23',
      'P25',
      'P26',
      'P27',
      'P30/TXD',
      'P31/RXD',
      'P32',
      'P33',
      'P34',
      'P35',
    ];
    const vcc = nets.find((net) => net.name === 'VCC');
    entries.push({
      id: 'pull-up',
      model: pullUpModel,
      create: () => ({ sync() {}, dispose() {} }),
    });
    for (const name of wanted) {
      const net = nets.find((candidate) => candidate.name === name);
      if (net === undefined) continue;
      const id = `RP:${name}`;
      instances.push({ id, type: 'pull-up', props: { resistance: 10_000 } });
      net.pins.push({ instance: id, pin: 'a' });
      vcc.pins.push({ instance: id, pin: 'b' });
    }
  }

  const library = createDeviceLibrary(entries);
  const faults = [];
  const board = createBoard(
    library,
    {
      instances,
      // 装配只认 id/pins/voltage；网名只用于注入上拉时定位网络。
      nets: nets.map(({ id, pins, voltage }) =>
        voltage === undefined ? { id, pins } : { id, pins, voltage },
      ),
    },
    options.quantum === undefined
      ? { execution: options.execution }
      : { execution: options.execution, cpuQuantum: options.quantum },
  );
  board.onDidError((event) => faults.push(event.message));
  return { board, faults };
}

const brightness = (id) => captured.get(id)?.get('brightness')?.last ?? 0;
const leds = components
  .filter((symbol) => symbol.device === 'xbotlab:blue-led')
  .sort((left, right) => left.designator.localeCompare(right.designator));
const displays = components
  .filter((symbol) => symbol.device === 'xbotlab:seg4')
  .sort((left, right) => left.designator.localeCompare(right.designator));

function interestingTopics(symbol) {
  const id = deviceOf.get(symbol.id);
  const topics = captured.get(symbol.id);
  if (topics === undefined || topics.size === 0) return [];
  const skip = new Set(['current', 'voltage']);
  if (id === 'xbotlab:blue-led') return [];
  return [...topics].filter(([topic]) => !skip.has(topic) && topic !== 'latch' && topic !== 'code');
}

const summarize = (topic, payload) => {
  if (topic === 'dump') {
    const bytes = Array.from(payload.slice(0, 12))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join(' ');
    return `<${payload.length} B: ${bytes} …>`;
  }
  if (topic === 'datetime' || topic === 'channels' || topic === 'code')
    return `"${asText(payload)}"`;
  if (topic === 'latch') return `0x${Number(payload).toString(16).padStart(2, '0')}`;
  if (topic.startsWith('digit')) return `0x${Number(payload).toString(16).padStart(2, '0')}`;
  if (typeof payload === 'number')
    return Number.isInteger(payload) ? String(payload) : payload.toFixed(4);
  return JSON.stringify(payload);
};

/** 七段解码：`digit` 端口按「点亮的段」编码（bit0=a…bit7=dp），与共阴/共阳无关。 */
const SEG_GLYPHS = new Map([
  [0x3f, '0'],
  [0x06, '1'],
  [0x5b, '2'],
  [0x4f, '3'],
  [0x66, '4'],
  [0x6d, '5'],
  [0x7d, '6'],
  [0x07, '7'],
  [0x7f, '8'],
  [0x6f, '9'],
  [0x40, '-'],
  [0x00, ' '],
  [0x77, 'A'],
  [0x7c, 'b'],
  [0x39, 'C'],
  [0x5e, 'd'],
  [0x79, 'E'],
  [0x71, 'F'],
  [0x3d, 'o'],
  [0x76, 'H'],
  [0x38, 'L'],
  [0x73, 'P'],
  [0x6e, 'u'],
]);
/** 七段字形 + 可选小数点：bit7 单独拼到字符后面。 */
const glyph = (mask) => {
  const base = SEG_GLYPHS.get(mask & 0x7f) ?? '?';
  return (mask & 0x80) === 0 ? base : `${base}.`;
};

const sendInput = (symbolId, channel, value) => {
  const input = inputsOf.get(symbolId)?.[channel];
  if (input === undefined) return false;
  input.send(value);
  return true;
};

/** 每个 `--press` 各自一份状态：同一个位号可以重复给出，用于连按切页。 */
const pressTargets = [];
for (const press of options.presses) {
  const symbol = components.find((candidate) => candidate.designator === press.designator);
  if (symbol === undefined) {
    console.warn(`未知位号 ${press.designator}，忽略对应的 --press`);
    continue;
  }
  pressTargets.push({ symbolId: symbol.id, ...press, state: false });
}

for (const hexFile of hexFiles) {
  const image = hexFile.endsWith('.bin')
    ? new Uint8Array(readFileSync(hexFile))
    : parseIntelHex(readFileSync(hexFile, 'utf8'));
  captured.clear();
  history.clear();
  inputsOf.clear();
  now = 0;
  for (const target of pressTargets) target.state = false;
  const { board, faults } = buildBoard(image);

  // 上电注入：温度与 ADC 输入只发一次，器件保持最新值。
  if (options.temperature !== undefined) {
    const sensor = components.find((symbol) => symbol.device === 'xbotlab:ds18b20');
    if (sensor !== undefined) sendInput(sensor.id, 'temperature', options.temperature);
  }
  for (const [channel, value] of Object.entries(options.ain)) {
    const converter = components.find((symbol) => symbol.device === 'xbotlab:pcf8591');
    if (converter === undefined) continue;
    const names = channel === 'ain' ? ['ain0', 'ain1', 'ain2', 'ain3'] : [channel];
    for (const name of names) sendInput(converter.id, name, value);
  }

  const started = performance.now();
  const ledTrail = [];
  const pressTrail = [];
  const displaySeen = new Map(displays.map((symbol) => [symbol.id, new Set()]));
  const stepPs = options.step * 1_000_000_000;
  const targetPs = options.ms * 1_000_000_000;
  const PS_PER_MS = 1_000_000_000;
  while (now < targetPs) {
    now = Math.min(targetPs, now + stepPs);
    const atMs = now / PS_PER_MS;
    for (const target of pressTargets) {
      const wanted = atMs >= target.start && atMs < target.start + target.duration;
      if (wanted === target.state) continue;
      target.state = wanted;
      sendInput(target.symbolId, 'press', wanted);
      pressTrail.push(
        `${atMs.toFixed(0)}ms:${designatorOf.get(target.symbolId)}.press=${wanted ? '1' : '0'}`,
      );
    }
    board.runUntil(now);
    const lit = leds.filter((symbol) => brightness(symbol.id) > 0.1).map((s) => s.designator);
    if (lit.join(',') !== (ledTrail.at(-1)?.lit ?? '')) {
      ledTrail.push({ at: atMs, lit: lit.join(',') });
    }
    for (const symbol of displays) {
      const topics = captured.get(symbol.id);
      if (topics === undefined) continue;
      const codes = ['digit1', 'digit2', 'digit3', 'digit4'].map(
        (name) => topics.get(name)?.last ?? null,
      );
      displaySeen.get(symbol.id).add(codes.join('/'));
    }
  }
  const wall = (performance.now() - started) / 1000;
  board.dispose();

  const seconds = options.ms / 1000;
  console.log(
    `\n=== ${basename(hexFile)}  ${image.length} B  模拟 ${seconds} s / 实际 ${wall.toFixed(2)} s  (RTF ${(seconds / wall).toFixed(3)})`,
  );
  console.log(`  faults: ${faults.length === 0 ? '无' : faults.slice(0, 5).join('; ')}`);
  if (pressTrail.length > 0) console.log(`  注入: ${pressTrail.join(' ')}`);
  console.log(
    `  LEDs(>0.1): ${ledTrail.map((entry) => `${entry.at.toFixed(0)}ms:${entry.lit || '-'}`).join('  ')}`,
  );
  for (const symbol of displays) {
    const topics = captured.get(symbol.id);
    const masks = ['digit1', 'digit2', 'digit3', 'digit4'].map((name) =>
      Number(topics?.get(name)?.last ?? 0),
    );
    const shown = masks.map((mask) => glyph(mask)).join('');
    console.log(
      `  ${symbol.designator}: 末值 ${masks.map((mask) => `0x${mask.toString(16).padStart(2, '0')}`).join(' ')}  显示「${shown}」  ${displaySeen.get(symbol.id).size} 种组合`,
    );
    const digits = history.get(symbol.id);
    if (digits !== undefined) {
      const trail = digits.get('digit1') ?? [];
      if (trail.length > 1) {
        const timeline = trail
          .slice(0, 12)
          .map((entry) => `${(entry.at / 1e9).toFixed(0)}ms:${glyph(entry.value)}`);
        console.log(
          `    digit1 变化: ${timeline.join(' ')}${trail.length > 12 ? ` … 共 ${trail.length} 次` : ''}`,
        );
      }
    }
  }
  for (const symbol of components) {
    const trails = history.get(symbol.id);
    for (const [topic, trail] of trails ?? []) {
      if (topic.startsWith('digit')) continue;
      const shown = trail
        .slice(0, 6)
        .map(
          (entry) => `${(entry.at / 1_000_000_000).toFixed(0)}ms:${summarize(topic, entry.value)}`,
        );
      console.log(
        `  ${symbol.designator}.${topic}: ${trail.length > 6 ? `${shown.join(' ')} … 共 ${trail.length} 次` : shown.join(' ')}`,
      );
    }
    const entries = interestingTopics(symbol);
    if (entries.length === 0) continue;
    console.log(
      `  ${symbol.designator}: ${entries
        .map(([topic, entry]) => `${topic}=${summarize(topic, entry.last)}(${entry.count})`)
        .join(' ')}`,
    );
  }
}
