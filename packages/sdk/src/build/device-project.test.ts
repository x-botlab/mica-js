import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { buildDeviceProject, prepareDeviceProject } from './device-project';
import {
  generateDeviceDeclaration,
  satisfiesVersion,
  validateDevicePackage,
  validateDevicePackageModel,
  validateGeometry,
} from './device-package';
import { compileDDL } from '@mica-js/ddl';
import type { Geometry2D } from '../device';

const roots: string[] = [];
const packageRoot = fileURLToPath(new URL('../..', import.meta.url));

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mica-sdk-device-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    publisher: 'example',
    name: 'button',
    version: '1.0.0',
    engines: { mica: '^0.3.0' },
    displayName: 'Button',
    properties: {
      label: { type: 'string', default: 'Start', nullable: false, maxLength: 16 },
      firmware: {
        type: 'firmware',
        default: null,
        nullable: true,
        maxBytes: 1024,
        addressSpaces: { code: { start: 0, size: 1024 } },
        addressSpace: 'code',
        loadAddress: 0,
      },
    },
    pins: { a: { label: 'A' }, b: { label: 'B' } },
    model: {
      entry: 'model.js',
      types: {
        Status: {
          type: 'object',
          properties: {
            pressed: { type: 'boolean' },
            values: { type: 'array', items: { type: 'number' } },
          },
          optional: ['values'],
        },
      },
      methods: {
        press: { params: { type: 'boolean' }, returns: { type: 'null' } },
        getStatus: { params: { type: 'null' }, returns: { ref: 'Status' } },
      },
      events: { onDidStatusChange: { ref: 'Status' } },
    },
    view2d: { geometry: 'views/2d/geometry.json', entry: 'views/2d/index.js' },
    ...overrides,
  };
}

const geometry = {
  sizing: 'physical',
  bounds: { x: -1, y: -1, width: 8, height: 8 },
  bodyBounds: { x: 0, y: 0, width: 6, height: 6 },
  pins: {
    a: { position: { x: -0.5, y: 1 }, outward: { x: -1, y: 0 } },
    b: { position: { x: 6.5, y: 1 }, outward: { x: 1, y: 0 } },
  },
};

