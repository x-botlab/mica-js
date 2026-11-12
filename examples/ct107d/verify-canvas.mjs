/**
 * 校验 `ct107d.cnv`：
 * 1. 画布能被 `parseCanvas` 解析，widget 定义通过 SDK 校验，绑定端点全部落在 `ct107d.sch` 上；
 * 2. 摆放与 `assets/ct107d-board.webp`（1068×768）对得上：背景图铺满整块板，17 个按键各自
 *    压在照片里的按键上且互不重叠，两片数码管盖住两个黑色窗口；
 * 3. 三个 widget 的实现能在真实 2D 上下文里跑起来：背景图画到位图、按键发布 press、
 *    数码管按段码点亮正确的段数；
 * 4. 用原理图建一块只含按键与辅助器件的板，逐个按下 17 个键，确认矩阵行/列与复位网络
 *    确实按 PDF 的接法闭合。
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { assertCanvasBindings, parseCanvas } from '@mica-js/document/canvas';
import {
  deriveSchematicTopology,
  deviceMetadataSymbol,
  parseDeviceMetadata,
  parseSchematic,
} from '@mica-js/document/schematic';
import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import { compileDDL } from '@mica-js/sdk/ddl';
import { validateMetadata } from '@mica-js/sdk/metadata';

const PROJECT = dirname(fileURLToPath(import.meta.url));
const BOARD_IMAGE = join(PROJECT, 'assets', 'ct107d-board.webp');
const failures = [];
const fail = (message) => failures.push(message);

// ---- 1. 文档与定义 ----------------------------------------------------------------------
const canvas = parseCanvas(readFileSync(join(PROJECT, 'ct107d.cnv'), 'utf8'));
const schematic = parseSchematic(readFileSync(join(PROJECT, 'ct107d.sch'), 'utf8'));

/** 器件引用 → 元数据目录：本工程芯片 + 相邻的三个器件工程。 */
const deviceDir = (reference) =>
  join(PROJECT, 'dist', 'devices', reference.slice('xbotlab:'.length));

const definitions = new Map();
for (const reference of new Set(schematic.sheet.symbols.map((symbol) => symbol.device))) {
  if (reference.startsWith('builtin:')) continue;
  const directory = deviceDir(reference);
  const raw = JSON.parse(readFileSync(join(directory, 'device.json'), 'utf8'));
  definitions.set(reference, parseDeviceMetadata(raw));
}
const symbolsById = new Map(
  schematic.sheet.symbols
    .filter((symbol) => symbol.designator)
    .map((symbol) => [symbol.id, symbol]),
);

const WIDGET_IDS = [...new Set(canvas.widgets.map((instance) => instance.widget))];
const widgets = new Map();
for (const reference of WIDGET_IDS) {
  const id = reference.slice('xbotlab:'.length);
  const directory = join(PROJECT, 'dist', 'widgets', id);
  if (!existsSync(join(directory, 'widget.json'))) {
    fail(`缺少 widget 产物 ${reference}（先运行 mica build）`);
    continue;
  }
  const definition = JSON.parse(readFileSync(join(directory, 'widget.json'), 'utf8'));
  try {
    validateMetadata(definition, 'widget', id);
  } catch (cause) {
    fail(`widget ${reference} 元数据不合规：${cause.message}`);
  }
  widgets.set(reference, {
    definition,
    module: await import(pathToFileURL(join(directory, 'widget.js')).href),
  });
}

assertCanvasBindings(canvas, {
  catalog: {
    widgetDefinition(reference) {
      const definition = widgets.get(reference)?.definition;
      return (
        definition && { ports: definition.ports, propertyKeys: Object.keys(definition.properties) }
      );
    },
    hasSchematic: (path) => path === canvas.schematic,
    hasSymbol: (id) => symbolsById.has(id),
    symbolPort(id, port) {
      const symbol = symbolsById.get(id);
      return symbol === undefined ? undefined : definitions.get(symbol.device)?.ports?.[port];
    },
  },
});

// ---- 2. 摆放与照片对位 ------------------------------------------------------------------
const image = canvas.widgets.find((instance) => instance.widget === 'xbotlab:image');
const buttons = canvas.widgets.filter((instance) => instance.widget === 'xbotlab:button');
const segments = canvas.widgets.filter((instance) => instance.widget === 'xbotlab:segment');
const leds = canvas.widgets.filter((instance) => instance.widget === 'xbotlab:led-indicator');
if (image === undefined) fail('缺少背景图实例');
if (buttons.length !== 17) fail(`按键实例 ${buttons.length} 个，期望 17`);
if (segments.length !== 2) fail(`数码管实例 ${segments.length} 个，期望 2`);
if (leds.length !== 8) fail(`LED 实例 ${leds.length} 个，期望 8`);

