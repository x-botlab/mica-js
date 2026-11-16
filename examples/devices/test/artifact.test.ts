import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SIMPLE_DEVICE_IDS } from './device-projects.ts';
import { createBoardWith, type DeviceModule, type Manifest } from './harness.ts';

/**
 * 聚合交付产物用例：每个简单器件的 `dist/<id>/` 必须包含与源码清单一致的
 * `package.json` 与可加载的 `model.js`，并能通过真实仿真板创建实例。
 *
 * 本轮不要求 view2d/几何/资产。器件发现与专项排除规则集中在
 * `test/device-projects.ts`。
 */

const ROOT = join(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist');

interface Artifact {
  readonly model: DeviceModule['model'];
  readonly create: DeviceModule['create'];
}

interface ArtifactManifest extends Manifest {
  readonly view2d?: unknown;
}

const readArtifactManifest = (id: string): ArtifactManifest =>
  JSON.parse(readFileSync(join(DIST, id, 'package.json'), 'utf8')) as ArtifactManifest;

const loadArtifact = async (id: string): Promise<Artifact> =>
  (await import(pathToFileURL(join(DIST, id, 'model.js')).href)) as Artifact;

function modelPins(model: DeviceModule['model']): string[] {
  return (model.declarations as readonly { readonly kind: string; readonly name: string }[])
    .filter((declaration) => declaration.kind === 'pin')
    .map((declaration) => declaration.name)
    .sort();
}

describe.skipIf(!existsSync(DIST))('聚合交付产物', () => {
  it.each(SIMPLE_DEVICE_IDS)('%s 的 package.json 与源码一致且入口为 model.js', (id) => {
    const artifactDir = join(DIST, id);
    expect(existsSync(join(artifactDir, 'package.json'))).toBe(true);

    const artifact = readArtifactManifest(id);
    const source = JSON.parse(readFileSync(join(ROOT, id, 'package.json'), 'utf8'));

    expect(artifact).toEqual(source);
    expect(artifact.model.entry).toBe('model.js');
    expect(artifact.view2d).toBeUndefined();
  });

  it.each(SIMPLE_DEVICE_IDS)(
    '%s 的 model.js 具名导出 model 与 create，且引脚与清单一致',
    async (id) => {
      const module = await loadArtifact(id);
      const manifest = readArtifactManifest(id);

      expect(module.model.kind).toBe('device');
      expect(module.model.name.length).toBeGreaterThan(0);
      expect(typeof module.create).toBe('function');
      expect(modelPins(module.model)).toEqual(Object.keys(manifest.pins ?? {}).sort());
    },
  );

  it.each(SIMPLE_DEVICE_IDS)('%s 的 model.js 能在真实仿真板上创建实例', async (id) => {
    const module = await loadArtifact(id);
    const manifest = readArtifactManifest(id);
    const board = await createBoardWith(
      [{ id: 'dut', type: id, device: { ...module, manifest } }],
      { nets: [] },
    );

    try {
      board.run(1_000_000_000);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });
});
