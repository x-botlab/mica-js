import { describe, expect, it } from 'vitest';
import { num } from '@mica-js/stm32g431rbt6-core/ir';
import { types } from '@mica-js/sdk/model';
import { atAddress, readMemory, writeMemory } from '@mica-js/stm32g431rbt6-core/memory';
import {
  CCM_BASE,
  DMA1_BASE,
  DMAMUX1_BASE,
  PERIPH_ACTIVE,
  SRAM_BASE,
  USART2_BASE,
  periphDeadlineState,
} from '@mica-js/stm32g431rbt6-core/layout';
import { runRig } from './peripheral-rig';
import { PeripheralSlot } from '@mica-js/stm32g431rbt6-core/layout';
import { validatePeripheralModules } from '@mica-js/stm32g431rbt6-core/peripheral';
import { BRR, CR1, TDR } from '@mica-js/stm32g431rbt6-core/usart';
import { dmaBus, dmaModule } from '@mica-js/stm32g431rbt6-core/dma-default';
import { I2C_CONFIGS, I2C_RXDR, I2C_TXDR } from '@mica-js/stm32g431rbt6-core/i2c-layout';
import { SPI_CONFIGS, SPI_DR } from '@mica-js/stm32g431rbt6-core/spi-layout';
import { DMAMUX_REQUESTS, dmamuxChannelOffset, dmamuxModule } from '@mica-js/stm32g431rbt6-core/dmamux';
import { crcModule } from '@mica-js/stm32g431rbt6-core/crc';
import { rngModule } from '@mica-js/stm32g431rbt6-core/rng';
import { watchdogModule } from '@mica-js/stm32g431rbt6-core/watchdog';
import { rtcModule } from '@mica-js/stm32g431rbt6-core/rtc';
import { DMA_CONTROLLERS, readDma, writeDma } from '@mica-js/stm32g431rbt6-core/dma';

