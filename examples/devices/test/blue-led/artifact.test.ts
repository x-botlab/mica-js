import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBoardWith, type DeviceModule } from '../harness.ts';

/**
 * 交付产物用例：先执行聚合构建，再装载 `dist/blue-led/package.json` 与
 * `dist/blue-led/model.js`，保证真正交付的文件也能在真实仿真板上工作。
 *
 * 直接 `vitest` 而没先构建时跳过，避免把「还没构建」误报成实现错误。
 */

const PACKAGE_DIR = join(import.meta.dirname, '..', '..');
const ARTIFACT_DIR = join(PACKAGE_DIR, 'dist', 'blue-led');

interface ArtifactModule {
  readonly model: DeviceModule['model'];
  readonly create: DeviceModule['create'];
}

describe.skipIf(!existsSync(join(ARTIFACT_DIR, 'model.js')))('交付产物', () => {
  it('package.json 与源码清单一致，入口为 model.js', () => {
    const artifact = JSON.parse(readFileSync(join(ARTIFACT_DIR, 'package.json'), 'utf8'));
    const source = JSON.parse(readFileSync(join(PACKAGE_DIR, 'blue-led', 'package.json'), 'utf8'));

    expect(artifact).toEqual(source);
    expect(artifact.model.entry).toBe('model.js');
    expect(artifact.view2d).toBeUndefined();
  });

  it('model.js 能在真实板上把正向电流换算成亮度', async () => {
    const module = (await import(
      pathToFileURL(join(ARTIFACT_DIR, 'model.js')).href
    )) as ArtifactModule;
    const manifest = JSON.parse(readFileSync(join(ARTIFACT_DIR, 'package.json'), 'utf8'));
    const device: DeviceModule = {
      model: module.model,
      create: module.create,
      manifest,
    };
    const board = await createBoardWith([{ id: 'led', type: 'blue-led', device, props: {} }], {
      resistors: [{ id: 'resistor', resistance: 330 }],
      nets: [
        { id: 'supply', pins: [{ instance: 'resistor', pin: 'a' }], voltage: 5 },
        {
          id: 'anode',
          pins: [
            { instance: 'resistor', pin: 'b' },
            { instance: 'led', pin: 'anode' },
          ],
        },
        { id: 'ground', pins: [{ instance: 'led', pin: 'cathode' }], voltage: 0 },
      ],
    });

    try {
      board.runUntil(1_000_000_000);
      const voltage = (await board.query('led', 'getVoltage')) as number;
      const current = (await board.query('led', 'getCurrent')) as number;
      const brightness = (await board.query('led', 'getBrightness')) as number;

      expect(voltage).toBeCloseTo((5 * 500) / 830, 6);
      expect(current).toBeCloseTo(5 / 830, 9);
      expect(brightness).toBeCloseTo(current / 0.02, 9);
    } finally {
      board.dispose();
    }
  });
});
