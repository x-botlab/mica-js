import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { defineConfig, findProjectConfig, loadProjectConfig } from './config';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(): Promise<string> {
  const root = await mkdtemp(fileURLToPath(new URL('../.tmp-config-', import.meta.url)));
  roots.push(root);
  return root;
}

it('discovers the nearest mitest marker independently of mica configuration', async () => {
  const root = await fixture();
  const nested = join(root, 'nested');
  await mkdir(join(nested, 'tests'), { recursive: true });
  await writeFile(join(root, 'mica.config.ts'), 'throw new Error("must not load SDK config");');
  await expect(findProjectConfig(nested)).rejects.toThrow('mitest.config.ts');
  const configFile = join(root, 'mitest.config.ts');
  await writeFile(configFile, 'throw new Error("discovery must not execute config");');
  expect(await findProjectConfig(join(nested, 'tests'))).toBe(configFile);
  await writeFile(join(nested, 'mitest.config.ts'), 'export default {};');
  expect(await findProjectConfig(join(nested, 'tests'))).toBe(join(nested, 'mitest.config.ts'));
  expect(await findProjectConfig(nested, join('..', 'mitest.config.ts'))).toBe(configFile);
  await expect(findProjectConfig(root, 'mica.config.ts')).rejects.toThrow(
    'must be named mitest.config.ts',
  );
});

it('loads typed configuration and imported paths without SDK configuration', async () => {
  const root = await fixture();
  const helper = join(dirname(fileURLToPath(import.meta.url)), 'config.ts').replaceAll('\\', '/');
  await writeFile(join(root, 'paths.ts'), 'export const document: string = "circuits/a.sch";');
  const configFile = join(root, 'mitest.config.ts');
  await writeFile(
    configFile,
    `
    import { defineConfig } from ${JSON.stringify(helper)};
    import { document } from './paths';
    export default defineConfig({ testbenches: { circuit: { document, devices: {} } } });
  `,
  );
  const loaded = await loadProjectConfig({ root });
  expect(loaded).toEqual({
    root,
    configFile,
    config: { testbenches: { circuit: { document: 'circuits/a.sch', devices: {} } } },
  });
  expect(defineConfig(loaded.config)).toBe(loaded.config);
});

it.each([
  ['null', 'object'],
  ['{}', 'testbenches'],
  ['{ testbenches: {} }', 'testbenches'],
  ['{ testbenches: { "../outside": {} } }', 'testbenches'],
  ['{ testbenches: { circuit: { document: "", devices: {} } } }', 'document'],
  ['{ testbenches: { circuit: { document: "a.sch", devices: [] } } }', 'devices'],
  [
    '{ testbenches: { circuit: { document: "a.sch", devices: { "test:switch": "" } } } }',
    'devices',
  ],
  ['{ testbenches: { circuit: { document: "a.sch", devices: {}, typo: true } } }', 'typo'],
  ['{ device: {}, testbenches: {} }', 'device'],
])('rejects malformed or misplaced configuration: %s', async (source, field) => {
  const root = await fixture();
  await writeFile(join(root, 'mitest.config.ts'), `export default ${source};`);
  await expect(loadProjectConfig({ root })).rejects.toThrow(field);
});
