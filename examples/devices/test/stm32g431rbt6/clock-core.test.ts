import { types } from '@mica-js/sdk/model';
import { describe, expect, it } from 'vitest';
import {
  CLOCK_CACHE,
  RCC_BDCR,
  RCC_CCIPR,
  RCC_CFGR,
  RCC_CR,
  RCC_PLLCFGR,
  readClockWord,
} from '@mica-js/stm32g431rbt6-core/clock-tree';
import { writeWordAt } from '@mica-js/stm32g431rbt6-core/ir';
import type { Body } from '@mica-js/stm32g431rbt6-core/ir';
import { readRcc, writeRcc } from '@mica-js/stm32g431rbt6-core/rcc';
import { clockRig } from './clock-rig';

const n = (b: Body, value: number) => b.constant(types.number, value);
const write = (b: Body, offset: number, value: number): void =>
  writeRcc(b, n(b, offset), 4, n(b, value));
const read = (b: Body, offset: number): ReturnType<typeof readRcc> => readRcc(b, n(b, offset), 4);
const save = (b: Body, index: number, value: ReturnType<typeof readRcc>): void =>
  b.writeState(`o${index}`, value);

const cache = (periph: Uint8Array, offset: number): number =>
  new DataView(periph.buffer, periph.byteOffset, periph.byteLength).getUint32(offset, true);

/** 一次典型的 80 MHz 配置：HSI→PLL、APB1/2 分频、LSE、外设时钟选择。 */
function configure80(b: Body): void {
  write(b, RCC_PLLCFGR, 0x1101_1412);
  write(b, RCC_CR, 0x0100_0100);
  write(b, RCC_CFGR, 0x0000_2c03);
  write(b, RCC_BDCR, 0x0000_0001);
  write(b, RCC_CCIPR, 0x1003_9039);
}

