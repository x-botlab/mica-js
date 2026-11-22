import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import typescript from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli } from './cli.js';
import { loadProjectConfig } from './config.js';
import { resolveDeviceBuildOptions } from './project.js';
import { buildDevice, watchDeviceBuild } from './unified-build.js';
import { watchDevice } from './unified-prepare.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const MANIFEST = {
  publisher: 'example',
  name: 'button',
  version: '1.0.0',
  description: 'Unified button package',
  private: true,
  engines: { mica: '^1.0.0' },
  displayName: 'Button',
  icon: 'assets/device-icon.svg',
  designatorPrefix: 'S',
  properties: {
    label: { type: 'string', default: 'start', nullable: false, maxLength: 16 },
    debounce: { type: 'integer', default: 2, nullable: false, min: 1, max: 32 },
    mode: {
      type: 'enum',
      default: 'momentary',
      nullable: false,
      options: [
        { value: 'momentary', label: 'Momentary' },
        { value: 'latching', label: 'Latching' },
      ],
    },
    icon: {
      type: 'image',
      nullable: true,
      maxBytes: 4096,
      default: { src: 'assets/icon.png', mode: 'package' },
    },
    profile: {
      type: 'binary',
      nullable: true,
      maxBytes: 2048,
      default: { src: 'assets/profile.bin', mode: 'package' },
    },
    firmware: {
      type: 'firmware',
      nullable: true,
      maxBytes: 65536,
      default: null,
      addressSpaces: { code: { start: 0, size: 8192 } },
      addressSpace: 'code',
      loadAddress: 0,
    },
  },
  pins: { a1: { label: '1 / A1' }, b1: { label: '2 / B1' } },
  model: {
    entry: 'model.js',
    types: {
      ButtonState: {
        type: 'object',
        properties: {
          pressed: { type: 'boolean' },
          samples: { type: 'array', items: { type: 'number' } },
        },
        optional: ['samples'],
      },
    },
    methods: {
      press: { params: { type: 'boolean' }, returns: { type: 'null' } },
      getStatus: { params: { type: 'null' }, returns: { ref: 'ButtonState' } },
    },
    events: { onDidStateChange: { ref: 'ButtonState' } },
  },
  view2d: { geometry: 'views/2d/geometry.json', entry: 'views/2d/index.js' },
  view: { monitor: { title: 'Button state', entry: 'views/index.html', icon: 'dashboard' } },
};

const DDL = `device Button(debounce: number default 2, label: string default "start", mode: Mode default Mode.momentary) {
  enum Mode { momentary, latching }
  pin a1;
  pin b1;
}`;

const GEOMETRY = {
  sizing: 'physical',
  bounds: { x: -1, y: -1, width: 8, height: 8 },
  bodyBounds: { x: 0, y: 0, width: 6, height: 6 },
  bodyImage: 'assets/body.svg',
  pins: {
    a1: { position: { x: -0.5, y: 1 }, outward: { x: -1, y: 0 } },
    b1: { position: { x: 6.5, y: 1 }, outward: { x: 1, y: 0 } },
  },
};

const SOURCES: Readonly<Record<string, string>> = {
  'model.ts': `export const create = () => ({
  methods: { press: () => null, getStatus: () => ({ pressed: false }) },
  sync() {},
  dispose() {},
});`,
  'views/2d/index.ts': `export default () => ({ renderOverlay() {} });`,
  'views/index.html':
    '<link rel="stylesheet" href="./styles.css"><script type="module" src="./panel.js"></script>',
  'views/styles.css': 'body { background: url("./panel-bg.png"); }',
  'views/panel.ts': `document.title = 'button';`,
  'views/panel-bg.png': 'png',
  'assets/device-icon.svg': '<svg/>',
  'assets/body.svg': '<svg/>',
  'assets/icon.png': 'png',
  'assets/profile.bin': 'bin',
};

