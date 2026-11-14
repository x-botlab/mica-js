import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  JOINT_CLOCK_FREQUENCY,
  JOINT_TIME_QUANTUM_PS,
  createJointBoard,
  type JointBoard,
} from '../test/joint-harness';

/**
 * STM32G431RBT6 + ILI9325 联合性能基准。
 *
 * 真实 `HAL_06_LCD.bin` 从复位开始推进到 440 ms，覆盖时钟/GPIO/PWR/USART/SysTick、
 * LCD 初始化、HAL_Delay 以及首帧之后的持续 GRAM 写入与 framebuffer 发布。
 *
 * 时间量子不能大于 SysTick 周期（约 200 µs）：运行时单次 `runUntil` 不会消费同一调用
 * 内的多个轮询边界，大切片会少计 `uwTick`。进程 CPU 时间包含建板与运行，三轮取最小值；
 * 首轮同时承担模块级翻译缓存冷启动。
 */

const COLD_PS = 200_000_000;
const MID_PS = 220_000_000_000;
const END_PS = 440_000_000_000;
const PS_PER_MS = 1_000_000_000;
const ROUNDS = 3;
const PANEL_WIDTH = 320;

interface DirectStats {
  readonly directCompiles: number;
  readonly directShards: number;
  readonly directCalls: number;
  readonly directFallbacks: number;
}

interface JitLike {
  readonly cache?: ReadonlyMap<number, unknown>;
  readonly direct?: {
    readonly program?: { readonly shards?: number };
  };
  readonly directPrograms?: ReadonlyMap<string, unknown>;
  readonly directStats?: DirectStats;
}

interface Reading {
  readonly device: string;
  readonly case: string;
  readonly round: number;
  readonly clockFrequency: number;
  readonly targetMs: number;
  readonly quantumPs: number;
  readonly coldMs: number;
  readonly activeMs: number;
  readonly postMs: number;
  readonly totalMs: number;
  readonly coldWallMs: number;
  readonly activeWallMs: number;
  readonly postWallMs: number;
  readonly totalWallMs: number;
  readonly activeRealtimeFactor: number;
  readonly postRealtimeFactor: number;
  readonly totalRealtimeFactor: number;
  readonly framesAt220Ms: number;
  readonly frames: number;
  readonly framePixels: number;
  readonly frameNonZeroPixels: number;
  readonly framePayloadBytes: number;
  readonly gramNonZeroPixels: number;
  readonly jit: {
    readonly direct: boolean;
    readonly programs: number;
    readonly blocks: number;
    readonly shards: number;
    readonly compiles: number;
    readonly calls: number;
    readonly fallbacks: number;
  };
}

const readings: Reading[] = [];

const cpuMs = (before: ReturnType<typeof process.cpuUsage>): number => {
  const usage = process.cpuUsage(before);

  return (usage.user + usage.system) / 1000;
};

const round = (value: number): number => Number(value.toFixed(3));

function summarizeFrames(frames: readonly Uint8Array[]): {
  readonly pixels: number;
  readonly nonZeroPixels: number;
  readonly payloadBytes: number;
} {
  let pixels = 0;
  let nonZeroPixels = 0;
  let payloadBytes = 0;

  for (const frame of frames) {
    if (frame.byteLength < 10) throw new Error('framebuffer payload is shorter than its header');
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const width = view.getUint16(4, true);
    const height = view.getUint16(6, true);
    const at = width * height;

    if (width === 0 || height === 0 || frame.byteLength !== 8 + at * 2)
      throw new Error('framebuffer payload does not match its rectangle');

    pixels += at;
    payloadBytes += frame.byteLength;
    for (let index = 0; index < at; index += 1)
      if (view.getUint16(8 + index * 2, true) !== 0) nonZeroPixels += 1;
  }

  return { pixels, nonZeroPixels, payloadBytes };
}

/** `gram` 以面板坐标行优先存储，发布帧应逐像素等于对应快照。 */
function frameMatchesGram(frame: Uint8Array, gram: Uint8Array): boolean {
  const pixels = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const memory = new DataView(gram.buffer, gram.byteOffset, gram.byteLength);
  const x = pixels.getUint16(0, true);
  const y = pixels.getUint16(2, true);
  const width = pixels.getUint16(4, true);
  const height = pixels.getUint16(6, true);

  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const panelX = x + column;
      const panelY = y + row;
      const fromFrame = pixels.getUint16(8 + (row * width + column) * 2, true);
      const fromGram = memory.getUint16((panelY * PANEL_WIDTH + panelX) * 2, true);

      if (fromFrame !== fromGram) return false;
    }
  }

  return true;
}

function nonZeroWords(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let count = 0;

  for (let offset = 0; offset < view.byteLength; offset += 2)
    if (view.getUint16(offset, true) !== 0) count += 1;

  return count;
}

function jitSnapshot(board: JointBoard['board']): Reading['jit'] {
  const jit = (board as unknown as { jits?: readonly JitLike[] }).jits?.[0];

  return {
    direct: jit?.direct !== undefined,
    programs: jit?.directPrograms?.size ?? 0,
    blocks: jit?.cache?.size ?? 0,
    shards: jit?.directStats?.directShards ?? jit?.direct?.program?.shards ?? 0,
    compiles: jit?.directStats?.directCompiles ?? 0,
    calls: jit?.directStats?.directCalls ?? 0,
    fallbacks: jit?.directStats?.directFallbacks ?? 0,
  };
}

const min = (values: readonly number[]): number => Math.min(...values);

