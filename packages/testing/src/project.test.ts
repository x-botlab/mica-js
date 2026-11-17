import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { afterEach, expect, it } from 'vitest';
import { createServer } from 'vite';
import { parseUnifiedManifest } from '@mica-js/document/fused';
import { runCli as runSdkCli } from '../../sdk/src/build/cli';
import { watchPreparation } from '@mica-js/sdk/prepare';
import { runCli } from './cli';
import { loadProjectConfig } from './config';
import { prepareTestbenches, testbenchInputs } from './prepare';
import { buttonLedCircuit, buttonSource, ledSource } from './test-helpers';
import { deviceFacade } from './devices';
import { createFileTestbench } from './node';
import { ms } from './time';
import { mitest } from './vite';

const roots: string[] = [];
const circuitFile = 'circuit #%.sch';
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function project() {
  const root = await mkdtemp(fileURLToPath(new URL('../.tmp-project-', import.meta.url)));
  roots.push(root);
  const fixture = await buttonLedCircuit();
  for (const name of ['button', 'led']) {
    const directory = join(root, name);
    await mkdir(join(directory, 'src'), { recursive: true });
    const dependency = fixture.document.dependencies[`test:${name}`];
    if (!dependency) throw new Error('Fixture dependency missing');
    const source = await fixture.registry.open({ id: `test:${name}`, ...dependency });
    const manifest = parseUnifiedManifest(
      new TextDecoder().decode(await source.read('package.json')),
    );
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify(
        name === 'button'
          ? {
              ...manifest,
              model: {
                ...manifest.model,
                types: { Pressed: { type: 'boolean' } },
                methods: {
                  setPressed: { params: { ref: 'Pressed' }, returns: { type: 'null' } },
                  fail: { params: { type: 'null' }, returns: { type: 'null' } },
                  onDidShared: { params: { type: 'null' }, returns: { type: 'null' } },
                  then: { params: { type: 'null' }, returns: { type: 'null' } },
                },
                events: { onDidPressed: { ref: 'Pressed' }, onDidShared: { ref: 'Pressed' } },
              },
            }
          : manifest,
      ),
    );
    await writeFile(
      join(directory, 'mica.config.ts'),
      `export default { device: { manifest: 'package.json', model: 'src/model.ddl' } };`,
    );
    await writeFile(
      join(directory, 'src', 'model.ddl'),
      name === 'button' ? buttonSource : ledSource,
    );
    await writeFile(
      join(directory, 'src', 'model.ts'),
      name === 'button'
        ? `export const create = (ctx) => ({
      methods: {
        setPressed(value) { ctx.inputs.pressed.send(value); ctx.events.onDidPressed.fire(value); return null; },
        fail() { throw new Error('Deliberate fixture fault'); },
        onDidShared() { return null; }, then() { return null; },
      }, sync() {}, dispose() {},
    });`
        : `export const create = (ctx) => {
      let value = 0;
      ctx.events.onDidBrightnessChange.fire(value);
      return {
        methods: { getBrightness() { return value; } },
        sync(batch) { for (const message of batch.outputs.brightness ?? []) { value = message.value; ctx.events.onDidBrightnessChange.fire(value); } },
        dispose() {},
      };
    };`,
    );
    const errors: string[] = [];
    const code = await runSdkCli(['build', '--root', directory], {
      out: { write() {} },
      err: { write: (message) => errors.push(message) },
    });
    expect(code, errors.join('')).toBe(0);
  }
  await writeFile(
    join(root, circuitFile),
    JSON.stringify({ ...fixture.document, dependencies: {} }),
  );
  await writeFile(
    join(root, 'mitest.config.ts'),
    `export default { testbenches: { switchLed: { document: ${JSON.stringify(circuitFile)}, devices: { 'test:button': 'button/dist', 'test:led': 'led/dist' } } } };`,
  );
  await mkdir(join(root, 'tests'));
  const messages: string[] = [];
  const cli = (args: string[]) =>
    runCli(['prepare', '--root', root, ...args], {
      out: { write: (text) => messages.push(text) },
      err: { write: (text) => messages.push(text) },
    });
  return { root, cli, messages, fixture };
}

