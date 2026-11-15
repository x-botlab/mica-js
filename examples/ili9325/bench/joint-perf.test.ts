import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  JOINT_440MS_EXPECTED,
  JOINT_CLOCK_FREQUENCY,
  JOINT_FULL_FRAME_PIXELS,
  JOINT_TIME_QUANTUM_PS,
  createJointBoard,
  gramMatchesOracle,
  nonZeroGramPixels,
  sameBytes,
  type JointAccountingReadout,
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
const FULL_FRAME_PIXELS = JOINT_FULL_FRAME_PIXELS;
/**
 * 完整 WR 边沿下的固定读数。
 *
 * 三者都是不带观察者的版本/内存读数，不向计时路径添加逐 intent 探针：
 * - `WR` sample 版本 = MCU WR intent 电平变化数；
 * - `gram` memory 版本 = `writePixel` 的 store 次数；
 * - 最终非零像素 = 整屏蓝色背景（部分被后续绘图覆盖，但都非零）。
 */
const EXPECTED_WR_SAMPLES = JOINT_440MS_EXPECTED.wrLevelChanges;
const EXPECTED_GRAM_STORES = JOINT_440MS_EXPECTED.gramStores;
const EXPECTED_GRAM_NON_ZERO = JOINT_440MS_EXPECTED.nonZeroPixels;
const CLEAR_COLOR = JOINT_440MS_EXPECTED.clearColor;

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
  /** `WR` sample 版本：不带观察者的边沿计数。 */
  readonly lcdWrSamples: number;
  /** `gram` memory 版本：不带观察者的 store 计数。 */
  readonly lcdGramStores: number;
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

/** 运行时内部资源槽：版本号随每次电气 sample 变化 / `store16le` 递增。 */
function lcdCounters(lcd: JointBoard['lcd']): {
  readonly wrSamples: number;
  readonly gramStores: number;
} {
  const internal = lcd as unknown as {
    readonly sampleResources: ReadonlyMap<string, { readonly version: number }>;
    readonly memoryResources: ReadonlyMap<string, { readonly version: number }>;
  };

  return {
    wrSamples: internal.sampleResources.get('WR')?.version ?? 0,
    gramStores: internal.memoryResources.get('gram')?.version ?? 0,
  };
}

/** 帧载荷必须等于模型在帧体发送时刻交给适配器的字节。 */
function framesMatchSource(joint: JointBoard): boolean {
  return (
    joint.frames.length === joint.expectedFrames.length &&
    joint.frames.every((frame, index) => sameBytes(frame, joint.expectedFrames[index]!))
  );
}

/** 计时之外的整屏内容摘要；只读取最终 GRAM，不参与计时。 */
function digestBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

interface ReconcileResult {
  readonly accounting: JointAccountingReadout;
  /** 与独立 MCU oracle 逐像素一致后的整屏摘要。 */
  readonly gramDigest: string;
}

