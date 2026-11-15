import { appendFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  JOINT_440MS_EXPECTED,
  JOINT_FULL_FRAME_PIXELS,
  JOINT_TIME_QUANTUM_PS,
  createJointBoard,
  gramMatchesOracle,
  nonZeroGramPixels,
  sameBytes,
  type JointBoard,
} from '../test/joint-harness';

/**
 * 可选的最小 post-only 热窗基准。
 *
 * 只在显式 `MICA_JOINT_POST_ONLY=1` 时运行；正式性能仍由 `joint-perf.test.ts` 负责。
 * 本入口只测真实 board 从 220 ms 到 440 ms 的单窗口 CPU/墙钟，前面 220 ms 只作准备，
 * 不计入结果。计时轮次不安装 accounting/profile/host 探针；独立 oracle 在计时结束后
 * 新建一块 accounting board 完成。测量日志写到 `/tmp/opencode`，不写仓库内 results。
 *
 * 200 µs 切片、真实 MCU/LCD 与 `assembleFrames` 夹具均保持不变。计时只使用
 * `process.cpuUsage()` 与 `performance.now()` 包住 `advanceTo`，不进入生产热循环。
 */

const MID_PS = 220_000_000_000;
const END_PS = 440_000_000_000;
const PS_PER_MS = 1_000_000_000;
const POST_SIM_MS = (END_PS - MID_PS) / PS_PER_MS;
const EXPECTED_CLEARS = 3;
const EXPECTED_FRAMES = 10;
const EXPECTED_FRAME_PIXELS = 436_480;
const ENABLED = process.env.MICA_JOINT_POST_ONLY === '1';
const REPORT_ROOT = '/tmp/opencode';

interface CounterSnapshot {
  readonly wrSamples: number;
  readonly gramStores: number;
  readonly frames: number;
  readonly framePixels: number;
  readonly direct: {
    readonly calls: number;
    readonly fallbacks: number;
    readonly compiles: number;
    readonly blocks: number;
    readonly shards: number;
    readonly programs: number;
  };
}

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

function framesPixels(frames: readonly Uint8Array[], from = 0): number {
  let pixels = 0;

  for (let index = from; index < frames.length; index += 1) {
    const frame = frames[index]!;
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    pixels += view.getUint16(4, true) * view.getUint16(6, true);
  }
  return pixels;
}

function directSnapshot(board: JointBoard['board']): CounterSnapshot['direct'] {
  const jit = (board as unknown as { jits?: readonly JitLike[] }).jits?.[0];

  return {
    calls: jit?.directStats?.directCalls ?? 0,
    fallbacks: jit?.directStats?.directFallbacks ?? 0,
    compiles: jit?.directStats?.directCompiles ?? 0,
    blocks: jit?.cache?.size ?? 0,
    shards: jit?.directStats?.directShards ?? jit?.direct?.program?.shards ?? 0,
    programs: jit?.directPrograms?.size ?? 0,
  };
}

function snapshot(joint: JointBoard): CounterSnapshot {
  const counters = lcdCounters(joint.lcd);

  return {
    ...counters,
    frames: joint.frames.length,
    framePixels: framesPixels(joint.frames),
    direct: directSnapshot(joint.board),
  };
}

const cpuMs = (before: ReturnType<typeof process.cpuUsage>): number => {
  const usage = process.cpuUsage(before);

  return (usage.user + usage.system) / 1000;
};

const round = (value: number): number => Number(value.toFixed(3));

function report(directory: string, kind: string, reading: Record<string, unknown>): void {
  appendFileSync(join(directory, 'readings.jsonl'), `${JSON.stringify({ kind, ...reading })}\n`);
}

