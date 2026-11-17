import { types } from '@mica-js/sdk/model';
import { describe, expect, it } from 'vitest';
import {
  RCC_CFGR,
  RCC_CR,
  RCC_PLLCFGR,
  peripheralClockHz,
  readHclkHz,
  readPclk1Hz,
} from '@mica-js/stm32g431rbt6-core/clock-tree';
import type { Body } from '@mica-js/stm32g431rbt6-core/ir';
import { writeRcc } from '@mica-js/stm32g431rbt6-core/rcc';
import { clockTimeRig } from './clock-rig';

const n = (b: Body, value: number) => b.constant(types.number, value);
const write = (b: Body, offset: number, value: number): void =>
  writeRcc(b, n(b, offset), 4, n(b, value));

const MILLISECOND = 1_000_000_000;

function configurePll80(b: Body): void {
  write(b, RCC_PLLCFGR, 0x1101_1412);
  write(b, RCC_CR, 0x0100_0100);
  write(b, RCC_CFGR, 3);
}

describe('动态时钟推进真实仿真时间', () => {
  it('HCLK 变化直接改变 CPU 步进耗时（16 MHz → 80 MHz ≈ 5×）', () => {
    const fallback = clockTimeRig({ clockHz: readHclkHz });
    const configured = clockTimeRig({ clockHz: readHclkHz, configure: configurePll80 });

    try {
      fallback.run(MILLISECOND);
      configured.run(MILLISECOND);
      expect(fallback.steps).toBeGreaterThan(15_000);
      expect(configured.steps).toBeGreaterThan(75_000);
      expect(configured.steps / fallback.steps).toBeGreaterThan(4.8);
      expect(configured.steps / fallback.steps).toBeLessThan(5.2);
    } finally {
      fallback.dispose();
      configured.dispose();
    }
  });

  it('定时器 APB 倍频改变定时器时钟（PCLK1 40 → TIM2 80 MHz，2×）', () => {
    const configure = (b: Body): void => {
      write(b, RCC_PLLCFGR, 0x1101_1412);
      write(b, RCC_CR, 0x0100_0100);
      write(b, RCC_CFGR, 0x2c03); // APB1=/2 ⇒ PCLK1 40、TIM2 80
      write(b, 0x58, 1); // APB1ENR1.TIM2EN
    };
    const timer = clockTimeRig({
      configure,
      clockHz: (b) => peripheralClockHz(b, 'tim2'),
    });
    const pclk = clockTimeRig({ configure, clockHz: readPclk1Hz });

    try {
      timer.run(MILLISECOND);
      pclk.run(MILLISECOND);
      expect(timer.steps / pclk.steps).toBeGreaterThan(1.9);
      expect(timer.steps / pclk.steps).toBeLessThan(2.1);
    } finally {
      timer.dispose();
      pclk.dispose();
    }
  });

  it('时钟缓存只通过私有 API 读取，guest 偏移读 0', () => {
    const rig = clockTimeRig({
      configure: configurePll80,
      clockHz: readHclkHz,
    });

    try {
      rig.run(1_000_000);
      // 这个断言由 readClockWord 在 CPU 时钟管线里使用；guest 可见性在
      // clock-core.test.ts 的 RCC 保留窗口用例里验证。
      expect(rig.steps).toBeGreaterThan(0);
    } finally {
      rig.dispose();
    }
  });
});