describe('unified device package validation', () => {
  it('accepts a complete manifest and rejects an incompatible SDK range', () => {
    const parsed = validateDevicePackage(manifest(), { sdkVersion: '0.3.3' });
    expect(parsed.model?.entry).toBe('model.js');
    expect(() => validateDevicePackage(manifest(), { sdkVersion: '0.5.0' })).toThrow(
      /engines\.mica/,
    );
  });

  it('rejects package defaults that are not package resources', () => {
    expect(() =>
      validateDevicePackage(
        manifest({
          properties: {
            photo: {
              type: 'image',
              default: { src: 'assets/photo.png', mode: 'file' },
              nullable: false,
            },
          },
        }),
      ),
    ).toThrow(/package/);
  });

  it('accepts firmware defaults with source-appropriate overrides', () => {
    const parsed = validateDevicePackage(
      manifest({
        properties: {
          firmware: {
            type: 'firmware',
            nullable: true,
            maxBytes: 1024,
            addressSpaces: { code: { start: 0, size: 1024 } },
            addressSpace: 'code',
            loadAddress: 0,
            default: {
              mode: 'package',
              src: 'assets/app.bin',
              addressSpace: 'code',
              loadAddress: 256,
            },
          },
        },
      }),
    );
    expect(parsed.properties?.firmware?.default).toMatchObject({ loadAddress: 256 });
    expect(() =>
      validateDevicePackage(
        manifest({
          properties: {
            firmware: {
              type: 'firmware',
              nullable: true,
              maxBytes: 1024,
              addressSpaces: { code: { start: 0, size: 1024 } },
              addressSpace: 'code',
              loadAddress: 0,
              default: { mode: 'package', src: 'assets/app.elf', loadAddress: 256 },
            },
          },
        }),
      ),
    ).toThrow(/loadAddress/);
  });

  it('rejects unknown fields inside device structures', () => {
    expect(() =>
      validateDevicePackage(manifest({ model: { entry: 'model.js', unknown: true } })),
    ).toThrow(/model\.unknown/);
  });

  it('allows several fields to reference one package resource', () => {
    const parsed = validateDevicePackage(
      manifest({
        properties: {
          first: {
            type: 'binary',
            default: { src: 'assets/shared.bin', mode: 'package' },
            nullable: false,
          },
          second: {
            type: 'binary',
            default: { src: 'assets/shared.bin', mode: 'package' },
            nullable: false,
          },
        },
      }),
    );
    expect(parsed.properties?.first?.default).toEqual({
      src: 'assets/shared.bin',
      mode: 'package',
    });
  });

  it('rejects multi-part and hyphenated binary extensions', () => {
    const invalid = (extensions: readonly string[]) =>
      manifest({
        properties: {
          data: { type: 'binary', extensions, nullable: false },
        },
      });
    expect(() => validateDevicePackage(invalid(['.bin.gz']))).toThrow(/extension/);
    expect(() => validateDevicePackage(invalid(['.foo-bar']))).toThrow(/extension/);
    expect(() => validateDevicePackage(invalid(['.bin']))).not.toThrow();
  });

  it('normalizes color defaults to uppercase RRGGBBAA', () => {
    const parsed = validateDevicePackage(
      manifest({
        properties: {
          tint: { type: 'color', default: '#a1b2c3', alpha: false, nullable: false },
          glow: { type: 'color', default: '#11223344', alpha: true, nullable: false },
        },
      }),
    );
    expect(parsed.properties?.tint?.default).toBe('#A1B2C3FF');
    expect(parsed.properties?.glow?.default).toBe('#11223344');
    expect(() =>
      validateDevicePackage(
        manifest({
          properties: {
            tint: { type: 'color', default: '#A1B2C399', alpha: false, nullable: false },
          },
        }),
      ),
    ).toThrow(/alpha/);
  });

  it('uses standard SemVer semantics for engines ranges', () => {
    expect(satisfiesVersion('0.3.3', '0.3')).toBe(true);
    expect(satisfiesVersion('0.3.3', '0.3.0 - 0.4.0')).toBe(true);
    expect(satisfiesVersion('0.4.0-beta.1', '^0.4.0-beta.1')).toBe(true);
    expect(satisfiesVersion('0.4.0-beta.1', '^0.4.0')).toBe(false);
    expect(() => validateDevicePackage(manifest({ engines: { mica: 'not-a-range' } }))).toThrow(
      /SemVer/,
    );
    expect(() => validateDevicePackage(manifest({ version: '01.0.0' }))).toThrow(/SemVer/);
    expect(() => validateDevicePackage(manifest({ version: 'v1.0.0' }))).toThrow(/SemVer/);
    expect(validateDevicePackage(manifest({ version: '1.0.0+build.1' })).version).toBe(
      '1.0.0+build.1',
    );
  });

  it('accepts nullable DDL number and binary properties', async () => {
    const parsed = validateDevicePackage(
      manifest({
        properties: {
          level: { type: 'number', nullable: true, default: null },
          payload: { type: 'binary', nullable: true, default: null },
        },
      }),
    );
    const nullable = await compileDDL(
      'device D(level: number? default none, payload: bytes? default none) { pin a; pin b; }',
    );
    expect(() => validateDevicePackageModel(parsed, nullable)).not.toThrow();
    const required = await compileDDL('device D(level: number, payload: bytes) { pin a; pin b; }');
    expect(() => validateDevicePackageModel(parsed, required)).toThrow(/type or nullability/);
  });

  it('rejects geometry pins that differ from the manifest', () => {
    expect(() => validateGeometry({ ...geometry, pins: { a: geometry.pins.a } })).not.toThrow();
    const parsed = validateDevicePackage(manifest());
    expect(() =>
      validateDevicePackageModel(
        parsed,
        {
          kind: 'device',
          name: 'button',
          declarations: [
            { kind: 'pin', name: 'a' },
            { kind: 'pin', name: 'b' },
          ],
        },
        { ...geometry, pins: { a: geometry.pins.a } } as unknown as Geometry2D,
      ),
    ).toThrow(/view2d\.geometry\.pins/);
  });

  it('requires DDL property types/defaults to match and forbids firmware in DDL', async () => {
    const parsed = validateDevicePackage(manifest());
    const good = await compileDDL('device D(label: string default "Start") { pin a; pin b; }');
    expect(() => validateDevicePackageModel(parsed, good)).not.toThrow();

    const wrongDefault = await compileDDL(
      'device D(label: string default "Other") { pin a; pin b; }',
    );
    expect(() => validateDevicePackageModel(parsed, wrongDefault)).toThrow(/default/);

    const firmware = validateDevicePackage(
      manifest({
        pins: {},
        properties: {
          firmware: {
            type: 'firmware',
            default: null,
            nullable: true,
            maxBytes: 8,
            addressSpaces: { code: { start: 0, size: 8 } },
            addressSpace: 'code',
            loadAddress: 0,
          },
        },
        model: { entry: 'model.js' },
      }),
    );
    expect(() =>
      validateDevicePackageModel(firmware, {
        kind: 'device',
        name: 'D',
        declarations: [{ kind: 'property', name: 'firmware', type: { kind: 'bytes' } }],
      }),
    ).toThrow(/firmware/);
  });

  it('generates fixed global names with resolved payload types', async () => {
    const parsed = validateDevicePackage(manifest());
    const model = await compileDDL('device D(label: string default "Start") { pin a; pin b; }');
    const declaration = generateDeviceDeclaration(parsed, model);
    expect(declaration).toContain('type DeviceProps =');
    expect(declaration).toContain('type DeviceMethods =');
    expect(declaration).toContain('type DeviceEvents =');
    expect(declaration).toContain('type DeviceModelContext = ModelContext<');
    expect(declaration).toContain('type DeviceFactory =');
    expect(declaration).toContain('type DeviceClient =');
    expect(declaration).toContain('type DevicePinId = "a" | "b"');
    expect(declaration).toContain('readonly "firmware": FirmwareImage | null');
    expect(declaration).toContain('readonly "getStatus": (params: null) => Model_Status');
  });
});

