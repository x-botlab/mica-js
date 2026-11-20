import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DeviceModule } from '../harness.ts';
import { createMcpBoard, expectedVoltage, makeBus } from './harness.ts';

/**
 * 交付产物：装载 `dist/mcp4017/model.js`，在真实板上通过 I²C 改写 wiper，并验证
 * CT117E 等效的 R17 上拉分压。直接运行 vitest 而尚未构建时跳过。
 */

const PACKAGE_DIR = join(import.meta.dirname, '..', '..');
const ARTIFACT_DIR = join(PACKAGE_DIR, 'dist', 'mcp4017');

interface ArtifactModule {
  readonly model: DeviceModule['model'];
  readonly create: DeviceModule['create'];
}

describe.skipIf(!existsSync(join(ARTIFACT_DIR, 'model.js')))('交付产物', () => {
  it('package.json 与源码清单一致', () => {
    const artifact = JSON.parse(readFileSync(join(ARTIFACT_DIR, 'package.json'), 'utf8'));
    const source = JSON.parse(readFileSync(join(PACKAGE_DIR, 'mcp4017', 'package.json'), 'utf8'));

    expect(artifact).toEqual(source);
    expect(artifact.model.entry).toBe('model.js');
    expect(artifact.view2d).toBeUndefined();
  });

  it('构建产物上电为 midscale，I²C 写 0/127 后电压随之改变', async () => {
    const module = (await import(
      pathToFileURL(join(ARTIFACT_DIR, 'model.js')).href
    )) as ArtifactModule;
    const manifest = JSON.parse(readFileSync(join(ARTIFACT_DIR, 'package.json'), 'utf8'));
    const device: DeviceModule = { model: module.model, create: module.create, manifest };
    const board = await createMcpBoard({ device });
    const bus = makeBus(board);

    try {
      expect(await board.query('dut', 'getWiper')).toBe(0x3f);
      expect(await board.query('dut', 'getVoltage')).toBeCloseTo(expectedVoltage(0x3f), 12);

      bus.start();
      expect(bus.writeByte(0x5e)).toBe(0);
      expect(bus.writeByte(0x00)).toBe(0);
      bus.stop();

      expect(await board.query('dut', 'getWiper')).toBe(0);
      const low = (await board.query('dut', 'getVoltage')) as number;

      expect(low).toBeCloseTo(expectedVoltage(0), 12);

      bus.start();
      expect(bus.writeByte(0x5e)).toBe(0);
      expect(bus.writeByte(0x7f)).toBe(0);
      bus.stop();

      expect(await board.query('dut', 'getWiper')).toBe(0x7f);
      const high = (await board.query('dut', 'getVoltage')) as number;

      expect(high).toBeCloseTo(expectedVoltage(0x7f), 12);
      expect(high).toBeGreaterThan(low);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('构建产物在全浮空时返回 voltage/unavailable，而不是确定 0 V', async () => {
    const module = (await import(
      pathToFileURL(join(ARTIFACT_DIR, 'model.js')).href
    )) as ArtifactModule;
    const manifest = JSON.parse(readFileSync(join(ARTIFACT_DIR, 'package.json'), 'utf8'));
    const device: DeviceModule = { model: module.model, create: module.create, manifest };
    const board = await createMcpBoard({ device, floating: true });

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
