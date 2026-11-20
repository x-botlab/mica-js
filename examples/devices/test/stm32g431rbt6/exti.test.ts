import { describe, expect, it } from 'vitest';
import { systemBoard } from './system-harness';
import { SystemThumb, vectorOf } from './system-thumb';

/**
 * EXTI/SYSCFG 真实路由：GPIO 边沿 → PR → IMR → NVIC。
 * 覆盖屏蔽期挂起、W1C、SWIER、共享 IRQ 分组与 EXTICR 端口选择。
 */

const SRAM_BASE = 0x2000_0000;
const EXTI_IMR1 = 0x4001_0400;
const EXTI_RTSR1 = 0x4001_0408;
const EXTI_FTSR1 = 0x4001_040c;
const EXTI_SWIER1 = 0x4001_0410;
const EXTI_PR1 = 0x4001_0414;
const SYSCFG_EXTICR1 = 0x4001_0008;
const SYSCFG_EXTICR2 = 0x4001_000c;
const NVIC_ISER0 = 0xe000_e100;
const NVIC_ICPR0 = 0xe000_e280;

function address(t: SystemThumb, register: number, value: number): void {
  t.movw(register, value & 0xffff).movt(register, value >>> 16);
}

function increment(t: SystemThumb, at: number): void {
  address(t, 0, at);
  t.ldrWord(1, 0, 0).adds(1, 1).strWord(1, 0, 0);
}

function clearPending(t: SystemThumb, line: number, irq: number): void {
  address(t, 0, EXTI_PR1);
  t.movs(1, 1 << line).strWord(1, 0, 0);
  address(t, 0, NVIC_ICPR0);
  t.movw(1, 1 << irq).strWord(1, 0, 0).bx(14);
}

