import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PANEL_HEIGHT, PANEL_WIDTH, artifactAvailable, circuit } from './harness';

const ARTIFACT_DIR = join(import.meta.dirname, '..', '..', 'dist', 'ili9325');

describe.skipIf(!artifactAvailable())('ILI9325 交付产物', () => {
  it('交付清单与 headless 模型文件齐全', () => {
    const artifact = JSON.parse(readFileSync(join(ARTIFACT_DIR, 'package.json'), 'utf8'));
    const source = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', '..', 'ili9325', 'package.json'), 'utf8'),
    );

    expect(artifact).toEqual(source);
    expect(artifact.view2d).toBeUndefined();
    expect(existsSync(join(ARTIFACT_DIR, 'model.js'))).toBe(true);
  });

  it('从 model.js 走通初始化、整屏填充与帧发布', async () => {
    const value = await circuit({ refreshRate: 60, variant: 'artifact' });

    try {
      // 参考 BSP 的关键初始化序列。
      value.command(0x03);
      value.data(0x1030);
      value.command(0x03);
      value.data(0x1018);
      value.command(0x20);
      value.data(0);
      value.command(0x21);
      value.data(0);
      value.command(0x07);
      value.data(0x0173);

      value.command(0x22);
      value.data(0x001f, PANEL_WIDTH * PANEL_HEIGHT);
      value.drain();
      value.run(value.framePeriod + 1_000_000);

      expect(value.faults).toEqual([]);
      expect(value.frames).toHaveLength(1);
      expect(value.stats).toEqual({ infos: 1, rows: 1 });
      expect(value.frames[0]).toMatchObject({
        x: 0,
        y: 0,
        width: PANEL_WIDTH,
        height: PANEL_HEIGHT,
      });
      expect(value.frames[0]!.pixels.every((entry) => entry === 0x001f)).toBe(true);
    } finally {
      value.dispose();
    }
  });
});
