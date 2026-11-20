import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DeviceModule } from '../harness.ts';
import { createLm324Board, expectedGain } from './harness.ts';

/**
 * 交付产物：装载 `dist/lm324/model.js`，在真实板上重新验证初始增益、运行期设位置
 * 与有限输出阻抗。直接运行 vitest 而尚未构建时跳过。
 */

const PACKAGE_DIR = join(import.meta.dirname, '..', '..');
const ARTIFACT_DIR = join(PACKAGE_DIR, 'dist', 'lm324');

interface ArtifactModule {
  readonly model: DeviceModule['model'];
  readonly create: DeviceModule['create'];
}

describe.skipIf(!existsSync(join(ARTIFACT_DIR, 'model.js')))('交付产物', () => {
  it('package.json 与源码清单一致', () => {
    const artifact = JSON.parse(readFileSync(join(ARTIFACT_DIR, 'package.json'), 'utf8'));
    const source = JSON.parse(readFileSync(join(PACKAGE_DIR, 'lm324', 'package.json'), 'utf8'));

    expect(artifact).toEqual(source);
    expect(artifact.model.entry).toBe('model.js');
  });

  it('构建产物在真实板上放大、运行期改增益并保留有限输出阻抗', async () => {
    const module = (await import(
      pathToFileURL(join(ARTIFACT_DIR, 'model.js')).href
    )) as ArtifactModule;
    const manifest = JSON.parse(readFileSync(join(ARTIFACT_DIR, 'package.json'), 'utf8'));
    const device: DeviceModule = { model: module.model, create: module.create, manifest };
    const fixture = await createLm324Board({
      device,
      plusVoltage: 0.05,
      loadResistance: 25,
      loadTo: 'gnd',
    });

    try {
      expect(await fixture.board.query('dut', 'getGain')).toBeCloseTo(21, 12);
      expect(await fixture.output()).toBeCloseTo(0.525, 9);

      fixture.board.send('dut', 'setWiper', 0.5);
      fixture.runPeriods(2);

      const gain = expectedGain(0.5);
      expect(await fixture.board.query('dut', 'getGain')).toBeCloseTo(gain, 12);
      expect(await fixture.output()).toBeCloseTo((0.05 * gain) / 2, 9);
      expect(fixture.board.faults).toEqual([]);
    } finally {
      fixture.board.dispose();
    }
  });
});
