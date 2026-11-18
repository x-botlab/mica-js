#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, createServer } from 'vite';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repository = resolve(app, '..', '..');
const components = resolve(repository, 'examples', 'playground-components');
const cli = resolve(repository, 'packages', 'sdk', 'dist', 'build', 'cli.js');
const mode = process.argv[2];

/** Designators present in the historical CT107D widget canvas. */
const CT107D_DEVICE_IDS = [
  '74hc02',
  '74hc138',
  '74hc573',
  '74hc14',
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
  'ultrasonic',
  'uart-probe',
  'vs1838',
  'seg4',
  'blue-led',
  'iap15f2k61s2',
];

function run(command, args, options = {}) {
  const child = spawn(command, args, { cwd: repository, stdio: 'inherit', ...options });
  return new Promise((settle, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) settle();
      else reject(new Error(`${command} exited with ${signal ?? code}`));
    });
  });
}

async function bootstrap() {
  const pnpm = process.env.npm_execpath ?? 'pnpm';
  const args = ['--filter', '@mica-js/sdk...', 'build'];
  if (/\.[cm]?js$/i.test(pnpm)) await run(process.execPath, [pnpm, ...args]);
  else await run(pnpm, args);
}

function serverOptions(args) {
  const result = {};
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--') continue;
    if (flag === '--strictPort') result.strictPort = true;
    else if (flag === '--open') result.open = true;
    else if (flag === '--host')
      result.host = args[index + 1]?.startsWith('-') || !args[index + 1] ? true : args[++index];
    else if (flag === '--port') {
      const port = Number(args[++index]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid --port');
      result.port = port;
    } else throw new Error(`Unsupported Playground option: ${flag}`);
  }
  return result;
}

function hasLegacyDevices(directory) {
  return (
    directory !== undefined &&
    CT107D_DEVICE_IDS.every(
      (id) =>
        existsSync(resolve(directory, id, 'device.json')) &&
        existsSync(resolve(directory, id, 'device.js')),
    )
  );
}

/**
 * Resolves the historical widget/device inputs of the CT107D playground preview.
 *
 * The unified device packages (`examples/devices/dist/<id>/model.js`) are deliberately not
 * accepted here: the old playground editor loads legacy `device.json` metadata and
 * `device.js` factories, while a unified package exposes `package.json` and `model.js` with
 * a different context/event contract. Copying those files into this directory would create
 * a preview that cannot run.
 */
export function ct107dPreviewPlan(root = repository) {
  const source = resolve(root, 'examples', 'ct107d');
  const legacySource = resolve(source, 'legacy', 'source');
  const widgets = resolve(source, 'dist', 'widgets');
  const assets = resolve(source, 'assets');
  const legacyDevices = [
    resolve(source, 'dist', 'devices'),
    resolve(root, 'examples', 'devices', 'dist', 'devices'),
    resolve(root, 'examples', 'devices', 'dist'),
  ].find(hasLegacyDevices);
  const missing = [];
  if (!existsSync(resolve(legacySource, 'ct107d.cnv'))) missing.push('legacy/source/ct107d.cnv');
  if (!existsSync(resolve(legacySource, 'ct107d.sch'))) missing.push('legacy/source/ct107d.sch');
  if (!existsSync(widgets)) missing.push('dist/widgets');
  if (!existsSync(assets)) missing.push('assets');
  if (legacyDevices === undefined)
    missing.push(
      'legacy device assets (`dist/devices/<id>/device.json` + `device.js`; ' +
        '统一器件包的 `model.js` 不能替代)',
    );

  return {
    source,
    legacySource,
    widgets,
    assets,
    legacyDevices,
    available: missing.length === 0,
    missing,
    reason:
      missing.length === 0
        ? undefined
        : `CT107D 旧 widget 预览不可用：${missing.join('、')}。` +
          '统一器件包只提供 package.json/model.js，旧 playground 需要 legacy device.json/device.js。',
  };
}