const PAYLOAD_MANIFEST = {
  ...MANIFEST,
  model: {
    ...MANIFEST.model,
    types: {
      Samples: { type: 'array', items: { type: 'array', items: { type: 'number' } } },
      Batch: {
        type: 'object',
        properties: { class: { type: 'string' }, default: { type: 'number' } },
      },
      Record: { type: 'boolean' },
      ModelClient: { type: 'number' },
      CoreContext: { type: 'null' },
      DeviceProps: { type: 'string' },
      ReadonlyBytes: { type: 'number' },
      MicaPayloadCollision: { type: 'number' },
    },
    methods: {
      press: { params: { type: 'boolean' }, returns: { type: 'null' } },
      getStatus: { params: { type: 'null' }, returns: { ref: 'Samples' } },
      getBatch: { params: { type: 'null' }, returns: { ref: 'Batch' } },
    },
    events: {
      onDidSamples: { ref: 'Samples' },
      onDidBatch: { ref: 'Batch' },
      onDidProps: { ref: 'DeviceProps' },
      onDidCollision: { ref: 'MicaPayloadCollision' },
    },
  },
};

const PAYLOAD_SAMPLE = `export const samples: DeviceEvents['onDidSamples'] = [
  [1, 2],
  [3],
];
// @ts-expect-error -- nested arrays stay arrays of numbers
export const wrongSamples: DeviceEvents['onDidSamples'] = [['x']];
export const batch: DeviceEvents['onDidBatch'] = { class: 'x', default: 1 };
// @ts-expect-error -- a declared object rejects unknown keys
export const extraBatch: DeviceEvents['onDidBatch'] = { class: 'x', default: 1, other: true };
// A payload type named DeviceProps is not the global property snapshot.
export const props: DeviceEvents['onDidProps'] = 'text';
// @ts-expect-error -- the global DeviceProps keeps its object shape
export const wrongProps: DeviceProps = 'text';
export const collision: DeviceEvents['onDidCollision'] = 1;
export const status: ReturnType<DeviceClient['methods']['getStatus']> = Promise.resolve([[1]]);
export type Sample = [DeviceMethods, DeviceModelContext, Record<never, never>];
`;

interface Project {
  readonly root: string;
  readonly outDir: string;
}

async function project(
  options: {
    readonly manifest?: unknown;
    readonly ddl?: string;
    readonly sources?: Readonly<Record<string, string>>;
    readonly config?: string;
  } = {},
): Promise<Project> {
  const root = await mkdtemp(join(tmpdir(), 'mica-unified-'));
  roots.push(root);
  await writeFile(
    join(root, 'mica.config.ts'),
    options.config ??
      "export default { device: { manifest: './package.json', model: './src/model.ddl' } };",
  );
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify(options.manifest ?? MANIFEST, null, 2),
  );
  const source = join(root, 'src');
  await mkdir(join(source, 'views', '2d'), { recursive: true });
  await writeFile(join(source, 'model.ddl'), options.ddl ?? DDL);
  await writeFile(join(source, 'views', '2d', 'geometry.json'), JSON.stringify(GEOMETRY, null, 2));
  for (const [path, content] of Object.entries({ ...SOURCES, ...options.sources })) {
    const file = resolve(source, ...path.split('/'));
    await mkdir(resolve(file, '..'), { recursive: true });
    await writeFile(file, content);
  }
  return { root, outDir: join(root, 'dist') };
}

const AUTHOR_SAMPLE = `export const factory: DeviceFactory = (context) => ({
  methods: {
    press: (pressed: boolean) => {
      void pressed;
      return null;
    },
    getStatus: () => ({ pressed: false }),
  },
  sync(batch) {
    void batch.from;
    context.events.onDidStateChange.fire({ pressed: true });
  },
  dispose() {},
});

export const pins: readonly DevicePinId[] = ['a1', 'b1'];

// @ts-expect-error -- a2 is not a declared pin
export const unknownPin: DevicePinId = 'a2';

// @ts-expect-error -- the method set must match the manifest
export const wrongMethods: DeviceMethods = { press: () => 1 };

export type Sample = [DeviceProps, DeviceEvents, DeviceClient, DeviceModelContext];
`;

/**
 * Typechecks `sample` against the generated `.mica` declaration using the real SDK author entry.
 *
 * Returns the TypeScript diagnostics, so a generated declaration that does not compile fails the
 * test with the compiler message instead of a string comparison.
 */