function diagnostics(root: string): string[] {
  const config = ts.parseJsonConfigFileContent(
    {
      extends: './.mitest/tsconfig.json',
      compilerOptions: {
        skipLibCheck: false,
        paths: Object.fromEntries(
          (
            [
              ['@mica-js/testing', '../src/index.ts'],
              ['@mica-js/testing/node', '../src/node.ts'],
              ['@mica-js/testing/config', '../src/config.ts'],
            ] as const
          ).map(([key, path]) => [key, [fileURLToPath(new URL(path, import.meta.url))]]),
        ),
      },
    },
    ts.sys,
    root,
  );
  const program = ts.createProgram(config.fileNames, config.options);
  return [...config.errors, ...ts.getPreEmitDiagnostics(program)]
    .filter((entry) => entry.category === ts.DiagnosticCategory.Error)
    .map((entry) => ts.flattenDiagnosticMessageText(entry.messageText, '\n'));
}

it('generates strict circuit types and executes the generated factory with actual local artifacts', async () => {
  const { root, cli, messages } = await project();
  expect(await cli(['--update-lock']), messages.join('')).toBe(0);
  await writeFile(
    join(root, 'tests', 'types.ts'),
    `
    import createTestbench from '../circuit #%.sch';
    import { ps } from '@mica-js/testing';
    import type { Event, ModelEvent, Disposable } from '@mica-js/testing';
    export async function check() {
      const bench = await createTestbench({ step: ps(1) });
      const result: null = await bench.devices.S1.setPressed(true);
      const event: Event<ModelEvent<boolean>> = bench.devices.S1.onDidPressed;
      const subscription: Disposable = bench.devices.S1.onDidPressed(({ value }) => { const pressed: boolean = value; });
      // @ts-expect-error -- unknown designators are not an open dictionary
      bench.devices.Missing;
      // @ts-expect-error -- method parameters are generated from the manifest
      bench.devices.S1.setPressed('yes');
      // @ts-expect-error -- explicit namespace preserves the same parameter type
      bench.devices.S1.methods.setPressed(1);
      // @ts-expect-error -- event payload is boolean
      bench.devices.S1.onDidPressed(({ value }) => { const pressed: string = value; });
      // @ts-expect-error -- generated facades cannot replace methods
      bench.devices.S1.setPressed = async () => null;
      // @ts-expect-error -- explicit method namespaces are also immutable
      bench.devices.S1.methods.setPressed = async () => null;
      // @ts-expect-error -- colliding names require an explicit namespace
      bench.devices.S1.onDidShared;
      // @ts-expect-error -- a method named then cannot make the facade thenable
      bench.devices.S1.then;
      await bench.devices.S1.methods.onDidShared(null);
      await bench.devices.S1.methods.then(null);
      const shared: Event<ModelEvent<boolean>> = bench.devices.S1.events.onDidShared;
      return { result, event, shared, subscription };
    }
  `,
  );
  expect(diagnostics(root)).toEqual([]);
  const generated = join(root, '.mitest', 'testbenches', 'switchLed.ts');
  const source = await readFile(generated, 'utf8');
  expect(source).not.toContain('@mica-js/core');
  expect(source).not.toContain('@mica-js/sdk');
  const module = await import(/* @vite-ignore */ pathToFileURL(generated).href);
  const bench = await module.createTestbench({ step: ms(0.01) });
  try {
    const values: boolean[] = [];
    bench.devices.S1.onDidPressed((event: { value: boolean }) => values.push(event.value));
    const old = bench.devices.S1;
    expect(Object.hasOwn(old, 'onDidShared')).toBe(false);
    expect(Object.hasOwn(old, 'then')).toBe(false);
    expect(await old.methods.onDidShared(null)).toBeNull();
    expect(await old.methods.then(null)).toBeNull();
    await old.setPressed(true);
    await bench.advanceFor(ms(0.1));
    expect(await bench.devices.D1.getBrightness(null)).toBeGreaterThan(0.9);
    await old.setPressed(false);
    await bench.advanceFor(ms(0.1));
    expect(await bench.devices.D1.getBrightness(null)).toBe(0);
    expect(values).toEqual([true, false]);
    await expect(old.fail(null)).rejects.toMatchObject({ code: 'model/execution-failed' });
    await bench.reset();
    await expect(old.setPressed(true)).rejects.toMatchObject({ code: 'model/disconnected' });
    await bench.devices.S1.setPressed(true);
    await bench.advanceFor(ms(0.1));
    expect(await bench.devices.D1.getBrightness(null)).toBeGreaterThan(0.9);
  } finally {
    await bench.dispose();
  }
  const raw = JSON.parse(await readFile(join(root, circuitFile), 'utf8'));
  await writeFile(join(root, circuitFile), JSON.stringify({ ...raw, wires: [] }));
  const disconnected = await module.createTestbench({ step: ms(0.01) });
  try {
    await disconnected.devices.S1.setPressed(true);
    await disconnected.advanceFor(ms(0.1));
    expect(await disconnected.devices.D1.getBrightness(null)).toBe(0);
  } finally {
    await disconnected.dispose();
  }
}, 60_000);

