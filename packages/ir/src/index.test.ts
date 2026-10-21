import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as ir from './index';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
let fixture: string;

beforeAll(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'mica-ir-consumer-'));
  const installedPackage = join(fixture, 'node_modules', '@mica', 'ir');
  await mkdir(installedPackage, { recursive: true });
  await copyFile(join(packageRoot, 'package.json'), join(installedPackage, 'package.json'));
  await build({
    root: packageRoot,
    configFile: join(packageRoot, 'vite.config.ts'),
    logLevel: 'silent',
    build: { outDir: join(installedPackage, 'dist'), emptyOutDir: true },
  });
}, 30_000);

afterAll(async () => {
  if (fixture) await rm(fixture, { recursive: true, force: true });
});

describe('public package boundary', () => {
  it('has no placeholder API', () => {
    expect(Object.keys(ir)).toEqual([]);
  });

  it('loads the built ESM through its package export and rejects private paths', async () => {
    const consumer = join(fixture, 'consumer.mjs');
    await writeFile(
      consumer,
      `import assert from 'node:assert/strict';
import * as ir from '@mica/ir';
assert.deepEqual(Object.keys(ir), []);
for (const path of ['src/index.js', 'dist/index.js', 'model', 'builder', 'validation', 'interpreter', 'provider']) {
  await assert.rejects(import('@mica/ir/' + path), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
}
`,
    );
    const result = spawnSync(process.execPath, [consumer], { encoding: 'utf8' });
    expect(result.error).toBeUndefined();
    expect(result.stdout + result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('rejects an unimplemented execution API in the ESM loader', async () => {
    const consumer = join(fixture, 'unsupported.mjs');
    await writeFile(consumer, "import { interpret } from '@mica/ir';\ninterpret();\n");
    const result = spawnSync(process.execPath, [consumer], { encoding: 'utf8' });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("does not provide an export named 'interpret'");
  });

  it('resolves emitted declarations in a strict external TypeScript consumer', async () => {
    const consumer = join(fixture, 'consumer.mts');
    await writeFile(
      consumer,
      `import * as ir from '@mica/ir';
import type * as IrModule from '@mica/ir';
type AssertNever<T extends never> = T;
export type PublicExports = AssertNever<keyof typeof IrModule>;
export type RuntimeExports = AssertNever<keyof typeof ir>;
// @ts-expect-error Execution is not implemented or exported.
import { interpret } from '@mica/ir';
// @ts-expect-error Internal paths are not public entry points.
import type * as Internal from '@mica/ir/dist/index.js';
`,
    );
    const config = join(dirname(consumer), 'tsconfig.json');
    await writeFile(
      config,
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          strict: true,
          noEmit: true,
          types: [],
        },
        files: ['consumer.mts'],
      }),
    );
    const result = spawnSync(process.execPath, [tsc, '--project', config], { encoding: 'utf8' });
    expect(result.error).toBeUndefined();
    expect(result.stdout + result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});