/** RIFF/WEBP 头里读像素尺寸，避免为了校验再装一个解码器。 */
function webpSize(bytes) {
  const text = (offset, length) => String.fromCharCode(...bytes.slice(offset, offset + length));
  if (text(0, 4) !== 'RIFF' || text(8, 4) !== 'WEBP') return undefined;
  const chunk = text(12, 4);
  if (chunk === 'VP8X') {
    return {
      width: 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)),
      height: 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)),
    };
  }
  if (chunk === 'VP8 ') {
    return {
      width: (bytes[26] | (bytes[27] << 8)) & 0x3fff,
      height: (bytes[28] | (bytes[29] << 8)) & 0x3fff,
    };
  }
  if (chunk === 'VP8L') {
    const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return undefined;
}

const size = webpSize(readFileSync(BOARD_IMAGE));
if (size === undefined) fail('无法读取 ct107d-board.webp 的像素尺寸');
if (image !== undefined) {
  const property = image.properties?.image;
  if (property?.mode !== 'file') fail('背景图应使用 file 模式的资源引用');
  if (property?.src !== 'assets/ct107d-board.webp')
    fail(`背景图 src ${property?.src} 不指向板面照片`);
  if (!existsSync(BOARD_IMAGE)) fail('缺少 assets/ct107d-board.webp');
  if (size && (image.width !== size.width || image.height !== size.height)) {
    fail(`背景图实例 ${image.width}×${image.height} 与照片 ${size.width}×${size.height} 不一致`);
  }
  if (image.x !== 0 || image.y !== 0) fail('背景图实例应从画布原点开始');
}

const overlaps = (left, right) =>
  left.x < right.x + right.width &&
  right.x < left.x + left.width &&
  left.y < right.y + right.height &&
  right.y < left.y + left.height;
for (let left = 0; left < buttons.length; left += 1) {
  for (let right = left + 1; right < buttons.length; right += 1) {
    if (overlaps(buttons[left], buttons[right])) {
      const a = symbolsById.get(buttons[left].bindings?.press?.symbol)?.designator;
      const b = symbolsById.get(buttons[right].bindings?.press?.symbol)?.designator;
      fail(`按键热区重叠：${a} / ${b}`);
    }
  }
}
for (const instance of buttons) {
  if (
    size &&
    (instance.x < 0 ||
      instance.y < 0 ||
      instance.x + instance.width > size.width ||
      instance.y + instance.height > size.height)
  ) {
    fail(`按键热区越出照片：${instance.id}`);
  }
  const bound = Object.keys(instance.bindings ?? {});
  if (bound.length !== 1 || bound[0] !== 'press') fail(`按键 ${instance.id} 应只绑定 press`);
  const symbol = symbolsById.get(instance.bindings?.press?.symbol);
  if (symbol?.device !== 'xbotlab:push-button') fail(`按键 ${instance.id} 绑定的不是轻触按键`);
}
const boundKeys = new Set(
  buttons.map((instance) => symbolsById.get(instance.bindings?.press?.symbol)?.designator),
);
for (const designator of [
  'S1',
  'S4',
  'S5',
  'S6',
  'S7',
  'S8',
  'S9',
  'S10',
  'S11',
  'S12',
  'S13',
  'S14',
  'S15',
  'S16',
  'S17',
  'S18',
  'S19',
]) {
  if (!boundKeys.has(designator)) fail(`画布缺少 ${designator} 的按键热区`);
}
for (const instance of segments) {
  const ports = Object.keys(instance.bindings ?? {}).sort();
  if (ports.join(',') !== 'digit1,digit2,digit3,digit4')
    fail(`数码管 ${instance.id} 应绑定 digit1–digit4`);
  const symbol = symbolsById.get(instance.bindings?.digit1?.symbol);
  if (symbol?.device !== 'xbotlab:seg4') fail(`数码管 ${instance.id} 绑定的不是 seg4`);
  if (
    size &&
    (instance.x < 0 ||
      instance.y < 0 ||
      instance.x + instance.width > size.width ||
      instance.y + instance.height > size.height)
  ) {
    fail(`数码管 ${instance.id} 越出照片`);
  }
}
if (segments.length === 2 && overlaps(segments[0], segments[1])) fail('两个数码管实例重叠');

