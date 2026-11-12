/**
 * issue #267 冷启动分阶段测量：import / 校验 / 装配 / 首帧。
 *
 * 必须在**新进程**里单跑一次：同一进程里重复执行会被模块缓存、IR 校验的身份缓存和 V8
 * 的编译缓存吃掉，读数就不再是冷启动。
 *
 *   pnpm --filter "@mica-js/sdk..." build
 *   pnpm --filter @mica-js/example-ct107d build
 *   node packages/sdk/scripts/cold-start.mjs
 *
 * 数据来源是真实产物：`examples/ct107d/dist/devices/<id>/device.js`（17 份，含 187 KB 的
 * 8051）与 `examples/ct107d/ct107d.sch` 折出的 44 器件网表。口径与 issue 报的数字对齐：
 * 导入所有 device.js → `createDeviceLibrary`（IR 校验）→ `createBoard`（装配）→ 首个
 * 200 µs 推进（惰性翻译 + 直接程序首次编译）。
 *
 * 第二个小节回答「model IR 从 device.js 拆出」值不值：
 * - `字面量`：把 model 当 JS 对象字面量解析并求值（现在 device.js 的实际做法）；
 * - `JSON.parse`：同一份负载走 JSON（拆成 model.json 后的做法）；
 * - 差值就是拆分能省下的上限，再与整条冷启动链路对比即可判断收益比例。
 *
 * 断言只守方向与量级：器件数、板能跑完、`JSON.parse` 不慢于字面量求值。
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const project = join(root, 'examples/ct107d');
const deviceRoot = join(project, 'dist/devices');
/** issue 的验收口径是「首个 200 µs 推进」。 */
const SLICE_PS = 200 * 1000 * 1000;
const IR_REPEATS = 5;

const format = (ms) => `${ms.toFixed(1)} ms`;
const jsonParse = (path) => JSON.parse(readFileSync(path, 'utf8'));

/** 分阶段计时：每次 `end()` 记录一次墙钟与进程 CPU。 */
const stages = [];
function stage(label) {
  const wall = performance.now();
  const cpu = process.cpuUsage();
  return {
    end(detail = '') {
      const usage = process.cpuUsage(cpu);
      const entry = {
        label,
        detail,
        wall: performance.now() - wall,
        cpu: (usage.user + usage.system) / 1000,
      };
      stages.push(entry);
      return entry;
    },
  };
}

const coldStart = performance.now();

let timer = stage('import sdk + device-model + document');
const { createBoard, createDeviceLibrary } = await import(
  pathToFileURL(join(root, 'packages/sdk/dist/index.js')).href
);
const { validateDeviceIR } = await import(
  pathToFileURL(join(root, 'packages/device-model/dist/index.js')).href
);
const { deriveSchematicTopology, deviceMetadataSymbol, parseDeviceMetadata, parseSchematic } =
  await import(pathToFileURL(join(root, 'packages/document/dist/schematic/index.js')).href);
timer.end();