describe('STM32G431RBT6 EXTI / SYSCFG', () => {
  it('PA0 上升沿经 EXTI0 进入 IRQ6，并在 handler 清 PR 后可再次触发', async () => {
    const t = new SystemThumb();

    t.vector(vectorOf(6), 'exti0');
    t.mark('start');
    address(t, 0, SYSCFG_EXTICR1);
    t.movs(1, 0).strWord(1, 0, 0);
    address(t, 0, EXTI_RTSR1);
    t.movs(1, 1).strWord(1, 0, 0);
    address(t, 0, EXTI_IMR1);
    t.movs(1, 1).strWord(1, 0, 0);
    address(t, 0, NVIC_ISER0);
    t.movs(1, 0x40).strWord(1, 0, 0);
    t.spin();

    t.mark('exti0');
    increment(t, SRAM_BASE + 0x300);
    clearPending(t, 0, 6);

    const board = await systemBoard({
      firmware: t.build(),
      clockFrequency: 16_000_000,
      pins: ['PA0'],
      initialLevels: { PA0: 0 },
    });

    try {
      board.run(100_000_000);
      board.inputs.PA0!.send(1);
      board.run(100_000_000);
      expect(board.faults).toEqual([]);
      expect(board.sramWord(0x300)).toBe(1);

      board.inputs.PA0!.send(0);
      board.run(50_000_000);
      board.inputs.PA0!.send(1);
      board.run(100_000_000);
      expect(board.sramWord(0x300)).toBe(2);
    } finally {
      board.dispose();
    }
  });

  it('IMR 屏蔽时边沿仍置 PR，解除屏蔽后补发；SWIER 无需引脚', async () => {
    const t = new SystemThumb();

    t.vector(vectorOf(6), 'exti0');
    t.mark('start');
    address(t, 0, EXTI_RTSR1);
    t.movs(1, 1).strWord(1, 0, 0);
    // 用 PB0 作为“现在解除 IMR 屏蔽”的握手输入；屏蔽期先产生 PA0 上升沿。
    address(t, 2, 0x4800_0410);
    t.mark('wait');
    t.ldrWord(1, 2, 0).movs(3, 1).ands(1, 3).cmp(1, 0).bcond(1, 'wait');
    address(t, 0, EXTI_IMR1);
    t.movs(1, 1).strWord(1, 0, 0);
    address(t, 0, NVIC_ISER0);
    t.movs(1, 0x40).strWord(1, 0, 0);
    t.spin();

    t.mark('exti0');
    increment(t, SRAM_BASE + 0x300);
    address(t, 0, EXTI_PR1);
    t.movs(1, 1).strWord(1, 0, 0);
    address(t, 0, NVIC_ICPR0);
    t.movs(1, 0x40).strWord(1, 0, 0).bx(14);

    const board = await systemBoard({
      firmware: t.build(),
      clockFrequency: 16_000_000,
      pins: ['PA0', 'PB0'],
      initialLevels: { PA0: 0, PB0: 0 },
    });

    try {
      board.run(50_000_000);
      // IMR=0：上升沿仍应置 PR。
      board.inputs.PA0!.send(1);
      board.run(50_000_000);
      // 握手后才解除 IMR；挂起的 PR 应立即可见。
      board.inputs.PB0!.send(1);
      board.run(100_000_000);
      expect(board.faults).toEqual([]);
      expect(board.sramWord(0x300)).toBe(1);

      // PR 已清；SWIER 写 1 再产生一次。
      const board2 = await systemBoard({
        firmware: (() => {
          const u = new SystemThumb();

          u.vector(vectorOf(6), 'exti0');
          u.mark('start');
          address(u, 0, EXTI_IMR1);
          u.movs(1, 1).strWord(1, 0, 0);
          address(u, 0, EXTI_SWIER1);
          u.movs(1, 1).strWord(1, 0, 0);
          address(u, 0, NVIC_ISER0);
          u.movs(1, 0x40).strWord(1, 0, 0);
          u.spin();
          u.mark('exti0');
          increment(u, SRAM_BASE + 0x320);
          address(u, 0, EXTI_PR1);
          u.movs(1, 1).strWord(1, 0, 0);
          address(u, 0, NVIC_ICPR0);
          u.movs(1, 0x40).strWord(1, 0, 0).bx(14);

          return u.build();
        })(),
        clockFrequency: 16_000_000,
      });

      try {
        board2.run(100_000_000);
        expect(board2.faults).toEqual([]);
        expect(board2.sramWord(0x320)).toBe(1);
      } finally {
        board2.dispose();
      }
    } finally {
      board.dispose();
    }
  });

  it('EXTICR 选择 PB0，EXTI 共享分组 9_5 使用 IRQ23', async () => {
    const t = new SystemThumb();

    t.vector(vectorOf(6), 'exti0').vector(vectorOf(23), 'exti9_5');
    t.mark('start');
    // line0 -> PB0（EXTICR1 nibble0 = 1）。
    address(t, 0, SYSCFG_EXTICR1);
    t.movs(1, 1).strWord(1, 0, 0);
    // line5 -> PB5（EXTICR2 的 nibble1 = 1）。
    address(t, 0, SYSCFG_EXTICR2);
    t.movs(1, 0x10).strWord(1, 0, 0);
    address(t, 0, EXTI_FTSR1);
    t.movs(1, 0x20).strWord(1, 0, 0);
    address(t, 0, EXTI_RTSR1);
    t.movs(1, 1).strWord(1, 0, 0);
    address(t, 0, EXTI_IMR1);
    t.movs(1, 0x21).strWord(1, 0, 0);
    address(t, 0, NVIC_ISER0);
    t.movw(1, 0x0040).movt(1, 0x0080).strWord(1, 0, 0);
    t.spin();

    t.mark('exti0');
    increment(t, SRAM_BASE + 0x334);
    address(t, 0, EXTI_PR1);
    t.movs(1, 1).strWord(1, 0, 0);
    address(t, 0, NVIC_ICPR0);
    t.movs(1, 0x40).strWord(1, 0, 0).bx(14);

    t.mark('exti9_5');
    increment(t, SRAM_BASE + 0x338);
    address(t, 0, EXTI_PR1);
    t.movs(1, 0x20).strWord(1, 0, 0);
    address(t, 0, NVIC_ICPR0);
    t.movw(1, 0x0000).movt(1, 0x0080).strWord(1, 0, 0).bx(14);

    const board = await systemBoard({
      firmware: t.build(),
      clockFrequency: 16_000_000,
      pins: ['PA0', 'PB0', 'PB5'],
      initialLevels: { PA0: 0, PB0: 0, PB5: 0 },
    });

    try {
      board.run(50_000_000);
      // PA0 不再是 line0 的源；这个上升沿不得触发。
      board.inputs.PA0!.send(1);
      board.run(50_000_000);
      expect(board.sramWord(0x334)).toBe(0);

      board.inputs.PB0!.send(1);
      board.run(100_000_000);
      expect(board.faults).toEqual([]);
      expect(board.sramWord(0x334)).toBe(1);

      // PB5 下降沿进入共享 IRQ23。
      board.inputs.PB5!.send(1);
      board.run(50_000_000);
      board.inputs.PB5!.send(0);
      board.run(100_000_000);
      expect(board.sramWord(0x338)).toBe(1);
    } finally {
      board.dispose();
    }
  });
});