async function typecheckAuthor(
  source: string,
  packageManifest: Record<string, unknown> = manifest(),
  ddl = 'device D(label: string default "Start") { pin a; pin b; }',
): Promise<{ readonly diagnostics: readonly ts.Diagnostic[]; readonly sourcePath: string }> {
  const root = await mkdtemp(join(packageRoot, '.tmp-types-'));
  roots.push(root);
  const parsed = validateDevicePackage(packageManifest);
  const model = await compileDDL(ddl);
  await writeFile(join(root, 'device.d.ts'), generateDeviceDeclaration(parsed, model), 'utf8');
  const sourcePath = join(root, 'author.ts');
  await writeFile(sourcePath, source, 'utf8');
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    customConditions: ['source'],
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
  };
  const program = ts.createProgram([join(root, 'device.d.ts'), sourcePath], options);
  return { diagnostics: ts.getPreEmitDiagnostics(program), sourcePath };
}

describe('unified device project', () => {
  it('prepares declarations and builds a package with an accurate release manifest', async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'views', '2d'), { recursive: true });
    await writeFile(
      join(root, 'package.json'),
      `${JSON.stringify(manifest({ view2d: undefined }), null, 2)}\n`,
      'utf8',
    );
    await writeFile(
      join(root, 'src', 'model.ddl'),
      'device Button(label: string default "Start") { pin a; pin b; }',
      'utf8',
    );
    await writeFile(
      join(root, 'src', 'index.ts'),
      [
        'export const create: DeviceFactory = (context) => ({',
        '  methods: { press: () => null, getStatus: () => ({ pressed: false }) },',
        '  sync(batch) { void batch; void context; },',
        '  dispose() {},',
        '});',
        '',
      ].join('\n'),
      'utf8',
    );
    const config = { device: {} };
    const prepared = await prepareDeviceProject(root, config);
    expect(
      prepared.files.map(
        (file) => file.endsWith('.mica/device.d.ts') || file.endsWith('.mica/tsconfig.json'),
      ),
    ).toEqual([true, true]);
    const declaration = await readFile(join(root, '.mica', 'device.d.ts'), 'utf8');
    expect(declaration).toContain('type DevicePinId = "a" | "b"');
    expect(JSON.parse(await readFile(join(root, '.mica', 'tsconfig.json'), 'utf8'))).toMatchObject({
      files: ['./device.d.ts'],
      include: ['../src', '../views'],
    });

    const result = await buildDeviceProject(root, config);
    expect(result.packageDir).toBe(join(root, 'dist'));
    expect(result.releaseFile).toBe(join(root, 'dist.release.json'));
    const packageManifest = JSON.parse(
      await readFile(join(result.packageDir, 'package.json'), 'utf8'),
    );
    expect(packageManifest.type).toBe('module');
    expect(packageManifest.model.entry).toBe('model.js');
    expect(result.files).not.toContain('release.json');

    const release = JSON.parse(await readFile(result.releaseFile, 'utf8'));
    expect(release.id).toBe('example:button');
    expect(release.version).toBe('1.0.0');
    expect(Object.keys(release.files).sort()).toEqual(result.files);
    for (const [path, entry] of Object.entries(
      release.files as Record<string, { size: number; integrity: string }>,
    )) {
      const data = await readFile(join(result.packageDir, path));
      expect(entry.size).toBe(data.length);
      expect(entry.integrity).toBe(`sha256:${createHash('sha256').update(data).digest('hex')}`);
    }
    const module = await import(
      `${pathToFileURL(join(result.packageDir, 'model.js')).href}?t=${Date.now()}`
    );
    expect(module.model.name).toBe('Button');
    expect(typeof module.create).toBe('function');
  });
});