describe.skipIf(!ENABLED)('STM32G431RBT6 + ILI9325 post-only hot window', () => {
  it('prepares 220 ms, then measures only 220 → 440 ms on the real board', async () => {
    mkdirSync(REPORT_ROOT, { recursive: true });
    const directory = mkdtempSync(join(REPORT_ROOT, 'mica-joint-post-only-'));

    const joint = await createJointBoard();

    try {
      joint.board.runUntil(0);
      // 准备窗口不计时。真实 board 先走完初始化、首帧与 Direct 编译。
      joint.advanceTo(MID_PS);
      expect(joint.board.time).toBe(MID_PS);
      expect(joint.errors).toEqual([]);
      expect(joint.faults).toEqual([]);
      expect(joint.board.status).toBe('ready');
      expect(joint.readAccounting()).toBeUndefined();

      const before = snapshot(joint);
      const cpuStart = process.cpuUsage();
      const wallStart = performance.now();

      joint.advanceTo(END_PS);

      const measuredCpuMs = cpuMs(cpuStart);
      const measuredWallMs = performance.now() - wallStart;
      const after = snapshot(joint);

      expect(joint.board.time).toBe(END_PS);
      expect(joint.errors).toEqual([]);
      expect(joint.faults).toEqual([]);
      expect(joint.board.status).toBe('ready');
      // 计时轮次没有逐 intent 对账探针。
      expect(joint.readAccounting()).toBeUndefined();

      const gram = joint.lcd.memories.get('gram')!;

      // 完整窗口固定工作量，和无观察者版本计数一致。
      expect(after.wrSamples).toBe(JOINT_440MS_EXPECTED.wrLevelChanges);
      expect(after.gramStores).toBe(JOINT_440MS_EXPECTED.gramStores);
      expect(nonZeroGramPixels(gram)).toBe(JOINT_440MS_EXPECTED.nonZeroPixels);
      expect(after.frames).toBe(EXPECTED_FRAMES);
      expect(after.framePixels).toBe(EXPECTED_FRAME_PIXELS);
      // 220 ms 准备窗口已发布 5 帧；后段再发布 5 帧，合计 10 帧。
      expect(before.frames).toBe(5);
      expect(after.frames - before.frames).toBe(5);
      expect(joint.expectedFrames).toHaveLength(EXPECTED_FRAMES);
      expect(
        joint.frames.every((frame, index) => sameBytes(frame, joint.expectedFrames[index]!)),
      ).toBe(true);
      // 后段确实执行了 Direct，而不是全部由解释器回退。
      expect(after.direct.calls - before.direct.calls).toBeGreaterThan(
        after.direct.fallbacks - before.direct.fallbacks,
      );
      expect(after.direct.calls - after.direct.fallbacks).toBeGreaterThan(0);

      const post = {
        device: 'stm32g431rbt6+ili9325',
        mode: 'post-only',
        targetMs: POST_SIM_MS,
        quantumPs: JOINT_TIME_QUANTUM_PS,
        cpuMs: round(measuredCpuMs),
        wallMs: round(measuredWallMs),
        realtimeFactor: round(POST_SIM_MS / measuredCpuMs),
        wallRealtimeFactor: round(POST_SIM_MS / measuredWallMs),
        postWrSamples: after.wrSamples - before.wrSamples,
        postGramStores: after.gramStores - before.gramStores,
        postFrames: after.frames - before.frames,
        postFramePixels: after.framePixels - before.framePixels,
        fullWrSamples: after.wrSamples,
        fullGramStores: after.gramStores,
        fullFrames: after.frames,
        fullFramePixels: after.framePixels,
        gramNonZeroPixels: nonZeroGramPixels(gram),
        direct: {
          calls: after.direct.calls - before.direct.calls,
          fallbacks: after.direct.fallbacks - before.direct.fallbacks,
          compiles: after.direct.compiles,
          blocks: after.direct.blocks,
          shards: after.direct.shards,
          programs: after.direct.programs,
          totalCalls: after.direct.calls,
          totalFallbacks: after.direct.fallbacks,
        },
      };

      report(directory, 'timed', post);
      process.stdout.write(`JOINT_POST_ONLY ${JSON.stringify(post)}\n`);
    } finally {
      joint.dispose();
    }

    // 计时外独立 oracle：再用 accounting board 跑完整 440 ms，验证固定工作量与图像。
    const oracleJoint = await createJointBoard({ accounting: true });

    try {
      oracleJoint.board.runUntil(0);
      oracleJoint.advanceTo(END_PS);

      expect(oracleJoint.board.time).toBe(END_PS);
      expect(oracleJoint.errors).toEqual([]);
      expect(oracleJoint.faults).toEqual([]);
      expect(oracleJoint.board.status).toBe('ready');

      const accounting = oracleJoint.readAccounting()!;
      const gram = oracleJoint.lcd.memories.get('gram')!;
      const clears = accounting.fullScreenFills.filter(
        (fill) =>
          fill.value === JOINT_440MS_EXPECTED.clearColor &&
          fill.pixels === JOINT_FULL_FRAME_PIXELS &&
          fill.uniform,
      );

      expect(accounting.wrLevelChanges).toBe(JOINT_440MS_EXPECTED.wrLevelChanges);
      expect(accounting.wrSamples).toBe(JOINT_440MS_EXPECTED.wrLevelChanges);
      expect(accounting.pixelWrites).toBe(JOINT_440MS_EXPECTED.pixelWrites);
      expect(accounting.gramStores).toBe(JOINT_440MS_EXPECTED.gramStores);
      expect(accounting.oracleGramStores).toBe(JOINT_440MS_EXPECTED.gramStores);
      expect(gramMatchesOracle(gram, accounting.oracleGram)).toBe(true);
      expect(nonZeroGramPixels(gram)).toBe(JOINT_440MS_EXPECTED.nonZeroPixels);
      expect(clears).toHaveLength(EXPECTED_CLEARS);
      expect(oracleJoint.frames).toHaveLength(EXPECTED_FRAMES);
      expect(framesPixels(oracleJoint.frames)).toBe(EXPECTED_FRAME_PIXELS);
      expect(accounting.oracleFrames).toHaveLength(EXPECTED_FRAMES);
      expect(
        oracleJoint.frames.every((frame, index) =>
          sameBytes(frame, accounting.oracleFrames[index]!),
        ),
      ).toBe(true);

      report(directory, 'oracle', {
        wrLevelChanges: accounting.wrLevelChanges,
        wrSamples: accounting.wrSamples,
        pixelWrites: accounting.pixelWrites,
        gramStores: accounting.gramStores,
        oracleGramStores: accounting.oracleGramStores,
        gramNonZeroPixels: nonZeroGramPixels(gram),
        fullScreenFills: clears.length,
        frames: oracleJoint.frames.length,
        framePixels: framesPixels(oracleJoint.frames),
      });
      process.stdout.write(`JOINT_POST_ONLY_REPORT ${directory}\n`);
    } finally {
      oracleJoint.dispose();
    }
  }, 900_000);
});