describe('时钟树核心 IR（合成夹具）', () => {
  it('PLL 80 MHz、AHB/APB 分频、定时器倍频与外设 mux', () => {
    const rig = clockRig({ emit: configure80 });

    try {
      rig.run(1);
      expect(cache(rig.periph, CLOCK_CACHE.epoch)).toBeGreaterThan(0);
      expect(cache(rig.periph, CLOCK_CACHE.sysHz)).toBe(80_000_000);
      expect(cache(rig.periph, CLOCK_CACHE.hclkHz)).toBe(80_000_000);
      expect(cache(rig.periph, CLOCK_CACHE.pclk1Hz)).toBe(40_000_000);
      expect(cache(rig.periph, CLOCK_CACHE.pclk2Hz)).toBe(20_000_000);
      expect(cache(rig.periph, CLOCK_CACHE.timApb1Hz)).toBe(80_000_000);
      expect(cache(rig.periph, CLOCK_CACHE.timApb2Hz)).toBe(40_000_000);
      expect(cache(rig.periph, CLOCK_CACHE.usart1Hz)).toBe(80_000_000);
      expect(cache(rig.periph, CLOCK_CACHE.usart2Hz)).toBe(16_000_000);
      expect(cache(rig.periph, CLOCK_CACHE.usart3Hz)).toBe(32_768);
      expect(cache(rig.periph, CLOCK_CACHE.i2c1Hz)).toBe(80_000_000);
      expect(cache(rig.periph, CLOCK_CACHE.i2c2Hz)).toBe(16_000_000);
      expect(cache(rig.periph, CLOCK_CACHE.i2c3Hz)).toBe(0);
      expect(cache(rig.periph, CLOCK_CACHE.adc12Hz)).toBe(80_000_000);
      expect(cache(rig.periph, CLOCK_CACHE.pllVcoHz)).toBe(160_000_000);
      expect(cache(rig.periph, CLOCK_CACHE.sws)).toBe(3);
    } finally {
      rig.dispose();
    }
  });

  it('同进程两块不同 HSE 配置的 MCU 互不污染', () => {
    const emitHse80 = (b: Body): void => {
      write(b, RCC_PLLCFGR, 0x0100_1423); // HSE /3 ×20 /2
      write(b, RCC_CR, 0x0101_0100); // HSION|HSEON|PLLON
      write(b, RCC_CFGR, 3);
    };
    const withoutHse = clockRig({ emit: emitHse80 });
    const withHse = clockRig({ emit: emitHse80, hseFrequency: 24_000_000 });

    try {
      withoutHse.run(1);
      withHse.run(1);
      expect(cache(withoutHse.periph, CLOCK_CACHE.sysHz)).toBe(16_000_000);
      expect(cache(withoutHse.periph, CLOCK_CACHE.sws)).toBe(0);
      expect(cache(withHse.periph, CLOCK_CACHE.sysHz)).toBe(80_000_000);
      expect(cache(withHse.periph, CLOCK_CACHE.sws)).toBe(3);
      // 反向再读一次，确认先运行的板没有被后运行的板改写。
      expect(cache(withoutHse.periph, CLOCK_CACHE.sysHz)).toBe(16_000_000);
    } finally {
      withoutHse.dispose();
      withHse.dispose();
    }
  });

  it('RCC 保留窗口与私有 CLOCK_CACHE 不对 guest 读写可见', () => {
    const rig = clockRig({
      emit: (b) => {
        configure80(b);
        save(b, 0, readClockWord(b, CLOCK_CACHE.epoch));
        save(b, 1, read(b, RCC_CR));
        save(b, 2, read(b, 0x100));
        save(b, 3, read(b, 0xa0));
        write(b, 0x100, 0xffff_ffff);
        write(b, 0xa0, 0xffff_ffff);
        write(b, 0x10, 0xffff_ffff); // RCC 保留偏移
        save(b, 4, read(b, RCC_CR));
        save(b, 5, readClockWord(b, CLOCK_CACHE.epoch));
        save(b, 6, read(b, 0x10));
      },
    });

    try {
      rig.run(1);
      expect(rig.states.get('o2')).toBe(0);
      expect(rig.states.get('o3')).toBe(0);
      expect(rig.states.get('o4')).toBe(rig.states.get('o1'));
      expect(rig.states.get('o5')).toBe(rig.states.get('o0'));
      expect(rig.states.get('o6')).toBe(0);
    } finally {
      rig.dispose();
    }
  });

  it('PLLSRC=none（HAL 关闭 PLL 的写法）不会锁定或切换', () => {
    const rig = clockRig({
      emit: (b) => {
        write(b, RCC_PLLCFGR, 0);
        write(b, RCC_CR, 0x0100_0100);
        write(b, RCC_CFGR, 3);
        save(b, 0, read(b, RCC_CR));
        save(b, 1, read(b, RCC_CFGR));
      },
    });

    try {
      rig.run(1);
      expect(cache(rig.periph, CLOCK_CACHE.sysHz)).toBe(16_000_000);
      expect(cache(rig.periph, CLOCK_CACHE.sws)).toBe(0);
      expect((rig.states.get('o0') as number) & (1 << 25)).toBe(0);
      expect(((rig.states.get('o1') as number) >>> 2) & 3).toBe(0);
    } finally {
      rig.dispose();
    }
  });

  it('门控/复位等非时钟写入不推进时钟代数', () => {
    const rig = clockRig({
      emit: (b) => {
        configure80(b);
        save(b, 0, readClockWord(b, CLOCK_CACHE.epoch));
        write(b, 0x4c, 1); // AHB2ENR.GPIOAEN
        write(b, 0x2c, 1); // AHB2RSTR.GPIOARST
        save(b, 1, readClockWord(b, CLOCK_CACHE.epoch));
        save(b, 2, readClockWord(b, CLOCK_CACHE.sysHz));
      },
    });

    try {
      rig.run(1);
      expect(rig.states.get('o1')).toBe(rig.states.get('o0'));
      expect(rig.states.get('o2')).toBe(80_000_000);
    } finally {
      rig.dispose();
    }
  });

  it('非法 PLL 配置不锁定，SWS 保持 HSI', () => {
    const rig = clockRig({
      emit: (b) => {
        write(b, RCC_PLLCFGR, 0x0100_0412); // PLLN=4
        write(b, RCC_CR, 0x0100_0100);
        write(b, RCC_CFGR, 3);
        save(b, 0, read(b, RCC_CR));
        save(b, 1, read(b, RCC_CFGR));
      },
    });

    try {
      rig.run(1);
      expect(cache(rig.periph, CLOCK_CACHE.sysHz)).toBe(16_000_000);
      expect(cache(rig.periph, CLOCK_CACHE.sws)).toBe(0);
      expect(cache(rig.periph, CLOCK_CACHE.pllVcoHz)).toBe(0);
      expect((rig.states.get('o0') as number) & (1 << 25)).toBe(0);
      expect(((rig.states.get('o1') as number) >>> 2) & 3).toBe(0);
    } finally {
      rig.dispose();
    }
  });

  it('HSE 源 PLL：24 MHz / M=3 × N=20 / R=2 = 80 MHz', () => {
    const rig = clockRig({
      hseFrequency: 24_000_000,
      emit: (b) => {
        write(b, RCC_PLLCFGR, 0x0100_1423);
        write(b, RCC_CR, 0x0101_0100); // HSION|HSEON|PLLON
        write(b, RCC_CFGR, 3);
        save(b, 0, read(b, RCC_CR));
        save(b, 1, read(b, RCC_CFGR));
      },
    });

    try {
      rig.run(1);
      expect(cache(rig.periph, CLOCK_CACHE.sysHz)).toBe(80_000_000);
      expect(cache(rig.periph, CLOCK_CACHE.sws)).toBe(3);
      expect((rig.states.get('o0') as number) & (1 << 17)).not.toBe(0);
      expect((rig.states.get('o0') as number) & (1 << 25)).not.toBe(0);
      expect(((rig.states.get('o1') as number) >>> 2) & 3).toBe(3);
    } finally {
      rig.dispose();
    }
  });

  it('目标源未就绪只保留 SW，SWS 不切换', () => {
    const rig = clockRig({
      emit: (b) => {
        write(b, RCC_CR, 0x0001_0100); // HSION + HSEON（无晶振）
        write(b, RCC_CFGR, 2);
        save(b, 0, read(b, RCC_CFGR));
        write(b, RCC_CFGR, 3);
        save(b, 1, read(b, RCC_CFGR));
        save(b, 2, read(b, RCC_CR));
      },
    });

    try {
      rig.run(1);
      expect((rig.states.get('o0') as number) & 3).toBe(2);
      expect(((rig.states.get('o0') as number) >>> 2) & 3).toBe(0);
      expect((rig.states.get('o1') as number) & 3).toBe(3);
      expect(((rig.states.get('o1') as number) >>> 2) & 3).toBe(0);
      expect((rig.states.get('o2') as number) & (1 << 17)).toBe(0);
      expect(cache(rig.periph, CLOCK_CACHE.sysHz)).toBe(16_000_000);
    } finally {
      rig.dispose();
    }
  });

  it('复现 HAL_06_LCD SystemClock_Config 的 HSI→PLL 80 MHz 寄存器序列', () => {
    const rig = clockRig({
      emit: (b) => {
        // HAL_RCC_OscConfig: HSE off / PLL off，然后写 PLLCFGR、PLLON、PLLREN。
        // HAL 的 PLLP 写进 PLLPDIV（2），不置 PLLPEN；主时钟只看 PLLREN。
        write(b, RCC_CR, 0x0000_0100);
        write(b, RCC_PLLCFGR, 0x1100_1412);
        write(b, RCC_CR, 0x0100_0100);
        write(b, RCC_PLLCFGR, 0x1100_1412);
        // HAL_RCC_ClockConfig: SYSCLK=PLL，AHB/APB1/APB2 都不分频。
        write(b, RCC_CFGR, 3);
        save(b, 0, read(b, RCC_CR));
        save(b, 1, read(b, RCC_CFGR));
      },
    });

    try {
      rig.run(1);
      expect(cache(rig.periph, CLOCK_CACHE.sysHz)).toBe(80_000_000);
      expect(cache(rig.periph, CLOCK_CACHE.hclkHz)).toBe(80_000_000);
      expect(cache(rig.periph, CLOCK_CACHE.pclk1Hz)).toBe(80_000_000);
      expect(cache(rig.periph, CLOCK_CACHE.pclk2Hz)).toBe(80_000_000);
      expect(cache(rig.periph, CLOCK_CACHE.sws)).toBe(3);
      expect((rig.states.get('o0') as number) & (1 << 25)).not.toBe(0);
      expect(((rig.states.get('o1') as number) >>> 2) & 3).toBe(3);
    } finally {
      rig.dispose();
    }
  });

  it('RCC 写入会按实际 USART 时钟重算位时长（16 MHz ↔ 80 MHz）', () => {
    const rig = clockRig({
      init: (b) => {
        writeWordAt(b, 'periph', 0x340, n(b, 9)); // USART2 CR1: UE|TE
        writeWordAt(b, 'periph', 0x34c, n(b, 0x22b)); // BRR = 555
      },
      emit: (b) => {
        configure80(b);
        write(b, RCC_CCIPR, 0); // USART2SEL = PCLK1(80 MHz)
        save(b, 0, b.readState('tx2Period', types.number));
        write(b, RCC_CCIPR, 8); // USART2SEL = HSI16
        save(b, 1, b.readState('tx2Period', types.number));
        write(b, RCC_CCIPR, 0); // USART2SEL = PCLK1
        save(b, 2, b.readState('tx2Period', types.number));
      },
    });

    try {
      rig.run(1);
      const pclk80 = rig.states.get('o0') as number;
      const hsi16 = rig.states.get('o1') as number;
      const pclkAgain = rig.states.get('o2') as number;

      // APB1=/2，所以 USART2 的 PCLK1 是 40 MHz；HSI mux 是 16 MHz。
      expect(pclk80).toBe(13_875_000);
      expect(hsi16).toBe(34_687_500);
      expect(pclkAgain).toBe(13_875_000);
      expect(hsi16 / pclk80).toBe(2.5);
    } finally {
      rig.dispose();
    }
  });
});
