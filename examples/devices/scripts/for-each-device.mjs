import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 统一器件聚合脚本：逐个单器件项目执行 prepare / build，或各自运行 tsc。
 *
 * 每个项目有自己的 `package.json`、`mica.config.ts`、`.mica/device.d.ts` 与
 * `.mica/tsconfig.json`；不把它们合并进同一个 TypeScript 程序，避免不同器件的
 * 全局 `DeviceProps` / `DeviceMethods` 相互污染。
 */

const root = join(import.meta.dirname, '..');
const command = process.argv[2];

if (!['prepare', 'build', 'typecheck'].includes(command ?? '')) {
  console.error('Usage: node scripts/for-each-device.mjs <prepare|build|typecheck>');
  process.exit(2);
}

function isDeviceProject(directory) {
  try {
    const manifest = JSON.parse(readFileSync(join(root, directory, 'package.json'), 'utf8'));
    return (
      typeof manifest.publisher === 'string' &&
      typeof manifest.name === 'string' &&
      typeof manifest.displayName === 'string' &&
      typeof manifest.engines?.mica === 'string'
    );
  } catch {
    return false;
  }
}

const devices = readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter(
    (name) => !['dist', 'node_modules', 'test', 'bench', 'docs', 'scripts', 'views'].includes(name),
  )
  .filter(isDeviceProject)
  .sort();

if (devices.length === 0) {
  console.error('No unified device projects found.');
  process.exit(1);
}

const executable = process.platform === 'win32' ? 'tsc.cmd' : 'tsc';
for (const device of devices) {
  const args = command === 'typecheck' ? ['-p', device, '--noEmit'] : [command, '--root', device];
  const binary =
    command === 'typecheck' ? executable : process.platform === 'win32' ? 'mica.cmd' : 'mica';
  console.log(`\n[${device}] ${binary} ${args.join(' ')}`);
  const result = spawnSync(binary, args, { cwd: root, stdio: 'inherit', env: process.env });
  if (result.error !== undefined) {
    console.error(`${device}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