describe('STM32G431RBT6 + ILI9325 联合性能', () => {
  it('0 → 200 µs 冷启动 + 200 µs → 220 ms + 220 → 440 ms，真实 GRAM/帧发布', async () => {
    // 预热 DDL 编译与模块装载，避免一次性模块初始化 skew 第一轮建板读数。
    // 不运行固件，因此不会预热模块级 Thumb 块缓存。
    (await createJointBoard()).dispose();

    for (let index = 0; index < ROUNDS; index += 1) {
      let joint: JointBoard | undefined;

      try {
        const coldCpuStart = process.cpuUsage();
        const coldWallStart = performance.now();

        joint = await createJointBoard();
        joint.board.runUntil(0);
        joint.board.runUntil(COLD_PS);

        const coldMs = cpuMs(coldCpuStart);
        const coldWallMs = performance.now() - coldWallStart;

        expect(joint.errors).toEqual([]);
        expect(joint.faults).toEqual([]);
        expect(joint.board.status).toBe('ready');
        expect(joint.frames).toHaveLength(0);

        const activeCpuStart = process.cpuUsage();
        const activeWallStart = performance.now();

        joint.advanceTo(MID_PS);

        const activeMs = cpuMs(activeCpuStart);
        const activeWallMs = performance.now() - activeWallStart;
        const framesAt220Ms = joint.frames.length;

        expect(joint.board.time).toBe(MID_PS);
        expect(framesAt220Ms).toBeGreaterThan(0);

        const postCpuStart = process.cpuUsage();
        const postWallStart = performance.now();

        joint.advanceTo(END_PS);

        const postMs = cpuMs(postCpuStart);
        const postWallMs = performance.now() - postWallStart;

        expect(joint.board.time).toBe(END_PS);
        expect(joint.errors).toEqual([]);
        expect(joint.faults).toEqual([]);
        expect(joint.board.status).toBe('ready');
        expect(joint.frames.length).toBeGreaterThan(framesAt220Ms);

        const summary = summarizeFrames(joint.frames);
        const gram = joint.lcd.memories.get('gram')!;

        expect(summary.pixels).toBeGreaterThan(0);
        expect(summary.nonZeroPixels).toBeGreaterThan(0);
        expect(nonZeroWords(gram)).toBeGreaterThan(0);
        expect(joint.frameGramSnapshots).toHaveLength(joint.frames.length);
        expect(frameMatchesGram(joint.frames.at(-1)!, joint.frameGramSnapshots.at(-1)!)).toBe(true);

        const totalMs = coldMs + activeMs + postMs;
        const activeSimMs = (MID_PS - COLD_PS) / PS_PER_MS;
        const postSimMs = (END_PS - MID_PS) / PS_PER_MS;

        readings.push({
          device: 'stm32g431rbt6+ili9325',
          case: 'HAL_06_LCD-440ms',
          round: index + 1,
          clockFrequency: JOINT_CLOCK_FREQUENCY,
          targetMs: END_PS / PS_PER_MS,
          quantumPs: JOINT_TIME_QUANTUM_PS,
          coldMs: round(coldMs),
          activeMs: round(activeMs),
          postMs: round(postMs),
          totalMs: round(totalMs),
          coldWallMs: round(coldWallMs),
          activeWallMs: round(activeWallMs),
          postWallMs: round(postWallMs),
          totalWallMs: round(coldWallMs + activeWallMs + postWallMs),
          activeRealtimeFactor: round(activeSimMs / activeMs),
          postRealtimeFactor: round(postSimMs / postMs),
          totalRealtimeFactor: round(END_PS / PS_PER_MS / totalMs),
          framesAt220Ms,
          frames: joint.frames.length,
          framePixels: summary.pixels,
          frameNonZeroPixels: summary.nonZeroPixels,
          framePayloadBytes: summary.payloadBytes,
          gramNonZeroPixels: nonZeroWords(gram),
          jit: jitSnapshot(joint.board),
        });
      } finally {
        joint?.dispose();
      }
    }

    expect(readings).toHaveLength(ROUNDS);
    expect(readings.every((reading) => reading.jit.direct)).toBe(true);
    expect(readings.every((reading) => reading.frames > 0)).toBe(true);

    const activeSimMs = (MID_PS - COLD_PS) / PS_PER_MS;
    const postSimMs = (END_PS - MID_PS) / PS_PER_MS;
    const best = {
      coldMs: min(readings.map((reading) => reading.coldMs)),
      activeMs: min(readings.map((reading) => reading.activeMs)),
      postMs: min(readings.map((reading) => reading.postMs)),
      totalMs: min(readings.map((reading) => reading.totalMs)),
      totalWallMs: min(readings.map((reading) => reading.totalWallMs)),
      activeRealtimeFactor: round(activeSimMs / min(readings.map((reading) => reading.activeMs))),
      postRealtimeFactor: round(postSimMs / min(readings.map((reading) => reading.postMs))),
      totalRealtimeFactor: round(
        END_PS / PS_PER_MS / min(readings.map((reading) => reading.totalMs)),
      ),
      framesAt220Ms: Math.min(...readings.map((reading) => reading.framesAt220Ms)),
      frames: Math.min(...readings.map((reading) => reading.frames)),
      framePixels: Math.min(...readings.map((reading) => reading.framePixels)),
      frameNonZeroPixels: Math.min(...readings.map((reading) => reading.frameNonZeroPixels)),
      gramNonZeroPixels: Math.min(...readings.map((reading) => reading.gramNonZeroPixels)),
    };

    console.log('JOINT_PERF', JSON.stringify(best));

    const path = join(import.meta.dirname, 'results.jsonl');
    for (const reading of readings) appendFileSync(path, `${JSON.stringify(reading)}\n`);
  }, 900_000);
});