async function diagnosticsOf(root: string, sample: string): Promise<readonly string[]> {
  await writeFile(join(root, 'src', 'author.ts'), sample);
  const configFile = join(root, 'tsconfig.check.json');
  const sdkRoot = fileURLToPath(new URL('../..', import.meta.url));
  await writeFile(
    configFile,
    JSON.stringify(
      {
        extends: './.mica/tsconfig.json',
        compilerOptions: {
          // The generated declaration is the artifact under test, so it must be checked as a
          // library file instead of being skipped.
          skipLibCheck: false,
          paths: { '@mica-js/sdk/device': [resolve(sdkRoot, 'src/device.ts')] },
        },
      },
      null,
      2,
    ),
  );
  const parsed = typescript.getParsedCommandLineOfConfigFile(
    configFile,
    {},
    {
      ...typescript.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(typescript.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
      },
    },
  );
  expect(parsed).toBeDefined();
  const files = parsed!.fileNames.map((file) => file.replaceAll('\\', '/'));
  expect(files.some((file) => file.endsWith('.mica/device.d.ts'))).toBe(true);
  expect(files.some((file) => file.endsWith('/src/author.ts'))).toBe(true);
  const program = typescript.createProgram({
    rootNames: parsed!.fileNames,
    options: parsed!.options,
  });
  return typescript.getPreEmitDiagnostics(program).map((diagnostic) => {
    const file = diagnostic.file === undefined ? '' : `${diagnostic.file.fileName}: `;
    return file + typescript.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
  });
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

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(condition: () => boolean, timeout = 15_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the watch loop');
    await new Promise((settle) => setTimeout(settle, 25));
  }
}