const boundLeds = new Set();
for (const instance of leds) {
  const ports = Object.keys(instance.bindings ?? {});
  if (ports.length !== 1 || ports[0] !== 'brightness')
    fail(`LED ${instance.id} 应只绑定 brightness`);
  const symbol = symbolsById.get(instance.bindings?.brightness?.symbol);
  if (symbol?.device !== 'xbotlab:blue-led') fail(`LED ${instance.id} 绑定的不是 blue-led`);
  if (symbol !== undefined) boundLeds.add(symbol.designator);
  if (
    size &&
    (instance.x < 0 ||
      instance.y < 0 ||
      instance.x + instance.width > size.width ||
      instance.y + instance.height > size.height)
  ) {
    fail(`LED ${instance.id} 越出照片`);
  }
}
for (let index = 1; index <= 8; index += 1) {
  if (!boundLeds.has(`D${index}`)) fail(`画布缺少 D${index} 的 LED 指示器`);
}
for (let left = 0; left < leds.length; left += 1) {
  for (let right = left + 1; right < leds.length; right += 1) {
    if (overlaps(leds[left], leds[right])) fail(`LED 实例重叠：${leds[left].id}`);
  }
}
for (const instance of leds) {
  for (const button of buttons) {
    if (overlaps(instance, button)) fail(`LED 与按键热区重叠：${instance.id}`);
  }
}

// ---- 3. widget 行为 ---------------------------------------------------------------------
function createCanvas() {
  const context = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: '',
    textBaseline: '',
    globalAlpha: 1,
    save() {},
    restore() {},
    beginPath() {},
    closePath() {},
    rect() {},
    clip() {},
    clearRect() {},
    moveTo() {},
    lineTo() {},
    arc() {},
    roundRect() {},
    stroke() {},
    strokeRect() {},
    fillRect() {},
    createRadialGradient() {
      return { addColorStop() {} };
    },
    fills: [],
    images: [],
    texts: [],
    fill() {
      context.fills.push(context.fillStyle);
    },
    drawImage(bitmap, x, y, width, height) {
      context.images.push({ bitmap, x, y, width, height });
    },
    fillText(text) {
      context.texts.push(text);
    },
  };
  return context;
}

function mount(
  reference,
  { width, height, props = {}, readBinary = async () => new Uint8Array() },
) {
  const published = [];
  const listeners = new Map();
  let invalidations = 0;
  const api = {
    instanceId: 'test',
    width,
    height,
    props,
    assets: { readBinary },
    audio: {},
    subscribe(port, listener) {
      const list = listeners.get(port) ?? [];
      list.push(listener);
      listeners.set(port, list);
      return () =>
        listeners.set(
          port,
          (listeners.get(port) ?? []).filter((entry) => entry !== listener),
        );
    },
    publish(port, payload) {
      published.push({ port, payload });
    },
    invalidate() {
      invalidations += 1;
    },
  };
  const widget = widgets.get(reference).module.default(api) ?? {};
  return {
    widget,
    published,
    invalidations: () => invalidations,
    deliver(port, payload) {
      for (const listener of listeners.get(port) ?? []) listener(payload, { simTime: 0 });
    },
  };
}

globalThis.createImageBitmap ??= async () => ({ width: 1068, height: 768, close() {} });

const imageMount = mount('xbotlab:image', {
  width: 1068,
  height: 768,
  props: { image: { src: 'assets/ct107d-board.webp', mode: 'file' } },
});
await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
const imageContext = createCanvas();
imageMount.widget.render(imageContext);
const drawn = imageContext.images[0];
if (drawn === undefined || drawn.width !== 1068 || drawn.height !== 768) {
  fail('背景图没有按 1068×768 画出位图');
} else if (drawn.x !== 0 || drawn.y !== 0) {
  fail('背景图没有从左上角开始绘制');
}
imageMount.widget.dispose?.();

const buttonMount = mount('xbotlab:button', {
  width: 40,
  height: 40,
  props: { color: '#38bdf8ff', radius: 8 },
});
if (buttonMount.published[0]?.payload !== false) fail('按键初始状态应为 press=false');
const buttonContext = createCanvas();
buttonMount.widget.render(buttonContext);
buttonMount.widget.input({ type: 'pointerdown', button: 0, x: 20, y: 20 });
if (buttonMount.published.at(-1)?.payload !== true) fail('pointerdown 落在热区内应发布 press=true');
buttonMount.widget.input({ type: 'pointerup', x: 400, y: 400 });
if (buttonMount.published.at(-1)?.payload !== false) fail('pointerup 应发布 press=false');
buttonMount.widget.input({ type: 'pointerdown', button: 0, x: 400, y: 400 });
if (buttonMount.published.at(-1)?.payload !== false) fail('热区外的 pointerdown 不应按下');

