import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, createServer } from 'vite';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repository = resolve(app, '..', '..');
const components = resolve(repository, 'examples', 'playground-components');
const cli = resolve(repository, 'packages', 'sdk', 'dist', 'build', 'cli.js');
const mode = process.argv[2];

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

/**
 * 把 `examples/ct107d` 的交付物复制到被忽略的 `public/components/ct107d`，让主页面能
 * 打开 `ct107d.cnv`。该示例包已包含整板用到的全部器件（含 IAP15F2K61S2、seg4 与
 * blue-led），因此不需要再从别的工程取器件；没有产物时只提示并跳过。
 */
async function copyCt107d(artifacts) {
  const source = resolve(repository, 'examples', 'ct107d');
  if (!existsSync(resolve(source, 'ct107d.cnv'))) {
    console.log('components: 未找到 examples/ct107d/ct107d.cnv，跳过 CT107D 画布预览');
    return;
  }
  if (!existsSync(resolve(source, 'dist', 'devices'))) {
    console.log('components: 未找到 examples/ct107d/dist，请先构建该示例包，跳过 CT107D 预览');
    return;
  }
  const target = resolve(artifacts, 'ct107d');
  await mkdir(target, { recursive: true });
  for (const file of ['ct107d.cnv', 'ct107d.sch']) {
    await cp(resolve(source, file), resolve(target, file));
  }
  await cp(resolve(source, 'assets'), resolve(target, 'assets'), { recursive: true });
  await cp(resolve(source, 'dist', 'devices'), resolve(target, 'devices'), { recursive: true });
  await cp(resolve(source, 'dist', 'widgets'), resolve(target, 'widgets'), { recursive: true });
  console.log('components: 已复制 CT107D 的器件、widget、原理图与画布');
}

try {
  if (mode !== 'build' && mode !== 'dev') throw new Error('Usage: components.mjs <dev|build>');
  await bootstrap();
  await run(process.execPath, [cli, 'build', '--root', components]);
  const ct107dCli = resolve(repository, 'packages', 'sdk', 'dist', 'build', 'cli.js');
  const ct107dRoot = resolve(repository, 'examples', 'ct107d');
  if (existsSync(resolve(ct107dRoot, 'mica.config.ts')))
    await run(process.execPath, [ct107dCli, 'build', '--root', ct107dRoot]);
  const artifacts = resolve(app, 'public', 'components');
  await rm(artifacts, { recursive: true, force: true });
  await cp(resolve(components, 'dist'), artifacts, { recursive: true });
  await copyCt107d(artifacts);
  if (mode === 'dev') {
    const server = await createServer({ root: app, server: serverOptions(process.argv.slice(3)) });
    await server.listen();
    server.printUrls();
    server.bindCLIShortcuts({ print: true });
  } else {
    await build({ root: app });
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
