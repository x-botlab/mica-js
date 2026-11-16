import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MeasureOptions } from './measure';

/**
 * 实际预览固件的基准夹具：`assets/digital-display-dynamic.bin` 是 Playground
 * 画布预览使用的 8 位数码管动态扫描固件，时钟 11.0592 MHz（与原理图里的 12 MHz
 * 演示固件不同）。
 *
 * 基准统一采用：
 * - `execution: 'throughput'`（画布预览的真实后端）；
 * - 预热 512 ms + 测量窗口 1024 ms：512 是 64 ms 的整数倍，窗口结束 1536 ms
 *   也落在 64 ms 网格上；
 * - 默认 64 ms 批次（画布粗粒度推进），另用 16 ms 批次做共同检查点对照；
 * - 检查点从 512 ms 开始、每 64 ms 一个，一直含到窗口终点 1536 ms，
 *   16 ms 与 64 ms 两种推进都能精确命中，不额外切分 `runUntil`。
 */

export const PREVIEW_FIRMWARE_NAME = 'digital-display-dynamic.bin';
export const PREVIEW_FIRMWARE_PATH = join(
  import.meta.dirname,
  '..',
  'assets',
  PREVIEW_FIRMWARE_NAME,
);
export const PREVIEW_CLOCK_FREQUENCY = 11_059_200;
export const PREVIEW_WARMUP_MS = 512;
export const PREVIEW_WINDOW_MS = 1024;
export const PREVIEW_TICK_MS = 64;
export const PREVIEW_CHECKPOINT_STEP_MS = 64;

/** 读取实际预览固件；每次返回新副本，避免被装配侧改写后影响下一轮。 */
export function previewFirmware(): Uint8Array {
  return new Uint8Array(readFileSync(PREVIEW_FIRMWARE_PATH));
}

/**
 * 生成共同仿真时间检查点：窗口起点、每 `stepMs` 一个、并包含窗口终点。
 * 调用方仍可用 `measureCt107d({ checkpointMs })` 直接传入绝对毫秒。
 */
export function checkpointTimesMs(startMs: number, endMs: number, stepMs: number): number[] {
  if (!(stepMs > 0)) throw new RangeError('stepMs must be positive.');
  if (endMs < startMs) throw new RangeError('endMs must not be less than startMs.');

  const times: number[] = [];

  for (let time = startMs; time <= endMs; time += stepMs) times.push(time);
  if (times[times.length - 1] !== endMs) times.push(endMs);

  return times;
}

export const PREVIEW_CHECKPOINTS_MS = checkpointTimesMs(
  PREVIEW_WARMUP_MS,
  PREVIEW_WARMUP_MS + PREVIEW_WINDOW_MS,
  PREVIEW_CHECKPOINT_STEP_MS,
);

/** 实际预览固件的统一基准参数；可用 `overrides` 切换 tick/执行模式做对照。 */
export function previewMeasureOptions(overrides: Partial<MeasureOptions> = {}): MeasureOptions {
  return {
    firmware: previewFirmware(),
    firmwareName: PREVIEW_FIRMWARE_NAME,
    props: { clockFrequency: PREVIEW_CLOCK_FREQUENCY },
    execution: 'throughput',
    warmUpMs: PREVIEW_WARMUP_MS,
    measureMs: PREVIEW_WINDOW_MS,
    tickMs: PREVIEW_TICK_MS,
    rounds: 1,
    checkpointMs: PREVIEW_CHECKPOINTS_MS,
    ...overrides,
  };
}