it('automatically prepares sch imports and reruns Vitest after circuit and configuration changes', async () => {
  const { root, cli, messages } = await project();
  expect(await cli(['--update-lock']), messages.join('')).toBe(0);
  await rm(join(root, '.mitest'), { recursive: true, force: true });
  const plugin = fileURLToPath(new URL('./vite.ts', import.meta.url)).replaceAll('\\', '/');
  await writeFile(
    join(root, 'vitest.config.ts'),
    `
    import { mitest } from ${JSON.stringify(plugin)};
    export default { plugins: [mitest()], test: { include: ['tests/plugin.test.ts'], environment: 'node', maxWorkers: 1 } };
  `,
  );
  await writeFile(
    join(root, 'tests', 'plugin.test.ts'),
    `
    import { it, expect } from 'vitest';
    import { appendFile, readFile } from 'node:fs/promises';
    import { ms } from '@mica-js/testing';
    import createTestbench from '../${circuitFile}';
    it('imports a factory that creates independent circuits', async () => {
      const first = await createTestbench({ step: ms(0.01) });
      const second = await createTestbench({ step: ms(0.01) });
      try {
        await first.devices.S1.setPressed(true);
        await first.advanceFor(ms(0.1));
        await second.advanceFor(ms(0.1));
        expect(await second.devices.D1.getBrightness(null)).toBe(0);
        const document = JSON.parse(await readFile(new URL('../${circuitFile.replaceAll('%', '%25').replaceAll('#', '%23')}', import.meta.url), 'utf8'));
        const brightness = await first.devices.D1.getBrightness(null);
        if (document.wires.length) expect(brightness).toBeGreaterThan(0.9);
        else expect(brightness).toBe(0);
        await appendFile(new URL('../runs.jsonl', import.meta.url), JSON.stringify({ brightness }) + '\\n');
      } finally { await first.dispose(); await second.dispose(); }
    });
  `,
  );
  const entry = join(
    dirname(fileURLToPath(import.meta.resolve('vitest/package.json'))),
    'vitest.mjs',
  );
  const child = spawn(
    process.execPath,
    [entry, '--watch', '--config', join(root, 'vitest.config.ts'), '--no-color'],
    { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    output += String(chunk);
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.once('exit', () => resolve());
    child.once('error', reject);
  });
  const runs = async (): Promise<Array<{ brightness: number }>> => {
    try {
      return (await readFile(join(root, 'runs.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return [];
    }
  };
  try {
    await expect
      .poll(async () => (await runs()).length, { timeout: 15_000 })
      .toBeGreaterThanOrEqual(1);
    await expect
      .poll(() => output.includes('Waiting for file changes'), { timeout: 5_000 })
      .toBe(true);
    expect((await runs())[0]?.brightness).toBeGreaterThan(0.9);
    const file = join(root, circuitFile);
    const document = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ ...document, wires: [] }));
    await expect
      .poll(async () => (await runs()).some((run) => run.brightness === 0), { timeout: 10_000 })
      .toBe(true);
    const count = (await runs()).length;
    const config = join(root, 'mitest.config.ts');
    await writeFile(config, (await readFile(config, 'utf8')).replace('switchLed:', 'renamed:'));
    await expect
      .poll(async () => (await runs()).length, { timeout: 10_000 })
      .toBeGreaterThan(count);
    expect(await readFile(join(root, '.mitest', 'testbenches', 'renamed.ts'), 'utf8')).toContain(
      'createTestbench',
    );
    const manifest = join(root, 'button', 'dist', 'package.json');
    const original = await readFile(manifest, 'utf8');
    await writeFile(manifest, '{}');
    await expect.poll(() => output.includes('integrity-mismatch'), { timeout: 10_000 }).toBe(true);
    const beforeRecovery = (await runs()).length;
    await writeFile(manifest, original);
    await expect
      .poll(async () => (await runs()).length, { timeout: 10_000 })
      .toBeGreaterThan(beforeRecovery);
  } catch (error) {
    throw new Error(`Vitest plugin watch failed:\n${output}`, { cause: error });
  } finally {
    child.kill();
    await exited;
  }
}, 90_000);

