import { describe, expect, it } from 'vitest';
import { measureHal } from './hal-bench';

/**
 * 主路径：`execution: 'throughput'`（直接后端，板级默认模式）。
 *
 * 单独成文件，让器件的翻译缓存从这个固件的冷启动开始计数。
 */
describe('HAL_06_LCD 裸 MCU、80 MHz、throughput', () => {
  it('0 → 200 µs 冷启动 + 200 µs → 220 ms 稳态', () => {
    const sample = measureHal('throughput');

    console.log('HAL', JSON.stringify({ firmware: 'HAL_06_LCD', ...sample }));
    expect(sample.direct).toBe(true);
    expect(sample.programs).toBeGreaterThan(0);
    expect(sample.blocks).toBeGreaterThan(0);
  }, 900_000);
});
