import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import { validateMetadata } from '@mica-js/sdk/metadata';
import { resistorModel } from './harness.ts';

/**
 * 交付产物用例：`pnpm test` 先执行 `mica build`，这里装载 `dist/` 里的 JS 与 JSON，
 * 保证真正交付的文件也能在真实仿真板上工作，而不只是源码副本。
 *
 * 直接 `vitest` 而没先构建时跳过，避免把「还没构建」误报成实现错误。
 */

const PACKAGE_DIR = join(import.meta.dirname, '..');
const ARTIFACT_DIR = join(PACKAGE_DIR, 'dist', 'devices', 'blue-led');

interface ArtifactModule {
  readonly model: unknown;
  readonly create: (context: unknown) => {
    sync(batch: { outputs: Readonly<Record<string, readonly { value: unknown }[]>> }): void;
    dispose(): void;
  };
}

describe.skipIf(!existsSync(join(ARTIFACT_DIR, 'device.js')))('交付产物', () => {
  it('device.json 通过 SDK 校验且与源码一致', () => {
    const artifact = JSON.parse(readFileSync(join(ARTIFACT_DIR, 'device.json'), 'utf8'));
    const source = JSON.parse(
      readFileSync(join(PACKAGE_DIR, 'src', 'devices', 'blue-led', 'device.json'), 'utf8'),
    );

    expect(() => validateMetadata(artifact, 'device', 'blue-led')).not.toThrow();
    expect(artifact).toEqual(source);
  });

  it('device.js 能在真实板上把正向电流换算成亮度', async () => {
    const module = (await import(
      pathToFileURL(join(ARTIFACT_DIR, 'device.js')).href
    )) as ArtifactModule;
    const resistor = await resistorModel();
    const readings = { brightness: Number.NaN, current: Number.NaN, voltage: Number.NaN };
    const create = (context: never) => {
      const adapter = module.create(context);

      return {
        sync(batch: Parameters<typeof adapter.sync>[0]) {
          adapter.sync(batch);

          for (const name of ['brightness', 'current', 'voltage'] as const) {
            const messages = batch.outputs[name] ?? [];
            const latest = messages[messages.length - 1];

            if (latest !== undefined) readings[name] = latest.value as number;
          }
        },
        dispose: () => adapter.dispose(),
      };
    };
    const library = createDeviceLibrary([
      { id: 'led', model: module.model as never, create: create as never },
      { id: 'resistor', model: resistor, create: () => ({ sync() {}, dispose() {} }) },
    ]);
    const board = createBoard(library, {
      instances: [
        { id: 'led', type: 'led', props: {} },
        { id: 'resistor', type: 'resistor', props: { resistance: 330 } },
      ],
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
    } finally {
      board.dispose();
    }

    expect(readings.voltage).toBeCloseTo((5 * 500) / 830, 6);
    expect(readings.current).toBeCloseTo(5 / 830, 9);
    expect(readings.brightness).toBeCloseTo(readings.current / 0.02, 9);
  });
});
