import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { measureCt107d } from './measure';

/**
 * CT107D 整板基准：44 颗器件按 `ct107d.sch` 装配，固件是 `assets/ct107d-demo.bin`
 * （1 MHz 8051，8 位数码管逐位扫描 + 8 路 LED 走马灯），读数取进程 CPU 时间。
 *
 * 断言只做下限与宽松区间：并行任务与 CI 都在抢 CPU，精确值没有意义，这里守住的是
 * 「字段齐全、板能跑完、行为摘要稳定且对行为敏感」。读数含义见 `README.md` 的「基准」。
 */

/** 空话题流（消息数为 0）的摘要，用来确认演示固件确实产生了可观测输出。 */
const EMPTY_DIGEST = 'sha256:e3b0c44298fc1c14';

let demoDigest = '';

describe('CT107D 整板基准', () => {
  it('ct107d-demo：1 MHz 扫描 8 位数码管与 8 路 LED', async () => {
    const result = await measureCt107d();

    demoDigest = result.topicDigest;
    appendFileSync(join(import.meta.dirname, 'results.jsonl'), `${JSON.stringify(result)}\n`);
    // 写 stdout 而不是 console.log：vitest 只在用例失败时才回显 console 输出。
    process.stdout.write(`PERF ${JSON.stringify(result)}\n`);

    expect(result.faults).toEqual([]);
    expect(result.devices).toBeGreaterThanOrEqual(40);
    expect(result.simMs).toBeGreaterThan(0);
    expect(result.wallMs).toBeGreaterThan(0);
    // 只守一个下限：读数异常到接近 0 说明测量本身坏了，而不是「变得很快」。
    expect(result.rtf).toBeGreaterThan(0.05);
    expect(result.rtf).toBeLessThan(50);

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
