import { types } from '@mica-js/sdk/model';
import type { Value } from '@mica-js/sdk/model';
import { describe, expect, it } from 'vitest';
import { asBody, boolBitAt, num, u32 } from '@mica-js/stm32g431rbt6-core/ir';
import type { Body } from '@mica-js/stm32g431rbt6-core/ir';
import {
  DMA_CONTROLLERS,
  DMA_STATES,
  advanceDma,
  dmaActive,
  dmaChannelPending,
  readDma,
  writeDma,
} from '@mica-js/stm32g431rbt6-core/dma';
import type { DmaBus, DmaRequestSource } from '@mica-js/stm32g431rbt6-core/dma';
import {
  DMAMUX_REQUESTS,
  dmamuxChannelOffset,
  readDmamux,
  writeDmamux,
} from '@mica-js/stm32g431rbt6-core/dmamux';
import { CCM_BASE, CODE, FLASH_BASE, SRAM_BASE, USART2_BASE } from '@mica-js/stm32g431rbt6-core/layout';
import { USARTS } from '@mica-js/stm32g431rbt6-core/usart';
import { BRR, CR1, ISR, TDR, readUsart, writeUsart } from '@mica-js/stm32g431rbt6-core/usart';
import { runRig } from './peripheral-rig';

const DMA1C1 = DMA_CONTROLLERS[0]!;
const CAPTURE_STATES = [
  'resultIsr',
  'resultCount',
  'resultCcr',
  'resultCleared',
  'resultIfcr',
  'resultPar',
  'resultMar',
  'usartCount',
  'usartActive',
  'usartQueue',
  'usartPublish',
  'dmaCcr',
  'dmamuxId',
  'dmaCount2',
  'dmaIsr2',
  'dma2Isr',
  'dma2Count',
  'count1',
  'count2',
  'raw1Ch2Count',
  'raw1Ch2Par',
  'raw1Ch2Mar',
  'raw1Ch2Ccr',
  'raw1Ch2Reserved',
  'raw1Ch3Ccr',
  'raw1Ch6Count',
  'raw1Ch6Par',
  'raw1Ch6Mar',
  'raw1Ch6Ccr',
  'raw1Ch6Reserved',
  'raw1Shadow',
  'raw2Ch2Count',
  'raw2Ch2Par',
  'raw2Ch2Mar',
  'raw2Ch2Ccr',
  'raw2Ch2Reserved',
  'raw2Ch3Ccr',
  'raw2Ch6Count',
  'raw2Ch6Par',
  'raw2Ch6Mar',
  'raw2Ch6Ccr',
  'raw2Ch6Reserved',
  'raw2Shadow',
].map((name) => ({ name, type: 'number' as const, initial: 0 }));
const CAPTURE_BOOL_STATES = ['resultBusy', 'resultPending', 'resultPendingCleared', 'busy'].map((name) => ({
  name,
  type: 'bool' as const,
  initial: false,
}));
const SRAM_SIZE = 0x100;
const CCM_SIZE = 0x100;
const CODE_SIZE = 64;

function inRegion(b: Body, address: Value<number>, base: number, size: number): Value<boolean> {
  return b.lessThan(u32(b, b.subtract(address, num(b, base))), num(b, size));
}

