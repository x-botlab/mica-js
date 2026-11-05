import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { defineConfig, findProjectConfig, loadProjectConfig } from './config';

const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
const roots: string[] = [];

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(packageRoot, '.config-test-'));
  roots.push(root);
  return root;
}

async function marker(root: string, source = 'export default {};'): Promise<string> {
  const file = join(root, 'mica.config.ts');
  await writeFile(file, source, 'utf8');
  return file;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('findProjectConfig', () => {
  it('finds the nearest marker upward without executing it', async () => {
    const root = await fixture();
    await marker(root, 'throw new Error("must not execute");');
    const nested = join(root, 'nested');
    const start = join(nested, 'deep');
    await mkdir(start, { recursive: true });
    expect(await findProjectConfig(start)).toBe(join(root, 'mica.config.ts'));
    const nearest = await marker(nested, 'throw new Error("must not execute");');
    expect(await findProjectConfig(start)).toBe(nearest);
  });

  it('resolves explicit relative and absolute paths against the starting directory', async () => {
    const root = await fixture();
    const nested = join(root, 'nested');
    await mkdir(nested);
    const file = await marker(root);
    await marker(nested);
    expect(await findProjectConfig(nested, join('..', 'mica.config.ts'))).toBe(file);
    expect(await findProjectConfig(nested, file)).toBe(file);
  });

  it('requires the explicit marker filename and a regular file', async () => {
    const root = await fixture();
    await writeFile(join(root, 'vite.config.ts'), 'export default {};');
    await expect(findProjectConfig(root, 'vite.config.ts')).rejects.toThrow(
      'must be named mica.config.ts',
    );
    await expect(findProjectConfig(root, 'mica.config.ts')).rejects.toThrow(
      'not a file or does not exist',
    );
    await mkdir(join(root, 'mica.config.ts'));
    await expect(findProjectConfig(root, 'mica.config.ts')).rejects.toThrow(
      'not a file or does not exist',
    );
    await expect(findProjectConfig(root)).rejects.toThrow('No mica.config.ts project marker');
  });

  it('reports missing markers through the filesystem root', async () => {
    const root = await fixture();
    await expect(findProjectConfig(root)).rejects.toThrow(
      `No mica.config.ts project marker found from ${root} upward`,
    );
  });

  it('defaults the starting directory to cwd', async () => {
    await expect(findProjectConfig()).rejects.toThrow(`from ${resolve(process.cwd())} upward`);
  });
});

describe('loadProjectConfig', () => {
  it('applies defaults and returns the marker directory as project root', async () => {
    const root = await fixture();
    const configFile = await marker(root);
    const nested = join(root, 'nested');
    await mkdir(nested);
    expect(await loadProjectConfig({ root: nested })).toEqual({
      root,
      configFile,
      config: { sourceDir: 'src', outDir: 'dist', base: '/' },
    });
  });

  it('loads TypeScript imports and the identity helper while preserving relative fields', async () => {
    const root = await fixture();
    await writeFile(join(root, 'paths.ts'), 'export const sourceDir: string = "./content";');
    const helper = join(dirname(fileURLToPath(import.meta.url)), 'config.ts').replaceAll('\\', '/');
    const configFile = await marker(
      root,
      `
      import { defineConfig } from ${JSON.stringify(helper)};
      import { sourceDir } from './paths';
      export default defineConfig({
        sourceDir, outDir: '../output', base: './', alias: { '@': './content' },
      });
    `,
    );
    expect(await loadProjectConfig({ root, config: configFile })).toEqual({
      root,
      configFile,
      config: {
        sourceDir: './content',
        outDir: '../output',
        base: './',
        alias: { '@': './content' },
      },
    });
  });

  it('returns the same object from defineConfig', () => {
    const config = { sourceDir: 'content' };
    expect(defineConfig(config)).toBe(config);
  });

  it.each([
    ['sourceDir: ""', 'sourceDir'],
    ['sourceDir: 42', 'sourceDir'],
    ['outDir: "  "', 'outDir'],
    ['outDir: false', 'outDir'],
    ['base: ""', 'base'],
    ['base: null', 'base'],
    ['alias: []', 'alias'],
    ['alias: null', 'alias'],
    ['alias: { "@": 12 }', 'alias.@'],
    ['server: {}', 'server'],
    ['plugins: []', 'plugins'],
    ['sorceDir: "src"', 'sorceDir'],
  ])('rejects invalid config %s', async (source, field) => {
    const root = await fixture();
    await marker(root, `export default { ${source} };`);
    await expect(loadProjectConfig({ root })).rejects.toThrow(field);
  });

  it.each(['[]', 'null', '42', '"config"', 'new (class Config {})()'])(
    'rejects a non-plain default export: %s',
    async (source) => {
      const root = await fixture();
      await marker(root, `export default ${source};`);
      await expect(loadProjectConfig({ root })).rejects.toThrow();
    },
  );
});
