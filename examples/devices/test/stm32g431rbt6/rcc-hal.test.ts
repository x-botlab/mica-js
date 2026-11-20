import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLOCK_CACHE } from '@mica-js/stm32g431rbt6-core/clock-tree';
import { clockBoard } from './clock-harness';

const HAL_FIRMWARE = join(import.meta.dirname, '..', 'ili9325', 'fixtures', 'HAL_06_LCD.bin');

/**
 * 真实 HAL_06_LCD 工程：SystemClock_Config 用 HSI16 → PLL（M=2,N=20,R=2）到
 * 80 MHz。夹具属性给 80 MHz，RCC 仍必须自己算出 80 MHz 才算通过。
 *
 * 先跑 60 µs 证明 CPU 不 halt、不留下 faultPc；再推进到 200 µs 检查真实
 * SystemClock_Config 已把时钟切到 PLL 80 MHz。全程使用标准 adapter，不用合成序列。
 */
describe('HAL_06_LCD 时钟启动兼容', () => {
  it('HSI→PLL 80 MHz 启动仍可完成', async () => {
    const rig = await clockBoard({
      firmware: new Uint8Array(readFileSync(HAL_FIRMWARE)),
      // 与既有 HAL_06_LCD 基准一致：属性给 80 MHz，RCC 仍必须自己算出 80 MHz。
      clockFrequency: 80_000_000,
    });

    try {
      // 60 µs 只做 fail-fast：CPU 不得 halt，也不得留下任何 faultPc。
      rig.run(60_000_000);
      expect(rig.board.status).toBe('ready');
      expect(rig.state('halted')).toBe(false);
      expect(rig.state('faultPc')).toBe(0);

      // SystemClock_Config 远早于 200 µs；继续验证真实 HAL 启动到 80 MHz。
      rig.run(140_000_000);
      expect(rig.board.status).toBe('ready');
      expect(rig.state('halted')).toBe(false);
      expect(rig.state('faultPc')).toBe(0);
      expect(rig.readPeriph(CLOCK_CACHE.epoch)).toBeGreaterThan(0);
      expect(rig.readPeriph(CLOCK_CACHE.sysHz)).toBe(80_000_000);
      expect(rig.readPeriph(CLOCK_CACHE.hclkHz)).toBe(80_000_000);
      expect(rig.readPeriph(CLOCK_CACHE.pclk1Hz)).toBe(80_000_000);
      expect(rig.readPeriph(CLOCK_CACHE.pclk2Hz)).toBe(80_000_000);
      expect(rig.readPeriph(CLOCK_CACHE.sws)).toBe(3);
    } finally {
      rig.dispose();
    }
  });
});
