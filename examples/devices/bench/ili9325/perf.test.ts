import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GRAM_HEIGHT, circuit } from '../../test/ili9325/harness';

/**
 * 器件侧性能基准。
 *
 * 口径：
 * - 每个访问 = 100 ns 仿真时间（WR 低 50 ns、WR 高 50 ns），一次像素写入一个访问；
 * - `wallMs` 是 `drain()` 的墙钟，只包含总线写入，不含合帧发布；
 * - `pixelsPerSecond` 是墙钟口径的像素吞吐；
 * - `slowdown` = 墙钟 / 仿真时间，越小越快（1 表示实时）。
 *
 * 基准要独占 CPU：读数需要时连跑 3 次取最小值。
 */

const ACCESS_PERIOD = 100_000;
const FULL_FRAME_PIXELS = 320 * 240;

interface Reading {
  readonly device: string;
  readonly case: string;
  readonly refreshRate: number;
  readonly pixels: number;
  readonly simMs: number;
  readonly wallMs: number;
  readonly slowdown: number;
  readonly pixelsPerSecond: number;
  readonly frames: number;
  readonly messages: number;
}

const readings: Reading[] = [];

describe('性能基准', () => {
  it('整屏填充：0x22 连续写 76,800 像素', async () => {
    const refreshRate = 60;
    const value = await circuit({ refreshRate, accessPeriod: ACCESS_PERIOD });

    try {
      value.command(0x22);
      value.data(0xf800, FULL_FRAME_PIXELS);

      const started = performance.now();

      value.drain();

      const wallMs = performance.now() - started;
      const burstSimMs = (FULL_FRAME_PIXELS * ACCESS_PERIOD) / 1_000_000_000;

      // 合帧发布：等到下一个刷新周期。
      value.run(value.framePeriod + 1_000_000);

      expect(value.faults).toEqual([]);
      expect(value.frames).toHaveLength(1);
      expect(value.stats).toEqual({ infos: 1, rows: 1 });

      readings.push({
        device: 'ili9325',
        case: 'full-frame',
        refreshRate,
        pixels: FULL_FRAME_PIXELS,
        simMs: Number(burstSimMs.toFixed(3)),
        wallMs: Math.round(wallMs),
        slowdown: Number((wallMs / burstSimMs).toFixed(1)),
        pixelsPerSecond: Math.round(FULL_FRAME_PIXELS / (wallMs / 1000)),
        frames: value.frames.length,
        messages: value.stats.infos + value.stats.rows,
      });
    } finally {
      value.dispose();
    }
  });

  it('文本行带宽：0x22 连续写 24 行 × 320 像素', async () => {
    const refreshRate = 240;
    const pixels = 320 * 24;
    const value = await circuit({ refreshRate, accessPeriod: ACCESS_PERIOD });

    try {
      // R03h = 0x0018：AM=1（Y 快轴）、I-D0=1、I-D1=0（Y 递减 → 面板列递增）。
      // 从 Y=319 开始，一条面板行正好是 GRAM 里连续的一段。
      value.command(0x03);
      value.data(0x0018);
      value.command(0x20);
      value.data(0);
      value.command(0x21);
      value.data(GRAM_HEIGHT - 1);
      value.command(0x22);
      value.data(0x001f, pixels);

      const started = performance.now();

      value.drain();

      const wallMs = performance.now() - started;
      const burstSimMs = (pixels * ACCESS_PERIOD) / 1_000_000_000;

      value.run(value.framePeriod + 1_000_000);

      expect(value.faults).toEqual([]);
      expect(value.frames).toHaveLength(1);
      // 脏矩形覆盖整行 → 单条像素体。
      expect(value.stats).toEqual({ infos: 1, rows: 1 });

      readings.push({
        device: 'ili9325',
        case: 'text-band',
        refreshRate,
        pixels,
        simMs: Number(burstSimMs.toFixed(3)),
        wallMs: Math.round(wallMs),
        slowdown: Number((wallMs / burstSimMs).toFixed(1)),
        pixelsPerSecond: Math.round(pixels / (wallMs / 1000)),
        frames: value.frames.length,
        messages: value.stats.infos + value.stats.rows,
      });
    } finally {
      value.dispose();
    }
  });

  it('按行发布：10×10 小矩形在非整行时按行分块', async () => {
    const refreshRate = 240;
    const value = await circuit({ refreshRate, accessPeriod: ACCESS_PERIOD });

    try {
      value.command(0x50);
      value.data(10);
      value.command(0x51);
      value.data(19);
      value.command(0x52);
      value.data(20);
      value.command(0x53);
      value.data(29);
      value.command(0x20);
      value.data(10);
      value.command(0x21);
      value.data(20);
      value.command(0x22);
      value.data(0x07e0, 100);

      const started = performance.now();

      value.drain();

      const wallMs = performance.now() - started;
      const burstSimMs = (100 * ACCESS_PERIOD) / 1_000_000_000;

      value.run(value.framePeriod + 1_000_000);

      expect(value.faults).toEqual([]);
      expect(value.stats).toEqual({ infos: 1, rows: 10 });

      readings.push({
        device: 'ili9325',
        case: 'partial-rows',
        refreshRate,
        pixels: 100,
        simMs: Number(burstSimMs.toFixed(3)),
        wallMs: Math.round(wallMs),
        slowdown: Number((wallMs / burstSimMs).toFixed(1)),
        pixelsPerSecond: Math.round(100 / (wallMs / 1000)),
        frames: value.frames.length,
        messages: value.stats.infos + value.stats.rows,
      });
    } finally {
      value.dispose();
    }
  });

  it('对照：同引脚的空白器件跑同样的整屏写入', async () => {
    const refreshRate = 60;
    const value = await circuit({
      refreshRate,
      accessPeriod: ACCESS_PERIOD,
      target: 'sink',
    });

    try {
      value.command(0x22);
      value.data(0xf800, FULL_FRAME_PIXELS);

      const started = performance.now();

      value.drain();

      const wallMs = performance.now() - started;
      const burstSimMs = (FULL_FRAME_PIXELS * ACCESS_PERIOD) / 1_000_000_000;

      expect(value.faults).toEqual([]);
      expect(value.frames).toHaveLength(0);

      readings.push({
        device: 'ili9325',
        case: 'sink-baseline',
        refreshRate,
        pixels: FULL_FRAME_PIXELS,
        simMs: Number(burstSimMs.toFixed(3)),
        wallMs: Math.round(wallMs),
        slowdown: Number((wallMs / burstSimMs).toFixed(1)),
        pixelsPerSecond: Math.round(FULL_FRAME_PIXELS / (wallMs / 1000)),
        frames: 0,
        messages: 0,
      });
    } finally {
      value.dispose();
    }
  });

  it('汇总读数', () => {
    const path = join(import.meta.dirname, 'results.jsonl');

    for (const reading of readings) {
      appendFileSync(path, `${JSON.stringify(reading)}\n`);
      console.log(`PERF ${JSON.stringify(reading)}`);
    }
    expect(readings).toHaveLength(4);
  });
});