describe('STM32G431 DMA/system peripheral registration', () => {
  it('registers non-overlapping ranges, unique slots and expected IRQs', () => {
    const modules = [dmaModule, dmamuxModule, crcModule, rngModule, watchdogModule, rtcModule];

    expect(() => validatePeripheralModules(modules)).not.toThrow();
    expect(dmaModule.slot).toBe(PeripheralSlot.Dma);
    expect(rngModule.slot).toBe(PeripheralSlot.CrcRng);
    expect(watchdogModule.slot).toBe(PeripheralSlot.Watchdog);
    expect(rtcModule.slot).toBe(PeripheralSlot.Rtc);

    const exceptions = modules.flatMap((module) =>
      (module.interrupts ?? []).map((interrupt) => interrupt.exception),
    );

    expect(exceptions).toContain(11 + 16);
    expect(exceptions).toContain(16 + 16);
    expect(exceptions).toContain(60 + 16);
    expect(exceptions).toContain(97 + 16);
    expect(exceptions).toContain(94 + 16);
    expect(exceptions).toContain(90 + 16);
    expect(exceptions).toContain(0 + 16);
    expect(exceptions).toContain(3 + 16);
    expect(exceptions).toContain(41 + 16);
  });

  it('reserves the DMA/module memories without exposing hidden words', () => {
    expect(dmaModule.id).toBe('dma');
    expect(crcModule.id).toBe('crc');
    expect(rngModule.id).toBe('rng');
    expect(rtcModule.id).toBe('rtc');
    expect(watchdogModule.id).toBe('watchdog');
  });

  it('drives DMA through the central bus and PeripheralModule slot dispatch', () => {
    const rig = runRig({
      peripherals: [dmaModule],
      states: [
        ...[0, 1, 2, 3].map((index) => ({ name: `w${index}`, type: 'number' as const, initial: 0 })),
        { name: 'active', type: 'number' as const, initial: 0 },
        { name: 'deadline', type: 'number' as const, initial: 0 },
      ],
      build: (b) => {
        const source = SRAM_BASE + 0x20;
        const dest = SRAM_BASE + 0x80;
        const byte = (address: number, value: number): void => {
          writeMemory(b, num(b, address), 1, num(b, value), false, atAddress(address));
        };
        const word = (address: number, value: number): void => {
          writeMemory(b, num(b, address), 4, num(b, value), false, atAddress(address));
        };

        byte(source, 0x11);
        byte(source + 1, 0x22);
        byte(source + 2, 0x33);
        byte(source + 3, 0x44);
        word(DMA1_BASE + 0x0c, 4);
        word(DMA1_BASE + 0x10, source);
        word(DMA1_BASE + 0x14, dest);
        word(DMA1_BASE + 0x08, 0x40c1);
        b.writeState('active', b.readState(PERIPH_ACTIVE, types.number));
        b.writeState(
          'deadline',
          b.readState(periphDeadlineState(PeripheralSlot.Dma), types.number),
        );
        dmaModule.advance!(b, num(b, 1_000_000));
        b.writeState('w0', readMemory(b, num(b, dest), 1, false, atAddress(dest)));
      },
    });

    try {
      expect((rig.state('active') as number) & (1 << PeripheralSlot.Dma)).toBe(1 << PeripheralSlot.Dma);
      expect(rig.state('deadline')).toBe(1_000_000);
      expect(rig.state('w0')).toBe(0x11);
    } finally {
      rig.dispose();
    }
  });

  it('feeds USART2 TDR through the default DMA bus adapter', () => {
    const rig = runRig({
      peripherals: [dmaModule, dmamuxModule],
      states: [
        { name: 'publish', type: 'number' as const, initial: 0 },
        { name: 'count', type: 'number' as const, initial: 0 },
        { name: 'active', type: 'number' as const, initial: 0 },
      ],
      build: (b) => {
        const word = (address: number, value: number): void => {
          writeMemory(b, num(b, address), 4, num(b, value), false, atAddress(address));
        };

        writeMemory(b, num(b, SRAM_BASE + 0x50), 1, num(b, 0x4f), false, atAddress(SRAM_BASE + 0x50));
        word(USART2_BASE + CR1, 0x0009);
        word(USART2_BASE + 0x08, 0x80); // CR3.DMAT
        word(USART2_BASE + BRR, 0x8b);
        word(DMAMUX1_BASE + dmamuxChannelOffset(1), DMAMUX_REQUESTS.USART2_TX);
        word(DMA1_BASE + 0x20, 1);
        word(DMA1_BASE + 0x24, USART2_BASE + TDR);
        word(DMA1_BASE + 0x28, SRAM_BASE + 0x50);
        word(DMA1_BASE + 0x1c, 0x91);
        dmaModule.advance!(b, num(b, 1_000_000));
        b.writeState('publish', b.readState('tx2Publish', types.number));
        b.writeState('count', b.readState('tx2Count', types.number));
        b.writeState('active', b.readState('tx2Active', types.number));
      },
    });

    try {
      expect(rig.state('publish')).toBe(0x4f);
      expect(rig.state('count')).toBe(0);
      expect((rig.state('active') as number) & 1).toBe(1);
    } finally {
      rig.dispose();
    }
  });

  it('checks width-aware DMA endpoint validity', () => {
    const rig = runRig({
      peripherals: [dmaModule],
      sramSize: 0x5800,
      states: [
        { name: 'inside', type: 'bool' as const, initial: false },
        { name: 'lastWord', type: 'bool' as const, initial: false },
        { name: 'rcc', type: 'bool' as const, initial: false },
      ],
      build: (b) => {
        b.writeState('inside', dmaBus.valid!(b, num(b, SRAM_BASE + 0x57fe), 4, 'read'));
        b.writeState('lastWord', dmaBus.valid!(b, num(b, SRAM_BASE + 0x57fc), 4, 'read'));
        b.writeState('rcc', dmaBus.valid!(b, num(b, 0x4002_1000), 4, 'write'));
      },
    });

    try {
      expect(rig.state('lastWord')).toBe(true);
      expect(rig.state('rcc')).toBe(false);
      expect(rig.state('inside')).toBe(false);
    } finally {
      rig.dispose();
    }
  });

  it('keeps USART DMA idle until CR3.DMAT is set', () => {
    const rig = runRig({
      peripherals: [dmaModule, dmamuxModule],
      states: [
        { name: 'publish', type: 'number' as const, initial: 0 },
        { name: 'count', type: 'number' as const, initial: 0 },
      ],
      build: (b) => {
        const word = (address: number, value: number): void => {
          writeMemory(b, num(b, address), 4, num(b, value), false, atAddress(address));
        };

        writeMemory(b, num(b, SRAM_BASE + 0x60), 1, num(b, 0x4f), false, atAddress(SRAM_BASE + 0x60));
        word(USART2_BASE + CR1, 0x0009);
        word(USART2_BASE + BRR, 0x8b);
        word(DMAMUX1_BASE + dmamuxChannelOffset(1), DMAMUX_REQUESTS.USART2_TX);
        word(DMA1_BASE + 0x20, 1);
        word(DMA1_BASE + 0x24, USART2_BASE + TDR);
        word(DMA1_BASE + 0x28, SRAM_BASE + 0x60);
        word(DMA1_BASE + 0x1c, 0x91);
        dmaModule.advance!(b, num(b, 1_000_000));
        b.writeState('publish', b.readState('tx2Publish', types.number));
        b.writeState('count', b.readState('tx2Count', types.number));
      },
    });

    try {
      expect(rig.state('publish')).toBe(-1);
      expect(rig.state('count')).toBe(0);
    } finally {
      rig.dispose();
    }
  });

  it('exposes only owner-declared I2C/SPI DMA data lanes by default', () => {
    const i2c = I2C_CONFIGS[0]!;
    const spi = SPI_CONFIGS[0]!;
    const rig = runRig({
      states: [
        { name: 'i2cRx', type: 'bool' as const, initial: false },
        { name: 'i2cTx', type: 'bool' as const, initial: false },
        { name: 'i2cReserved', type: 'bool' as const, initial: true },
        { name: 'spiDr', type: 'bool' as const, initial: false },
        { name: 'spiWide', type: 'bool' as const, initial: true },
      ],
      build: (b) => {
        b.writeState('i2cRx', dmaBus.valid!(b, num(b, i2c.base + I2C_RXDR), 1, 'read'));
        b.writeState('i2cTx', dmaBus.valid!(b, num(b, i2c.base + I2C_TXDR), 1, 'write'));
        b.writeState('i2cReserved', dmaBus.valid!(b, num(b, i2c.base), 1, 'read'));
        b.writeState('spiDr', dmaBus.valid!(b, num(b, spi.base + SPI_DR), 2, 'write'));
        b.writeState('spiWide', dmaBus.valid!(b, num(b, spi.base + SPI_DR), 4, 'read'));
      },
    });

    try {
      expect(rig.state('i2cRx')).toBe(true);
      expect(rig.state('i2cTx')).toBe(true);
      expect(rig.state('i2cReserved')).toBe(false);
      expect(rig.state('spiDr')).toBe(true);
      expect(rig.state('spiWide')).toBe(false);
    } finally {
      rig.dispose();
    }
  });

  it('turns cross-boundary, Flash-write and unsupported DMA targets into TE', () => {
    const transfer = (source: number, dest: number): { readonly isr: unknown; readonly ccr: unknown } => {
      const rig = runRig({
        peripherals: [dmaModule, dmamuxModule],
        sramSize: 0x5800,
        states: [
          { name: 'isr', type: 'number' as const, initial: 0 },
          { name: 'ccr', type: 'number' as const, initial: 0 },
        ],
        build: (b) => {
          const controller = DMA_CONTROLLERS[0]!;

          writeDma(b, controller, num(b, 0x0c), 4, num(b, 1));
          writeDma(b, controller, num(b, 0x10), 4, num(b, source));
          writeDma(b, controller, num(b, 0x14), 4, num(b, dest));
          writeDma(b, controller, num(b, 0x08), 4, num(b, 0x4ac1));
          dmaModule.advance!(b, num(b, 1_000_000));
          b.writeState('isr', readDma(b, controller, num(b, 0), 4));
          b.writeState('ccr', readDma(b, controller, num(b, 0x08), 4));
        },
      });

      try {
        return { isr: rig.state('isr'), ccr: rig.state('ccr') };
      } finally {
        rig.dispose();
      }
    };

    for (const result of [
      transfer(SRAM_BASE + 0x57fe, SRAM_BASE + 0x100),
      transfer(SRAM_BASE + 0x20, 0x0800_0000),
      transfer(SRAM_BASE + 0x20, CCM_BASE + 0x20),
      transfer(SRAM_BASE + 0x20, 0x4002_1000),
      transfer(SRAM_BASE + 0x20, 0x4002_0008),
    ]) {
      expect((result.isr as number) & 0x9).toBe(0x9);
      expect((result.ccr as number) & 1).toBe(0);
    }
  });
});
