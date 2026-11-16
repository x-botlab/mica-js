import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compileDDL } from '@mica-js/ddl';
import type { Geometry2D, UnifiedDeviceManifest } from '@mica-js/document/fused';
import {
  collectDevicePackage,
  createRelease,
  renderRelease,
  writeDevicePackage,
} from './unified-package';
import type { LoadedDevicePackage } from './unified-manifest';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const manifest: UnifiedDeviceManifest = {
  publisher: 'example',
  name: 'button',
  version: '1.0.0',
  engines: { mica: '^1.0.0' },
  displayName: 'Button',
  icon: 'assets/device-icon.svg',
  properties: {
    icon: { type: 'image', nullable: true, default: { src: 'assets/icon.png', mode: 'package' } },
    profile: {
      type: 'binary',
      nullable: true,
      default: { src: 'assets/profile.bin', mode: 'package' },
    },
  },
  pins: { a1: {}, b1: {} },
  model: {
    entry: 'model.js',
    methods: { press: { params: { type: 'boolean' }, returns: { type: 'null' } } },
    events: { onDidPress: { type: 'boolean' } },
  },
  view2d: { geometry: 'views/2d/geometry.json', entry: 'views/2d/index.js' },
  view: { monitor: { title: 'Button', entry: 'views/index.html' } },
};

const geometry: Geometry2D = {
  sizing: 'physical',
  bounds: { x: 0, y: 0, width: 6, height: 6 },
  bodyBounds: { x: 0, y: 0, width: 6, height: 6 },
  bodyImage: 'assets/body.svg',
  pins: { a1: { position: { x: 0, y: 1 }, outward: { x: -1, y: 0 } } },
};

const files: Readonly<Record<string, string>> = {
  'model.ddl': `device Button() {
    pin a1;
    pin b1;
  }`,
  'model.ts': `export const create = () => ({ methods: { press: () => null }, sync() {}, dispose() {} });`,
  'views/2d/index.ts': `export default () => ({ renderOverlay() {} });`,
  'views/2d/geometry.json': JSON.stringify(
    { ...geometry, pins: { a1: geometry.pins['a1'], b1: geometry.pins['a1'] } },
    null,
    2,
  ),
  'views/index.html':
    '<link rel="stylesheet" href="./styles.css"><script type="module" src="./panel.js"></script>' +
    '<img src="../assets/body.svg"><a href="https://example.com/">external</a>',
  'views/styles.css': 'body { background: url("./panel-bg.png"); }',
  'views/panel.ts': `document.title = 'button';`,
  'views/panel-bg.png': 'png',
  'assets/device-icon.svg': '<svg/>',
  'assets/body.svg': '<svg/>',
  'assets/icon.png': 'png',
  'assets/profile.bin': 'bin',
};

async function fixture(
  overrides: Readonly<Record<string, string>> = {},
  manifestOverrides: Partial<UnifiedDeviceManifest> = {},
): Promise<{
  root: string;
  device: LoadedDevicePackage;
}> {
  const root = await mkdtemp(join(tmpdir(), 'mica-unified-package-'));
  roots.push(root);
  const source = join(root, 'src');
  for (const [path, content] of Object.entries({ ...files, ...overrides })) {
    const file = resolve(source, ...path.split('/'));
    await mkdir(resolve(file, '..'), { recursive: true });
    await writeFile(file, content);
  }
  const model = await compileDDL(files['model.ddl']!);
  return {
    root,
    device: {
      manifestFile: join(root, 'package.json'),
      authored: { ...manifest, ...manifestOverrides, private: true },
      manifest: { ...structuredClone(manifest), ...manifestOverrides },
      model,
      geometry,
      geometryFile: 'views/2d/geometry.json',
    },
  };
}

function find(packageFiles: readonly { path: string; data: Uint8Array }[], path: string) {
  const file = packageFiles.find((entry) => entry.path === path);
  expect(file, `missing package file ${path}`).toBeDefined();
  return Buffer.from(file!.data).toString('utf8');
}