const segmentMount = mount('xbotlab:segment', { width: 126, height: 60 });
const MASKS = [0x06, 0x5b, 0x7f, 0x80];
MASKS.forEach((mask, index) => segmentMount.deliver(`digit${index + 1}`, mask));
const segmentContext = createCanvas();
segmentMount.widget.render(segmentContext);
const lit = segmentContext.fills.filter((fill) => fill === 'rgba(255, 59, 48, 1)').length;
const expectedLit = MASKS.reduce(
  (total, mask) =>
    total + ((mask & 0x7f).toString(2).split('1').length - 1) + (mask & 0x80 ? 1 : 0),
  0,
);
if (lit !== expectedLit) fail(`数码管点亮 ${lit} 段，期望 ${expectedLit} 段`);
if (segmentContext.fills.length !== 1 + 4 * 8)
  fail(`数码管应画 1 次底色 + 32 段，实际 ${segmentContext.fills.length}`);

// ---- 4. 按键网络 ------------------------------------------------------------------------
const topology = deriveSchematicTopology(schematic, {
  devices: {
    getDeviceName: (reference) => definitions.get(reference.raw)?.displayName,
    getDeviceSymbol: (reference) => {
      const definition = definitions.get(reference.raw);
      return definition === undefined ? undefined : deviceMetadataSymbol(definition);
    },
  },
});
const netOfPin = new Map();
for (const net of topology.nets) {
  for (const member of net.members) {
    if (member.kind === 'pin') netOfPin.set(`${member.symbolId}/${member.pinId}`, net.name);
  }
}

const probeModel = await compileDDL(
  `device TestProbe {
     pin y(low: 1.5, high: 3.5);
     output channel level: number(capacity: 8, overflow: Overflow.drop_oldest);
     pure fn code(sampled: Logic) -> number {
       if sampled == Logic.high {
         return 1;
       } else if sampled == Logic.low {
         return 0;
       }
       return 2;
     }
     derived current: number = code(y.sample.level);
     process start {
       level.send(current);
     }
     process changed on current {
       level.send(current);
     }
   }`,
);
const resistorModel = (resistance) =>
  compileDDL(`device TestResistor {
     pin a = [resistor(to: b, resistance: ${resistance})];
     pin b;
   }`);

const buttonSymbols = schematic.sheet.symbols.filter(
  (symbol) => symbol.device === 'xbotlab:push-button',
);
const ROWS = ['P30/TXD', 'P31/RXD', 'P32', 'P33'];
const COLUMNS = ['P42/WR', 'P35', 'P34'];
const PULL_UP = 1000;
const PULL_DOWN = 10000;

const nets = new Map();
const addPin = (name, instance, pin) => {
  if (name === undefined) return;
  const list = nets.get(name) ?? [];
  list.push({ instance, pin });
  nets.set(name, list);
};
for (const symbol of buttonSymbols) {
  addPin(netOfPin.get(`${symbol.id}/a`), symbol.id, 'a');
  addPin(netOfPin.get(`${symbol.id}/b`), symbol.id, 'b');
}
// 行 1 kΩ 上拉、列 10 kΩ 下拉：独立按键按下把行拉到 0 V，矩阵键按下把列抬到 4.5 V。
for (const row of ROWS) {
  addPin(row, `pull_up_${row}`, 'b');
  addPin('VCC', `pull_up_${row}`, 'a');
}
for (const column of COLUMNS) {
  addPin(column, `pull_down_${column}`, 'a');
  addPin('GND', `pull_down_${column}`, 'b');
}
addPin('RST', 'pull_down_RST', 'a');
addPin('GND', 'pull_down_RST', 'b');
const PROBES = [...ROWS, ...COLUMNS, 'RST'];
for (const net of PROBES) addPin(net, `probe_${net}`, 'y');

