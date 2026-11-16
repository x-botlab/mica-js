import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { parseCliArguments, runCli } from './cli';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it('parses prepare options and rejects incompatible lock updates and runner commands', () => {
  expect(
    parseCliArguments(['prepare', '--update-lock', '--config=mitest.config.ts']),
  ).toMatchObject({
    updateLock: true,
    watch: false,
    config: 'mitest.config.ts',
  });
  expect(parseCliArguments(['prepare', '--watch']).watch).toBe(true);
  expect(parseCliArguments(['update-lock']).updateLock).toBe(true);
  expect(() => parseCliArguments(['update-lock', '--watch'])).toThrow('without --watch');
  expect(() => parseCliArguments(['prepare', '--watch', '--update-lock'])).toThrow(
    'without --watch',
  );
  expect(() => parseCliArguments(['prepare', '--update-lock=true'])).toThrow(
    'does not take a value',
  );
  expect(() => parseCliArguments(['prepare', '--root'])).toThrow('Missing value');
  expect(() => parseCliArguments(['test'])).toThrow('Unknown command');
});

it('prepares only .mitest outputs while preserving co-located author configuration and types', async () => {
  const root = await mkdtemp(fileURLToPath(new URL('../.tmp-cli-', import.meta.url)));
  roots.push(root);
  const out: string[] = [];
  const err: string[] = [];
  const streams = {
    out: { write: (text: string) => out.push(text) },
    err: { write: (text: string) => err.push(text) },
  };
  await writeFile(join(root, 'mica.config.ts'), 'throw new Error("must not read SDK config");');
  await mkdir(join(root, '.mica'));
  await writeFile(join(root, '.mica', 'device.d.ts'), 'declare const AuthorDevice: string;');
  expect(await runCli(['prepare', '--root', root], streams)).toBe(1);
  expect(err.join('')).toContain('mitest.config.ts');
  await writeFile(
    join(root, 'mitest.config.ts'),
    `export default { testbenches: { empty: { document: 'empty.sch', devices: {} } } };`,
  );
  await writeFile(
    join(root, 'empty.sch'),
    JSON.stringify({
      version: 2,
      dependencies: {},
      instances: [],
      nodes: [],
      wires: [],
      labels: [],
      references: [],
    }),
  );
  expect(await runCli(['prepare', '--root', root], streams), err.join('')).toBe(0);
  expect(out.join('')).toContain('mitest prepare: circuit testbench types ready');
  const config = JSON.parse(await readFile(join(root, '.mitest', 'tsconfig.json'), 'utf8'));
  expect(config.include).toContain('../mitest.config.ts');
  expect(config.include).not.toContain('../mica.config.ts');
  expect(config.files).toBeUndefined();
  const source = await readFile(join(root, '.mitest', 'testbenches', 'empty.ts'), 'utf8');
  expect(source).not.toContain('@mica-js/sdk');
  expect(await readFile(join(root, '.mica', 'device.d.ts'), 'utf8')).toBe(
    'declare const AuthorDevice: string;',
  );
});
