import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { measureCt107d } from './measure';
import { PREVIEW_CHECKPOINTS_MS, previewMeasureOptions } from './preview';

/**
 * CT107D 整板基准：51 颗器件按 `ct107d.sch` 装配，固件是 `assets/ct107d-demo.bin`
 * （12 MHz 8051，8 位数码管全亮 + 8 路 LED 走马灯），读数取进程 CPU 时间。
 *
 * 断言只做下限与宽松区间：并行任务与 CI 都在抢 CPU，精确值没有意义，这里守住的是
 * 「字段齐全、板能跑完、行为摘要稳定且对行为敏感」。读数含义见 `README.md` 的「基准」。
 */

/** 空话题流（消息数为 0）的摘要，用来确认演示固件确实产生了可观测输出。 */
const EMPTY_DIGEST = 'sha256:e3b0c44298fc1c14';

let demoDigest = '';

describe('CT107D 整板基准', () => {
  it('ct107d-demo：12 MHz 扫描 8 位数码管与 8 路 LED', async () => {
    const result = await measureCt107d();

    demoDigest = result.topicDigest;
    appendFileSync(join(import.meta.dirname, 'results.jsonl'), `${JSON.stringify(result)}\n`);
    // 写 stdout 而不是 console.log：vitest 只在用例失败时才回显 console 输出。
    process.stdout.write(`PERF ${JSON.stringify(result)}\n`);

    expect(result.faults).toEqual([]);
    expect(result.devices).toBeGreaterThanOrEqual(40);
    expect(result.simMs).toBeGreaterThan(0);
    expect(result.cpuMs).toBeGreaterThan(0);
    expect(result.elapsedWallMs).toBeGreaterThan(0);
    expect(result.realtimeRatio).toBeGreaterThan(0);
    // 历史字段仍是 CPU 口径的别名，新字段才是墙钟/实时比。
    expect(result.wallMs).toBe(result.cpuMs);
    expect(result.rtf).toBeCloseTo(result.cpuMs / result.simMs, 2);

    expect(result.solves).toBeGreaterThan(100);
    expect(result.components).toBeGreaterThan(0);
    expect(result.usPerSolve).toBeGreaterThan(0);

    expect(result.boundaryCalls).toBeGreaterThan(0);
    expect(result.publishCalls).toBeGreaterThan(0);
    expect(result.electricalPublishes).toBeGreaterThan(0);
    expect(result.dirtySlots).toBeGreaterThan(0);

    expect(result.topicDigest).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(result.topicDigest).not.toBe(EMPTY_DIGEST);
    expect(result.topicFinalDigest).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(result.topicFinalDigest).not.toBe(EMPTY_DIGEST);
    // 同一轮里跑 3 次，摘要必须完全一致：这是「行为不变」对照值的前提。
    expect(result.topicDigestStable).toBe(true);
  }, 1_800_000);

  it('throughput preserves outputs and outpaces precise execution', async () => {
    const throughput = await measureCt107d({ execution: 'throughput' });
    const precise = await measureCt107d({ execution: 'precise' });

    process.stdout.write(
      `PERF_COMPARE ${JSON.stringify({
        throughput: { wallMs: throughput.wallMs, boundaryCalls: throughput.boundaryCalls },
        precise: { wallMs: precise.wallMs, boundaryCalls: precise.boundaryCalls },
      })}\n`,
    );

    expect(throughput.faults).toEqual(precise.faults);
    expect(throughput.topicDigest).toBe(precise.topicDigest);
    expect(throughput.topicFinalDigest).toBe(precise.topicFinalDigest);
    expect(throughput.topicDigestStable).toBe(true);
    expect(precise.topicDigestStable).toBe(true);
    expect(throughput.boundaryCalls).toBeLessThan(precise.boundaryCalls * 0.1);
    expect(throughput.wallMs).toBeLessThan(precise.wallMs * 0.75);
  }, 1_800_000);

  it('preview firmware preserves outputs and accelerates in throughput mode', async () => {
    const throughput = await measureCt107d(previewMeasureOptions({ tickMs: 16 }));
    const precise = await measureCt107d(
      previewMeasureOptions({ tickMs: 16, execution: 'precise' }),
    );
    const coarse = await measureCt107d(previewMeasureOptions({ tickMs: 64 }));

    process.stdout.write(
      `PREVIEW_FIRMWARE ${JSON.stringify({
        throughput: {
          cpuMs: throughput.cpuMs,
          elapsedWallMs: throughput.elapsedWallMs,
          realtimeRatio: throughput.realtimeRatio,
          direct: throughput.direct,
          directCalls: throughput.directCalls,
          cachedInstructions: throughput.cachedInstructions,
          directFallbackPcs: throughput.directFallbackPcs,
        },
        precise: { cpuMs: precise.cpuMs, elapsedWallMs: precise.elapsedWallMs },
        coarse: { cpuMs: coarse.cpuMs, elapsedWallMs: coarse.elapsedWallMs },
        topicFinalDigest: throughput.topicFinalDigest,
        topicFinalDigestByDevice: throughput.topicFinalDigestByDevice,
        checkpoints: PREVIEW_CHECKPOINTS_MS,
      })}\n`,
    );

    expect(throughput.faults).toEqual(precise.faults);
    expect(throughput.topicFinalDigest).toBe(precise.topicFinalDigest);
    expect(throughput.topicFinalDigestByDevice).toBe(precise.topicFinalDigestByDevice);
    expect(throughput.topicFinalTopics).toEqual(precise.topicFinalTopics);
    expect(throughput.topicFinalTopics).toEqual(coarse.topicFinalTopics);
    expect(throughput.topicDigestStable).toBe(true);
    expect(precise.topicDigestStable).toBe(true);
    expect(coarse.topicDigestStable).toBe(true);
    expect(throughput.checkpointsStable).toBe(true);
    expect(precise.checkpointsStable).toBe(true);
    expect(coarse.checkpointsStable).toBe(true);
    expect(throughput.execution).toBe('throughput');
    expect(precise.execution).toBe('precise');
    expect(throughput.direct).toBe(true);
    expect(throughput.directCalls).toBeGreaterThan(0);
    expect(throughput.cpuMs).toBeLessThan(precise.cpuMs * 0.75);
    // 同名端口不再互相覆盖：四个 573 的 latch 同时存在。唯一键是「实例 ID/端口」，
    // 位号只作辅助定位。
    for (const designator of ['U6', 'U7', 'U8', 'U9']) {
      const instanceId = Object.entries(throughput.instanceDesignators).find(
        ([, value]) => value === designator,
      )?.[0];

      expect(instanceId).toBeDefined();
      expect(throughput.topicFinalTopics[`${instanceId}/latch`]).toBeDefined();
    }
  }, 1_800_000);

  it('空转固件：行为摘要与演示固件不同', async () => {
    // `SJMP $`：整板只在装配期求解一次，窗口内几乎没有话题消息。
    const idle = await measureCt107d({
      firmware: Uint8Array.from([0x80, 0xfe]),
      warmUpMs: 10,
      measureMs: 50,
      rounds: 1,
    });

    process.stdout.write(`PERF ${JSON.stringify(idle)}\n`);

    expect(idle.faults).toEqual([]);
    expect(idle.topicDigest).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(idle.topicDigest).not.toBe(demoDigest);
  }, 1_800_000);
});
