import { describe, expect, it } from 'vitest';
import { CLOCK_CACHE } from '@mica-js/stm32g431rbt6-core/clock-tree';
import { clockBoard } from './clock-harness';
import { firmware } from './harness';

/**
 * 真实器件上的 USART 位时长：固件先把 BRR 写成 0x22B（16 MHz 下 34.6875 µs），
 * 再切 PLL 80 MHz，并把 USART2SEL 在 PCLK1 与 HSI16 之间来回切。最后状态是
 * PCLK1(80 MHz)，因此 tx2Period 必须变成 6.9375 µs；仅看 cache Hz 不算通过。
 */
describe('真实器件 USART 位时长', () => {
  it('RCC/CCIPR 变化后 tx2Period 与发送字节都更新', async () => {
    const rig = await clockBoard({
      firmware: firmware('clock-usart.bin'),
      clockFrequency: 16_000_000,
      pins: ['PA2'],
      execution: 'throughput',
    });

    try {
      rig.run(5_000_000_000);
      expect(rig.readPeriph(CLOCK_CACHE.sysHz)).toBe(80_000_000);
      expect(rig.readPeriph(CLOCK_CACHE.hclkHz)).toBe(80_000_000);
      expect(rig.readPeriph(CLOCK_CACHE.pclk1Hz)).toBe(80_000_000);
      expect(rig.readPeriph(CLOCK_CACHE.usart2Hz)).toBe(80_000_000);
      expect(rig.state('tx2Period')).toBe(6_937_500);
      expect(
        (rig.topics['serial2.tx'] as Uint8Array[] | undefined)?.flatMap((bytes) => [...bytes]),
      ).toEqual([0xff, 0xff, 0xff, 0xff]);
    } finally {
      rig.dispose();
    }
  });
});
