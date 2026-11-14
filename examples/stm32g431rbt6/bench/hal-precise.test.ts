import { describe, expect, it } from 'vitest';
import { measureHal } from './hal-bench';

/**
 * 对照：`execution: 'precise'`（逐指令调度，用于需要精确时序的场景）。
 *
 * 单独成文件，避免被 throughput 那一轮焐热的翻译缓存抬高读数。
 */
describe('HAL_06_LCD 裸 MCU、80 MHz、precise', () => {
  it('0 → 200 µs 冷启动 + 200 µs → 220 ms 稳态 + 220 → 440 ms 无重建稳态', () => {
    const sample = measureHal('precise');

    console.log('HAL', JSON.stringify({ firmware: 'HAL_06_LCD', ...sample }));
    expect(sample.direct).toBe(false);
    expect(sample.blocks).toBeGreaterThan(0);
  }, 900_000);
});
