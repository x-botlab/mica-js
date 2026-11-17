import { types } from '@mica-js/sdk/model';
import { describe, expect, it } from 'vitest';
import { num } from '@mica-js/stm32g431rbt6-core/ir';
import { DMA } from '@mica-js/stm32g431rbt6-core/layout';
import {
  DMAMUX_CHANNELS,
  DMAMUX_REQUESTS,
  dmamuxChannelOffset,
  dmamuxPending,
  dmamuxRequestId,
  readDmamux,
  setDmamuxOverrun,
  setDmamuxRequestGeneratorOverrun,
  writeDmamux,
} from '@mica-js/stm32g431rbt6-core/dmamux';
import { runRig } from './peripheral-rig';

const CAPTURES = [
  'id0',
  'id1',
  'id6',
  'id11',
  'reserved',
  'csr',
  'clear',
  'rgStatus',
  'rgClear',
  'syncFields',
].map((name) => ({ name, type: 'number' as const, initial: 0 }));
const BOOL_CAPTURES = ['pending', 'pendingCleared'].map((name) => ({
  name,
  type: 'bool' as const,
  initial: false,
}));

describe('STM32G431 DMAMUX1', () => {
  it('maps DMA1 CH1–6/DMA2 CH1–6 to the real DMAMUX register offsets', () => {
    const rig = runRig({
      states: [...CAPTURES, ...BOOL_CAPTURES],
      build: (b) => {
        writeDmamux(b, num(b, dmamuxChannelOffset(0)), 4, num(b, DMAMUX_REQUESTS.USART2_TX));
        writeDmamux(b, num(b, dmamuxChannelOffset(1)), 4, num(b, DMAMUX_REQUESTS.USART1_RX));
        writeDmamux(b, num(b, dmamuxChannelOffset(6)), 4, num(b, DMAMUX_REQUESTS.SPI1_TX));
        writeDmamux(b, num(b, dmamuxChannelOffset(11)), 4, num(b, DMAMUX_REQUESTS.ADC1));

        b.writeState('id0', dmamuxRequestId(b, 0));
        b.writeState('id1', dmamuxRequestId(b, 1));
        b.writeState('id6', dmamuxRequestId(b, 6));
        b.writeState('id11', dmamuxRequestId(b, 11));
        b.writeState('reserved', readDmamux(b, num(b, 0x18), 4));
        writeDmamux(
          b,
          num(b, dmamuxChannelOffset(4)),
          4,
          num(b, 0x1b | 0x100 | 0x200 | 0x10000 | (2 << 17) | (3 << 19) | (5 << 24)),
        );
        b.writeState('syncFields', readDmamux(b, num(b, dmamuxChannelOffset(4)), 4));
      },
    });

    try {
      expect(rig.state('id0')).toBe(DMAMUX_REQUESTS.USART2_TX);
      expect(rig.state('id1')).toBe(DMAMUX_REQUESTS.USART1_RX);
      expect(rig.state('id6')).toBe(DMAMUX_REQUESTS.SPI1_TX);
      expect(rig.state('id11')).toBe(DMAMUX_REQUESTS.ADC1);
      expect(rig.state('reserved')).toBe(0);
      expect(rig.state('syncFields')).toBe(0x051d031b);
      expect(rig.memory(DMA)[0x200 + 0x18]).toBe(0);
      expect(rig.memory(DMA)[0x200 + 0x1c]).toBe(0);
      expect(rig.memory(DMA)[0x200 + 0x20]).toBe(DMAMUX_REQUESTS.SPI1_TX);
      expect(rig.memory(DMA)[0x200 + 0x34]).toBe(DMAMUX_REQUESTS.ADC1);
    } finally {
      rig.dispose();
    }
  });

  it('implements CFR/RGCFR W1C and overrun interrupt pending', () => {
    const rig = runRig({
      states: [...CAPTURES, ...BOOL_CAPTURES],
      build: (b) => {
        writeDmamux(b, num(b, dmamuxChannelOffset(2)), 4, num(b, DMAMUX_REQUESTS.USART3_RX | 0x100));
        setDmamuxOverrun(b, 2);
        setDmamuxRequestGeneratorOverrun(b, 1);
        b.writeState('csr', readDmamux(b, num(b, 0x80), 4));
        b.writeState('rgStatus', readDmamux(b, num(b, 0x140), 4));
        b.writeState('pending', dmamuxPending(b));

        writeDmamux(b, num(b, 0x84), 4, num(b, 1 << 2));
        writeDmamux(b, num(b, 0x144), 4, num(b, 1 << 1));
        b.writeState('clear', readDmamux(b, num(b, 0x80), 4));
        b.writeState('rgClear', readDmamux(b, num(b, 0x140), 4));
        b.writeState('pendingCleared', dmamuxPending(b));
      },
    });

    try {
      expect(rig.state('csr')).toBe(1 << 2);
      expect(rig.state('rgStatus')).toBe(1 << 1);
      expect(rig.state('pending')).toBe(true);
      expect(rig.state('clear')).toBe(0);
      expect(rig.state('rgClear')).toBe(0);
      expect(rig.state('pendingCleared')).toBe(false);
    } finally {
      rig.dispose();
    }
  });

  it('keeps all 12 channel registers and request generator registers addressable', () => {
    const rig = runRig({
      build: (b) => {
        for (let channel = 0; channel < DMAMUX_CHANNELS; channel += 1)
          writeDmamux(
            b,
            num(b, dmamuxChannelOffset(channel)),
            4,
            num(b, 0x40 + channel),
          );
        for (let generator = 0; generator < 4; generator += 1)
          writeDmamux(b, num(b, 0x100 + generator * 4), 4, num(b, 0x101 + generator));
      },
    });

    try {
      const memory = rig.memory(DMA);

      for (let channel = 0; channel < 12; channel += 1) {
        const offset = 0x200 + dmamuxChannelOffset(channel);

        expect(memory[offset]).toBe(0x40 + channel);
      }
      for (let generator = 0; generator < 4; generator += 1)
        expect(memory[0x200 + 0x100 + generator * 4]).toBe(0x01 + generator);
    } finally {
      rig.dispose();
    }
  });
});
