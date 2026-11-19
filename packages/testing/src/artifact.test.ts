import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import ts from 'typescript';
import { parseUnifiedManifest } from '@mica-js/document/fused';
import type { DeviceLock, PackageFiles } from '@mica-js/document/fused';
import { runCli } from '../../sdk/src/build/cli';
import { buttonLedCircuit, buttonSource, canonical } from './test-helpers';
import { createTestbench } from './testbench';
import { ms } from './time';

it('builds a unified button through the CLI and runs that artifact in the real LED circuit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mica-testing-artifact-'));
  let bench: Awaited<ReturnType<typeof createTestbench>> | undefined;
  try {
    const fixture = await buttonLedCircuit();
    const dependency = fixture.document.dependencies['test:button'];
    if (!dependency) throw new Error('Button fixture dependency missing');
    const sourcePackage = await fixture.registry.open({ id: 'test:button', ...dependency });
    await mkdir(join(root, 'src'));
    const manifest = parseUnifiedManifest(
      new TextDecoder().decode(await sourcePackage.read('package.json')),
    );
    if (!manifest.model) throw new Error('Fixture model missing');
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        ...manifest,
        model: {
          ...manifest.model,
          methods: {
            ...manifest.model.methods,
            deny: { params: { type: 'null' }, returns: { type: 'null' } },
          },
        },
      }),
    );
    const modelApi = fileURLToPath(new URL('../../sdk/src/fused/model.ts', import.meta.url));
    await writeFile(
      join(root, 'mica.config.ts'),
      `export default { device: { manifest: 'package.json', model: 'src/model.ddl' }, alias: ${JSON.stringify({ '@mica-js/sdk/fused': modelApi })} };`,
    );
    await writeFile(join(root, 'src', 'model.ddl'), buttonSource);
    await writeFile(
      join(root, 'src', 'model.ts'),
      `
import { MethodError } from '@mica-js/sdk/fused';
export const create: DeviceFactory = (ctx) => {
  return {
    methods: {
      press(value) { ctx.inputs.pressed.send(value); return null; },
      deny() { throw new MethodError('button/denied', 'Requested rejection', { reason: 'fixture' }); },
    },
    sync() {},
    dispose() {},
  };
};
export default create;
`,
    );
    const messages: string[] = [];
    const streams = {
      out: { write: (message: string) => messages.push(message) },
      err: { write: (message: string) => messages.push(message) },
    };
    expect(await runCli(['prepare', '--root', root], streams), messages.join('')).toBe(0);
    expect(await readFile(join(root, '.mica', 'device.d.ts'), 'utf8')).toContain('DeviceFactory');
    const config = ts.parseJsonConfigFileContent(
      {
        extends: './.mica/tsconfig.json',
        compilerOptions: {
          customConditions: ['source'],
          paths: {
            '@mica-js/sdk/device': [
              fileURLToPath(new URL('../../sdk/src/device.ts', import.meta.url)),
            ],
            '@mica-js/sdk/fused': [
              fileURLToPath(new URL('../../sdk/src/fused/index.ts', import.meta.url)),
            ],
          },
        },
      },
      ts.sys,
      root,
    );
    const program = ts.createProgram(config.fileNames, config.options);
    const errors = [...config.errors, ...ts.getPreEmitDiagnostics(program)]
      .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
    expect(errors).toEqual([]);
    expect(await runCli(['build', '--root', root], streams), messages.join('')).toBe(0);
    const release = JSON.parse(await readFile(join(root, 'dist', 'release.json'), 'utf8')) as {
      id: string;
      version: string;
      files: PackageFiles['files'];
    };
    const lock: DeviceLock = {
      id: release.id,
      version: release.version,
      integrity: `sha256:${createHash('sha256').update(canonical(release)).digest('hex')}`,
    };
    const built: PackageFiles = {
      lock,
      files: release.files,
      async read(path) {
        return new Uint8Array(await readFile(join(root, 'dist', ...path.split('/'))));
      },
    };
    const document = structuredClone(fixture.document);
    const options = {
      ...fixture,
      document: {
        ...document,
        dependencies: {
          ...document.dependencies,
          [lock.id]: { version: lock.version, integrity: lock.integrity },
        },
      },
      registry: {
        open: (requested: DeviceLock) =>
          requested.id === lock.id ? Promise.resolve(built) : fixture.registry.open(requested),
      },
      async loadModule(files: PackageFiles, path: string): Promise<unknown> {
        if (files.lock.id !== lock.id) return fixture.loadModule(files, path);
        const code = await files.read(path);
        return import(
          /* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
        );
      },
      step: ms(0.01),
    };
    bench = await createTestbench(options);
    const press = bench.device('S1').methods.press;
    const deny = bench.device('S1').methods.deny;
    const brightness = bench.device('D1').methods.getBrightness;
    if (!press || !brightness || !deny) throw new Error('Artifact interface missing');
    await press(true);
    await bench.advanceFor(ms(0.1));
    expect(await brightness(null)).toBeGreaterThan(0.9);
    await press(false);
    await bench.advanceFor(ms(0.1));
    expect(await brightness(null)).toBe(0);
    await expect(deny(null)).rejects.toMatchObject({
      code: 'button/denied',
      details: { reason: 'fixture' },
    });
    await bench.advanceFor(ms(0.01));
  } finally {
    try {
      await bench?.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}, 30_000);