/** 计时外的一次完整独立对账；不进入任何计时轮次。 */
async function reconcile(key: string): Promise<ReconcileResult> {
  const joint = await createJointBoard({ accounting: true });

  try {
    joint.board.runUntil(0);
    joint.advanceTo(END_PS);

    expect(joint.board.time).toBe(END_PS);
    expect(joint.errors).toEqual([]);
    expect(joint.faults).toEqual([]);
    expect(joint.board.status).toBe('ready');

    const accounting = joint.readAccounting()!;
    const gram = joint.lcd.memories.get('gram')!;

    // MCU 发出量 vs LCD 接收量：旧路径 272,007 次写只收到 136 次 store 会失败。
    expect(accounting.wrLevelChanges).toBe(EXPECTED_WR_SAMPLES);
    expect(accounting.selectedRises).toBe(JOINT_440MS_EXPECTED.selectedRises);
    expect(accounting.wrSamples).toBe(accounting.wrLevelChanges);
    expect(accounting.csSamples).toBe(accounting.csLevelChanges);
    expect(accounting.rsSamples).toBe(accounting.rsLevelChanges);
    expect(accounting.dataSamples).toBeGreaterThanOrEqual(accounting.dataBitLevelChanges);
    expect(accounting.pixelWrites).toBe(EXPECTED_GRAM_STORES);
    expect(accounting.gramStores).toBe(accounting.pixelWrites);
    expect(accounting.oracleGramStores).toBe(accounting.pixelWrites);

    // 独立参考图像与整屏蓝色清屏。
    expect(gramMatchesOracle(gram, accounting.oracleGram)).toBe(true);
    expect(nonZeroGramPixels(gram)).toBe(EXPECTED_GRAM_NON_ZERO);
    expect(accounting.oracleFrames).toHaveLength(joint.frames.length);
    expect(
      joint.frames.every((frame, index) => sameBytes(frame, accounting.oracleFrames[index]!)),
    ).toBe(true);
    expect(
      accounting.fullScreenFills.some(
        (fill) => fill.value === CLEAR_COLOR && fill.pixels === FULL_FRAME_PIXELS && fill.uniform,
      ),
    ).toBe(true);

    // 帧体在模型发送时刻的副本必须与话题载荷一致。
    expect(joint.expectedFrames.length).toBeGreaterThan(0);
    expect(framesMatchSource(joint)).toBe(true);

    console.log(
      'JOINT_ACCOUNTING',
      JSON.stringify({
        key,
        timeMs: accounting.timePs / PS_PER_MS,
        intentCalls: accounting.intentCalls,
        wrLevelChanges: accounting.wrLevelChanges,
        wrSamples: accounting.wrSamples,
        csSamples: accounting.csSamples,
        rsSamples: accounting.rsSamples,
        dataBitLevelChanges: accounting.dataBitLevelChanges,
        dataSamples: accounting.dataSamples,
        pixelWrites: accounting.pixelWrites,
        gramStores: accounting.gramStores,
        fullScreenFills: accounting.fullScreenFills.length,
        frames: joint.frames.length,
      }),
    );

    return { accounting, gramDigest: digestBytes(gram) };
  } finally {
    joint.dispose();
  }
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

    const roundDigests: string[] = [];

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
        const counters = lcdCounters(joint.lcd);

        // 无观察者版本计数：完整边沿的固定读数，可直接抓住漏写而不影响计时。
        expect(counters.wrSamples).toBe(EXPECTED_WR_SAMPLES);
        expect(counters.gramStores).toBe(EXPECTED_GRAM_STORES);
        expect(nonZeroGramPixels(gram)).toBe(EXPECTED_GRAM_NON_ZERO);
        expect(summary.pixels).toBeGreaterThan(0);
        expect(summary.nonZeroPixels).toBeGreaterThan(0);
        expect(joint.expectedFrames.length).toBeGreaterThan(0);
        expect(framesMatchSource(joint)).toBe(true);
        // 计时轮次不得安装逐 intent 对账探针。
        expect(joint.readAccounting()).toBeUndefined();
        roundDigests.push(digestBytes(gram));

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
          gramNonZeroPixels: nonZeroGramPixels(gram),
          lcdWrSamples: counters.wrSamples,
          lcdGramStores: counters.gramStores,
          jit: jitSnapshot(joint.board),
        });
      } finally {
        joint?.dispose();
      }
    }

    expect(readings).toHaveLength(ROUNDS);
    expect(readings.every((reading) => reading.jit.direct)).toBe(true);
    expect(readings.every((reading) => reading.frames > 0)).toBe(true);

    // 计时之外的一次独立 MCU intent / LCD sample / GRAM oracle 完整对账。
    // 计时轮次的最终整屏必须等于这次独立对账得到的参考图像；旧路径会在这里失败。
    const reference = await reconcile('HAL_06_LCD-440ms');

    expect(roundDigests).toHaveLength(ROUNDS);
    expect(roundDigests.every((digest) => digest === reference.gramDigest)).toBe(true);

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
      lcdWrSamples: Math.min(...readings.map((reading) => reading.lcdWrSamples)),
      lcdGramStores: Math.min(...readings.map((reading) => reading.lcdGramStores)),
    };

    console.log('JOINT_PERF', JSON.stringify(best));

    const path = join(import.meta.dirname, 'results.jsonl');
    for (const reading of readings) appendFileSync(path, `${JSON.stringify(reading)}\n`);
  }, 900_000);
});
