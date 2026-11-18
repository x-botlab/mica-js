/**
 * 固件联调：把一个或多个 Intel HEX（或裸 `.bin`）装进 legacy 整板跑联合仿真，
 * 打印板面可观测输出（LED 亮度、数码管段码、锁存器/译码器话题、串行器件话题）。
 *
 * 与 `verify-schematic.mjs` 一样装载 `examples/devices/dist/<id>/model.js`，因此先构建器件库。
 * 统一器件包通过 `legacy/device-package.mjs` 的显式旧消费投影接入；这里不把旧 `.sch v1`
 * 当作 RFC 0024 的 `.sch v2`，也不声称已迁移到融合运行时。
 * 与它的区别是固件由命令行给出，而不是用 `assets/` 里自带的演示固件。
 *
 * 用法：
 *   node verify-firmware.mjs <hex|bin> [<hex|bin> ...] [选项]
 *
 * 选项：
 *   --ms=<n>            每个固件的仿真时长（毫秒，正有限数），默认 200
 *   --warmup-ms=<n>     计时前预热仿真时长（毫秒，非负有限数），默认 0；比较吞吐时用于摊销 JIT 编译
 *   --step=<n>          推进步长（毫秒，正有限数），默认 2；这是 CLI 自己的采样粒度，
 *                       不是 Playground 画布预览的 64 ms 批次
 *   --clock=<hz>        MCU 时钟，默认 11059200；原理图里是 12000000
 *   --execution=<mode>  执行模式：precise（默认，逐指令求解）或 throughput（预览一致的批量推进）
 *   --quantum=<ps>      CPU 可见性量子（`cpuQuantum`），默认 10000000 = 10 us；
 *                       只用于 throughput，且当前实现只校验不使用
 *   --press=<位号>@<起始 ms>[:<持续 ms>]
 *                       注入按键，可重复；例如 `--press=S9@300:150`
 *   --temp=<℃>          注入 DS18B20 环境温度
 *   --ain0..3=<0..1>    注入 PCF8591 模拟输入，`--ain=<v>` 表示四路同值
 *   --distance=<cm>     覆盖超声波器件的目标距离，默认使用原理图属性（100 cm）
 *   --uart=<text>       经 UART_PROBE 按 8N1 注入命令，未以 CR 结尾时自动补 `\r`
 *   --uart-baud=<n>     UART_PROBE 波特率，默认 9600
 *   --uart-at=<ms>      UART 命令注入时刻，默认 20 ms
 *   --display-after=<ms> 只汇总该时刻之后各数码管位观测到的字形，默认 0
 *   --without=<id,...>  从整板移除器件（定位总线冲突时用）
 *
 * IAP15 的准双向口弱上拉由 MCU 器件模型提供，与 Playground 使用同一电气模型。
 *
 * 默认用 `precise`。`throughput` 首次运行会编译直接 JIT；对比稳态速度时用
 * `--warmup-ms` 在同一块板上预热后再计时，避免把一次性编译成本算入测量窗口。
 *
 * 计时口径与 bench / 浏览器测量同名同义：`cpuMs` 是测量窗口的进程 CPU 时间
 * （`user + system`），`elapsedWallMs` 是测量窗口的墙钟时间，
 * `realtimeRatio = simMs / elapsedWallMs`。`coldCpuMs` / `coldElapsedWallMs` 覆盖
 * 装配 + `runUntil(0)` + 预热；本文件顶部的器件模块导入不在冷启动计时内。
 *
 * CLI 在测量窗口内还要做 LED / 数码管 / 话题历史观测，这些开销计入 `cpuMs` 和
 * `elapsedWallMs`；bench 测量的是另一套夹具，数字不能直接等价比较。
 * 每个固件在输出末尾打印一行 `FIRMWARE_METRICS <json>`，供脚本读取。
 *
 * 需要 Node ≥ 22：DDL 编译器依赖 `Object.groupBy`。
 *
 * 固件来自仓库根的 `dist/代码/*.zip`，解压后取 `Objects/*.hex`：
 *   unzip -q -o "dist/代码/1.0 led.zip" -d /tmp/ct107d-firmware
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSchematic } from '@mica-js/document/schematic';
import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import { performance } from 'node:perf_hooks';
import { TextEncoder } from 'node:util';
import { loadLegacyDevice, legacyCreateWithFirmware } from './legacy/device-package.mjs';

const PROJECT = dirname(fileURLToPath(import.meta.url));
const LEGACY_SOURCE = join(PROJECT, 'legacy', 'source');

const options = {
  ms: 200,
  warmupMs: 0,
  step: 2,
  clock: 11059200,
  execution: 'precise',
  quantum: undefined,
  presses: [],
  temperature: undefined,
  ain: {},
  distance: undefined,
  uart: undefined,
  uartBaud: 9600,
  uartAt: 20,
  displayAfter: 0,
  without: new Set(),
};
const hexFiles = [];
for (const argument of process.argv.slice(2)) {
  const match = /^--(ms|step|clock|quantum)=(.+)$/.exec(argument);
  const warmup = /^--warmup-ms=(.+)$/.exec(argument);
  const press = /^--press=([^@]+)@(\d+)(?::(\d+))?$/.exec(argument);
  const ain = /^--(ain[0-3]?)=(.+)$/.exec(argument);
  const temp = /^--temp=(.+)$/.exec(argument);
  const distance = /^--distance=(.+)$/.exec(argument);
  const uart = /^--uart=(.*)$/.exec(argument);
  const uartBaud = /^--uart-baud=(\d+)$/.exec(argument);
  const uartAt = /^--uart-at=(\d+(?:\.\d+)?)$/.exec(argument);
  const displayAfter = /^--display-after=(\d+(?:\.\d+)?)$/.exec(argument);
  const execution = /^--execution=(throughput|precise)$/.exec(argument);
  if (warmup !== null) options.warmupMs = Number(warmup[1]);
  else if (match !== null) options[match[1]] = Number(match[2]);
  else if (execution !== null) options.execution = execution[1];
  else if (press !== null)
    options.presses.push({
      designator: press[1],
      start: Number(press[2]),
      duration: Number(press[3] ?? 150),
    });
  else if (temp !== null) options.temperature = Number(temp[1]);
  else if (distance !== null) options.distance = Number(distance[1]);
  else if (uart !== null) options.uart = uart[1];
  else if (uartBaud !== null) options.uartBaud = Number(uartBaud[1]);
  else if (uartAt !== null) options.uartAt = Number(uartAt[1]);
  else if (displayAfter !== null) options.displayAfter = Number(displayAfter[1]);
  else if (ain !== null) options.ain[ain[1]] = Number(ain[2]);
  else if (argument.startsWith('--without='))
    options.without = new Set(argument.slice('--without='.length).split(','));
  else hexFiles.push(argument);
}
if (!Number.isFinite(options.warmupMs) || options.warmupMs < 0)
  throw new RangeError('--warmup-ms must be a non-negative finite duration');
for (const [flag, value] of [
  ['--ms', options.ms],
  ['--step', options.step],
]) {
  if (!Number.isFinite(value) || value <= 0)
    throw new RangeError(`${flag} must be a positive finite duration`);
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

const schematicText = readFileSync(join(LEGACY_SOURCE, 'ct107d.sch'), 'utf8');
const schematic = parseSchematic(schematicText);

const DEVICES_PROJECT = join(PROJECT, '..', 'devices');
const DEVICES_DIST = join(DEVICES_PROJECT, 'dist');
const loadDevice = (id) => loadLegacyDevice(DEVICES_DIST, id);
const loadModuleFile = (id) => join(DEVICES_DIST, id, 'model.js');

/** 器件清单由原理图引用决定：新增实例不需要同步维护第二份 id 列表。 */
const deviceIds = [
  ...new Set(
    schematic.sheet.symbols
      .filter((symbol) => symbol.designator && symbol.device.startsWith('xbotlab:'))
      .map((symbol) => symbol.device.slice('xbotlab:'.length)),
  ),
].sort();

