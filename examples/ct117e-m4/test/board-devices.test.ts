import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createBoardHarness } from './board-harness';
import type { BoardHarness } from './board-harness';

/**
 * §1/§3 板载器件验收：全部从 `dist/model.js` 装载。
 *
 * 固件只读 `.bin` 夹具；测试通过公共 model 方法操作按键/电位器，并直接检查
 * DDL 内部状态与 GRAM，避免用宿主假电压绕过 fused 引脚。
 */

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(resolve(import.meta.dirname, 'fixtures', `${name}.bin`)));
}

const US = 1_000_000;
const MS = 1_000 * US;

function call<T>(harness: BoardHarness, name: string, params: unknown): T {
  return harness.methods[name]!(params) as T;
}

function ledEvents(harness: BoardHarness): readonly unknown[] {
  return harness.events.filter((event) => event.name === 'led').map((event) => event.value);
}

function buttonEvents(harness: BoardHarness): readonly unknown[] {
  return harness.events.filter((event) => event.name === 'button').map((event) => event.value);
}

function potEvents(harness: BoardHarness): readonly unknown[] {
  return harness.events
    .filter((event) => event.name === 'potentiometer')
    .map((event) => event.value);
}

function word(memory: Uint8Array, offset: number): number {
  return new DataView(memory.buffer, memory.byteOffset, memory.byteLength).getUint32(offset, true);
}

describe('74HC573 + 8 LED', () => {
  it('LE 高透明、LE 低保持，低有效亮灭与 LCD 写共享高字节', async () => {
    const harness = await createBoardHarness(fixture('led-latch'));

    try {
      harness.run(10 * US);
      // D=0xA5, LE high: Q=0xA5, public lit mask = 0x5A.
      expect(call<number>(harness, 'getLedState', null)).toBe(0x5a);
      expect(harness.state('ledLatch')).toBe(0xa5);

      call<null>(harness, 'setButton', { id: 1, pressed: true });
      harness.run(10 * US);
      // D changes to 0x3C while LE is still high: Q follows, mask = 0xC3.
      expect(call<number>(harness, 'getLedState', null)).toBe(0xc3);
      expect(harness.state('ledLatch')).toBe(0xa5);

      const beforeClose = ledEvents(harness).length;
      call<null>(harness, 'setButton', { id: 2, pressed: true });
      harness.run(10 * US);
      // Falling edge latches 0x3C; later D=0x22 must not pass through.
      expect(call<number>(harness, 'getLedState', null)).toBe(0xc3);
      expect(harness.state('ledLatch')).toBe(0x3c);
      expect(ledEvents(harness)).toHaveLength(beforeClose);
    } finally {
      harness.dispose();
    }
  });

  it('透明期 LCD 读驱动 PC8–PC15 时，573 看到 LCD 数据而不是 MCU 释放值', async () => {
    const harness = await createBoardHarness(fixture('led-read'));

    try {
      harness.run(10 * US);
      // index 0 reads 0x9325; high byte 0x93 -> Q=0x93, lit mask 0x6C.
      expect(call<number>(harness, 'getLedState', null)).toBe(0x6c);
    } finally {
      harness.dispose();
    }
  });

  it('LCD 全屏 GRAM 写入改变 PC0–PC15 时已关闭的锁存保持不变', async () => {
    const harness = await createBoardHarness(fixture('led-lcd'));

    try {
      harness.run(40 * MS);
      expect(call<number>(harness, 'getLedState', null)).toBe(0x5a);
      expect(harness.state('ledLatch')).toBe(0xa5);
      expect(harness.state('fusedGramStores')).toBe(320 * 240);

      const gram = harness.memory('gram');
      const view = new DataView(gram.buffer, gram.byteOffset, gram.byteLength);
      const first = view.getUint16(0, true);
      const last = view.getUint16(gram.length - 2, true);
      expect(first).toBe(0x001f);
      expect(last).toBe(0x001f);
      expect(Array.from({ length: 8 }, (_, row) => view.getUint16(row * 640, true))).toEqual(
        Array.from({ length: 8 }, () => 0x001f),
      );
    } finally {
      harness.dispose();
    }
  });
});