it('rejects unconfigured imports and ambiguous circuit configurations', async () => {
  const { root, cli } = await project();
  expect(await cli(['--update-lock'])).toBe(0);
  const server = await createServer({
    root,
    configFile: false,
    plugins: [mitest()],
    server: { middlewareMode: true, watch: null },
  });
  try {
    await expect(
      server.environments.ssr!.pluginContainer.load(join(root, 'unknown.sch')),
    ).rejects.toThrow('not configured');
    const config = join(root, 'mitest.config.ts');
    await writeFile(
      config,
      `export default { testbenches: { first: { document: ${JSON.stringify(circuitFile)}, devices: {} }, second: { document: ${JSON.stringify(circuitFile)}, devices: {} } } };`,
    );
    await expect(
      server.environments.ssr!.pluginContainer.load(join(root, circuitFile)),
    ).rejects.toThrow('Multiple testbenches');
  } finally {
    await server.close();
  }
});

it('resolves precise sch types for a circuit outside the project root', async () => {
  const { root, cli, messages } = await project();
  const external = await mkdtemp(fileURLToPath(new URL('../.tmp-circuits-', import.meta.url)));
  roots.push(external);
  const file = join(external, circuitFile);
  await rename(join(root, circuitFile), file);
  const config = join(root, 'mitest.config.ts');
  await writeFile(
    config,
    (await readFile(config, 'utf8')).replace(
      JSON.stringify(circuitFile),
      JSON.stringify(relative(root, file)),
    ),
  );
  expect(await cli(['--update-lock']), messages.join('')).toBe(0);
  await writeFile(
    join(root, 'tests', 'types.ts'),
    `
    import createTestbench from ${JSON.stringify(relative(join(root, 'tests'), file).replaceAll('\\', '/'))};
    import { ps } from '@mica-js/testing';
    async function check() {
      const bench = await createTestbench({ step: ps(1) });
      await bench.devices.S1.setPressed(true);
      // @ts-expect-error -- external circuits retain their manifest parameter types
      await bench.devices.S1.setPressed('yes');
    }
  `,
  );
  expect(diagnostics(root)).toEqual([]);
}, 30_000);

it('keeps ordinary prepare read-only and refuses stale generated bindings before loading a model', async () => {
  const { root, cli, messages } = await project();
  const file = join(root, circuitFile);
  const before = await readFile(file, 'utf8');
  expect(await cli([])).toBe(1);
  expect(messages.join('')).toContain('--update-lock');
  expect(await readFile(file, 'utf8')).toBe(before);
  expect(await cli(['--update-lock']), messages.join('')).toBe(0);
  const locked = await readFile(file, 'utf8');
  expect(await cli([]), messages.join('')).toBe(0);
  expect(await readFile(file, 'utf8')).toBe(locked);
  const raw = JSON.parse(await readFile(file, 'utf8'));
  raw.dependencies['unused:device'] = raw.dependencies['test:button'];
  await writeFile(file, JSON.stringify(raw));
  expect(await cli([])).toBe(1);
  expect(messages.join('')).toContain('No local device configured for unused:device');
  delete raw.dependencies['unused:device'];
  const expected = structuredClone({ dependencies: raw.dependencies, instances: raw.instances });
  raw.instances[0].designator = 'SW2';
  await writeFile(file, JSON.stringify(raw));
  await expect(
    createFileTestbench(
      { document: pathToFileURL(file), devices: {}, expected },
      { step: ms(0.01) },
    ),
  ).rejects.toThrow('bindings are stale');
  raw.instances[0].designator = expected.instances[0].designator;
  raw.dependencies['test:button'].integrity = 'sha256:' + '0'.repeat(64);
  await writeFile(file, JSON.stringify(raw));
  await expect(
    createFileTestbench(
      { document: pathToFileURL(file), devices: {}, expected },
      { step: ms(0.01) },
    ),
  ).rejects.toThrow('dependencies are stale');
  const after = await readFile(file, 'utf8');
  expect(await cli([])).toBe(1);
  expect(await readFile(file, 'utf8')).toBe(after);
  expect(await cli(['--update-lock']), messages.join('')).toBe(0);
  const releaseFile = join(root, 'button', 'dist', 'release.json');
  const releaseBefore = await readFile(releaseFile, 'utf8');
  await writeFile(releaseFile, JSON.stringify({ ...JSON.parse(releaseBefore), version: '1.0.1' }));
  await expect(
    createFileTestbench(
      {
        document: pathToFileURL(file),
        devices: {
          'test:button': pathToFileURL(join(root, 'button', 'dist')),
          'test:led': pathToFileURL(join(root, 'led', 'dist')),
        },
        expected,
      },
      { step: ms(0.01) },
    ),
  ).rejects.toThrow('differs from its dependency lock');
  await writeFile(releaseFile, releaseBefore);
  await writeFile(join(root, 'button', 'dist', 'package.json'), '{}');
  expect(await cli([])).toBe(1);
  expect(messages.join('')).toContain('integrity-mismatch');
}, 30_000);

