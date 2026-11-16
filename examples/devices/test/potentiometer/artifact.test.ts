import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DeviceModule } from '../harness.ts';
import { createPotBoard, expectedVoltage } from './harness.ts';

/**
 * 交付产物：装载 `dist/potentiometer/model.js`，在真实板上重新验证初始分压与
 * 运行期设位置。直接运行 vitest 而尚未构建时跳过。
 */

const PACKAGE_DIR = join(import.meta.dirname, '..', '..');
const ARTIFACT_DIR = join(PACKAGE_DIR, 'dist', 'potentiometer');

interface ArtifactModule {
  readonly model: DeviceModule['model'];
  readonly create: DeviceModule['create'];
}

describe.skipIf(!existsSync(join(ARTIFACT_DIR, 'model.js')))('交付产物', () => {
  it('package.json 与源码清单一致', () => {
    const artifact = JSON.parse(readFileSync(join(ARTIFACT_DIR, 'package.json'), 'utf8'));
    const source = JSON.parse(
      readFileSync(join(PACKAGE_DIR, 'potentiometer', 'package.json'), 'utf8'),
    );

    expect(artifact).toEqual(source);
    expect(artifact.model.entry).toBe('model.js');
    expect(artifact.view2d).toBeUndefined();
  });

  it('构建产物在真实板上完成分压，并可运行期改变位置', async () => {
    const module = (await import(
      pathToFileURL(join(ARTIFACT_DIR, 'model.js')).href
    )) as ArtifactModule;
    const manifest = JSON.parse(readFileSync(join(ARTIFACT_DIR, 'package.json'), 'utf8'));
    const device: DeviceModule = { model: module.model, create: module.create, manifest };
    const board = await createPotBoard({
      device,
      props: { initialPosition: 0.2, trackResistance: 20_000, endResistance: 20 },
    });

    try {
      const initial = (await board.query('dut', 'getVoltage')) as number;

      expect(initial).toBeCloseTo(
        expectedVoltage(0.2, { trackResistance: 20_000, endResistance: 20 }),
        12,
      );

      board.send('dut', 'setPosition', 0.8);
      board.run(1_000_000);

      const changed = (await board.query('dut', 'getVoltage')) as number;

      expect(changed).toBeCloseTo(
        expectedVoltage(0.8, { trackResistance: 20_000, endResistance: 20 }),
        12,
      );
      expect(changed).toBeGreaterThan(initial);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('构建产物在浮空滑臂上返回 voltage/unavailable，而不是确定 0 V', async () => {
    const module = (await import(
      pathToFileURL(join(ARTIFACT_DIR, 'model.js')).href
    )) as ArtifactModule;
    const manifest = JSON.parse(readFileSync(join(ARTIFACT_DIR, 'package.json'), 'utf8'));
    const device: DeviceModule = { model: module.model, create: module.create, manifest };
    const board = await createPotBoard({ device, connectSupply: false });

    try {
      await expect(board.query('dut', 'getVoltage')).rejects.toMatchObject({
        name: 'MethodError',
        code: 'voltage/unavailable',
      });
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });
});