const devices = new Map();
const deviceModuleSha256 = {};
for (const id of deviceIds) {
  deviceModuleSha256[id] = createHash('sha256')
    .update(readFileSync(loadModuleFile(id)))
    .digest('hex');
  const loaded = await loadDevice(id);
  devices.set(`xbotlab:${id}`, {
    manifest: loaded.manifest,
    module: loaded.module,
  });
}
const artifacts = {
  source: 'dist',
  note: 'device modules from examples/devices/dist/<id>/model.js; unified factory/event adapter; firmware from the CLI input',
  schematicSha256: createHash('sha256').update(schematicText).digest('hex'),
  deviceModulesSha256: deviceModuleSha256,
};

/** 进程 CPU 时间增量（微秒）；与 bench 测量使用同一口径。 */
const cpuMicrosSince = (before) => {
  const usage = process.cpuUsage(before);
  return usage.user + usage.system;
};
const cpuMsSince = (before) => cpuMicrosSince(before) / 1000;
const round = (value, digits = 3) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};
const netlist = JSON.parse(readFileSync(join(LEGACY_SOURCE, 'ct107d.netlist.json'), 'utf8'));
const components = schematic.sheet.symbols
  .filter((symbol) => symbol.designator && symbol.device.startsWith('xbotlab:'))
  .filter(
    (symbol) =>
      options.without.size === 0 || !options.without.has(symbol.device.replace(/^xbotlab:/, '')),
  );
