import { spawn } from 'node:child_process';
import { cp, rm } from 'node:fs/promises';
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

try {
  if (mode !== 'build' && mode !== 'dev') throw new Error('Usage: components.mjs <dev|build>');
  await bootstrap();
  await run(process.execPath, [cli, 'build', '--root', components]);
  const artifacts = resolve(app, 'public', 'components');
  await rm(artifacts, { recursive: true, force: true });
  await cp(resolve(components, 'dist'), artifacts, { recursive: true });
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