describe('unified device CLI', () => {
  it('prepares the global type environment and keeps unchanged output', async () => {
    const { root } = await project();
    const { streams, out } = capture();
    expect(await runCli(['prepare', '--root', root], streams)).toBe(0);
    const declarationFile = join(root, '.mica', 'device.d.ts');
    const tsconfigFile = join(root, '.mica', 'tsconfig.json');
    expect(out.join('')).toContain('device type environment ready for ./package.json');
    const declaration = await readFile(declarationFile, 'utf8');
    expect(declaration).toContain('declare global {');
    expect(declaration).toContain('  type DeviceProps = {');
    expect(declaration).toContain('readonly label: string;');
    expect(declaration).toContain('readonly debounce: number;');
    expect(declaration).toContain('readonly mode: "momentary" | "latching";');
    expect(declaration).toContain('readonly icon: ReadonlyBytes | null;');
    expect(declaration).toContain('readonly firmware: FirmwareImage | null;');
    expect(declaration).toContain('readonly press: (params: boolean) => null;');
    expect(declaration).toContain('readonly onDidStateChange: MicaPayload_ButtonState;');
    expect(declaration).toContain('type DevicePinId = "a1" | "b1";');
    expect(declaration).toContain('type Batch = DeviceBatch<MicaOutputs>;');
    expect(declaration).toContain(
      'type CoreContext = DeviceContext<DeviceProps, MicaInputs, MicaMemory>;',
    );
    const tsconfig = JSON.parse(await readFile(tsconfigFile, 'utf8'));
    expect(tsconfig.files).toEqual(['./device.d.ts']);
    expect(tsconfig.include).toEqual(['../src']);

    const before = await stat(declarationFile);
    expect(await runCli(['prepare', '--root', root], capture().streams)).toBe(0);
    expect((await stat(declarationFile)).mtimeMs).toBe(before.mtimeMs);
  });

  it('builds the package files and a release with real digests', async () => {
    const { root, outDir } = await project();
    const { streams, out } = capture();
    expect(await runCli(['build', '--root', root], streams)).toBe(0);
    expect(out.join('')).toContain('mica build: complete');
    expect(await exists(join(root, '.mica', 'device.d.ts'))).toBe(true);
    const release = JSON.parse(await readFile(join(outDir, 'release.json'), 'utf8')) as {
      id: string;
      version: string;
      files: Record<string, { size: number; integrity: string }>;
    };
    expect(release.id).toBe('example:button');
    expect(release.version).toBe('1.0.0');
    expect(Object.keys(release.files)).toEqual([
      'assets/body.svg',
      'assets/device-icon.svg',
      'assets/icon.png',
      'assets/profile.bin',
      'model.js',
      'package.json',
      'views/2d/geometry.json',
      'views/2d/index.js',
      'views/index.html',
      'views/panel-bg.png',
      'views/panel.js',
      'views/styles.css',
    ]);
    for (const [path, record] of Object.entries(release.files)) {
      const data = await readFile(join(outDir, ...path.split('/')));
      expect(record.size).toBe(data.byteLength);
      expect(record.integrity).toBe(`sha256:${createHash('sha256').update(data).digest('hex')}`);
    }
    const model = await readFile(join(outDir, 'model.js'), 'utf8');
    expect(model).toMatch(/export\s*\{[^}]*\bmodel\b/);
    expect(model).toMatch(/export\s*\{[^}]*\bcreate\b/);
    expect(await readFile(join(outDir, 'package.json'), 'utf8')).toBe(
      `${JSON.stringify(MANIFEST, null, 2)}\n`,
    );
    expect(await readFile(join(outDir, 'views', 'panel.js'), 'utf8')).toMatch(
      /document\.title\s*=\s*"button"/,
    );
    expect(await readdir(join(outDir, 'views', '2d'))).toEqual(['geometry.json', 'index.js']);
  });

  it('rejects pin, property and geometry mismatches before writing artifacts', async () => {
    const pins = await project({ manifest: { ...MANIFEST, pins: { a1: {} } } });
    const pinsRun = capture();
    expect(await runCli(['build', '--root', pins.root], pinsRun.streams)).toBe(1);
    expect(pinsRun.err.join('')).toContain('pins');
    expect(pinsRun.err.join('')).toContain('differ between manifest and model IR');
    expect(await exists(pins.outDir)).toBe(false);

    const types = await project({
      manifest: {
        ...MANIFEST,
        properties: { ...MANIFEST.properties, debounce: { type: 'string', default: '2' } },
      },
    });
    const typesRun = capture();
    expect(await runCli(['prepare', '--root', types.root], typesRun.streams)).toBe(1);
    expect(typesRun.err.join('')).toContain('properties.debounce');

    const geometry = await project();
    await writeFile(
      join(geometry.root, 'src', 'views', '2d', 'geometry.json'),
      JSON.stringify({ ...GEOMETRY, pins: { a1: GEOMETRY.pins.a1 } }, null, 2),
    );
    const geometryRun = capture();
    expect(await runCli(['prepare', '--root', geometry.root], geometryRun.streams)).toBe(1);
    expect(geometryRun.err.join('')).toContain('view2d/pin-mismatch');
  });

  it('regenerates the type environment when a watched input changes', async () => {
    const { root } = await project();
    const options = {
      root,
      sourceDir: 'src',
      manifest: './package.json',
      model: './src/model.ddl',
      configFile: join(root, 'mica.config.ts'),
    };
    const runs: (readonly string[])[] = [];
    const errors: unknown[] = [];
    const watcher = watchDevice({
      load: async () => options,
      debounceMs: 10,
      onPrepare: (files) => runs.push(files),
      onError: (error) => errors.push(error),
    });
    try {
      await watcher.ready;
      expect(runs).toHaveLength(1);
      await writeFile(
        join(root, 'package.json'),
        JSON.stringify(
          {
            ...MANIFEST,
            properties: { ...MANIFEST.properties, extra: { type: 'number', default: 1 } },
          },
          null,
          2,
        ),
      );
      const deadline = Date.now() + 5_000;
      while (runs.length < 2 && Date.now() < deadline)
        await new Promise((settle) => setTimeout(settle, 25));
      expect(errors).toEqual([]);
      expect(runs.length).toBeGreaterThanOrEqual(2);
      expect(await readFile(join(root, '.mica', 'device.d.ts'), 'utf8')).toContain(
        'readonly extra: number;',
      );
    } finally {
      await watcher.dispose();
    }
  }, 15_000);

  it.each([false, true])(
    'reports watch failures when no reporter can handle them (%s)',
    async (reporterThrows) => {
      const failure = new Error('Cannot load watch configuration');
      const reportingFailure = new Error('Reporter failed');
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      const watcher = watchDevice({
        async load() {
          throw failure;
        },
        ...(reporterThrows
          ? {
              onError() {
                throw reportingFailure;
              },
            }
          : {}),
      });
      try {
        await watcher.ready;
        expect(log).toHaveBeenCalledWith('mica prepare --watch:', failure);
        if (reporterThrows) {
          expect(log).toHaveBeenCalledWith(
            'mica prepare --watch error handler failed:',
            reportingFailure,
          );
        }
      } finally {
        await watcher.dispose();
        log.mockRestore();
      }
    },
  );

  it('builds the same package through the programmatic entry', async () => {
    const { root, outDir } = await project();
    const result = await buildDevice({
      root,
      manifest: './package.json',
      model: './src/model.ddl',
      outDir,
      minify: false,
    });
    expect(result.outDir).toBe(outDir);
    expect(result.files).toContain(join(outDir, 'model.js'));
    expect(result.files).not.toContain(join(outDir, 'release.json'));
    const release = JSON.parse(await readFile(join(outDir, 'release.json'), 'utf8')) as {
      id: string;
      files: Record<string, { size: number; integrity: string }>;
    };
    expect(release.id).toBe('example:button');
    expect(Object.keys(release.files)).toContain('model.js');
    expect(result.files.every((file) => file.startsWith(outDir))).toBe(true);
    expect(await exists(join(root, '.mica', 'device.d.ts'))).toBe(true);
  });

  it('rejects a manifest default that contradicts the DDL', async () => {
    const { root } = await project({
      manifest: {
        ...MANIFEST,
        properties: { ...MANIFEST.properties, debounce: { type: 'integer', default: 3 } },
      },
    });
    const { streams, err } = capture();
    expect(await runCli(['prepare', '--root', root], streams)).toBe(1);
    expect(err.join('')).toContain('properties.debounce');
    expect(err.join('')).toContain('must equal the model IR default');
  });

  it('refuses unsafe output directories and keeps the source tree', async () => {
    const { root } = await project();
    const sentinel = join(root, 'src', 'sentinel.txt');
    await writeFile(sentinel, 'keep');
    const build = (outDir: string) =>
      buildDevice({
        root,
        manifest: './package.json',
        model: './src/model.ddl',
        outDir,
        minify: false,
      });
    await expect(build(root)).rejects.toThrow('a protected path');
    await expect(build(join(root, 'src'))).rejects.toThrow('a protected path');
    await expect(build(dirname(root))).rejects.toThrow('it contains');
    await expect(build(homedir())).rejects.toThrow('home directory');
    expect(await readFile(sentinel, 'utf8')).toBe('keep');

    const result = await build(join(root, 'dist'));
    expect(result.files.length).toBeGreaterThan(0);
    expect(await readFile(sentinel, 'utf8')).toBe('keep');
  });

  it('typechecks the generated global types against the SDK author entry', async () => {
    const { root } = await project();
    expect(await runCli(['prepare', '--root', root], capture().streams)).toBe(0);
    expect(await diagnosticsOf(root, AUTHOR_SAMPLE)).toEqual([]);
  }, 60_000);

  it('typechecks payload types that would collide with generated or global names', async () => {
    const { root } = await project({ manifest: PAYLOAD_MANIFEST });
    expect(await runCli(['prepare', '--root', root], capture().streams)).toBe(0);
    const diagnostics = await diagnosticsOf(root, PAYLOAD_SAMPLE);
    expect(diagnostics).toEqual([]);
  }, 60_000);

  it('reports invalid declarations inside the generated file', async () => {
    const { root } = await project();
    expect(await runCli(['prepare', '--root', root], capture().streams)).toBe(0);
    const declarationFile = join(root, '.mica', 'device.d.ts');
    const declaration = await readFile(declarationFile, 'utf8');
    await writeFile(
      declarationFile,
      declaration.replace('declare global {', 'declare global {\n  type DeviceProps = number;'),
    );
    const diagnostics = (await diagnosticsOf(root, AUTHOR_SAMPLE)).join('\n');
    expect(diagnostics).toContain("Duplicate identifier 'DeviceProps'");
  }, 60_000);

  it('reports a manifest that the device contract rejects', async () => {
    const { root } = await project({ manifest: { ...MANIFEST, publisher: 'Example' } });
    const { streams, err } = capture();
    expect(await runCli(['prepare', '--root', root], streams)).toBe(1);
    expect(err.join('')).toContain('package.json');
    expect(err.join('')).toContain('package/invalid-manifest');
    expect(await exists(join(root, '.mica'))).toBe(false);
  });

  it('keeps the legacy component project on the legacy prepare and build path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mica-unified-legacy-'));
    roots.push(root);
    await writeFile(join(root, 'mica.config.ts'), 'export default {};');
    await mkdir(join(root, 'src', 'devices', 'resistor'), { recursive: true });
    await writeFile(
      join(root, 'src', 'devices', 'resistor', 'model.ddl'),
      'device Resistor() {\n  pin a;\n  pin b;\n}',
    );
    await writeFile(
      join(root, 'src', 'devices', 'resistor', 'device.json'),
      JSON.stringify(
        {
          kind: 'device',
          id: 'resistor',
          version: '1.0.0',
          displayName: 'Resistor',
          properties: {},
          pins: { a: {}, b: {} },
        },
        null,
        2,
      ),
    );
    const { streams, out } = capture();
    expect(await runCli(['build', '--root', root], streams)).toBe(0);
    expect(await exists(join(root, 'src', 'devices', 'resistor', 'model.d.ddl.ts'))).toBe(true);
    expect(await exists(join(root, '.mica'))).toBe(false);
    expect(
      await readFile(join(root, 'dist', 'devices', 'resistor', 'device.js'), 'utf8'),
    ).toContain('model');
    expect(out.join('')).toContain('mica build: complete');
  });
});

