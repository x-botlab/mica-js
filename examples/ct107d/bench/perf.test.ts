import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEMO_CLOCK_FREQUENCY, measureCt107d } from './measure';
import { PREVIEW_CHECKPOINTS_MS, previewMeasureOptions } from './preview';

/**
 * CT107D 融合整板基准：直接从正式 `device/dist` 装载 1 实例/1 JIT；固件是
 * `assets/ct107d-demo.bin`（12 MHz 8051，8 位数码管全亮 + 8 路 LED 走马灯），
 * 读数取进程 CPU 时间。
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
    expect(result.clockFrequency).toBe(DEMO_CLOCK_FREQUENCY);
    expect(result.devices).toBe(1);
    expect(result.instances).toBe(1);
    expect(result.jits).toBe(1);
    expect(result.nets).toBe(2);
    expect(result.simMs).toBeGreaterThan(0);
    expect(result.cpuMs).toBeGreaterThan(0);
    expect(result.elapsedWallMs).toBeGreaterThan(0);
    expect(result.realtimeRatio).toBeGreaterThan(0);
    // 历史字段仍是 CPU 口径的别名，新字段才是墙钟/实时比。
    expect(result.wallMs).toBe(result.cpuMs);
    expect(result.rtf).toBeCloseTo(result.cpuMs / result.simMs, 2);

    // 融合板没有板内电气网络；工作量为 JIT 指令、边界、话题与显示事件。
    expect(result.solves).toBe(0);
    expect(result.usPerSolve).toBe(0);
    // The two external rails are still a trivial two-component network.
    expect(result.components).toBeLessThanOrEqual(2);
    expect(result.unavailable.solves).toContain('内部槽');
    expect(result.boundaryCalls).toBeGreaterThan(0);
    expect(result.publishCalls).toBeGreaterThan(0);
    expect(result.electricalPublishes).toBe(0);
    expect(result.topicMessages).toBeGreaterThan(0);
    expect(result.direct).toBe(true);
    expect(result.directCalls).toBeGreaterThan(0);
    expect(result.fallbackRate).toBeGreaterThanOrEqual(0);
    expect(result.fallbackRate).toBeLessThanOrEqual(1);
    expect(result.directFallbackPcs).toBeNull();
    expect(result.unavailable.directFallbackPcs).toContain('不公开');
    expect(result.directFallbacksExhausted).toBe(false);

    expect(result.topicDigest).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(result.topicDigest).not.toBe(EMPTY_DIGEST);
    expect(result.topicFinalDigest).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(result.topicFinalDigest).not.toBe(EMPTY_DIGEST);
    // 同一轮里跑 3 次，摘要必须完全一致：这是「行为不变」对照值的前提。
    expect(result.topicDigestStable).toBe(true);

    // 固定工作量：演示固件把两片数码管全部点亮，并让至少一颗 LED 处于点亮状态。
    for (const designator of ['DS1', 'DS2'])
      for (let index = 1; index <= 4; index += 1)
        expect(result.topicFinalTopics[`${designator}/digit${index}`]).toBe('255');
    const litLed = Object.entries(result.topicFinalTopics).find(
      ([key, value]) => /^D\d\/brightness$/.test(key) && Number(value) > 0.1,
    );
    expect(litLed, 'at least one LED is on').toBeDefined();
    const litDesignator = litLed![0].split('/')[0]!;
    expect(Number(result.topicFinalTopics[`${litDesignator}/voltage`])).toBeGreaterThan(4.5);
    expect(Number(result.topicFinalTopics[`${litDesignator}/current`])).toBeGreaterThan(0);
    for (const designator of ['U6', 'U7', 'U8', 'U9'])
      expect(result.topicFinalTopics[`${designator}/latch`]).toBeDefined();

    // Explicit props remain authoritative over the demo's 12 MHz default.
    const custom = await measureCt107d({
      props: { clockFrequency: 11_059_200 },
      warmUpMs: 0,
      measureMs: 1,
      rounds: 1,
    });
    expect(custom.clockFrequency).toBe(11_059_200);
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
    // 同名端口不再互相覆盖：四个 573 的 latch 通过显式位号同时存在。
    for (const designator of ['U6', 'U7', 'U8', 'U9'])
      expect(throughput.topicFinalTopics[`${designator}/latch`]).toBeDefined();
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