const designatorOf = new Map(components.map((symbol) => [symbol.id, symbol.designator]));
const deviceOf = new Map(components.map((symbol) => [symbol.id, symbol.device]));
const byDesignator = new Map(components.map((symbol) => [symbol.designator, symbol]));
const nets = Object.entries(netlist).map(([name, members]) => ({
  name,
  pins: members.flatMap((member) => {
    const separator = member.lastIndexOf('.');
    const symbol = byDesignator.get(member.slice(0, separator));
    return symbol === undefined ? [] : [{ instance: symbol.id, pin: member.slice(separator + 1) }];
  }),
  ...(name === 'VCC' ? { voltage: 5 } : name === 'GND' ? { voltage: 0 } : {}),
}));
const MCU_REF = 'xbotlab:iap15f2k61s2';

const asText = (payload) => {
  if (typeof payload === 'string') return payload;
  if (payload instanceof Uint8Array) return Buffer.from(payload).toString('latin1');
  if (payload !== null && typeof payload === 'object' && typeof payload.length === 'number')
    return Buffer.from(payload.slice()).toString('latin1');
  return String(payload);
};

const asBytes = (payload) =>
  payload instanceof Uint8Array
    ? payload
    : typeof payload === 'number'
      ? Uint8Array.of(payload)
      : typeof payload === 'string'
        ? Uint8Array.from(Buffer.from(payload, 'latin1'))
        : Uint8Array.from(payload ?? []);

const asciiBytes = (values) =>
  Buffer.from(values).toString('latin1').replace(/\r/g, '\\r').replace(/\n/g, '\\n');

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
/** 字节流不去重，保留每个线上字节及其时刻。 */
const STREAMED = new Set(['uart1Tx', 'uart1Rx', 'tx', 'rx']);

function instrument(symbol, device, firmware) {
  const topics = new Map();
  const trails = new Map();
  captured.set(symbol.id, topics);
  history.set(symbol.id, trails);
  const create =
    symbol.device === MCU_REF ? legacyCreateWithFirmware(device, firmware) : device.module.create;

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
          if (STREAMED.has(topic)) {
            const trail = trails.get(topic) ?? [];
            trail.push({ at: now, value: payload });
            trails.set(topic, trail);
          } else if (TRAILED.has(topic)) {
            const trail = trails.get(topic) ?? [];
            if (trail.length === 0 || trail.at(-1).value !== payload)
              trail.push({ at: now, value: payload });
            trails.set(topic, trail);
          }
          context.topics.publish(topic, payload);
        },
      },
    };
    return create(wrapped);
  };
}

