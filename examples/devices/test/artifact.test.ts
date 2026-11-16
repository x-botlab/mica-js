import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 聚合交付产物用例：每个简单器件的 `dist/<id>/` 必须包含与源码清单一致的
 * `package.json` 与可加载的 `model.js`。本轮不要求 view2d/几何/资产。
 */

const ROOT = join(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist');
const IDS = [
  '74hc02',
  '74hc138',
  '74hc14',
  '74hc573',
  'at24c02',
  'blue-led',
  'buzzer',
  'cx20106a',
  'ds1302',
  'ds18b20',
  'jumper',
  'jumper-2x3',
  'lm386',
  'ne555',
  'pcf8591',
  'push-button',
  'relay',
  'uart-probe',
  'uln2003',
  'ultrasonic',
  'vs1838',
] as const;

interface Artifact {
  readonly model: { readonly kind: string; readonly name: string };
  readonly create: unknown;
}

describe.skipIf(!existsSync(DIST))('聚合交付产物', () => {
  it.each(IDS)('%s 的 package.json 与源码一致且入口为 model.js', (id) => {
    const artifactDir = join(DIST, id);
    expect(existsSync(join(artifactDir, 'package.json'))).toBe(true);

    const artifact = JSON.parse(readFileSync(join(artifactDir, 'package.json'), 'utf8'));
    const source = JSON.parse(readFileSync(join(ROOT, id, 'package.json'), 'utf8'));

    expect(artifact).toEqual(source);
    expect(artifact.model.entry).toBe('model.js');
    expect(artifact.view2d).toBeUndefined();
  });

  it.each(IDS)('%s 的 model.js 具名导出 model 与 create', async (id) => {
    const module = (await import(pathToFileURL(join(DIST, id, 'model.js')).href)) as Artifact;
    expect(module.model.kind).toBe('device');
    expect(module.model.name.length).toBeGreaterThan(0);
    expect(typeof module.create).toBe('function');
  });
});