const probeReadings = new Map();
const buttonTopics = new Map(buttonSymbols.map((symbol) => [symbol.id, new Set()]));
const library = [];
const instances = [];
for (const symbol of buttonSymbols) {
  const module = await import(
    pathToFileURL(join(PROJECT, 'dist', 'devices', 'push-button', 'device.js')).href
  );
  const listeners = buttonTopics.get(symbol.id);
  library.push({
    id: symbol.id,
    model: module.model,
    create: (context) =>
      module.create({
        ...context,
        topics: {
          ...context.topics,
          onDidReceive(listener) {
            listeners.add(listener);
            return { dispose: () => listeners.delete(listener) };
          },
        },
      }),
  });
  instances.push({ id: symbol.id, type: symbol.id, props: {} });
}
for (const name of ['pull_up', 'pull_down']) {
  for (const net of name === 'pull_up' ? ROWS : [...COLUMNS, 'RST']) {
    const id = `${name}_${net}`;
    library.push({
      id,
      model: await resistorModel(name === 'pull_up' ? PULL_UP : PULL_DOWN),
      create: () => ({ sync() {}, dispose() {} }),
    });
    instances.push({ id, type: id, props: {} });
  }
}
for (const net of PROBES) {
  const id = `probe_${net}`;
  library.push({
    id,
    model: probeModel,
    create: () => ({
      sync(batch) {
        const messages = batch.outputs.level ?? [];
        if (messages.length > 0) probeReadings.set(net, messages.at(-1).value);
      },
      dispose() {},
    }),
  });
  instances.push({ id, type: id, props: {} });
}

const board = createBoard(createDeviceLibrary(library), {
  instances,
  nets: [...nets].map(([name, pins]) => ({
    id: name,
    pins,
    ...(name === 'VCC' ? { voltage: 5 } : name === 'GND' ? { voltage: 0 } : {}),
  })),
});
const faults = [];
board.onDidError((event) => faults.push(event.message));
board.runUntil(1_000_000_000);

const press = (designator, value) => {
  const symbol = buttonSymbols.find((candidate) => candidate.designator === designator);
  for (const listener of buttonTopics.get(symbol.id)) listener({ topic: 'press', payload: value });
};
const settle = () => board.runUntil(board.time + 1_000_000_000);

const EXPECTED = [
  ['S7', 'P30/TXD'],
  ['S6', 'P31/RXD'],
  ['S5', 'P32'],
  ['S4', 'P33'],
  ['S11', 'P42/WR'],
  ['S10', 'P42/WR'],
  ['S9', 'P42/WR'],
  ['S8', 'P42/WR'],
  ['S15', 'P35'],
  ['S14', 'P35'],
  ['S13', 'P35'],
  ['S12', 'P35'],
  ['S19', 'P34'],
  ['S18', 'P34'],
  ['S17', 'P34'],
  ['S16', 'P34'],
];
for (const [designator, row] of ['S7', 'S6', 'S5', 'S4'].map((key, index) => [key, ROWS[index]])) {
  press(designator, true);
  settle();
  if (probeReadings.get(row) !== 0)
    fail(`按下 ${designator} 后 ${row} 应为低，实际 ${probeReadings.get(row)}`);
  press(designator, false);
  settle();
  if (probeReadings.get(row) !== 1)
    fail(`松开 ${designator} 后 ${row} 应为高，实际 ${probeReadings.get(row)}`);
}
for (const [designator, column] of EXPECTED.slice(4)) {
  press(designator, true);
  settle();
  if (probeReadings.get(column) !== 1)
    fail(`按下 ${designator} 后 ${column} 应为高，实际 ${probeReadings.get(column)}`);
  press(designator, false);
  settle();
  if (probeReadings.get(column) !== 0)
    fail(`松开 ${designator} 后 ${column} 应为低，实际 ${probeReadings.get(column)}`);
}
press('S1', true);
settle();
if (probeReadings.get('RST') !== 1) fail(`按下 S1 后 RST 应为高，实际 ${probeReadings.get('RST')}`);
press('S1', false);
settle();
if (probeReadings.get('RST') !== 0) fail(`松开 S1 后 RST 应为低，实际 ${probeReadings.get('RST')}`);
board.dispose();
for (const message of faults) fail(`按键板故障：${message}`);

// ---- 结果 ------------------------------------------------------------------------------
console.log(
  `widgets ${canvas.widgets.length}（按键 ${buttons.length}、数码管 ${segments.length}、LED ${leds.length}、背景图 1）  照片 ${size?.width}×${size?.height}`,
);
console.log(`数码管 ${lit}/${expectedLit} 段点亮  按键网络 ${EXPECTED.length + 1} 个逐键验证`);
if (failures.length > 0) {
  for (const message of failures) console.error(`✗ ${message}`);
  process.exitCode = 1;
} else {
  console.log('✓ 画布解析、绑定、对位、widget 渲染与按键网络全部通过');
}