function buildBoard(firmware) {
  const present = new Set(components.map((symbol) => symbol.id));
  const boardNets = nets.map((net, index) => ({
    id: `net:${index}`,
    name: net.name,
    pins: net.pins.filter((pin) => present.has(pin.instance)),
    ...(net.voltage === undefined ? {} : { voltage: net.voltage }),
  }));
  const instances = components.map((symbol) => {
    const rest = { ...(symbol.properties ?? {}) };
    if (symbol.device === MCU_REF) {
      delete rest.firmware;
      return {
        id: symbol.id,
        type: symbol.id,
        props: { ...rest, clockFrequency: options.clock },
      };
    }
    if (symbol.device === 'xbotlab:ultrasonic' && options.distance !== undefined)
      rest.distanceCm = options.distance;
    if (symbol.device === 'xbotlab:uart-probe') rest.baud = options.uartBaud;
    return { id: symbol.id, type: symbol.id, props: rest };
  });
  const entries = components.map((symbol) => {
    const device = devices.get(symbol.device);
    return {
      id: symbol.id,
      model: device.module.model,
      create: instrument(symbol, device, firmware),
    };
  });

  const library = createDeviceLibrary(entries);
  const faults = [];
  const board = createBoard(
    library,
    {
      instances,
      // 装配只认 id/pins/voltage；网名只用于注入理想电源。
      nets: boardNets.map(({ id, pins, voltage }) =>
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
  if (STREAMED.has(topic)) {
    const bytes = asBytes(payload);
    return `"${asciiBytes(bytes)}"(${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(' ')})`;
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

const uartProbe = components.find((candidate) => candidate.device === 'xbotlab:uart-probe');
const mcu = components.find((candidate) => candidate.device === MCU_REF);
const uartCommand =
  options.uart === undefined
    ? undefined
    : options.uart.endsWith('\r')
      ? options.uart
      : `${options.uart}\r`;

for (const hexFile of hexFiles) {
  const firmwareName = basename(hexFile);
  const image = hexFile.endsWith('.bin')
    ? new Uint8Array(readFileSync(hexFile))
    : parseIntelHex(readFileSync(hexFile, 'utf8'));
  const firmwareSha256 = createHash('sha256').update(image).digest('hex');
  captured.clear();
  history.clear();
  inputsOf.clear();
  now = 0;
  for (const target of pressTargets) target.state = false;
  let uartInjected = false;
  // 冷启动从装配开始；文件顶部的模块导入不在这段计时内。
  const coldCpuBefore = process.cpuUsage();
  const coldWallBefore = performance.now();
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

  const ledTrail = [];
  const pressTrail = [];
  const displaySeen = new Map(displays.map((symbol) => [symbol.id, new Set()]));
  const stepPs = options.step * 1_000_000_000;
  const warmupPs = options.warmupMs * 1_000_000_000;
  const measurementEndPs = warmupPs + options.ms * 1_000_000_000;
  const PS_PER_MS = 1_000_000_000;
  /** 测量窗口内的 CPU 分段；advance 含 instrumented topic capture，observe 只含每步 LED/数码管读取。 */
  const segmentCpuUs = { inject: 0, advance: 0, observe: 0 };
  let recordingSegments = false;
  const advance = (endPs) => {
    now = Math.min(endPs, now + stepPs);
    const atMs = now / PS_PER_MS;
    const injectStarted = recordingSegments ? process.cpuUsage() : undefined;
    if (!uartInjected && uartCommand !== undefined && atMs >= options.uartAt) {
      uartInjected = true;
      if (
        uartProbe === undefined ||
        !sendInput(uartProbe.id, 'send', new TextEncoder().encode(uartCommand))
      )
        console.warn('原理图中没有可用的 UART 探针，忽略 --uart');
    }
    for (const target of pressTargets) {
      const wanted = atMs >= target.start && atMs < target.start + target.duration;
      if (wanted === target.state) continue;
      target.state = wanted;
      sendInput(target.symbolId, 'press', wanted);
      pressTrail.push(
        `${atMs.toFixed(0)}ms:${designatorOf.get(target.symbolId)}.press=${wanted ? '1' : '0'}`,
      );
    }
    if (injectStarted !== undefined) segmentCpuUs.inject += cpuMicrosSince(injectStarted);
    const advanceStarted = recordingSegments ? process.cpuUsage() : undefined;
    board.runUntil(now);
    if (advanceStarted !== undefined) segmentCpuUs.advance += cpuMicrosSince(advanceStarted);
    const observeStarted = recordingSegments ? process.cpuUsage() : undefined;
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
    if (observeStarted !== undefined) segmentCpuUs.observe += cpuMicrosSince(observeStarted);
  };
  // 与 bench 一致：装配后先 runUntil(0)，再预热；冷启动计时覆盖到这里。
  board.runUntil(0);
  while (now < warmupPs) advance(warmupPs);
  const coldCpuMs = cpuMsSince(coldCpuBefore);
  const coldElapsedWallMs = performance.now() - coldWallBefore;
  recordingSegments = true;
  const windowCpuBefore = process.cpuUsage();
  const windowWallBefore = performance.now();
  while (now < measurementEndPs) advance(measurementEndPs);
  const windowCpuMs = cpuMsSince(windowCpuBefore);
  const windowWallMs = performance.now() - windowWallBefore;
  recordingSegments = false;
  board.dispose();

  const windowStartMs = warmupPs / PS_PER_MS;
  const windowEndMs = measurementEndPs / PS_PER_MS;
  const simMs = windowEndMs - windowStartMs;
  const realtimeRatio = windowWallMs > 0 ? simMs / windowWallMs : 0;
  console.log(
    `\n=== ${firmwareName}  ${image.length} B  冷启动 CPU ${coldCpuMs.toFixed(1)} ms / 墙钟 ${coldElapsedWallMs.toFixed(1)} ms（装配 + runUntil(0) + 预热 ${options.warmupMs} ms）`,
  );
  console.log(
    `  测量窗口 sim ${simMs} ms / CPU ${windowCpuMs.toFixed(1)} ms / 墙钟 ${windowWallMs.toFixed(1)} ms  (realtimeRatio ${realtimeRatio.toFixed(3)})  含 CLI 观测开销`,
  );
  console.log(`  faults: ${faults.length === 0 ? '无' : faults.slice(0, 5).join('; ')}`);
  const metrics = {
    firmware: firmwareName,
    firmwareSha256,
    firmwareBytes: image.length,
    execution: options.execution,
    clockFrequency: options.clock,
    tickMs: options.step,
    warmUpMs: options.warmupMs,
    windowStartMs,
    windowEndMs,
    simMs: round(simMs),
    cpuMs: round(windowCpuMs),
    elapsedWallMs: round(windowWallMs),
    realtimeRatio: round(realtimeRatio),
    coldCpuMs: round(coldCpuMs),
    coldElapsedWallMs: round(coldElapsedWallMs),
    coldRealtimeRatio: round(coldElapsedWallMs > 0 ? options.warmupMs / coldElapsedWallMs : 0),
    segments: {
      injectCpuMs: round(segmentCpuUs.inject / 1000),
      advanceCpuMs: round(segmentCpuUs.advance / 1000),
      observeCpuMs: round(segmentCpuUs.observe / 1000),
      note: 'CPU subsets of cpuMs; advance includes instrumented topic capture, observe is per-step LED/display reads.',
    },
    observationIncluded: true,
    artifacts,
    faults: faults.length,
    notes: [
      'cpuMs/elapsedWallMs include CLI observation: instrumented LED/display/history capture and per-step LED/display reads.',
      'Process CPU includes all Node threads (JIT/GC), so cpuMs may exceed elapsedWallMs.',
      'The bench fixture measures a different window and harness; CLI numbers are not strictly comparable.',
      'Cold start is per firmware: assembly + runUntil(0) + warmup; device module imports at file load are excluded.',
    ],
  };
  if (uartCommand !== undefined)
    console.log(
      `  UART 注入 @${options.uartAt}ms (${options.uartBaud} baud): "${asciiBytes(new TextEncoder().encode(uartCommand))}"`,
    );
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
    const displayAfterPs = options.displayAfter * 1_000_000_000;
    const glyphsSeen = ['digit1', 'digit2', 'digit3', 'digit4'].map((name) =>
      [
        ...new Set(
          (digits?.get(name) ?? [])
            .filter((entry) => entry.at >= displayAfterPs)
            .map((entry) => glyph(Number(entry.value))),
        ),
      ].join(''),
    );
    console.log(
      `    每位观测字形: ${glyphsSeen.map((value, index) => `digit${index + 1}="${value}"`).join(' ')}`,
    );
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

  if (uartCommand !== undefined) {
    const stream = (symbolId, topic) =>
      Buffer.concat(
        (history.get(symbolId)?.get(topic) ?? []).map((entry) => Buffer.from(asBytes(entry.value))),
      );
    const a = stream(mcu?.id, 'uart1Tx');
    const b = stream(uartProbe?.id, 'tx');
    const injected = stream(uartProbe?.id, 'rx');
    const received = stream(mcu?.id, 'uart1Rx');
    console.log(`  U1.uart1Tx: "${asciiBytes(a)}"  hex=${a.toString('hex')}`);
    console.log(`  UART_PROBE.tx: "${asciiBytes(b)}"  hex=${b.toString('hex')}`);
    console.log(`  UART_PROBE.rx: "${asciiBytes(injected)}"  hex=${injected.toString('hex')}`);
    console.log(`  U1.uart1Rx: "${asciiBytes(received)}"  hex=${received.toString('hex')}`);
    console.log(`  A/B 帧一致: ${a.length > 0 && b.length > 0 && a.equals(b) ? '是' : '否'}`);
  }
  console.log(`FIRMWARE_METRICS ${JSON.stringify(metrics)}`);
}
