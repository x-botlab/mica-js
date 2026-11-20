import { describe, expect, it } from 'vitest';
import { CLOCK_CACHE } from '@mica-js/stm32g431rbt6-core/clock-tree';
import { clockBoard } from './clock-harness';
import { firmware } from './harness';

function word(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  );
}

/**
 * 真实器件同进程双板：同一固件、同一 cyclePs，仅 HSE 配置不同。
 *
 * 这个用例专门防止 JIT service 块缓存只按 `cyclePs:pc:bytes` 命中：如果中央没有把
 * `clockConfigKey()`（profile + fallback/hse/lse/lsi）纳入缓存键，先跑的 HSE=0
 * 板会让后跑的 HSE=24 MHz 板复用「HSE 不可用」的 service IR，B 板会错误停在
 * 16 MHz。需要中央先在 DDL/Machine 声明 `hseFrequency`，因此当前 skip；接口落地
 * 后去掉 `.skip`，不允许用合成 rig 替代。
 */
describe('真实器件 HSE 双板隔离', () => {
  it('同进程 HSE=0 与 HSE=24 MHz 两块 MCU 互不污染', async () => {
    const noHse = await clockBoard({
      firmware: firmware('rcc-hse.bin'),
      clockFrequency: 16_000_000,
      hseFrequency: 0,
    });
    const withHse = await clockBoard({
      firmware: firmware('rcc-hse.bin'),
      clockFrequency: 16_000_000,
      hseFrequency: 24_000_000,
    });

    try {
      // 先跑无晶振板，再跑有晶振板，最后复核第一块仍未被改写。
      noHse.run(5_000_000_000);
      withHse.run(5_000_000_000);
      expect(noHse.readPeriph(CLOCK_CACHE.sysHz)).toBe(16_000_000);
      expect(noHse.readPeriph(CLOCK_CACHE.sws)).toBe(0);
      expect(withHse.readPeriph(CLOCK_CACHE.sysHz)).toBe(80_000_000);
      expect(withHse.readPeriph(CLOCK_CACHE.sws)).toBe(3);
      expect(noHse.readPeriph(CLOCK_CACHE.sysHz)).toBe(16_000_000);

      const noCr = word(noHse.memory('sram'), 0);
      const yesCr = word(withHse.memory('sram'), 0);

      expect(noCr & (1 << 17)).toBe(0); // 无 HSE
      expect(yesCr & (1 << 17)).not.toBe(0);
      expect(yesCr & (1 << 25)).not.toBe(0); // PLL 锁定
    } finally {
      noHse.dispose();
      withHse.dispose();
    }
  });
});
