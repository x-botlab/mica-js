import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFusedCt107dBoard } from '../bench/fused';
import { assemble } from './fixtures/8051/assemble';

/**
 * CT107D 独立频率回归：真实 fused NE555 + J3 闭合 + 1 s T0 门控。
 *
 * 固件见 `fixtures/8051/frequency-gate.asm`：T1 每 100 µs 中断一次，第 10000 次
 * 中断时把 T0 的下降沿计数写入 IRAM 0x33/0x34。NE555 的器件级频率是
 * 4810.00481000481 Hz（rA=rB=10k、c=10nF，tHigh=138.6 µs、tLow=69.3 µs）。
 *
 * 这里验证的是固件门控计数与完成时刻上界的一致性，而不是拿 4810 反推一个期望后
 * 修改定时器常量：
 * - 修复前每次中断入口少记 2 个系统时钟，10000 次中断把完成时刻拉长约 1.667 ms，
 *   计数约为 4818；
 * - 修复后完成时刻回到约 1 s，计数应为 NE555 在约 1 s 内的 4809/4810。
 *
 * 注意：`captureMs` 是复位启动到测试轮询发现 done 的绝对时刻，不是 TR0 开门→
 * 关门的精确门宽。它包含启动设置、最后一次 ISR 的采样/停表指令和 0.5 ms 轮询
 * 粒度；因此这里只把它当作“完成时刻上界近似 1 s”的辅助判据，主判据仍是 T0 的
 * 下降沿计数。修复前约 1002 ms，修复后约 1000–1000.6 ms；1001 ms 只用于区分
 * 是否多出了约 1.67 ms，而不是声称精确测到了门宽。
 */
const FIRMWARE = join(import.meta.dirname, 'fixtures', '8051', 'frequency-gate.asm');
const CLOCK_HZ = 12_000_000;
const POLL_PS = 500_000_000;
const LIMIT_PS = 1_050_000_000_000;

interface FrequencySnapshot {
  readonly ne555: { readonly frequency: number; readonly dutyCycle: number };
}

async function runFrequency(execution: 'throughput' | 'precise'): Promise<{
  readonly count: number;
  readonly captureMs: number;
  readonly frequency: number;
  readonly dutyCycle: number;
  readonly faults: readonly string[];
}> {
  const fused = await createFusedCt107dBoard({
    firmware: assemble(readFileSync(FIRMWARE, 'utf8')),
    props: { clockFrequency: CLOCK_HZ },
    execution,
  });

  try {
    fused.methods.setJumper!({ designator: 'J3', closed: true });
    const runtime = fused.board as unknown as {
      readonly instances: readonly {
        readonly memories?: ReadonlyMap<string, Uint8Array>;
      }[];
    };
    const iram = runtime.instances[0]?.memories?.get('iram');

    if (iram === undefined) throw new Error('frequency-gate: missing iram memory');

    let capturePs = 0;
    for (let target = POLL_PS; target <= LIMIT_PS; target += POLL_PS) {
      fused.board.runUntil(target);
      if (iram[0x32] === 1) {
        capturePs = fused.board.time;
        break;
      }
    }
    if (capturePs === 0) throw new Error('frequency-gate: no capture within 1.05 s');

    const snapshot = fused.methods.getSnapshot!(null) as FrequencySnapshot;

    return {
      count: iram[0x33]! | (iram[0x34]! << 8),
      captureMs: capturePs / 1e9,
      frequency: snapshot.ne555.frequency,
      dutyCycle: snapshot.ne555.dutyCycle,
      faults: [...fused.faults],
    };
  } finally {
    fused.dispose();
  }
}

describe('CT107D 独立频率门控', () => {
  for (const execution of ['throughput', 'precise'] as const) {
    it(`${execution}：真实 NE555 1 s 门控计数为 4809/4810，完成时刻上界约 1 s`, async () => {
      const result = await runFrequency(execution);

      expect(result.faults).toEqual([]);
      // NE555 源本身独立于门控缺陷；它必须仍是 4810.0048 Hz，而不是 4818。
      expect(result.frequency).toBeCloseTo(4810.00481000481, 9);
      expect(result.dutyCycle).toBeCloseTo(66.66666666666666, 9);
      expect(result.count).toBeGreaterThanOrEqual(4809);
      expect(result.count).toBeLessThanOrEqual(4810);
      // captureMs 是启动到轮询发现 done 的绝对时刻，不是精确门宽；它包含启动设置、
      // 最后 ISR 的采样/停表和 0.5 ms 轮询。修复前约 1002 ms；修复后约
      // 1000–1000.6 ms。这里只证明没有多出的约 1.67 ms 门宽拉伸。
      expect(result.captureMs).toBeGreaterThan(999);
      expect(result.captureMs).toBeLessThan(1001);
    });
  }
});