it('regenerates bindings when a watched circuit changes', async () => {
  const { root, cli, messages } = await project();
  expect(await cli(['--update-lock']), messages.join('')).toBe(0);
  let runs = 0;
  const errors: unknown[] = [];
  const watcher = watchPreparation({
    load: () => loadProjectConfig({ root }),
    inputs: (project) => [project.configFile, ...testbenchInputs(project)],
    prepare: (project) => prepareTestbenches(project),
    onPrepare() {
      runs++;
    },
    onError(error) {
      errors.push(error);
    },
    debounceMs: 10,
  });
  try {
    await watcher.ready;
    const file = join(root, circuitFile);
    const raw = JSON.parse(await readFile(file, 'utf8'));
    raw.instances[0].designator = 'SW2';
    await writeFile(file, JSON.stringify(raw));
    const deadline = Date.now() + 5_000;
    while (runs < 2 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 25));
    expect(runs).toBeGreaterThanOrEqual(2);
    expect(errors).toEqual([]);
    expect(await readFile(join(root, '.mitest', 'testbenches', 'switchLed.ts'), 'utf8')).toContain(
      'get "SW2"',
    );
  } finally {
    await watcher.dispose();
  }
}, 30_000);

it('recovers watch preparation when a missing package directory is created', async () => {
  const root = await mkdtemp(fileURLToPath(new URL('../.tmp-project-', import.meta.url)));
  roots.push(root);
  const file = join(root, 'missing', 'nested', 'release.json');
  const errors: unknown[] = [];
  let prepared = false;
  const watcher = watchPreparation({
    load: async () => file,
    inputs: (target) => [target],
    prepare: async (target) => {
      await readFile(target);
      return [target];
    },
    onPrepare: () => {
      prepared = true;
    },
    onError: (error) => {
      errors.push(error);
    },
    debounceMs: 10,
  });
  try {
    await watcher.ready;
    expect(errors).toHaveLength(1);
    expect(prepared).toBe(false);
    await mkdir(join(root, 'missing', 'nested'), { recursive: true });
    await writeFile(file, '{}');
    await expect.poll(() => prepared, { timeout: 5_000 }).toBe(true);
  } finally {
    await watcher.dispose();
  }
});

it('keeps colliding and reserved names accessible only through explicit namespaces', () => {
  const sharedMethod = () => 1;
  const sharedEvent = () => 2;
  const facade = deviceFacade(
    { shared: sharedMethod, methods: sharedMethod, then: sharedMethod, press: sharedMethod },
    { shared: sharedEvent, onDidPressed: sharedEvent },
  );
  expect(Object.hasOwn(facade, 'shared')).toBe(false);
  expect(Object.hasOwn(facade, 'then')).toBe(false);
  expect(facade.methods.shared()).toBe(1);
  expect(facade.events.shared()).toBe(2);
  expect(facade.methods.methods()).toBe(1);
  expect(facade.press()).toBe(1);
  expect(facade.onDidPressed()).toBe(2);
});
