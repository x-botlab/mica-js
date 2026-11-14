import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  JOINT_440MS_EXPECTED,
  createJointBoard,
  gramMatchesOracle,
  nonZeroGramPixels,
  sameBytes,
  type JointBoard,
} from '../test/joint-harness';

/**
 * 默认路径逐窗口对账诊断。
 *
 * 历史 `yield-on-intent` 反事实与其 CPU profile 已记录在
 * docs/stm32g431rbt6-ili9325-joint-bottlenecks.md；这里只跑正式路径，避免默认
 * perf 配置重复执行两套 440 ms + 六个 profile。需要显式开启：
 * `MICA_JOINT=1 ./node_modules/.bin/vitest run --config vitest.perf.config.ts bench/joint-diagnosis.test.ts`。
 */

const COLD = 200_000_000;
const MID = 220_000_000_000;
const END = 440_000_000_000;
const PS_PER_MS = 1_000_000_000;
const directory = mkdtempSync(join(tmpdir(), 'mica-joint-diagnosis-'));

function report(kind: string, reading: Record<string, unknown>): void {
  const line = JSON.stringify({ kind, ...reading });
  appendFileSync(join(directory, 'readings.jsonl'), `${line}\n`);
  process.stdout.write(`${line}\n`);
}

function measure(run: () => void): { cpuMs: number; wallMs: number } {
  const cpu = process.cpuUsage();
  const start = performance.now();
  run();
  const usage = process.cpuUsage(cpu);
  return {
    cpuMs: Number(((usage.user + usage.system) / 1000).toFixed(3)),
    wallMs: Number((performance.now() - start).toFixed(3)),
  };
}

function framePixels(joint: JointBoard): number {
  let pixels = 0;

  for (const frame of joint.frames) {
    const header = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    pixels += header.getUint16(4, true) * header.getUint16(6, true);
  }
  return pixels;
}

function reportCounts(window: string, joint: JointBoard): void {
  const accounting = joint.readAccounting()!;

  report('counts', {
    mode: 'default',
    window,
    timeMs: joint.board.time / PS_PER_MS,
    intentCalls: accounting.intentCalls,
    intentChanges: accounting.intentChanges,
    wrLevelChanges: accounting.wrLevelChanges,
    wrRises: accounting.wrRises,
    selectedRises: accounting.selectedRises,
    commandWrites: accounting.commandWrites,
    dataWrites: accounting.dataWrites,
    pixelWrites: accounting.pixelWrites,
    csLevelChanges: accounting.csLevelChanges,
    rsLevelChanges: accounting.rsLevelChanges,
    dataBitLevelChanges: accounting.dataBitLevelChanges,
    wrSamples: accounting.wrSamples,
    csSamples: accounting.csSamples,
    rsSamples: accounting.rsSamples,
    dataSamples: accounting.dataSamples,
    gramStores: accounting.gramStores,
    oracleGramStores: accounting.oracleGramStores,
    gramNonZero: nonZeroGramPixels(joint.lcd.memories.get('gram')!),
    fullScreenFills: accounting.fullScreenFills.length,
    frames: joint.frames.length,
    framePixels: framePixels(joint),
  });
}

describe.skipIf(!process.env.MICA_JOINT)('MCU + LCD 边沿对账诊断', () => {
  it('默认路径 0 → 440 ms 逐窗口对账 WR/CS/RS/PC intent 与 GRAM store', async () => {
    (await createJointBoard()).dispose();

    const joint = await createJointBoard({ accounting: true });

    try {
      joint.board.runUntil(0);
      for (const [window, target] of [
        ['cold', COLD],
        ['active', MID],
        ['post', END],
      ] as const) {
        const duration = measure(() => joint.advanceTo(target));

        report('window', { mode: 'default', window, ...duration });
        reportCounts(window, joint);
        expect(joint.board.time).toBe(target);

        // 每个窗口都检查，避免只在最终才发现前半程已经漏沿。
        const windowCounts = joint.readAccounting()!;

        expect(windowCounts.wrSamples).toBe(windowCounts.wrLevelChanges);
        expect(windowCounts.gramStores).toBe(windowCounts.pixelWrites);
      }

      expect(joint.errors).toEqual([]);
      expect(joint.faults).toEqual([]);

      const accounting = joint.readAccounting()!;
      const gram = joint.lcd.memories.get('gram')!;

      // 固定工作量：旧路径 272,007 次写只收到 136 次 store 会在这里失败。
      expect(accounting.wrLevelChanges).toBe(JOINT_440MS_EXPECTED.wrLevelChanges);
      expect(accounting.selectedRises).toBe(JOINT_440MS_EXPECTED.selectedRises);
      expect(accounting.wrSamples).toBe(JOINT_440MS_EXPECTED.wrLevelChanges);
      expect(accounting.csSamples).toBe(accounting.csLevelChanges);
      expect(accounting.rsSamples).toBe(accounting.rsLevelChanges);
      expect(accounting.dataSamples).toBeGreaterThanOrEqual(accounting.dataBitLevelChanges);
      expect(accounting.pixelWrites).toBe(JOINT_440MS_EXPECTED.pixelWrites);
      expect(accounting.gramStores).toBe(JOINT_440MS_EXPECTED.gramStores);
      expect(accounting.oracleGramStores).toBe(JOINT_440MS_EXPECTED.gramStores);
      expect(gramMatchesOracle(gram, accounting.oracleGram)).toBe(true);
      expect(nonZeroGramPixels(gram)).toBe(JOINT_440MS_EXPECTED.nonZeroPixels);
      expect(
        accounting.fullScreenFills.some(
          (fill) =>
            fill.value === JOINT_440MS_EXPECTED.clearColor &&
            fill.pixels === JOINT_440MS_EXPECTED.nonZeroPixels &&
            fill.uniform,
        ),
      ).toBe(true);
      expect(joint.expectedFrames).toHaveLength(joint.frames.length);
      expect(
        joint.frames.every((frame, index) => sameBytes(frame, joint.expectedFrames[index]!)),
      ).toBe(true);
      expect(accounting.oracleFrames).toHaveLength(joint.frames.length);
      expect(
        joint.frames.every((frame, index) => sameBytes(frame, accounting.oracleFrames[index]!)),
      ).toBe(true);
    } finally {
      joint.dispose();
    }
  }, 900_000);
});
