import { types } from '@mica-js/sdk/model';
import type { Value } from '@mica-js/sdk/model';
import { asBody, bool, num, u32 } from './ir';
import type { Body } from './ir';
import type { AlternateDriver } from './machine';
import type { PeripheralModule } from './peripheral';
import { createAdcModule } from './adc';
import { crcModule } from './crc';
import { createComparatorModule } from './comparator';
import { createDacModule } from './dac';
import { flashModule } from './flash';
import { DMA_STATES } from './dma';
import { dmaModule } from './dma-default';
import { DMAMUX_STATES, dmamuxModule } from './dmamux';
import { EXTI_MODULE } from './exti';
import { FDCAN_MODULE } from './fdcan';
import { i2cModule } from './i2c';
import { createOpampModule } from './opamp';
import { spiModule } from './spi';
import { ADVANCE_ELAPSED, ADVANCE_PENDING, LPUART1_BASE, UART4_BASE } from './layout';
import { RNG_STATES, rngModule } from './rng';
import { RTC_STATES, rtcModule } from './rtc';
import { SYSCFG_MODULE } from './syscfg';
import { TIMER_STATE_SPECS, TIMER_MODULE, setTimerClockProvider } from './tim';
import { peripheralClockHz } from './clock-tree';
import type { PeripheralClockName } from './clock-tree';
import { USARTS, readUsart, usartPending, writeUsart } from './usart';
import { UCPD_MODULE } from './ucpd';
import { WATCHDOG_STATES, watchdogModule } from './watchdog';
import { registerResetHook } from './reset';

/**
 * 中央外设注册表（生产 profile）。
 *
 * 每个代理只交付自己的 `PeripheralModule`；这里显式列出 profile 启用的模块。
 * 独立 `stm32g431rbt6` 使用冻结的 `PERIPHERALS`，包含 TIM/ADC/DAC/COMP/OPAMP/I2C/
 * SPI/USART 扩展/SYSCFG/EXTI/DMAMUX/DMA/CRC/RNG/RTC/看门狗/FDCAN/UCPD/Flash。
 * USB 本轮不提供，模块源码保留在实验边界，但不进入本注册表。
 * ct117e 的 fused 基线只启用 `FUSED_PERIPHERALS`，避免把需要独立引脚或模拟量的
 * 外设 IR 展开进只支持数字 fused 引脚的模型。注册表冻结用于阻止测试通过 cast 注入
 * 第二套 profile；真实配置必须走本文件。
 */
const TIMER_CLOCKS: Readonly<Record<number, PeripheralClockName>> = {
  1: 'tim1',
  2: 'tim2',
  3: 'tim3',
  4: 'tim4',
  6: 'tim6',
  7: 'tim7',
  8: 'tim8',
  15: 'tim15',
  16: 'tim16',
  17: 'tim17',
};

// 定时器时钟跟随 RCC/APB 实际值；不把 `clockFrequency` 属性当成永远是外设时钟。
setTimerClockProvider((b, config) => peripheralClockHz(b, TIMER_CLOCKS[config.index]!));

const EXT_USARTS = USARTS.filter((config) => config.index >= 4);

function inRange(b: Body, address: Value<number>, base: number, size: number): Value<boolean> {
  return b.lessThan(u32(b, b.subtract(address, num(b, base))), num(b, size));
}

const usartExtModule: PeripheralModule = {
  id: 'usart-ext',
  ranges: [
    { base: UART4_BASE, size: 0x400 },
    { base: LPUART1_BASE, size: 0x400 },
  ],
  read: (b, address, size) => {
    const result = b.local(types.number, 0);

    for (const config of EXT_USARTS) {
      b.if(inRange(b, address, config.base, 0x400), (hit) => {
        const body = asBody(hit);

        body.setLocal(
          result,
          readUsart(body, config, body.subtract(address, num(body, config.base)), size),
        );
      });
    }

    return b.getLocal(result);
  },
  write: (b, address, size, value) => {
    for (const config of EXT_USARTS) {
      b.if(inRange(b, address, config.base, 0x400), (hit) => {
        writeUsart(
          asBody(hit),
          config,
          asBody(hit).subtract(address, num(asBody(hit), config.base)),
          size,
          value,
        );
      });
    }
  },
  interrupts: EXT_USARTS.map((config) => ({
    exception: 16 + config.irq,
    pending: (b: Body) => usartPending(b, config),
    acknowledge: () => {},
  })),
};

/**
 * 独立 MCU profile。DMA 的 `DmaBus`/请求源尚未由中央接线，因此暂不注册；访问 DMA
 * 寄存器会落到 generic 后备，文档明确列为未完成，而不是假称已实现。
 */
export const PERIPHERALS: readonly PeripheralModule[] = Object.freeze([
  TIMER_MODULE,
  createAdcModule(),
  createDacModule(),
  createComparatorModule(),
  createOpampModule(),
  i2cModule,
  spiModule,
  usartExtModule,
  SYSCFG_MODULE,
  EXTI_MODULE,
  dmamuxModule,
  dmaModule,
  crcModule,
  rngModule,
  rtcModule,
  watchdogModule,
  FDCAN_MODULE,
  UCPD_MODULE,
  flashModule,
]);

/** ct117e 只保留 HAL_06_LCD 已验证的数字基线；新外设不默认进入 fused。 */
export const FUSED_PERIPHERALS: readonly PeripheralModule[] = Object.freeze([]);

export function alternateDriversOf(
  modules: readonly PeripheralModule[],
): readonly AlternateDriver[] {
  const drivers: AlternateDriver[] = [];

  for (const module of modules) {
    if (module.alternateDrivers !== undefined) drivers.push(...module.alternateDrivers);
  }

  return drivers;
}

/**
 * 模块把内部热状态放在 DDL state 而不是 memory 时，软件复位必须显式写回复位值。
 * `reset.ts` 的 applyReset 只清 memory 与核心 state；这里补齐各模块公布的 STATE_SPECS。
 * NRST 走 DDL 的 mcuReset，那里由生成清单直接清零。
 */
export function resetModuleStates(b: Body): void {
  const write = (name: string, initial: number | boolean): void => {
    if (typeof initial === 'boolean') {
      b.writeState(name, bool(b, initial));

      return;
    }

    b.writeState(name, num(b, initial));
  };

  b.writeState(ADVANCE_PENDING, num(b, 0));
  b.writeState(ADVANCE_ELAPSED, num(b, 0));
  for (const spec of TIMER_STATE_SPECS) write(spec.name, spec.initial);
  for (const spec of DMA_STATES) write(spec.name, spec.initial);
  for (const spec of DMAMUX_STATES) write(spec.name, spec.initial);
  for (const spec of RNG_STATES) write(spec.name, spec.initial);
  for (const spec of RTC_STATES) write(spec.name, spec.initial);
  for (const spec of WATCHDOG_STATES) write(spec.name, spec.initial);
}

registerResetHook(resetModuleStates);

/** 供诊断/文档读取当前 profile 的时间外设数量。 */
export const peripheralCount = (): number => PERIPHERALS.length;