describe('unified device build watch', () => {
  it('rebuilds when a source file changes and reports a new package summary', async () => {
    const { root, outDir } = await project();
    const options = {
      root,
      outDir,
      manifest: './package.json',
      model: './src/model.ddl',
      configFile: join(root, 'mica.config.ts'),
    };
    const builds: string[] = [];
    const errors: unknown[] = [];
    const watcher = watchDeviceBuild({
      load: async () => options,
      debounceMs: 10,
      onBuild: (summary) => builds.push(summary),
      onError: (error) => errors.push(error),
    });
    try {
      await watcher.ready;
      expect(errors).toEqual([]);
      expect(builds).toHaveLength(1);
      expect(builds[0]).toContain('example:button@1.0.0');
      expect(builds[0]).toMatch(/ sha256:[0-9a-f]{64}$/);
      const before = JSON.parse(await readFile(join(outDir, 'release.json'), 'utf8')) as {
        files: Record<string, { integrity: string }>;
      };

      await writeFile(
        join(root, 'src', 'views', '2d', 'index.ts'),
        `export default () => ({ renderOverlay() { document.title = 'updated'; } });`,
      );
      await waitFor(() => builds.length >= 2);
      expect(errors).toEqual([]);
      expect(builds[1]).not.toBe(builds[0]);
      const after = JSON.parse(await readFile(join(outDir, 'release.json'), 'utf8')) as {
        files: Record<string, { integrity: string }>;
      };
      expect(after.files['views/2d/index.js']?.integrity).not.toBe(
        before.files['views/2d/index.js']?.integrity,
      );
    } finally {
      await watcher.dispose();
    }
  }, 30_000);

  it('keeps the last complete package when a rebuild fails and resumes afterwards', async () => {
    const { root, outDir } = await project();
    const options = {
      root,
      outDir,
      manifest: './package.json',
      model: './src/model.ddl',
      configFile: join(root, 'mica.config.ts'),
    };
    const builds: string[] = [];
    const errors: unknown[] = [];
    const watcher = watchDeviceBuild({
      load: async () => options,
      debounceMs: 10,
      onBuild: (summary) => builds.push(summary),
      onError: (error) => errors.push(error),
    });
    try {
      await watcher.ready;
      const releaseFile = join(outDir, 'release.json');
      const before = await readFile(releaseFile, 'utf8');
      const entries = (await readdir(outDir)).sort();

      await writeFile(join(root, 'src', 'model.ts'), 'export const missingCreate = true;');
      await waitFor(() => errors.length >= 1);
      expect(String(errors[0])).toContain('create');
      expect(await readFile(releaseFile, 'utf8')).toBe(before);
      expect((await readdir(outDir)).sort()).toEqual(entries);
      expect(await exists(join(root, '.mica', 'build-watch'))).toBe(false);

      await writeFile(
        join(root, 'src', 'model.ts'),
        `export const create = () => ({
  methods: { press: () => null, getStatus: () => ({ pressed: true }) },
  sync() {},
  dispose() {},
});`,
      );
      await waitFor(() => builds.length >= 2);
      expect(builds[1]).not.toBe(builds[0]);
      expect(await exists(join(outDir, 'release.json'))).toBe(true);
    } finally {
      await watcher.dispose();
    }
  }, 30_000);

  it('keeps watching after the initial build fails', async () => {
    const { root, outDir } = await project({ manifest: { ...MANIFEST, pins: { a1: {} } } });
    const options = {
      root,
      outDir,
      manifest: './package.json',
      model: './src/model.ddl',
      configFile: join(root, 'mica.config.ts'),
    };
    const builds: string[] = [];
    const errors: unknown[] = [];
    const watcher = watchDeviceBuild({
      load: async () => options,
      debounceMs: 10,
      onBuild: (summary) => builds.push(summary),
      onError: (error) => errors.push(error),
    });
    try {
      await watcher.ready;
      expect(builds).toEqual([]);
      expect(errors).toHaveLength(1);
      expect(await exists(outDir)).toBe(false);

      await writeFile(join(root, 'package.json'), JSON.stringify(MANIFEST, null, 2));
      await waitFor(() => builds.length === 1);
      expect(await exists(join(outDir, 'release.json'))).toBe(true);
    } finally {
      await watcher.dispose();
    }
  }, 30_000);

  it('retargets the source directory when the config changes', async () => {
    const { root, outDir } = await project();
    const load = async () => resolveDeviceBuildOptions(await loadProjectConfig({ root }));
    const builds: string[] = [];
    const errors: unknown[] = [];
    const watcher = watchDeviceBuild({
      load,
      debounceMs: 10,
      onBuild: (summary) => builds.push(summary),
      onError: (error) => errors.push(error),
    });
    try {
      await watcher.ready;
      expect(builds).toHaveLength(1);

      await cp(join(root, 'src'), join(root, 'content'), { recursive: true });
      await writeFile(
        join(root, 'mica.config.ts'),
        "export default { sourceDir: 'content', device: { manifest: './package.json', model: './src/model.ddl' } };",
      );
      await waitFor(() => builds.length >= 2);

      await writeFile(
        join(root, 'content', 'views', '2d', 'index.ts'),
        `export default () => ({ renderOverlay() { document.title = 'retargeted'; } });`,
      );
      await waitFor(() => builds.length >= 3);
      expect(errors).toEqual([]);
      expect(outDir).toBe(join(root, 'dist'));
    } finally {
      await watcher.dispose();
    }
  }, 30_000);

  it('ignores writes below outDir', async () => {
    const { root, outDir } = await project();
    await cp(join(root, 'src'), root, { recursive: true });
    const options = {
      root,
      outDir,
      manifest: './package.json',
      sourceDir: '.',
      model: './src/model.ddl',
      configFile: join(root, 'mica.config.ts'),
    };
    const builds: string[] = [];
    const errors: unknown[] = [];
    const watcher = watchDeviceBuild({
      load: async () => options,
      debounceMs: 10,
      onBuild: (summary) => builds.push(summary),
      onError: (error) => errors.push(error),
    });
    try {
      await watcher.ready;
      expect(errors).toEqual([]);
      expect(builds).toHaveLength(1);

      await writeFile(join(outDir, 'consumer.txt'), 'read');
      await new Promise((settle) => setTimeout(settle, 400));
      expect(builds).toHaveLength(1);
      expect(errors).toEqual([]);
    } finally {
      await watcher.dispose();
    }
  }, 30_000);
});

