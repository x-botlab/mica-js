import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MeasureResult, TopicCheckpoint } from './measure';
import { measureCt107d } from './measure';
import {
  PREVIEW_CHECKPOINTS_MS,
  PREVIEW_CLOCK_FREQUENCY,
  PREVIEW_FIRMWARE_NAME,
  PREVIEW_FIRMWARE_PATH,
  PREVIEW_TICK_MS,
  PREVIEW_WARMUP_MS,
  PREVIEW_WINDOW_MS,
  previewMeasureOptions,
} from './preview';

/**
 * 实际预览固件基准：`digital-display-dynamic.bin` + 11.0592 MHz + throughput。
 *
 * 与 `perf.test.ts` 的演示固件基准分开，因为二者关注的指标不同：这里固定
 * 「预热 512 ms + 窗口 1024 ms + 默认 64 ms 批次」，并把 16 ms 与 64 ms 的差别
 * 落在**共同仿真时间检查点**上，而不是只比较窗口最后值。
 *
 * 话题流唯一键始终是「实例 ID/端口」（如 `c7d00000-…-021f/digit1`）；位号
 * （DS1/U7…）只是辅助映射，可能重复，不作为唯一键。
 *
 * 断言只守可复现字段、唯一话题键和 16/64 ms 的检查点一致性；绝对速度受并行任务
 * 抢 CPU 影响，不作为验收值。
 */

const EXPECTED_FIRMWARE_BYTES = 2_421;
const EXPECTED_FIRMWARE_SHA256 = 'b15a9f9f4232a70d88d080e2f6336359c701777951685a93177e3264b829bd25';
const SCHEMATIC_PATH = join(import.meta.dirname, '..', 'ct107d.sch');
/** 超过安全整数上限的预热毫秒值：乘以 1e9 后已无法精确表示。 */
const UNSAFE_WARMUP_MS = Math.floor(Number.MAX_SAFE_INTEGER / 1_000_000_000) + 1;
const DISPLAY_PORTS = new Set(['digit1', 'digit2', 'digit3', 'digit4']);
const LATCH_PORTS = new Set(['latch', 'select', 'code', 'enabled']);
const DISPLAYS = ['DS1', 'DS2'] as const;

const SEVEN_SEGMENT = new Map<number, string>([
  [0x3f, '0'],
  [0x06, '1'],
  [0x5b, '2'],
  [0x4f, '3'],
  [0x66, '4'],
  [0x6d, '5'],
  [0x7d, '6'],
  [0x07, '7'],
  [0x7f, '8'],
  [0x6f, '9'],
  [0x40, '-'],
  [0x00, ' '],
  [0x77, 'A'],
  [0x7c, 'b'],
  [0x39, 'C'],
  [0x5e, 'd'],
  [0x79, 'E'],
  [0x71, 'F'],
  [0x3d, 'o'],
  [0x76, 'H'],
  [0x38, 'L'],
  [0x73, 'P'],
  [0x6e, 'u'],
]);

function glyph(mask: number): string {
  const base = SEVEN_SEGMENT.get(mask & 0x7f) ?? '?';

  return (mask & 0x80) === 0 ? base : `${base}.`;
}

function displayText(
  topics: Readonly<Record<string, string>>,
  result: Pick<MeasureResult, 'instanceDesignators'>,
  designator: string,
): string {
  return `${[1, 2, 3, 4]
    .map((index) =>
      glyph(Number(topicValue(topics, result, designator, `digit${index}`) ?? Number.NaN)),
    )
    .join('')}`;
}

/** 位号只是辅助标签；按它找实例 ID，再拼「实例 ID/端口」唯一键。 */
function instanceIdsByDesignator(
  result: Pick<MeasureResult, 'instanceDesignators'>,
  designator: string,
): readonly string[] {
  return Object.entries(result.instanceDesignators)
    .filter(([, value]) => value === designator)
    .map(([instanceId]) => instanceId)
    .sort();
}