function unavailableNotice(plan) {
  return `# CT107D 旧 widget 预览已停用

${plan.reason}

这是一个明确停用状态，不是“未找到就跳过”。请使用正式的新工作台：

- 在仓库根目录运行 \`pnpm --dir examples/ct107d run workbench:dev\`，打开 CT107D v2 工作台；
- 或在 \`apps/playground\` 运行 \`pnpm run dev:workbench\`，打开新的 workbench 演示。

旧 playground 已不再列出 CT107D 文档入口；本目录的 README 只保留停用原因。不要再从统一器件包伪造 legacy 产物，也不要把它当作 CT107D 宿主。
`;
}

/**
 * Copies the CT107D preview assets into `public/components/ct107d`.
 *
 * Returns an explicit status. When the legacy device artifacts are absent the function
 * writes a README that explains the migration instead of silently skipping (or copying
 * incompatible unified packages) in the caller.
 */
export async function copyCt107d(artifacts, root = repository) {
  const plan = ct107dPreviewPlan(root);
  const target = resolve(artifacts, 'ct107d');
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });

  if (!plan.available) {
    await writeFileSync(resolve(target, 'README.md'), unavailableNotice(plan), 'utf8');
    return { status: 'unavailable', target, reason: plan.reason };
  }

  const previewSchematic = 'ct107d-digital-display.sch';
  const previewCanvas = 'ct107d-digital-display.cnv';
  for (const file of ['ct107d.cnv', 'ct107d.sch']) {
    await cp(resolve(plan.legacySource, file), resolve(target, file));
  }
  const schematic = JSON.parse(readFileSync(resolve(plan.legacySource, 'ct107d.sch'), 'utf8'));
  writeFileSync(resolve(target, previewSchematic), `${JSON.stringify(schematic, null, 2)}\n`);
  const canvas = JSON.parse(readFileSync(resolve(plan.legacySource, 'ct107d.cnv'), 'utf8'));
  canvas.schematic = previewSchematic;
  writeFileSync(resolve(target, previewCanvas), `${JSON.stringify(canvas, null, 2)}\n`);
  await cp(plan.assets, resolve(target, 'assets'), { recursive: true });
  await cp(plan.legacyDevices, resolve(target, 'devices'), { recursive: true });
  await cp(plan.widgets, resolve(target, 'widgets'), { recursive: true });
  return { status: 'copied', target };
}

async function main() {
  if (mode !== 'build' && mode !== 'dev') throw new Error('Usage: components.mjs <dev|build>');
  await bootstrap();
  await run(process.execPath, [cli, 'build', '--root', components]);
  const componentCli = resolve(repository, 'packages', 'sdk', 'dist', 'build', 'cli.js');
  const devicesRoot = resolve(repository, 'examples', 'devices');
  const ct107dRoot = resolve(repository, 'examples', 'ct107d');
  for (const root of [devicesRoot, ct107dRoot]) {
    if (existsSync(resolve(root, 'mica.config.ts')))
      await run(process.execPath, [componentCli, 'build', '--root', root]);
  }
  const artifacts = resolve(app, 'public', 'components');
  await rm(artifacts, { recursive: true, force: true });
  await cp(resolve(components, 'dist'), artifacts, { recursive: true });
  const preview = await copyCt107d(artifacts);
  if (preview.status === 'unavailable') {
    console.log(`components: ${preview.reason}`);
    console.log(
      'components: CT107D 旧预览已明确停用；请使用新工作台（见 public/components/ct107d/README.md）',
    );
  } else {
    console.log('components: 已复制 CT107D 的器件、widget、原理图与画布');
  }
  if (mode === 'dev') {
    const server = await createServer({ root: app, server: serverOptions(process.argv.slice(3)) });
    await server.listen();
    server.printUrls();
    server.bindCLIShortcuts({ print: true });
  } else {
    await build({ root: app });
  }
}

const invoked =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
