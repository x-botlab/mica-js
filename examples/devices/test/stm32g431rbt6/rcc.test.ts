import { describe, expect, it } from 'vitest';
import { CLOCK_CACHE, HSI_HZ, LSE_DEFAULT_HZ } from '@mica-js/stm32g431rbt6-core/clock-tree';
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

const sramWord = (bytes: Uint8Array, offset: number): number => word(bytes, offset);

describe('RCC 时钟树', () => {
  it('从 HSI 配置 PLL 80 MHz，并缓存 AHB/APB/定时器/外设时钟', async () => {
    const rig = await clockBoard({
      firmware: firmware('rcc-pll.bin'),
      clockFrequency: 16_000_000,
    });

    try {
      rig.run(5_000_000_000);
      expect(rig.state('halted')).toBe(false);
      expect(rig.readPeriph(CLOCK_CACHE.epoch)).toBeGreaterThan(0);
      expect(rig.readPeriph(CLOCK_CACHE.sysHz)).toBe(80_000_000);
      expect(rig.readPeriph(CLOCK_CACHE.hclkHz)).toBe(80_000_000);
      expect(rig.readPeriph(CLOCK_CACHE.pclk1Hz)).toBe(40_000_000);
      expect(rig.readPeriph(CLOCK_CACHE.pclk2Hz)).toBe(20_000_000);
      // APB1 /2 与 APB2 /4 都会触发定时器倍频。
      expect(rig.readPeriph(CLOCK_CACHE.timApb1Hz)).toBe(80_000_000);
      expect(rig.readPeriph(CLOCK_CACHE.timApb2Hz)).toBe(40_000_000);
      expect(rig.readPeriph(CLOCK_CACHE.usart1Hz)).toBe(80_000_000);
      expect(rig.readPeriph(CLOCK_CACHE.usart2Hz)).toBe(HSI_HZ);
      expect(rig.readPeriph(CLOCK_CACHE.usart3Hz)).toBe(LSE_DEFAULT_HZ);
      expect(rig.readPeriph(CLOCK_CACHE.i2c1Hz)).toBe(80_000_000);
      expect(rig.readPeriph(CLOCK_CACHE.i2c2Hz)).toBe(HSI_HZ);
      expect(rig.readPeriph(CLOCK_CACHE.i2c3Hz)).toBe(0);
      expect(rig.readPeriph(CLOCK_CACHE.adc12Hz)).toBe(80_000_000);
      expect(rig.readPeriph(CLOCK_CACHE.pllVcoHz)).toBe(160_000_000);
      expect(rig.readPeriph(CLOCK_CACHE.sws)).toBe(3);
    } finally {
      rig.dispose();
    }
  });

  it('非法 PLL 不置 ready，SWS 保持 HSI', async () => {
    const rig = await clockBoard({
      firmware: firmware('rcc-invalid.bin'),
      clockFrequency: 16_000_000,
    });

    try {
      rig.run(5_000_000_000);
      const cr = sramWord(rig.memory('sram'), 0);
      const cfgr = sramWord(rig.memory('sram'), 4);

      expect(cr & (1 << 25)).toBe(0); // PLLRDY
      expect(cr & (1 << 10)).not.toBe(0); // HSIRDY
      expect(cfgr & 3).toBe(3); // 请求的是 PLL
      expect((cfgr >>> 2) & 3).toBe(0); // 实际仍是 HSI
      expect(rig.readPeriph(CLOCK_CACHE.sysHz)).toBe(HSI_HZ);
      expect(rig.readPeriph(CLOCK_CACHE.sws)).toBe(0);
      expect(rig.readPeriph(CLOCK_CACHE.pllVcoHz)).toBe(0);
    } finally {
      rig.dispose();
    }
  });

  it('目标源未就绪时只记录 SW，不切换 SWS', async () => {
    const rig = await clockBoard({
      firmware: firmware('rcc-switch.bin'),
      clockFrequency: 16_000_000,
    });

    try {
      rig.run(5_000_000_000);
      const cfgr = sramWord(rig.memory('sram'), 0);
      const cr = sramWord(rig.memory('sram'), 4);

      expect(cfgr & 3).toBe(3);
      expect((cfgr >>> 2) & 3).toBe(0);
      expect(cr & (1 << 17)).toBe(0); // HSERDY：未提供晶振
      expect(rig.readPeriph(CLOCK_CACHE.sysHz)).toBe(HSI_HZ);
      expect(rig.readPeriph(CLOCK_CACHE.sws)).toBe(0);
    } finally {
      rig.dispose();
    }
  });

  it('USART/GPIO 复位位会清外设寄存器与发送状态', async () => {
    const rig = await clockBoard({
      firmware: firmware('rcc-reset.bin'),
      clockFrequency: 16_000_000,
      pins: ['PA5'],
    });

    try {
      rig.run(20_000_000_000);
      expect(rig.readSram(0)).toBe(0); // USART2 CR1 after reset
      expect(rig.readSram(4)).toBe(0); // GPIOA MODER after reset
      expect(rig.readPeriph(0x300 + 0x40)).toBe(0); // USART2 CR1 backing
      expect(rig.state('tx2Active')).toBe(0);
      expect(rig.state('txMask')).toBe(0);
      expect(rig.state('gpioModer0')).toBe(0);
      expect(rig.state('gpioOdr0')).toBe(0);
      const pa5 = rig.transitions.PA5 ?? [];
      const last = pa5[pa5.length - 1];

      expect(last?.value).not.toBe(1);
    } finally {
      rig.dispose();
    }
  });
});