function topicValue(
  topics: Readonly<Record<string, string>>,
  result: Pick<MeasureResult, 'instanceDesignators'>,
  designator: string,
  port: string,
): string | undefined {
  for (const instanceId of instanceIdsByDesignator(result, designator)) {
    const value = topics[`${instanceId}/${port}`];

    if (value !== undefined) return value;
  }

  return undefined;
}

function topicKeysForDesignator(
  topics: Readonly<Record<string, string>>,
  result: Pick<MeasureResult, 'instanceDesignators'>,
  designator: string,
  port: string,
): readonly string[] {
  return instanceIdsByDesignator(result, designator)
    .map((instanceId) => `${instanceId}/${port}`)
    .filter((key) => Object.hasOwn(topics, key));
}

/** 八位数码管：两块 seg4 的 4 位字形。 */
function displaySummary(
  topics: Readonly<Record<string, string>>,
  result: Pick<MeasureResult, 'instanceDesignators'>,
): Record<string, string> {
  return Object.fromEntries(
    DISPLAYS.map((designator) => [designator, displayText(topics, result, designator)]),
  );
}

/** 只保留与八位数码管、574/138 锁存—译码链相关的话题。 */
function displayAndLatchTopics(
  topics: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(topics).filter(([key]) => {
      const port = key.slice(key.lastIndexOf('/') + 1);

      return DISPLAY_PORTS.has(port) || LATCH_PORTS.has(port);
    }),
  );
}

function tracedCheckpoints(
  result: MeasureResult,
): readonly { readonly simMs: number; readonly topics: Readonly<Record<string, string>> }[] {
  return result.checkpoints.map((checkpoint) => ({
    simMs: checkpoint.simMs,
    topics: displayAndLatchTopics(checkpoint.topics),
  }));
}

function latchSeries(checkpoint: TopicCheckpoint): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(checkpoint.topics).filter(([key]) => key.endsWith('/latch')),
  );
}

function latencySummary(result: MeasureResult): Record<string, number> {
  return {
    cpuMs: result.cpuMs,
    elapsedWallMs: result.elapsedWallMs,
    realtimeRatio: result.realtimeRatio,
    coldCpuMs: result.coldCpuMs,
    coldElapsedWallMs: result.coldElapsedWallMs,
    coldRealtimeRatio: result.coldRealtimeRatio,
  };
}

function baselineSummary(result: MeasureResult): Record<string, unknown> {
  return {
    board: result.board,
    firmware: result.firmwareName,
    firmwareBytes: result.firmwareBytes,
    firmwareSha256: result.firmwareSha256,
    execution: result.execution,
    clockFrequency: result.clockFrequency,
    devices: result.devices,
    nets: result.nets,
    warmUpMs: result.warmUpMs,
    simMs: result.simMs,
    tickMs: result.tickMs,
    rounds: result.rounds,
    windowStartMs: result.windowStartMs,
    windowEndMs: result.windowEndMs,
    timing: latencySummary(result),
    legacyCpuFields: {
      wallMs: result.wallMs,
      rtf: result.rtf,
      coldMs: result.coldMs,
    },
    checkpointMs: result.checkpoints.map((checkpoint) => checkpoint.simMs),
    checkpointsStable: result.checkpointsStable,
    fingerprints: result.fingerprints,
    instanceDesignators: result.instanceDesignators,
    display: displaySummary(result.topicFinalTopics, result),
    latches: latchSeries({ simMs: result.windowEndMs, topics: result.topicFinalTopics }),
    topicDigest: result.topicDigest,
    topicFinalDigest: result.topicFinalDigest,
    topicFinalDigestByDevice: result.topicFinalDigestByDevice,
    topicFinalKeys: Object.keys(result.topicFinalTopics),
    topicFinalPortKeys: Object.keys(result.topicFinalPorts),
    faults: result.faults,
  };
}

/**
 * 预热现在按 `tickMs` 分批推进：`Infinity` 会让批次循环永不终止，NaN / 负数 /
 * 超安全整数也不该进入装配。校验发生在 `createCt107dBoard` 之前，所以这组用例
 * 不会运行真实板。
 */