describe('model-less and headless projects', () => {
  it('prepares and builds a static display package without a model or pins', async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, 'views', '2d'), { recursive: true });
    await mkdir(join(root, 'assets'), { recursive: true });
    const displayManifest = manifest({
      model: undefined,
      pins: undefined,
      properties: {},
      view2d: { geometry: 'views/2d/geometry.json' },
    });
    await writeFile(
      join(root, 'package.json'),
      `${JSON.stringify(displayManifest, null, 2)}
`,
      'utf8',
    );
    await writeFile(
      join(root, 'views', '2d', 'geometry.json'),
      JSON.stringify({
        sizing: 'flexible',
        bounds: { x: 0, y: 0, width: 20, height: 10 },
        bodyBounds: { x: 0, y: 0, width: 20, height: 10 },
        bodyImage: 'assets/body.svg',
        pins: {},
      }),
      'utf8',
    );
    await writeFile(join(root, 'assets', 'body.svg'), '<svg />', 'utf8');

    const prepared = await prepareDeviceProject(root, { device: {} });
    expect(prepared.files).toHaveLength(2);
    const declaration = await readFile(join(root, '.mica', 'device.d.ts'), 'utf8');
    expect(declaration).toContain('type DevicePinId = never');

    const result = await buildDeviceProject(root, { device: {} });
    expect(result.files).toEqual(
      expect.arrayContaining(['package.json', 'views/2d/geometry.json', 'assets/body.svg']),
    );
    expect(result.files).not.toContain('model.js');
    const published = JSON.parse(await readFile(join(result.packageDir, 'package.json'), 'utf8'));
    expect(published.model).toBeUndefined();
    expect(published.pins).toBeUndefined();
  });

  it('builds a headless model without view2d', async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(
      join(root, 'package.json'),
      `${JSON.stringify(manifest({ view2d: undefined }), null, 2)}
`,
      'utf8',
    );
    await writeFile(
      join(root, 'src', 'model.ddl'),
      'device Button(label: string default "Start") { pin a; pin b; }',
      'utf8',
    );
    await writeFile(
      join(root, 'src', 'index.ts'),
      'export const create: DeviceFactory = () => ({ methods: { press: () => null, getStatus: () => ({ pressed: false }) }, sync() {}, dispose() {} });\n',
      'utf8',
    );
    const result = await buildDeviceProject(root, { device: {} });
    expect(result.files).toContain('model.js');
    expect(result.files.some((file) => file.startsWith('views/'))).toBe(false);
    const published = JSON.parse(await readFile(join(result.packageDir, 'package.json'), 'utf8'));
    expect(published.model.entry).toBe('model.js');
    expect(published.view2d).toBeUndefined();
  });
});

