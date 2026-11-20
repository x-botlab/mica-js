import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const cli = resolve(root, 'node_modules', '@mica-js', 'sdk', 'dist', 'build', 'cli.js');
const tsc = resolve(root, 'node_modules', 'typescript', 'bin', 'tsc');
const ids = ['led', 'push-button', 'resistor', 'voltmeter'];
const command = process.argv[2] ?? 'build';
const run = (args) =>
  execFileSync(process.execPath, args, { cwd: root, stdio: 'inherit', timeout: 120_000 });

if (!['build', 'prepare', 'typecheck'].includes(command))
  throw new Error('Usage: components.mjs <build|prepare|typecheck>');

if (command !== 'typecheck') rmSync(resolve(root, 'dist'), { recursive: true, force: true });

for (const id of ids) {
  const directory = resolve(root, id);
  run([cli, command === 'typecheck' ? 'prepare' : command, '--root', directory]);
  if (command === 'typecheck') run([tsc, '-p', directory, '--noEmit']);
}
