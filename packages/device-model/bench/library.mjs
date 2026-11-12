/**
 * 器件库冷启动分阶段测量（issue #267 验收口径）。
 *
 * 必须在**新进程**里运行：issue 报的 237 ms 是进程级冷启动时间，同一进程里重复跑会被
 * 模块缓存和 IR 校验缓存吃掉。
 *
 *   pnpm --filter @mica-js/device-model build
 *   node packages/device-model/bench/library.mjs
 *
 * 数据来源是两套真实器件库产物：`examples/ct107d/dist/devices/*` 与
 * `examples/stm32g431rbt6/dist/devices/*`（共 18 份 device.js）。
 *
 * 断言只做方向性判断（第二次远快于第一次）与身份判断（缓存命中后模型还是同一份冻结
 * 快照），不断言绝对毫秒；精确的「校验次数为 1」由
 * `packages/sdk/src/device-library-cache.test.ts` 用 spy 计数断言：ESM 导出在进程内
 * 不可改写，这里只能观察身份稳定。
 */
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const sources = [
  { label: 'ct107d', directory: join(root, 'examples/ct107d/dist/devices') },
  { label: 'stm32g431rbt6', directory: join(root, 'examples/stm32g431rbt6/dist/devices') },
];

const importModule = (specifier) => import(pathToFileURL(specifier).href);
const format = (ms) => `${ms.toFixed(1)} ms`;

const startup = performance.now();
const { createDeviceLibrary } = await importModule(join(root, 'packages/sdk/dist/index.js'));
const { validateDeviceIR } = await importModule(join(root, 'packages/device-model/dist/index.js'));
const libraryImport = performance.now() - startup;

const entries = [];
const models = [];
const importTimes = [];
for (const source of sources) {
  const started = performance.now();
  const ids = (await readdir(source.directory)).sort();
  for (const id of ids) {
    const module = await importModule(join(source.directory, id, 'device.js'));
    models.push(module.model);
    entries.push({ id: `${source.label}/${id}`, model: module.model, create: module.create });
  }
  importTimes.push([source, ids.length, performance.now() - started]);
}

const measure = (label) => {
  const started = performance.now();
  const result = createDeviceLibrary(entries);
  return [result, performance.now() - started, label];
};

const [first, firstTime, firstLabel] = measure('createDeviceLibrary #1');
const [second, secondTime, secondLabel] = measure('createDeviceLibrary #2');

console.log(`device-model bench: ${entries.length} models from ${sources.length} libraries`);
console.log(`  import sdk + device-model: ${format(libraryImport)}`);
for (const [source, count, time] of importTimes)
  console.log(`  import ${source.label} (${count} device.js): ${format(time)}`);
console.log(`  ${firstLabel} (cold): ${format(firstTime)}`);
console.log(`  ${secondLabel} (cached): ${format(secondTime)}`);

assert.ok(first && second, 'createDeviceLibrary must return a library');
assert.ok(
  secondTime < firstTime / 4,
  `${secondLabel} should be far faster than ${firstLabel}: ${format(secondTime)} vs ${format(firstTime)}`,
);

const snapshots = models.map((model) => [validateDeviceIR(model), validateDeviceIR(model)]);
for (const [index, [once, again]] of snapshots.entries()) {
  assert.equal(once, again, `model ${entries[index].id} must hit the validation cache`);
  assert.notEqual(once, models[index], `model ${entries[index].id} must be captured, not shared`);
  assert.ok(Object.isFrozen(once), `model ${entries[index].id} must be frozen`);
  assert.ok(!Object.isFrozen(models[index]), `model ${entries[index].id} input stays mutable`);
}
console.log(`  cached snapshots: ${snapshots.length}/${models.length} stable`);