const ids = readdirSync(deviceRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

timer = stage('读取 device.js 文本');
const sources = ids.map((id) => ({
  id,
  path: join(deviceRoot, id, 'device.js'),
  text: readFileSync(join(deviceRoot, id, 'device.js'), 'utf8'),
}));
timer.end(`${(sources.reduce((sum, item) => sum + item.text.length, 0) / 1024).toFixed(0)} KB`);

timer = stage(`import ${sources.length} 份 device.js`);
const entries = [];
for (const source of sources) {
  const module = await import(pathToFileURL(source.path).href);
  entries.push({ id: source.id, model: module.model, create: module.create });
}
timer.end();

timer = stage('解析原理图并折网表');
const schematic = parseSchematic(readFileSync(join(project, 'ct107d.sch'), 'utf8'));
const referenceId = (reference) => reference.replace(/^xbotlab:/, '');
const definitions = new Map();
for (const symbol of schematic.sheet.symbols) {
  const id = referenceId(symbol.device);
  if (definitions.has(id) || !ids.includes(id)) continue;
  definitions.set(id, parseDeviceMetadata(jsonParse(join(deviceRoot, id, 'device.json'))));
}
const topology = deriveSchematicTopology(schematic, {
  devices: {
    getDeviceName: (reference) => definitions.get(referenceId(reference.raw))?.displayName,
    getDeviceSymbol: (reference) => {
      const definition = definitions.get(referenceId(reference.raw));
      return definition === undefined ? undefined : deviceMetadataSymbol(definition);
    },
  },
});
const firmware = new Uint8Array(readFileSync(join(project, 'assets', 'ct107d-demo.bin')));
const components = schematic.sheet.symbols
  .filter((symbol) => symbol.designator)
  .map((symbol) => ({
    id: symbol.id,
    device: referenceId(symbol.device),
    props: symbol.properties ?? {},
  }));
const nets = topology.nets.map((net, index) => ({
  id: `net:${index}`,
  pins: net.members
    .filter((member) => member.kind === 'pin')
    .map((member) => ({ instance: member.symbolId, pin: member.pinId })),
  ...(net.name === 'VCC'
    ? { voltage: 5 }
    : net.name === 'GND' || net.name === 'P42/WR'
      ? { voltage: 0 }
      : {}),
}));
const description = {
  instances: components.map((component) => ({
    id: component.id,
    type: component.id,
    props:
      'firmware' in component.props ? { ...component.props, firmware } : { ...component.props },
  })),
  nets,
};
timer.end(`${components.length} 器件 / ${nets.length} 网`);

timer = stage('createDeviceLibrary（IR 校验）');
const library = createDeviceLibrary(
  components.map((component) => {
    const device = entries.find((entry) => entry.id === component.device);
    assert.ok(device, `缺少器件 ${component.device}`);
    return { id: component.id, model: device.model, create: device.create };
  }),
);
timer.end();

timer = stage('createBoard（装配）');
const board = createBoard(library, description);
const faults = [];
const subscription = board.onDidError((event) => faults.push(event.message));
timer.end();

timer = stage('首个 200 µs 推进（翻译 + 直接程序首次编译）');
board.runUntil(SLICE_PS);
timer.end(`simTime=${(board.time / 1e9).toFixed(3)} ms`);

timer = stage('第二个 200 µs 推进（稳态参考）');
board.runUntil(board.time + SLICE_PS);
timer.end();

subscription.dispose();
board.dispose();
const total = performance.now() - coldStart;

console.log(`issue #267 冷启动分阶段（新进程，${sources.length} 份 device.js）：`);
for (const entry of stages)
  console.log(
    `  ${entry.label.padEnd(40)}${format(entry.wall).padStart(11)}  CPU ${format(entry.cpu).padStart(10)}${entry.detail === '' ? '' : `  ${entry.detail}`}`,
  );
console.log(`  ${'合计'.padEnd(40)}${format(total).padStart(11)}`);
assert.equal(faults.length, 0, `装配/运行期不应有模型错误：${faults.join('; ')}`);
assert.ok(board.time >= SLICE_PS * 2, '板必须真的推进到目标时间');

/* ------------------------------------------------------------------ */
/* model IR 拆分评估：JS 对象字面量 vs JSON.parse                       */
/* ------------------------------------------------------------------ */

const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
};

const measure = (run) => {
  const samples = [];
  for (let index = 0; index < IR_REPEATS; index += 1) {
    const started = performance.now();
    run(index);
    samples.push(performance.now() - started);
  }
  return median(samples);
};

let literalMs = 0;
let jsonMs = 0;
let bytesTotal = 0;
let bytesModel = 0;
const rows = [];
for (const source of sources) {
  const module = await import(pathToFileURL(source.path).href);
  const json = JSON.stringify(module.model);
  bytesTotal += source.text.length;
  bytesModel += json.length;
  // 唯一前缀让每次编译的源码不同，避免 V8 的编译缓存把重复测量抹平。
  const literal = measure((index) => new Function(`/*${source.id}:${index}*/return ${json};`)());
  const parsed = measure((index) => JSON.parse(`${' '.repeat(index % 2)}${json}`));
  literalMs += literal;
  jsonMs += parsed;
  rows.push({ id: source.id, literal, json: parsed, bytes: json.length });
}

console.log('\nmodel IR 负载：JS 对象字面量 vs JSON.parse（每项取 5 次中位数）');
console.log(
  `  ${'device.js'.padEnd(20)}${'model 负载'.padStart(12)}${'字面量'.padStart(10)}${'JSON.parse'.padStart(12)}`,
);
for (const row of rows)
  console.log(
    `  ${row.id.padEnd(20)}${`${(row.bytes / 1024).toFixed(1)} KB`.padStart(12)}${format(row.literal).padStart(10)}${format(row.json).padStart(12)}`,
  );
const savings = literalMs - jsonMs;
const importStage = stages.find((entry) => entry.label.startsWith('import '));
console.log(
  `  ${'合计'.padEnd(20)}${`${(bytesModel / 1024).toFixed(1)} KB`.padStart(12)}${format(literalMs).padStart(10)}${format(jsonMs).padStart(12)}`,
);
console.log(
  `\n  拆分上限：${format(savings)}（字面量求值 - JSON.parse），占整条冷启动链路 ${((savings / total) * 100).toFixed(1)}%，` +
    `占 import 阶段 ${((savings / importStage.wall) * 100).toFixed(0)}%；` +
    `model 负载占 device.js 源码 ${((bytesModel / bytesTotal) * 100).toFixed(0)}%。`,
);
assert.ok(jsonMs <= literalMs * 1.5, `JSON.parse 不应显著慢于字面量求值：${format(jsonMs)}`);
assert.equal(validateDeviceIR.length, 1, 'validateDeviceIR 仍由 device-model 提供');