describe('generated device types', () => {
  const statusManifest = manifest({
    model: {
      entry: 'model.js',
      types: {
        Status: {
          type: 'object',
          properties: {
            pressed: { type: 'boolean' },
            samples: { type: 'array', items: { type: 'number' } },
          },
          optional: ['samples'],
          additionalProperties: { type: 'string' },
        },
      },
      methods: {
        press: { params: { type: 'boolean' }, returns: { type: 'null' } },
        getStatus: { params: { type: 'null' }, returns: { ref: 'Status' } },
      },
      events: { onDidStatusChange: { ref: 'Status' } },
    },
  });

  const validSource = `export const create: DeviceFactory = (context) => ({
  methods: {
    press: (value) => (value ? null : null),
    getStatus: () => ({ pressed: false, extra: 'ok' }),
  },
  sync() {
    context.events.onDidStatusChange.fire({ pressed: true, extra: 'ok' });
  },
  dispose() {},
});
`;

  it('accepts a complete implementation, including disjoint additionalProperties', async () => {
    const { diagnostics } = await typecheckAuthor(validSource, statusManifest);
    expect(
      diagnostics.map((diagnostic) =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
      ),
    ).toEqual([]);
  });

  it.each([
    [
      'missing method',
      `export const create: DeviceFactory = () => ({
  methods: { getStatus: () => ({ pressed: false }) },
  sync() {},
  dispose() {},
});
`,
    ],
    [
      'wrong method parameter',
      `export const create: DeviceFactory = () => ({
  methods: { press: (value: number) => null, getStatus: () => ({ pressed: false }) },
  sync() {},
  dispose() {},
});
`,
    ],
    [
      'wrong method result',
      `export const create: DeviceFactory = () => ({
  methods: { press: () => null, getStatus: () => 1 },
  sync() {},
  dispose() {},
});
`,
    ],
    [
      'wrong event payload',
      `export const create: DeviceFactory = (context) => ({
  methods: { press: () => null, getStatus: () => ({ pressed: false }) },
  sync() { context.events.onDidStatusChange.fire(1); },
  dispose() {},
});
`,
    ],
    [
      'unknown event',
      `export const create: DeviceFactory = (context) => ({
  methods: { press: () => null, getStatus: () => ({ pressed: false }) },
  sync() { context.events.onDidUnknown.fire(1); },
  dispose() {},
});
`,
    ],
  ])('rejects %s', async (_name, source) => {
    const { diagnostics, sourcePath } = await typecheckAuthor(source, statusManifest);
    expect(diagnostics.some((diagnostic) => diagnostic.file?.fileName === sourcePath)).toBe(true);
  });
});

describe('build safety', () => {
  async function headlessProject(overrides: Record<string, unknown> = {}): Promise<string> {
    const root = await temporaryRoot();
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(
      join(root, 'package.json'),
      `${JSON.stringify(manifest({ view2d: undefined, ...overrides }), null, 2)}\n`,
      'utf8',
    );
    await writeFile(join(root, 'src', 'model.ddl'), 'device D { pin a; pin b; }', 'utf8');
    await writeFile(
      join(root, 'src', 'index.ts'),
      'export const create: DeviceFactory = () => ({ methods: {}, sync() {}, dispose() {} });\n',
      'utf8',
    );
    return root;
  }

  it('copies one package resource referenced by several fields only once', async () => {
    const root = await headlessProject({
      icon: 'assets/shared.svg',
      properties: {
        first: {
          type: 'binary',
          default: { src: 'assets/shared.svg', mode: 'package' },
          nullable: false,
        },
        second: {
          type: 'binary',
          default: { src: 'assets/shared.svg', mode: 'package' },
          nullable: false,
        },
      },
    });
    await mkdir(join(root, 'assets'), { recursive: true });
    await writeFile(join(root, 'assets', 'shared.svg'), '<svg />', 'utf8');
    const result = await buildDeviceProject(root, { device: {} });
    expect(result.files.filter((file) => file === 'assets/shared.svg')).toHaveLength(1);
    const release = JSON.parse(await readFile(result.releaseFile, 'utf8'));
    expect(Object.keys(release.files).filter((file) => file === 'assets/shared.svg')).toHaveLength(
      1,
    );
  });

  it('rejects release paths that would overwrite project files or source directories', async () => {
    const root = await headlessProject();
    await expect(buildDeviceProject(root, { device: { release: 'package.json' } })).rejects.toThrow(
      /overwrite/,
    );
    await expect(
      buildDeviceProject(root, { device: { release: 'src/model.ddl' } }),
    ).rejects.toThrow(/overwrite/);
    await expect(
      buildDeviceProject(root, { device: { release: 'mica.config.ts' } }),
    ).rejects.toThrow(/overwrite/);
    await expect(
      buildDeviceProject(root, { device: { release: 'src/release.json' } }),
    ).rejects.toThrow(/source directory/);
    await expect(
      buildDeviceProject(root, { device: { release: 'views/release.json' } }),
    ).rejects.toThrow(/source directory/);
    const manifestText = await readFile(join(root, 'package.json'), 'utf8');
    expect(manifestText).toContain('"publisher"');
  });
});