/** 测试总线：SRAM/CCM/Flash + 真实 USART2 寄存器，没有外设影子数组。 */
function testBus(withUsart = false): DmaBus {
  const read = (b: Body, address: Value<number>, size: 1 | 2 | 4): Value<number> => {
    const value = b.local(types.number, 0);

    b.if(inRegion(b, address, SRAM_BASE, SRAM_SIZE), (hit) => {
      const body = asBody(hit);
      const offset = body.subtract(address, num(body, SRAM_BASE));
      const loaded = body.local(types.number, 0);

      body.if(body.equal(types.number, num(body, size), num(body, 1)), (byte) =>
        byte.setLocal(loaded, byte.load8('sram', offset)),
      );
      body.if(body.equal(types.number, num(body, size), num(body, 2)), (half) =>
        half.setLocal(loaded, half.load16le('sram', offset)),
      );
      body.if(body.equal(types.number, num(body, size), num(body, 4)), (word) =>
        word.setLocal(loaded, word.load32le('sram', offset)),
      );
      body.setLocal(value, body.getLocal(loaded));
    });
    b.if(inRegion(b, address, CCM_BASE, CCM_SIZE), (hit) => {
      const body = asBody(hit);
      const offset = body.subtract(address, num(body, CCM_BASE));
      const loaded = body.local(types.number, 0);

      body.if(body.equal(types.number, num(body, size), num(body, 1)), (byte) =>
        byte.setLocal(loaded, byte.load8('ccm', offset)),
      );
      body.if(body.equal(types.number, num(body, size), num(body, 2)), (half) =>
        half.setLocal(loaded, half.load16le('ccm', offset)),
      );
      body.if(body.equal(types.number, num(body, size), num(body, 4)), (word) =>
        word.setLocal(loaded, word.load32le('ccm', offset)),
      );
      body.setLocal(value, body.getLocal(loaded));
    });
    b.if(inRegion(b, address, FLASH_BASE, CODE_SIZE), (hit) => {
      const body = asBody(hit);
      const offset = body.subtract(address, num(body, FLASH_BASE));
      const loaded = body.local(types.number, 0);

      body.if(body.equal(types.number, num(body, size), num(body, 1)), (byte) =>
        byte.setLocal(loaded, byte.load8(CODE, offset)),
      );
      body.if(body.equal(types.number, num(body, size), num(body, 2)), (half) =>
        half.setLocal(loaded, half.load16le(CODE, offset)),
      );
      body.if(body.equal(types.number, num(body, size), num(body, 4)), (word) =>
        word.setLocal(loaded, word.load32le(CODE, offset)),
      );
      body.setLocal(value, body.getLocal(loaded));
    });
    if (withUsart)
      b.if(inRegion(b, address, USART2_BASE, 0x400), (hit) => {
        const body = asBody(hit);

        body.setLocal(
          value,
          readUsart(body, USARTS[1]!, body.subtract(address, num(body, USART2_BASE)), size),
        );
      });

    return b.getLocal(value);
  };

  const write = (
    b: Body,
    address: Value<number>,
    size: 1 | 2 | 4,
    value: Value<number>,
  ): void => {
    b.if(inRegion(b, address, SRAM_BASE, SRAM_SIZE), (hit) => {
      const body = asBody(hit);
      const offset = body.subtract(address, num(body, SRAM_BASE));
      const local = body.local(types.number, value);

      body.if(body.equal(types.number, num(body, size), num(body, 1)), (byte) =>
        byte.store8('sram', offset, byte.getLocal(local)),
      );
      body.if(body.equal(types.number, num(body, size), num(body, 2)), (half) =>
        half.store16le('sram', offset, half.getLocal(local)),
      );
      body.if(body.equal(types.number, num(body, size), num(body, 4)), (word) =>
        word.store32le('sram', offset, word.getLocal(local)),
      );
    });
    b.if(inRegion(b, address, CCM_BASE, CCM_SIZE), (hit) => {
      const body = asBody(hit);
      const offset = body.subtract(address, num(body, CCM_BASE));
      const local = body.local(types.number, value);

      body.if(body.equal(types.number, num(body, size), num(body, 1)), (byte) =>
        byte.store8('ccm', offset, byte.getLocal(local)),
      );
      body.if(body.equal(types.number, num(body, size), num(body, 2)), (half) =>
        half.store16le('ccm', offset, half.getLocal(local)),
      );
      body.if(body.equal(types.number, num(body, size), num(body, 4)), (word) =>
        word.store32le('ccm', offset, word.getLocal(local)),
      );
    });
    if (withUsart)
      b.if(inRegion(b, address, USART2_BASE, 0x400), (hit) => {
        const body = asBody(hit);

        writeUsart(body, USARTS[1]!, body.subtract(address, num(body, USART2_BASE)), size, value);
      });
  };

  return { read, write };
}

function writeDmaReg(
  b: Body,
  controllerIndex: 0 | 1,
  offset: number,
  value: number,
): void {
  writeDma(b, DMA_CONTROLLERS[controllerIndex]!, num(b, offset), 4, num(b, value));
}

function readDmaReg(
  b: Body,
  controllerIndex: 0 | 1,
  offset: number,
  target: string,
): void {
  b.writeState(target, readDma(b, DMA_CONTROLLERS[controllerIndex]!, num(b, offset), 4));
}

