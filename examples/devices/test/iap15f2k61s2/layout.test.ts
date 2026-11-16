import { describe, expect, it } from 'vitest';
import {
  CLOCK_BASE,
  EXTINT_BASE,
  PERIPHERAL_REGIONS,
  PERIPH_SIZE,
} from '../../src/devices/iap15f2k61s2/peripherals/layout.ts';

/**
 * `periph` 布局回归。
 *
 * 之前外部中断的 LEVEL(4)（P3_0 采样电平）落在 0x90，与时钟模块的 LOW_VOLTAGE 共用
 * 同一字节：只要 P3_0 起始为高，时钟就会永久认为自己处于低压，`clock.active()` 让
 * BUSY 常真，直接挡住定时器期限快路径。这里把区间声明集中到 layout.ts 并逐段校验。
 */
describe('periph 布局', () => {
  it('各外设区间不重叠且落在 PERIPH_SIZE 内', () => {
    const sorted = [...PERIPHERAL_REGIONS].sort((left, right) => left.start - right.start);
    let previousEnd = -1;

    for (const region of sorted) {
      expect(region.start, `${region.name} 起点越界`).toBeGreaterThanOrEqual(0);
      expect(region.end, `${region.name} 终点越界`).toBeLessThan(PERIPH_SIZE);
      expect(region.start, `${region.name} 与前一区间重叠`).toBeGreaterThan(previousEnd);
      expect(region.end, `${region.name} 区间为空`).toBeGreaterThanOrEqual(region.start);
      previousEnd = region.end;
    }
  });

  it('时钟区与外部中断区完全分离', () => {
    const extint = PERIPHERAL_REGIONS.find((region) => region.name === 'extint');
    const clock = PERIPHERAL_REGIONS.find((region) => region.name === 'clock');

    expect(extint).toBeDefined();
    expect(clock).toBeDefined();
    expect(clock!.start).toBeGreaterThan(extint!.end);
    expect(clock!.start).toBe(CLOCK_BASE);
    expect(EXTINT_BASE).toBeLessThanOrEqual(extint!.end);
  });
});