describe('CT107D 预热时长校验', () => {
  it.each([
    ['Infinity', Number.POSITIVE_INFINITY],
    ['NaN', Number.NaN],
    ['负数', -PREVIEW_TICK_MS],
    ['超安全整数', UNSAFE_WARMUP_MS],
  ] as const)('拒绝 %s 预热，不装配真实板', async (_label, warmUpMs) => {
    const error = await measureCt107d(previewMeasureOptions({ warmUpMs })).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(RangeError);
    expect((error as Error).message).toBe(
      'warmUpMs must represent a non-negative safe integer number of picoseconds.',
    );
  });
});

describe('CT107D 实际预览固件基准', () => {
  it('64 ms 批次：记录固件指纹、冷启动/稳态计时与共同检查点', async () => {
    const result = await measureCt107d(previewMeasureOptions());

    process.stdout.write(`PREVIEW_BASELINE ${JSON.stringify(baselineSummary(result))}\n`);
    if (process.env['MICA_PREVIEW_DUMP'])
      process.stdout.write(`PREVIEW_RESULT ${JSON.stringify(result)}\n`);

    expect(result.faults).toEqual([]);
    expect(result.firmwareName).toBe(PREVIEW_FIRMWARE_NAME);
    expect(result.firmwareBytes).toBe(EXPECTED_FIRMWARE_BYTES);
    expect(result.firmwareSha256).toBe(EXPECTED_FIRMWARE_SHA256);
    expect(readFileSync(PREVIEW_FIRMWARE_PATH)).toHaveLength(EXPECTED_FIRMWARE_BYTES);
    expect(createHash('sha256').update(readFileSync(PREVIEW_FIRMWARE_PATH)).digest('hex')).toBe(
      EXPECTED_FIRMWARE_SHA256,
    );

    expect(result.execution).toBe('throughput');
    expect(result.clockFrequency).toBe(PREVIEW_CLOCK_FREQUENCY);
    expect(result.warmUpMs).toBe(PREVIEW_WARMUP_MS);
    expect(result.simMs).toBe(PREVIEW_WINDOW_MS);
    expect(result.tickMs).toBe(PREVIEW_TICK_MS);
    expect(result.rounds).toBe(1);
    expect(result.windowStartMs).toBe(PREVIEW_WARMUP_MS);
    expect(result.windowEndMs).toBe(PREVIEW_WARMUP_MS + PREVIEW_WINDOW_MS);
    expect(result.checkpoints.map((checkpoint) => checkpoint.simMs)).toEqual(
      PREVIEW_CHECKPOINTS_MS,
    );
    expect(PREVIEW_CHECKPOINTS_MS[0]).toBe(PREVIEW_WARMUP_MS);
    expect(PREVIEW_CHECKPOINTS_MS.at(-1)).toBe(PREVIEW_WARMUP_MS + PREVIEW_WINDOW_MS);
    expect(PREVIEW_CHECKPOINTS_MS).toHaveLength(PREVIEW_WINDOW_MS / PREVIEW_TICK_MS + 1);
    expect(PREVIEW_WARMUP_MS).toBe(512);
    expect(PREVIEW_WINDOW_MS).toBe(1024);
    expect(result.checkpointsStable).toBe(true);

    expect(result.cpuMs).toBeGreaterThan(0);
    expect(result.elapsedWallMs).toBeGreaterThan(0);
    expect(result.realtimeRatio).toBeCloseTo(result.simMs / result.elapsedWallMs, 2);
    expect(result.coldCpuMs).toBeGreaterThan(0);
    expect(result.coldElapsedWallMs).toBeGreaterThan(0);
    expect(result.coldRealtimeRatio).toBeCloseTo(result.warmUpMs / result.coldElapsedWallMs, 2);

    // 历史字段必须仍然可读，但明确仍是 CPU 口径的别名。
    expect(result.wallMs).toBe(result.cpuMs);
    expect(result.rtf).toBeCloseTo(result.cpuMs / result.simMs, 2);
    expect(result.coldMs).toBe(result.coldCpuMs);

    // 同名端口不再互相覆盖：四个 573、两个 seg4、138 的译码端口都要能同时看到。
    // 唯一键是「实例 ID/端口」；位号只用来定位实例，不作为键。
    for (const designator of ['U6', 'U7', 'U8', 'U9'])
      expect(
        topicKeysForDesignator(result.topicFinalTopics, result, designator, 'latch').length,
      ).toBeGreaterThan(0);
    for (const designator of DISPLAYS)
      for (let index = 1; index <= 4; index += 1)
        expect(
          topicKeysForDesignator(result.topicFinalTopics, result, designator, `digit${index}`)
            .length,
        ).toBeGreaterThan(0);
    expect(
      topicKeysForDesignator(result.topicFinalTopics, result, 'U24', 'select').length,
    ).toBeGreaterThan(0);
    expect(
      topicKeysForDesignator(result.topicFinalTopics, result, 'U24', 'code').length,
    ).toBeGreaterThan(0);
    expect(
      topicKeysForDesignator(result.topicFinalTopics, result, 'U24', 'enabled').length,
    ).toBeGreaterThan(0);

    // 每个话题键的实例段都必须是真实实例 ID；位号（DS1/U7…）不能当唯一键。
    for (const key of Object.keys(result.topicFinalTopics)) {
      const instanceId = key.slice(0, key.lastIndexOf('/'));

      expect(instanceId).not.toBe('');
      expect(instanceId).not.toBe('DS1');
      expect(instanceId).not.toBe('U7');
      if (instanceId === '@host') continue;
      expect(result.instanceDesignators[instanceId]).toBeDefined();
    }

    // 旧键只有裸端口名，会覆盖同名器件；新键用「实例 ID/端口」。
    expect(Object.hasOwn(result.topicFinalTopics, 'latch')).toBe(false);
    expect(Object.hasOwn(result.topicFinalTopics, 'digit1')).toBe(false);
    expect(Object.hasOwn(result.topicFinalTopics, 'DS1/digit1')).toBe(false);
    expect(Object.hasOwn(result.topicFinalPorts, 'latch')).toBe(true);

    // 基准夹具读的是 src，不是 dist；浏览器核对的是 dist，两者不能直接比原始哈希。
    expect(result.fingerprints.source).toBe('src');
    expect(result.fingerprints.firmware).toBe(result.firmwareSha256);
    expect(result.fingerprints.schematic).toBe(
      createHash('sha256').update(readFileSync(SCHEMATIC_PATH)).digest('hex'),
    );
    for (const digest of [
      result.fingerprints.models,
      result.fingerprints.code,
      result.fingerprints.definitions,
    ])
      expect(digest).toMatch(/^[0-9a-f]{64}$/);

    // 八位显示（两块 4 位）在窗口内可观测，且字形全部可解码。
    for (const designator of DISPLAYS) {
      const text = displayText(result.topicFinalTopics, result, designator);
      expect(text).toHaveLength(4);
      expect(text).not.toContain('?');
    }

    // 窗口末值不是唯一对照：检查点里锁存值确实在变化。
    const series = new Set(
      result.checkpoints.map((checkpoint) => JSON.stringify(latchSeries(checkpoint))),
    );
    expect(series.size).toBeGreaterThan(1);
  }, 1_800_000);

  it('16 ms 与 64 ms 在共同仿真检查点上的显示与锁存一致', async () => {
    const fine = await measureCt107d(previewMeasureOptions({ tickMs: 16 }));
    const coarse = await measureCt107d(previewMeasureOptions({ tickMs: PREVIEW_TICK_MS }));

    expect(fine.checkpoints.map((checkpoint) => checkpoint.simMs)).toEqual(
      coarse.checkpoints.map((checkpoint) => checkpoint.simMs),
    );
    expect(fine.checkpoints.map((checkpoint) => checkpoint.simMs)).toEqual(PREVIEW_CHECKPOINTS_MS);

    const fineTraced = tracedCheckpoints(fine);
    const coarseTraced = tracedCheckpoints(coarse);

    process.stdout.write(
      `PREVIEW_COMPARE ${JSON.stringify({
        checkpointMs: fine.checkpoints.map((checkpoint) => checkpoint.simMs),
        fine: {
          tickMs: fine.tickMs,
          timing: latencySummary(fine),
          display: Object.fromEntries(
            DISPLAYS.map((designator) => [
              designator,
              fine.checkpoints.map((checkpoint) =>
                displayText(checkpoint.topics, fine, designator),
              ),
            ]),
          ),
          latches: fine.checkpoints.map((checkpoint) => latchSeries(checkpoint)),
        },
        coarse: {
          tickMs: coarse.tickMs,
          timing: latencySummary(coarse),
          display: Object.fromEntries(
            DISPLAYS.map((designator) => [
              designator,
              coarse.checkpoints.map((checkpoint) =>
                displayText(checkpoint.topics, coarse, designator),
              ),
            ]),
          ),
          latches: coarse.checkpoints.map((checkpoint) => latchSeries(checkpoint)),
        },
      })}\n`,
    );

    expect(fine.faults).toEqual([]);
    expect(coarse.faults).toEqual([]);
    expect(fine.firmwareSha256).toBe(EXPECTED_FIRMWARE_SHA256);
    expect(coarse.firmwareSha256).toBe(EXPECTED_FIRMWARE_SHA256);
    expect(fine.execution).toBe('throughput');
    expect(coarse.execution).toBe('throughput');

    // 两种批次在每个共同检查点看到同一组显示 + 锁存状态。
    expect(fineTraced).toEqual(coarseTraced);

    // 八位显示在 1024 ms 窗口内会动态进位（DS2 由 --02 变 --03），因此不要求
    // 整窗恒定；要求每个共同检查点 16/64 ms 看到同一文本，且每个字形可解码。
    const fineDisplayTexts = DISPLAYS.flatMap((designator) =>
      fine.checkpoints.map((checkpoint) => displayText(checkpoint.topics, fine, designator)),
    );

    for (const designator of DISPLAYS) {
      const fineTexts = fine.checkpoints.map((checkpoint) =>
        displayText(checkpoint.topics, fine, designator),
      );
      const coarseTexts = coarse.checkpoints.map((checkpoint) =>
        displayText(checkpoint.topics, coarse, designator),
      );

      expect(coarseTexts).toEqual(fineTexts);
      for (const text of fineTexts) {
        expect(text).toHaveLength(4);
        expect(text).not.toContain('?');
      }
    }

    // 窗口必须覆盖真实动态扫描的进位，而不是把同一帧复制 17 次。
    expect(new Set(fineDisplayTexts).size).toBeGreaterThan(1);

    // 检查点覆盖多个真实锁存状态，而不是把窗口最后值复制多次。
    expect(
      new Set(coarse.checkpoints.map((checkpoint) => JSON.stringify(latchSeries(checkpoint)))).size,
    ).toBeGreaterThan(1);
    expect(coarse.checkpoints.length).toBeGreaterThan(2);

    // 终值也必须保持唯一键；旧裸端口键只为兼容保留。
    for (const result of [fine, coarse]) {
      for (const designator of ['U6', 'U7', 'U8', 'U9'])
        expect(
          topicKeysForDesignator(result.topicFinalTopics, result, designator, 'latch').length,
        ).toBeGreaterThan(0);
      expect(
        topicKeysForDesignator(result.topicFinalTopics, result, 'DS1', 'digit1').length,
      ).toBeGreaterThan(0);
      expect(
        topicKeysForDesignator(result.topicFinalTopics, result, 'DS2', 'digit4').length,
      ).toBeGreaterThan(0);
      expect(result.topicFinalTopics['DS1/digit1']).toBeUndefined();
      expect(result.topicFinalTopics['latch']).toBeUndefined();
      expect(result.fingerprints.source).toBe('src');
    }
    expect(fine.instanceDesignators).toEqual(coarse.instanceDesignators);
    expect(fine.fingerprints).toEqual(coarse.fingerprints);
  }, 1_800_000);
});
