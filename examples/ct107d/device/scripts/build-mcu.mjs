import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MCU_ARTIFACT,
  MCU_ROOT,
  MCU_STAMP,
  mcuArtifactHash,
  mcuSourceHash,
} from './mcu-source.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CT107D = join(HERE, '..', '..');
const REPO = join(CT107D, '..', '..');
const CLI = realpathSync(
  join(REPO, 'examples', 'ct107d', 'node_modules', '@mica-js', 'sdk', 'dist', 'build', 'cli.js'),
);

const result = spawnSync(process.execPath, [CLI, 'build', '--root', MCU_ROOT], {
  cwd: CT107D,
  stdio: 'inherit',
  env: process.env,
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
if (!existsSync(MCU_ARTIFACT)) throw new Error('MCU build did not produce model.js');
mkdirSync(dirname(MCU_STAMP), { recursive: true });
const artifact = mcuArtifactHash();
if (artifact === undefined) throw new Error('MCU build did not produce artifact files');
const stamp = { version: 1, source: mcuSourceHash(), artifact };
writeFileSync(MCU_STAMP, `${JSON.stringify(stamp, null, 2)}\n`);
console.log(`MCU stamp source=${stamp.source} artifact=${stamp.artifact}`);