describe('unified device pack', () => {
  it('packs the existing build without rebuilding and matches the release file table', async () => {
    const { root, outDir } = await project();
    await buildDevice({
      root,
      manifest: './package.json',
      model: './src/model.ddl',
      outDir,
      minify: false,
    });
    const packed = await readFile(join(outDir, 'views', '2d', 'index.js'), 'utf8');
    await writeFile(
      join(root, 'src', 'views', '2d', 'index.ts'),
      `export default () => ({ renderOverlay() { document.title = 'not built'; } });`,
    );

    const { streams, out } = capture();
    expect(await runCli(['pack', '--root', root], streams)).toBe(0);
    const archiveFile = join(root, 'example-button-1.0.0.zip');
    expect(out.join('')).toBe(`mica pack: ${archiveFile}\n`);
    expect(await readFile(join(outDir, 'views', '2d', 'index.js'), 'utf8')).toBe(packed);

    const release = JSON.parse(await readFile(join(outDir, 'release.json'), 'utf8')) as {
      files: Record<string, { size: number; integrity: string }>;
    };
    const archive = await readFile(archiveFile);
    const entries = unzipSync(new Uint8Array(archive));
    expect(Object.keys(entries).sort()).toEqual(
      [...Object.keys(release.files), 'release.json'].sort(),
    );
    for (const path of [...Object.keys(release.files), 'release.json'])
      expect(
        Buffer.from(entries[path]!).equals(await readFile(join(outDir, ...path.split('/')))),
      ).toBe(true);
    // Store-only entries: the first local header declares compression method 0.
    expect(new DataView(archive.buffer, archive.byteOffset).getUint16(8, true)).toBe(0);
  }, 30_000);

  it('writes identical archives for the same build and honors --out', async () => {
    const { root, outDir } = await project();
    await buildDevice({ root, manifest: './package.json', model: './src/model.ddl', outDir });

    const first = capture();
    expect(await runCli(['pack', '--root', root], first.streams)).toBe(0);
    const custom = join(root, 'artifacts', 'led.zip');
    const second = capture();
    expect(await runCli(['pack', '--root', root, '--out', custom], second.streams)).toBe(0);
    expect(second.out.join('')).toBe(`mica pack: ${custom}\n`);

    const defaultArchive = await readFile(join(root, 'example-button-1.0.0.zip'));
    const customArchive = await readFile(custom);
    expect(customArchive.equals(defaultArchive)).toBe(true);
    const digest = (data: Buffer): string => createHash('sha256').update(data).digest('hex');
    expect(digest(customArchive)).toBe(digest(defaultArchive));
  }, 30_000);

  it('rejects a missing or stale build without writing a ZIP', async () => {
    const empty = await project();
    const missing = capture();
    expect(await runCli(['pack', '--root', empty.root], missing.streams)).toBe(1);
    expect(missing.err.join('')).toContain('release.json');
    expect(await exists(join(empty.root, 'example-button-1.0.0.zip'))).toBe(false);

    const { root, outDir } = await project();
    const build = () =>
      buildDevice({ root, manifest: './package.json', model: './src/model.ddl', outDir });
    await build();
    const archiveFile = join(root, 'example-button-1.0.0.zip');

    await writeFile(join(outDir, 'model.js'), 'export const model = tampered;');
    const changed = capture();
    expect(await runCli(['pack', '--root', root], changed.streams)).toBe(1);
    expect(changed.err.join('')).toContain('model.js');
    expect(changed.err.join('')).toContain('release.json');
    expect(await exists(archiveFile)).toBe(false);

    await build();
    await rm(join(outDir, 'assets', 'icon.png'));
    const incomplete = capture();
    expect(await runCli(['pack', '--root', root], incomplete.streams)).toBe(1);
    expect(incomplete.err.join('')).toContain('assets/icon.png');
    expect(await exists(archiveFile)).toBe(false);
  }, 30_000);
});