describe('collectDevicePackage', () => {
  it('emits the manifest, the module entries, HTML resources and assets', async () => {
    const { root, device } = await fixture();
    const packageFiles = await collectDevicePackage({
      root,
      sourceDir: 'src',
      device,
      minify: false,
    });
    expect(packageFiles.map((file) => file.path)).toEqual([
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
    const model = find(packageFiles, 'model.js');
    expect(model).toMatch(/export\s*\{[^}]*\bmodel\b/);
    expect(model).toMatch(/export\s*\{[^}]*\bcreate\b/);
    expect(model).toMatch(/"name":\s*"Button"/);
    expect(model).not.toContain('source');
    expect(find(packageFiles, 'views/2d/index.js')).toMatch(/as default/);
    expect(find(packageFiles, 'views/panel.js')).toMatch(/document\.title\s*=\s*"button"/);
    expect(JSON.parse(find(packageFiles, 'package.json'))).toEqual({
      ...manifest,
      private: true,
    });
  });

  it('reports a missing implementation module through the declared entry', async () => {
    const { root, device } = await fixture(
      {},
      {
        model: {
          entry: 'model.js',
          methods: { press: { params: { type: 'boolean' }, returns: { type: 'null' } } },
        },
      },
    );
    await rm(resolve(root, 'src', 'model.ts'));
    await expect(
      collectDevicePackage({ root, sourceDir: 'src', device, minify: false }),
    ).rejects.toThrow('the manifest declares model methods or events');
  });

  it('rejects an HTML reference that leaves the package', async () => {
    const { root, device } = await fixture({
      'views/index.html': '<img src="../../outside.png">',
    });
    await expect(
      collectDevicePackage({ root, sourceDir: 'src', device, minify: false }),
    ).rejects.toThrow('resolves outside the package root');
  });

  it('rejects two sources that claim the same package file', async () => {
    const { root, device } = await fixture(
      {
        'views/panel.js': 'export const create = () => ({ methods: {}, sync() {}, dispose() {} });',
      },
      {
        icon: 'views/panel.js',
        model: { entry: 'views/panel.js', events: { onDidPress: { type: 'boolean' } } },
      },
    );
    await expect(
      collectDevicePackage({ root, sourceDir: 'src', device, minify: false }),
    ).rejects.toThrow("Two sources produce the package file 'views/panel.js'");
  });
});

describe('createRelease', () => {
  it('records the real size and SHA-256 of every package file', async () => {
    const { root, device } = await fixture();
    const packageFiles = await collectDevicePackage({
      root,
      sourceDir: 'src',
      device,
      minify: false,
    });
    const release = createRelease(device.manifest, packageFiles);
    expect(release.id).toBe('example:button');
    expect(release.version).toBe('1.0.0');
    expect(Object.keys(release.files)).toEqual(packageFiles.map((file) => file.path));
    expect(Object.keys(release.files)).not.toContain('release.json');
    for (const file of packageFiles) {
      const record = release.files[file.path]!;
      expect(record.size).toBe(file.data.byteLength);
      expect(record.integrity).toBe(
        `sha256:${createHash('sha256').update(file.data).digest('hex')}`,
      );
    }
    expect(JSON.parse(renderRelease(release))).toEqual(release);
  });
});

describe('writeDevicePackage', () => {
  it('replaces the output directory and writes the release beside the files', async () => {
    const { root, device } = await fixture();
    const packageFiles = await collectDevicePackage({
      root,
      sourceDir: 'src',
      device,
      minify: false,
    });
    const release = createRelease(device.manifest, packageFiles);
    const outDir = join(root, 'dist');
    await mkdir(join(outDir, 'stale'), { recursive: true });
    await writeFile(join(outDir, 'stale', 'old.txt'), 'old');
    await writeDevicePackage({ outDir, files: packageFiles, release });
    expect(await readFile(join(outDir, 'release.json'), 'utf8')).toBe(renderRelease(release));
    expect(await readdir(join(outDir, 'stale')).catch(() => [])).toEqual([]);
    expect(await readFile(join(outDir, 'views', 'panel.js'), 'utf8')).toContain('document.title');
  });
});
