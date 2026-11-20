import { expect, it } from 'vitest';
import { types } from '@mica-js/sdk/model';
import { writeWordAt } from '@mica-js/stm32g431rbt6-core/ir';
import type { Body } from '@mica-js/stm32g431rbt6-core/ir';
import {
  CLOCK_CACHE,
  RCC_APB1ENR1,
  RCC_CFGR,
  RCC_CR,
  RCC_PLLCFGR,
} from '@mica-js/stm32g431rbt6-core/clock-tree';
import { writeRcc } from '@mica-js/stm32g431rbt6-core/rcc';
import { spiNextDeadlinePs, spiRequestedTickPs } from '@mica-js/stm32g431rbt6-core/spi';
import { i2cRequestedTickPs } from '@mica-js/stm32g431rbt6-core/i2c';
import {
  SPI_CR1,
  SPI_F_FRACTION,
  SPI_F_PHASE,
  SPI_F_REMAINING,
  SPI_INTERNAL_OFFSET,
  SPI_STATE,
  SPI_STATE_STRIDE,
} from '@mica-js/stm32g431rbt6-core/spi-layout';
import {
  I2C_F_HIGH_PS,
  I2C_F_LOW_PS,
  I2C_F_PHASE,
  I2C_INTERNAL_OFFSET,
  I2C_STATE,
  I2C_STATE_STRIDE,
} from '@mica-js/stm32g431rbt6-core/i2c-layout';
import { clockRig } from './clock-rig';

const n = (b: Body, value: number) => b.constant(types.number, value);
const write = (b: Body, memory: string, offset: number, value: number): void =>
  writeWordAt(b, memory, offset, n(b, value));

function word(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  );
}

function configure(b: Body): void {
  // PLL 80 MHz, APB1=/2 => PCLK1 40 MHz, APB2=/4 => PCLK2 20 MHz.
  writeRcc(b, n(b, RCC_PLLCFGR), 4, n(b, 0x1101_1412));
  writeRcc(b, n(b, RCC_CR), 4, n(b, 0x0100_0100));
  writeRcc(b, n(b, RCC_CFGR), 4, n(b, 0x2c03));
  writeRcc(b, n(b, RCC_APB1ENR1), 4, n(b, 1 << 14)); // SPI2EN

  const spiInternal = SPI_STATE + SPI_STATE_STRIDE + SPI_INTERNAL_OFFSET;
  const i2cInternal = I2C_STATE + I2C_STATE_STRIDE + I2C_INTERNAL_OFFSET;

  // SPI2: SPE|MSTR, BR=0, active phase; PCLK1 40 MHz / 2 => half 25 ns.
  write(b, 'spi', spiInternal + SPI_CR1, (1 << 6) | (1 << 2));
  write(b, 'spi', spiInternal + SPI_F_PHASE, 1);
  // 切换后新帧的半周期：0 core cycles + 25 ns fraction。
  write(b, 'spi', spiInternal + SPI_F_REMAINING, 0);
  write(b, 'spi', spiInternal + SPI_F_FRACTION, 25_000);
  // I2C2: active phase with low/high = 25 ns.
  write(b, 'i2c', i2cInternal + I2C_F_PHASE, 1);
  write(b, 'i2c', i2cInternal + I2C_F_LOW_PS, 25_000);
  write(b, 'i2c', i2cInternal + I2C_F_HIGH_PS, 25_000);

  b.writeState('o0', spiRequestedTickPs(b));
  b.writeState('o1', i2cRequestedTickPs(b));
  b.writeState('o2', spiNextDeadlinePs(b));
}

function measure(dynamicClock: boolean): {
  readonly spi: number;
  readonly i2c: number;
  readonly spiDeadline: number;
  readonly hclkHz: number;
  readonly pclk1Hz: number;
  readonly pclk2Hz: number;
} {
  const rig = clockRig({ dynamicClock, emit: configure });

  try {
    rig.run(1);

    return {
      spi: rig.states.get('o0') as number,
      i2c: rig.states.get('o1') as number,
      spiDeadline: rig.states.get('o2') as number,
      hclkHz: word(rig.periph, CLOCK_CACHE.hclkHz),
      pclk1Hz: word(rig.periph, CLOCK_CACHE.pclk1Hz),
      pclk2Hz: word(rig.periph, CLOCK_CACHE.pclk2Hz),
    };
  } finally {
    rig.dispose();
  }
}

it('SPI2 服务下限在 80 MHz/APB1=/2 后使用 12.5 ns CPU 周期', () => {
  const value = measure(true);

  expect(value.hclkHz).toBe(80_000_000);
  expect(value.pclk1Hz).toBe(40_000_000);
  expect(value.pclk2Hz).toBe(20_000_000);
  expect(value.spi).toBe(25_000);
  expect(value.spiDeadline).toBe(25_000);
});

it('I2C2 服务下限在 80 MHz/APB1=/2 后使用 12.5 ns CPU 周期', () => {
  const value = measure(true);

  expect(value.hclkHz).toBe(80_000_000);
  expect(value.pclk1Hz).toBe(40_000_000);
  expect(value.pclk2Hz).toBe(20_000_000);
  expect(value.i2c).toBe(25_000);
});

it('无 dynamicClock 的 rig 保持 boot 62.5 ns 静态 fallback', () => {
  const value = measure(false);

  expect(value.spi).toBe(62_500);
  expect(value.i2c).toBe(62_500);
});