describe('4 按键', () => {
  it('按原理图分别拉低 B1/B2/B3/B4，重复设置不发事件', async () => {
    const harness = await createBoardHarness(fixture('buttons'));

    try {
      harness.run(5 * US);
      expect(word(harness.memory('sram'), 0)).toBe(0b1111);

      const ids = [1, 2, 3, 4] as const;
      let expected = 0b1111;
      for (const id of ids) {
        call<null>(harness, 'setButton', { id, pressed: true });
        harness.run(5 * US);
        expected &= ~(1 << (id - 1));
        expect(word(harness.memory('sram'), 0), `button ${id}`).toBe(expected);
        expect(call<boolean>(harness, 'getButton', { id })).toBe(true);
      }

      const beforeRepeat = buttonEvents(harness).length;
      call<null>(harness, 'setButton', { id: 4, pressed: true });
      harness.run(5 * US);
      expect(buttonEvents(harness)).toHaveLength(beforeRepeat);
      expect(harness.events.filter((event) => event.name === 'button')).toHaveLength(4);

      for (const id of ids) {
        call<null>(harness, 'setButton', { id, pressed: false });
      }
      harness.run(5 * US);
      expect(word(harness.memory('sram'), 0)).toBe(0b1111);
    } finally {
      harness.dispose();
    }
  });

  it('非法按键 id/类型被 MethodError 拒绝且不改变状态', async () => {
    const harness = await createBoardHarness(fixture('buttons'));

    try {
      harness.run(5 * US);
      expect(() => call(harness, 'setButton', { id: 0, pressed: true })).toThrow(/button id/);
      expect(() => call(harness, 'setButton', { id: 1, pressed: 1 })).toThrow(
        /pressed must be a boolean/,
      );
      expect(call<boolean>(harness, 'getButton', { id: 1 })).toBe(false);
    } finally {
      harness.dispose();
    }
  });
});

describe('两路 ADC 电位器', () => {
  function adcCodes(harness: BoardHarness): { adc1: number; adc2: number } {
    const sram = harness.memory('sram');
    return { adc1: word(sram, 0) & 0xffff, adc2: word(sram, 4) & 0xffff };
  }

  it('位置 0/0.5/1：ADC1_IN11 与 ADC2_IN15 单调且 ±1 LSB', async () => {
    const harness = await createBoardHarness(fixture('adc'));

    try {
      const positions = [0, 0.5, 1] as const;
      for (const position of positions) {
        call<null>(harness, 'setPotentiometer', { id: 1, position });
        call<null>(harness, 'setPotentiometer', { id: 2, position });
        call<null>(harness, 'setButton', { id: 1, pressed: true });
        harness.run(30 * US);

        const { adc1, adc2 } = adcCodes(harness);
        const expected = position === 1 ? 4095 : Math.round(position * 4096);
        expect(Math.abs(adc1 - expected), `ADC1 at ${position}`).toBeLessThanOrEqual(1);
        expect(Math.abs(adc2 - expected), `ADC2 at ${position}`).toBeLessThanOrEqual(1);
      }
    } finally {
      harness.dispose();
    }
  });

  it('改位置后新采样生效；重复设置不发事件、不重排时间线', async () => {
    const harness = await createBoardHarness(fixture('adc'));

    try {
      call<null>(harness, 'setPotentiometer', { id: 1, position: 0.25 });
      call<null>(harness, 'setPotentiometer', { id: 2, position: 0.75 });
      call<null>(harness, 'setButton', { id: 1, pressed: true });
      harness.run(30 * US);

      const first = adcCodes(harness);
      // id 1 = R37/PB15 = ADC2_IN15; id 2 = R38/PB12 = ADC1_IN11.
      expect(Math.abs(first.adc1 - 3072)).toBeLessThanOrEqual(1);
      expect(Math.abs(first.adc2 - 1024)).toBeLessThanOrEqual(1);

      const before = potEvents(harness).length;
      const timeBefore = harness.board.time;
      call<null>(harness, 'setPotentiometer', { id: 1, position: 0.25 });
      call<null>(harness, 'setPotentiometer', { id: 2, position: 0.75 });
      harness.run(30 * US);
      expect(potEvents(harness)).toHaveLength(before);
      expect(call<number>(harness, 'getPotentiometer', { id: 1 })).toBe(0.25);
      expect(call<number>(harness, 'getPotentiometer', { id: 2 })).toBe(0.75);
      expect(harness.board.time).toBeGreaterThan(timeBefore);

      call<null>(harness, 'setPotentiometer', { id: 1, position: 1 });
      call<null>(harness, 'setPotentiometer', { id: 2, position: 0 });
      harness.run(30 * US);
      const second = adcCodes(harness);
      expect(Math.abs(second.adc1 - 0)).toBeLessThanOrEqual(1);
      expect(Math.abs(second.adc2 - 4095)).toBeLessThanOrEqual(1);
      expect(potEvents(harness)).toHaveLength(before + 2);
    } finally {
      harness.dispose();
    }
  });

  it('未置 ADSTART 时 DR 保持 0，不伪造转换结果', async () => {
    const harness = await createBoardHarness(fixture('adc-idle'));

    try {
      harness.run(10 * US);
      expect(word(harness.memory('sram'), 0)).toBe(0);
    } finally {
      harness.dispose();
    }
  });
});
