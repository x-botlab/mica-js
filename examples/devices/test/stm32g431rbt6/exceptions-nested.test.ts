import { describe, expect, it } from 'vitest';
import { systemBoard } from './system-harness';
import { SystemThumb, vectorOf } from './system-thumb';

/**
 * 标准主 MCU adapter 的嵌套异常回归：
 * TIM2 IRQ28（优先级 0x80）先进入，handler 内等待；TIM6 IRQ54（优先级 0）抢占。
 * 高优先级返回 EXC_RETURN=0xFFFFFFF1（回 handler/MSP），低优先级最终返回
 * EXC_RETURN=0xFFFFFFF9（回 thread/MSP）。不依赖 rig 替身。
 */

const SRAM_BASE = 0x2000_0000;
const TIM2 = 0x4000_0000;
const TIM6 = 0x4000_1000;
const RCC = 0x4002_1000;
const NVIC_IPR = 0xe000_e400;
const NVIC_ISER0 = 0xe000_e100;
const NVIC_ISER1 = 0xe000_e104;

const ARR = 0x2c;
const DIER = 0x0c;
const SR = 0x10;
const PSC = 0x28;
const CR1 = 0x00;

function at(t: SystemThumb, register: number, value: number): void {
  t.movw(register, value & 0xffff).movt(register, value >>> 16);
}

describe('STM32G431RBT6 TIM 嵌套异常', () => {
  it('TIM6 IRQ54 抢占 TIM2 IRQ28，F1 回 handler 后 F9 回 thread', async () => {
    const t = new SystemThumb();

    t.vector(vectorOf(28), 'irq28').vector(vectorOf(54), 'irq54');
    t.mark('start');
    at(t, 0, RCC);
    t.movs(1, 0x11).strWord(1, 0, 0x58); // TIM2EN | TIM6EN
    at(t, 0, TIM2);
    t.movs(1, 9).strWord(1, 0, ARR); // 10 ticks = 625 ns @16 MHz
    t.movs(1, 0).strWord(1, 0, PSC);
    t.movs(1, 1).strWord(1, 0, DIER);
    at(t, 0, TIM6);
    t.movs(1, 49).strWord(1, 0, ARR); // 50 ticks = 3.125 us
    t.movs(1, 0).strWord(1, 0, PSC);
    t.movs(1, 1).strWord(1, 0, DIER);

    at(t, 0, NVIC_IPR + 28);
    t.movs(1, 0x80).strByte(1, 0, 0); // IRQ28 低优先级
    at(t, 0, NVIC_ISER0);
    t.movw(1, 0x0000).movt(1, 0x1000).strWord(1, 0, 0); // bit28
    at(t, 0, NVIC_ISER1);
    t.movw(1, 0x0000).movt(1, 0x0040).strWord(1, 0, 0); // bit22 = IRQ54
    // 最后才启动 TIM2/TIM6，保证 NVIC 已配置。
    at(t, 0, TIM2);
    t.movs(1, 1).strWord(1, 0, CR1);
    at(t, 0, TIM6);
    t.movs(1, 1).strWord(1, 0, CR1);
    t.spin();

    t.mark('irq28');
    at(t, 0, SRAM_BASE + 0x500);
    t.movs(1, 1).strWord(1, 0, 0); // low-start
    t.push(0x100).pop(0x02);
    at(t, 0, SRAM_BASE + 0x508);
    t.strWord(1, 0, 0); // low EXC_RETURN (expect f9)
    at(t, 2, SRAM_BASE + 0x504); // flag
    t.mark('lowWait');
    t.ldrWord(1, 2, 0).cmp(1, 0).bcond(0, 'lowWait');
    at(t, 0, SRAM_BASE + 0x50c);
    t.movs(1, 3).strWord(1, 0, 0); // low-end
    at(t, 0, TIM2);
    t.movs(1, 0).strWord(1, 0, SR); // clear UIF
    t.bx(14);

    t.mark('irq54');
    at(t, 0, SRAM_BASE + 0x504);
    t.movs(1, 1).strWord(1, 0, 0); // flag
    t.push(0x100).pop(0x02);
    at(t, 0, SRAM_BASE + 0x510);
    t.strWord(1, 0, 0); // high EXC_RETURN (expect f1)
    at(t, 0, SRAM_BASE + 0x514);
    t.movs(1, 2).strWord(1, 0, 0); // high marker
    at(t, 0, TIM6);
    t.movs(1, 0).strWord(1, 0, SR);
    t.bx(14);

    const board = await systemBoard({ firmware: t.build(), clockFrequency: 16_000_000 });

    try {
      board.run(20_000_000);
      expect(board.faults).toEqual([]);
      expect(board.sramWord(0x500)).toBe(1);
      expect(board.sramWord(0x504)).toBe(1);
      expect(board.sramWord(0x50c)).toBe(3);
      expect(board.sramWord(0x508)).toBe(0xfffffff9);
      expect(board.sramWord(0x510)).toBe(0xfffffff1);
      expect(board.sramWord(0x514)).toBe(2);
    } finally {
      board.dispose();
    }
  });
});
