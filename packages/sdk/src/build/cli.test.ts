import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCliArguments, runCli } from './cli.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), 'mica-cli-'));
  roots.push(root);
  await cp(
    fileURLToPath(new URL('../../templates/basic/src', import.meta.url)),
    resolve(root, 'src'),
    { recursive: true },
  );
  await writeFile(resolve(root, 'mica.config.ts'), 'export default {};');
  return root;
}
function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    streams: {
      out: { write: (text: string) => out.push(text) },
      err: { write: (text: string) => err.push(text) },
    },
  };
}

describe('project CLI', () => {
  it('parses commands and rejects unsupported watch options', () => {
    expect(parseCliArguments(['build', '--config=./mica.config.ts']).command).toBe('build');
    expect(() => parseCliArguments(['dev'])).toThrow('Unknown command');
    expect(() => parseCliArguments(['build', '--watch'])).toThrow('prepare');
    expect(() => parseCliArguments(['build', '--config'])).toThrow('Missing value');
  });

  it('requires a project marker even for prepare', async () => {
    const root = await fixture();
    await rm(resolve(root, 'mica.config.ts'));
    const { streams, err } = capture();
    expect(await runCli(['prepare', '--root', root], streams)).toBe(1);
    expect(err.join('')).toContain('mica.config.ts');
  });

  it('builds using the discovered project root, paths and aliases', async () => {
    const root = await fixture();
    await mkdir(resolve(root, 'src/shared'), { recursive: true });
    await writeFile(resolve(root, 'src/shared/value.ts'), 'export const value = 42;');
    await writeFile(
      resolve(root, 'src/widgets/lamp/index.ts'),
      'import { value } from "@/shared/value"; export default () => ({ value });',
    );
    await writeFile(
      resolve(root, 'mica.config.ts'),
      'export default { outDir: "output", alias: { "@": "./src" } };',
    );
    const { streams } = capture();
    expect(await runCli(['build', '--root', resolve(root, 'src/widgets')], streams)).toBe(0);
    expect(await readFile(resolve(root, 'output/widgets/lamp/widget.js'), 'utf8')).toContain('42');
  });

  it('rejects output directories that could destroy source files', async () => {
    const root = await fixture();
    await writeFile(resolve(root, 'mica.config.ts'), 'export default { outDir: "src" };');
    const { streams, err } = capture();
    expect(await runCli(['build', '--root', root], streams)).toBe(1);
    expect(err.join('')).toContain('outDir');
    expect(await readFile(resolve(root, 'src/devices/resistor/model.ddl'), 'utf8')).toContain(
      'device',
    );
  });
});