describe('STM32G431 DMA1/DMA2', () => {
  it('performs a real memory-to-memory transfer with MINC/PINC and W1C flags', () => {
    const rig = runRig({
      states: [...DMA_STATES, ...CAPTURE_STATES, ...CAPTURE_BOOL_STATES],
      build: (b) => {
        const bus = testBus();

        for (let index = 0; index < 4; index += 1)
          b.store8('sram', num(b, 0x10 + index), num(b, 0x11 + index * 0x11));

        writeDmaReg(b, 0, 0x0c, 4); // CNDTR (CH1 = 0x08, CNDTR = +4)
        writeDmaReg(b, 0, 0x10, SRAM_BASE + 0x10); // CPAR
        writeDmaReg(b, 0, 0x14, SRAM_BASE + 0x80); // CMAR
        writeDmaReg(b, 0, 0x08, 0x40c3); // EN|TCIE|MEM2MEM|MINC|PINC

        for (let step = 0; step < 4; step += 1)
          advanceDma(b, num(b, 1_000_000), { bus, requests: [] });
        readDmaReg(b, 0, 0x00, 'resultIsr');
        readDmaReg(b, 0, 0x0c, 'resultCount');
        readDmaReg(b, 0, 0x08, 'resultCcr');
        b.writeState('resultBusy', dmaActive(b));
        b.writeState('resultPending', dmaChannelPending(b, DMA1C1, 1));

        writeDma(b, DMA1C1, num(b, 0x04), 4, num(b, 0x7)); // IFCR: CGIF|CTCIF|CHTIF
        readDmaReg(b, 0, 0x00, 'resultCleared');
        b.writeState('resultIfcr', readDma(b, DMA1C1, num(b, 0x04), 4));
        b.writeState('resultPendingCleared', dmaChannelPending(b, DMA1C1, 1));
      },
    });

    try {
      expect([...rig.memory('sram').subarray(0x80, 0x84)]).toEqual([0x11, 0x22, 0x33, 0x44]);
      expect(rig.state('resultIsr')).toBe(0x7);
      expect(rig.state('resultCount')).toBe(0);
      expect(rig.state('resultCcr')).toBe(0x40c2);
      expect(rig.state('resultBusy')).toBe(false);
      expect(rig.state('resultPending')).toBe(true);
      expect(rig.state('resultPendingCleared')).toBe(false);
      expect(rig.state('resultCleared')).toBe(0);
      expect(rig.state('resultIfcr')).toBe(0);
    } finally {
      rig.dispose();
    }
  });

  it('reloads circular count/addresses and exposes HT/TC flags', () => {
    const rig = runRig({
      states: [...DMA_STATES, ...CAPTURE_STATES, ...CAPTURE_BOOL_STATES],
      build: (b) => {
        const bus = testBus();

        b.store8('sram', num(b, 0x30), num(b, 0xaa));
        b.store8('sram', num(b, 0x31), num(b, 0xbb));
        writeDmaReg(b, 0, 0x0c, 2);
        writeDmaReg(b, 0, 0x10, SRAM_BASE + 0x30);
        writeDmaReg(b, 0, 0x14, SRAM_BASE + 0xa0);
        writeDmaReg(b, 0, 0x08, 0x40e1); // EN|CIRC|MEM2MEM|MINC|PINC

        for (let step = 0; step < 3; step += 1)
          advanceDma(b, num(b, 1_000_000), { bus, requests: [] });
        readDmaReg(b, 0, 0x00, 'resultIsr');
        readDmaReg(b, 0, 0x0c, 'resultCount');
        readDmaReg(b, 0, 0x10, 'resultPar');
        readDmaReg(b, 0, 0x14, 'resultMar');
        b.writeState('resultBusy', dmaActive(b));
      },
    });

    try {
      expect([...rig.memory('sram').subarray(0xa0, 0xa3)]).toEqual([0xaa, 0xbb, 0x00]);
      expect(rig.state('resultIsr')).toBe(0x7); // GIF|TC|HT
      expect(rig.state('resultCount')).toBe(1);
      expect(rig.state('resultPar')).toBe(SRAM_BASE + 0x31);
      expect(rig.state('resultMar')).toBe(SRAM_BASE + 0xa1);
      expect(rig.state('resultBusy')).toBe(true);
    } finally {
      rig.dispose();
    }
  });

  it('feeds USART2 TDR from memory through a registered DMAMUX request', () => {
    const requests: readonly DmaRequestSource[] = [
      {
        id: DMAMUX_REQUESTS.USART2_TX,
        name: 'USART2 TX',
        ready: (b) =>
          boolBitAt(b, readUsart(b, USARTS[1]!, num(b, ISR), 4), 7),
      },
    ];

    const rig = runRig({
      states: [...DMA_STATES, ...CAPTURE_STATES, ...CAPTURE_BOOL_STATES],
      build: (b) => {
        const bus = testBus(true);

        writeUsart(b, USARTS[1]!, num(b, CR1), 4, num(b, 0x0008 | 0x0001));
        writeUsart(b, USARTS[1]!, num(b, BRR), 4, num(b, 0x8b));
        b.store8('sram', num(b, 0x50), num(b, 0x4f));
        b.store8('sram', num(b, 0x51), num(b, 0x4b));
        b.store8('sram', num(b, 0x52), num(b, 0x0a));

        writeDmamux(b, num(b, dmamuxChannelOffset(1)), 4, num(b, DMAMUX_REQUESTS.USART2_TX));
        writeDmaReg(b, 0, 0x20, 3); // DMA1 CH2 CNDTR (+0x04)
        writeDmaReg(b, 0, 0x24, USART2_BASE + TDR); // CPAR (+0x08)
        writeDmaReg(b, 0, 0x28, SRAM_BASE + 0x50); // CMAR (+0x0c)
        writeDmaReg(b, 0, 0x1c, 0x91); // CCR (+0x00): EN|DIR|MINC

        for (let step = 0; step < 3; step += 1)
          advanceDma(b, num(b, 1_000_000), { bus, requests });
        b.writeState('usartCount', b.readState('tx2Count', types.number));
        b.writeState('usartActive', b.readState('tx2Active', types.number));
        b.writeState('usartQueue', b.readState('tx2Queue', types.number));
        b.writeState('usartPublish', b.readState('tx2Publish', types.number));
        readDmaReg(b, 0, 0x20, 'dmaCount2');
        readDmaReg(b, 0, 0x00, 'dmaIsr2');
        readDmaReg(b, 0, 0x1c, 'dmaCcr');
        b.writeState('dmamuxId', readDmamux(b, num(b, dmamuxChannelOffset(1)), 4));
      },
    });

    try {
      expect(rig.state('usartCount')).toBe(2);
      expect((rig.state('usartActive') as number) & 1).toBe(1);
      expect(rig.state('usartPublish')).toBe(0x4f);
      expect(rig.state('usartQueue')).toBe(0x0a4b);
      expect(rig.state('dmaCount2')).toBe(0);
      expect(rig.state('dmaIsr2')).toBe(0x70);
      expect(rig.state('dmaCcr')).toBe(0x90);
      expect(rig.state('dmamuxId')).toBe(DMAMUX_REQUESTS.USART2_TX);
    } finally {
      rig.dispose();
    }
  });

  it('models DMA2 channel 6 with the same transfer semantics', () => {
    const rig = runRig({
      states: [...DMA_STATES, ...CAPTURE_STATES, ...CAPTURE_BOOL_STATES],
      build: (b) => {
        const bus = testBus();

        b.store8('sram', num(b, 0x70), num(b, 0x5a));
        writeDmaReg(b, 1, 0x70, 1); // CH6 CNDTR (0x6c + 0x04)
        writeDmaReg(b, 1, 0x74, SRAM_BASE + 0x70);
        writeDmaReg(b, 1, 0x78, SRAM_BASE + 0xc0);
        writeDmaReg(b, 1, 0x6c, 0x40c1);
        advanceDma(b, num(b, 1_000_000), { bus, requests: [] });
        readDmaReg(b, 1, 0x00, 'dma2Isr');
        readDmaReg(b, 1, 0x70, 'dma2Count');
      },
    });

    try {
      expect(rig.memory('sram')[0xc0]).toBe(0x5a);
      expect(rig.state('dma2Isr')).toBe(0x300000); // CH6 GIF/TC flags at bits 20–23
      expect(rig.state('dma2Count')).toBe(0);
    } finally {
      rig.dispose();
    }
  });

  it('decodes raw CMSIS CH2/CH6 offsets on both controllers without reserved/shadow aliasing', () => {
    const rig = runRig({
      states: [...DMA_STATES, ...CAPTURE_STATES, ...CAPTURE_BOOL_STATES],
      build: (b) => {
        for (const controller of [0, 1] as const) {
          // CMSIS/RM0440: CH2 base 0x1c, CH6 base 0x6c, stride 0x14.
          writeDmaReg(b, controller, 0x20, 0x1234); // CH2 CNDTR
          writeDmaReg(b, controller, 0x24, SRAM_BASE + 0x40); // CH2 CPAR
          writeDmaReg(b, controller, 0x28, SRAM_BASE + 0x60); // CH2 CMAR
          writeDmaReg(b, controller, 0x1c, 0); // CH2 CCR
          writeDmaReg(b, controller, 0x70, 0x45); // CH6 CNDTR
          writeDmaReg(b, controller, 0x74, SRAM_BASE + 0x50); // CH6 CPAR
          writeDmaReg(b, controller, 0x78, SRAM_BASE + 0x70); // CH6 CMAR
          writeDmaReg(b, controller, 0x6c, 0); // CH6 CCR
          // +0x10 是保留 word，0x80 起是内部 BASE_* 影子；写 guest 都不得生效。
          writeDmaReg(b, controller, 0x2c, 0xdead_beef);
          writeDmaReg(b, controller, 0x7c, 0xdead_beef);
          writeDmaReg(b, controller, 0x80, 0xdead_beef);
        }

        for (const [controller, prefix] of [
          [0, 'raw1'],
          [1, 'raw2'],
        ] as const) {
          readDmaReg(b, controller, 0x20, `${prefix}Ch2Count`);
          readDmaReg(b, controller, 0x24, `${prefix}Ch2Par`);
          readDmaReg(b, controller, 0x28, `${prefix}Ch2Mar`);
          readDmaReg(b, controller, 0x1c, `${prefix}Ch2Ccr`);
          readDmaReg(b, controller, 0x2c, `${prefix}Ch2Reserved`);
          readDmaReg(b, controller, 0x30, `${prefix}Ch3Ccr`);
          readDmaReg(b, controller, 0x70, `${prefix}Ch6Count`);
          readDmaReg(b, controller, 0x74, `${prefix}Ch6Par`);
          readDmaReg(b, controller, 0x78, `${prefix}Ch6Mar`);
          readDmaReg(b, controller, 0x6c, `${prefix}Ch6Ccr`);
          readDmaReg(b, controller, 0x7c, `${prefix}Ch6Reserved`);
          readDmaReg(b, controller, 0x80, `${prefix}Shadow`);
        }
      },
    });

    try {
      for (const prefix of ['raw1', 'raw2']) {
        expect(rig.state(`${prefix}Ch2Count`)).toBe(0x1234);
        expect(rig.state(`${prefix}Ch2Par`)).toBe(SRAM_BASE + 0x40);
        expect(rig.state(`${prefix}Ch2Mar`)).toBe(SRAM_BASE + 0x60);
        expect(rig.state(`${prefix}Ch2Ccr`)).toBe(0);
        expect(rig.state(`${prefix}Ch2Reserved`)).toBe(0);
        expect(rig.state(`${prefix}Ch3Ccr`)).toBe(0);
        expect(rig.state(`${prefix}Ch6Count`)).toBe(0x45);
        expect(rig.state(`${prefix}Ch6Par`)).toBe(SRAM_BASE + 0x50);
        expect(rig.state(`${prefix}Ch6Mar`)).toBe(SRAM_BASE + 0x70);
        expect(rig.state(`${prefix}Ch6Ccr`)).toBe(0);
        expect(rig.state(`${prefix}Ch6Reserved`)).toBe(0);
        expect(rig.state(`${prefix}Shadow`)).toBe(0);
      }
    } finally {
      rig.dispose();
    }
  });

  it('selects the highest priority channel when two requests compete', () => {
    const rig = runRig({
      states: [...DMA_STATES, ...CAPTURE_STATES, ...CAPTURE_BOOL_STATES],
      build: (b) => {
        const bus = testBus();

        b.store8('sram', num(b, 0x60), num(b, 0x01));
        b.store8('sram', num(b, 0x61), num(b, 0x02));
        // CH1 low priority, CH2 high priority, both mem2mem.
        writeDmaReg(b, 0, 0x0c, 1);
        writeDmaReg(b, 0, 0x10, SRAM_BASE + 0x60);
        writeDmaReg(b, 0, 0x14, SRAM_BASE + 0xe0);
        writeDmaReg(b, 0, 0x08, 0x40c1);
        writeDmaReg(b, 0, 0x20, 1);
        writeDmaReg(b, 0, 0x24, SRAM_BASE + 0x61);
        writeDmaReg(b, 0, 0x28, SRAM_BASE + 0xe1);
        writeDmaReg(b, 0, 0x1c, 0x70c1); // EN|MEM2MEM|MINC|PINC|PL=3

        advanceDma(b, num(b, 1_000_000), { bus, requests: [] });
        readDmaReg(b, 0, 0x0c, 'count1');
        readDmaReg(b, 0, 0x20, 'count2');
        b.writeState('busy', dmaActive(b));
      },
    });

    try {
      expect(rig.state('count1')).toBe(1);
      expect(rig.state('count2')).toBe(0);
      expect(rig.memory('sram')[0xe1]).toBe(0x02);
      expect(rig.state('busy')).toBe(true);
    } finally {
      rig.dispose();
    }
  });
});
