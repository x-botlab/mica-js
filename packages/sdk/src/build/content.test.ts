import { afterEach, describe, expect, it } from 'vitest';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBoard, createDeviceLibrary } from '@mica-js/simulator';
import type { DeviceIR } from '@mica-js/device-model';
import type { DeviceFactory } from '../device.js';
import { buildContent, modelExpression } from './content.js';
import { runCli } from './cli.js';

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), 'mica-sdk-build-'));
  roots.push(root);
  await writeFile(resolve(root, 'mica.config.ts'), 'export default {};');
  await cp(
    fileURLToPath(new URL('../../templates/basic/src', import.meta.url)),
    resolve(root, 'src'),
    { recursive: true },
  );
  return root;
}
async function write(root: string, name: string, source: string) {
  const path = resolve(root, name);
  await mkdir(resolve(path, '..'), { recursive: true });
  await writeFile(path, source);
}
async function load(source: string) {
  return (await import(
    /* @vite-ignore */ `data:text/javascript,${encodeURIComponent(source)}`
  )) as Record<string, unknown>;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('standalone content builds', () => {
  it('builds real DDL plus adapter, registers the model and runs a board', async () => {
    const root = await fixture();
    const files = await buildContent({ root });
    expect(files.map((file) => file.fileName)).toEqual([
      'devices/resistor/device.json',
      'devices/resistor/device.js',
      'widgets/lamp/widget.json',
      'widgets/lamp/widget.js',
    ]);
    const device = await load(files[1]!.source);
    const library = createDeviceLibrary([
      { id: 'resistor', model: device.model as DeviceIR, create: device.create as DeviceFactory },
    ]);
    const board = createBoard(library, {
      instances: [{ id: 'r1', type: 'resistor' }],
      nets: [
        { id: 'vcc', voltage: 3.3, pins: [{ instance: 'r1', pin: 'a' }] },
        { id: 'gnd', voltage: 0, pins: [{ instance: 'r1', pin: 'b' }] },
      ],
    });
    board.runUntil(100);
    expect(board.time).toBe(100);
    board.dispose();
    const widget = await load(files[3]!.source);
    expect(widget.default).toBeTypeOf('function');
  });

  it('provides a minimal adapter for pure DDL devices', async () => {
    const root = await fixture();
    await rm(resolve(root, 'src/devices/resistor/index.ts'));
    const files = await buildContent({ root });
    const device = await load(files[1]!.source);
    const create = device.create as () => { sync(): void; dispose(): void };
    expect(create().sync()).toBeUndefined();
    expect(create().dispose()).toBeUndefined();
  });

  it('preserves special IR values and own __proto__ keys', async () => {
    const object = JSON.parse('{"__proto__":42}') as Record<string, unknown>;
    const result = await load(
      `export const value = ${modelExpression({ ...object, values: [NaN, Infinity, -Infinity, -0], bytes: new Uint8Array([0, 255]) })};`,
    );
    const value = result.value as { values: number[]; bytes: Uint8Array; __proto__: number };
    expect(Number.isNaN(value.values[0])).toBe(true);
    expect(value.values.slice(1, 3)).toEqual([Infinity, -Infinity]);
    expect(Object.is(value.values[3], -0)).toBe(true);
    expect(value.bytes).toEqual(new Uint8Array([0, 255]));
    expect(Object.hasOwn(value, '__proto__')).toBe(true);
  });

  it('inlines shared code, literal dynamic imports and URL resources', async () => {
    const root = await fixture();
    await write(root, 'src/shared/helper.ts', 'export const text = "shared";');
    await write(root, 'src/widgets/lamp/pixel.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await write(
      root,
      'src/widgets/lamp/index.ts',
      `import image from './pixel.svg?url';
      export default () => ({ image, get: async () => (await import('../../shared/helper')).text });`,
    );
    const files = await buildContent({ root });
    const widget = await load(files[3]!.source);
    const instance = (widget.default as () => { image: string; get(): Promise<string> })();
    expect(instance.image).toMatch(/^data:image\/svg\+xml/);
    expect(await instance.get()).toBe('shared');
  });

  it('rejects dynamic runtime imports and extra CSS files', async () => {
    const root = await fixture();
    await write(
      root,
      'src/widgets/lamp/index.ts',
      'export default (api) => ({ load: () => import(/* @vite-ignore */ api.path) });',
    );
    await expect(buildContent({ root })).rejects.toThrow(/runtime module/);
    await write(root, 'src/widgets/lamp/style.css', '.lamp { color: red; }');
    await write(
      root,
      'src/widgets/lamp/index.ts',
      'import "./style.css"; export default () => ({});',
    );
    await expect(buildContent({ root })).rejects.toThrow(/exactly one/);
  });

  it('rejects Node built-ins and adapters without default exports', async () => {
    const root = await fixture();
    await write(
      root,
      'src/widgets/lamp/index.ts',
      'import fs from "node:fs"; export default () => fs;',
    );
    await expect(buildContent({ root })).rejects.toThrow(/Node built-ins/);
    await write(root, 'src/widgets/lamp/index.ts', 'export default () => ({});');
    await write(root, 'src/devices/resistor/index.ts', 'export const unrelated = 1;');
    await expect(buildContent({ root })).rejects.toThrow(/default/);
  });

  it('validates metadata without comparing it to the DDL interface', async () => {
    const root = await fixture();
    await write(
      root,
      'src/devices/resistor/device.json',
      JSON.stringify({
        kind: 'device',
        id: 'resistor',
        version: '1',
        displayName: 'Independent',
        pins: { different: {} },
      }),
    );
    const files = await buildContent({ root });
    expect(JSON.parse(files[0]!.source).pins).toEqual({ different: {} });
    await write(
      root,
      'src/devices/resistor/device.json',
      JSON.stringify({ kind: 'device', id: 'wrong', version: '1', displayName: 'Wrong' }),
    );
    await expect(buildContent({ root })).rejects.toThrow(/id/i);
  });

  it('uses Vite without HTML and emits only two files per entry', async () => {
    const root = await fixture();
    await write(root, 'public/extra.txt', 'must not be copied');
    expect(await runCli(['build', '--root', root])).toBe(0);
    expect(await readdir(resolve(root, 'dist'))).toEqual(['devices', 'widgets']);
    expect(await readdir(resolve(root, 'dist/devices/resistor'))).toEqual([
      'device.js',
      'device.json',
    ]);
    expect(await readdir(resolve(root, 'dist/widgets/lamp'))).toEqual(['widget.js', 'widget.json']);
    expect(await readFile(resolve(root, 'src/devices/resistor/model.d.ddl.ts'), 'utf8')).toContain(
      'Factory',
    );
  });
});
