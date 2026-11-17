import { describe, expect, it } from 'vitest';
import { systemBoard } from './system-harness';
import { SystemThumb, vectorOf } from './system-thumb';

/**
 * 真实 G431 器件 + JIT 的手写 Thumb 固件：
 * - 4 个 NVIC bank（IRQ37/91 分属 bank1/2）；
 * - IPR 优先级参与仲裁；
 * - PRIMASK 只延迟可配置异常；
 * - PendSV/NMI 入口；
 * - 嵌套异常与 EXC_RETURN（thread MSP=0xFFFFFFF9、nested handler=0xFFFFFFF1）。
 */

const SRAM_BASE = 0x2000_0000;
const NVIC_ISER1 = 0xe000_e104;
const NVIC_ISPR1 = 0xe000_e204;
const NVIC_ICPR1 = 0xe000_e284;
const NVIC_ISER2 = 0xe000_e108;
const NVIC_ISPR2 = 0xe000_e208;
const NVIC_ICPR2 = 0xe000_e288;
const NVIC_IPR = 0xe000_e400;
const SCB_ICSR = 0xe000_ed04;

function address(t: SystemThumb, register: number, value: number): void {
  t.movw(register, value & 0xffff).movt(register, value >>> 16);
}

function increment(t: SystemThumb, addressValue: number): void {
  address(t, 0, addressValue);
  t.ldrWord(1, 0, 0).adds(1, 1).strWord(1, 0, 0);
}

describe('STM32G431RBT6 NVIC 多 bank 与优先级', () => {
  it('使能并挂起 bank1(IRQ37) 与 bank2(IRQ91)', async () => {
    const t = new SystemThumb();

    t.vector(vectorOf(37), 'irq37').vector(vectorOf(91), 'irq91');
    t.mark('start');
    address(t, 0, NVIC_ISER1);
    t.movs(1, 0x20).strWord(1, 0, 0);
    address(t, 0, NVIC_ISPR1);
    t.movs(1, 0x20).strWord(1, 0, 0);
    address(t, 0, NVIC_ISER2);
    t.movw(1, 0x0000).movt(1, 0x0800).strWord(1, 0, 0);
    address(t, 0, NVIC_ISPR2);
    t.movw(1, 0x0000).movt(1, 0x0800).strWord(1, 0, 0);
    t.spin();

    t.mark('irq37');
    increment(t, SRAM_BASE + 0x100);
    address(t, 0, NVIC_ICPR1);
    t.movs(1, 0x20).strWord(1, 0, 0).bx(14);

    t.mark('irq91');
    increment(t, SRAM_BASE + 0x104);
    address(t, 0, NVIC_ICPR2);
    t.movw(1, 0x0000).movt(1, 0x0800).strWord(1, 0, 0).bx(14);

    const board = await systemBoard({ firmware: t.build(), clockFrequency: 16_000_000 });

    try {
      board.run(1_000_000_000);
      expect(board.faults).toEqual([]);
      expect(board.sramWord(0x100)).toBe(1);
      expect(board.sramWord(0x104)).toBe(1);
    } finally {
      board.dispose();
    }
  });

  it('bank1 bit31（IRQ63）通过 STIR 挂起并派发', async () => {
    const t = new SystemThumb();

    t.vector(79, 'irq63'); // 63 + 16 = 79
    t.mark('start');
    address(t, 0, NVIC_ISER1);
    t.movw(1, 0x0000).movt(1, 0x8000).strWord(1, 0, 0);
    address(t, 0, 0xe000_ef00); // NVIC->STIR
    t.movs(1, 63).strWord(1, 0, 0);
    t.spin();

    t.mark('irq63');
    increment(t, SRAM_BASE + 0x130);
    address(t, 0, NVIC_ICPR1);
    t.movw(1, 0x0000).movt(1, 0x8000).strWord(1, 0, 0).bx(14);

    const board = await systemBoard({ firmware: t.build(), clockFrequency: 16_000_000 });

    try {
      board.run(1_000_000_000);
      expect(board.faults).toEqual([]);
      expect(board.sramWord(0x130)).toBe(1);
    } finally {
      board.dispose();
    }
  });

  it('ISPR1 bit31（IRQ63 软件 pending）跨 bank 派发', async () => {
    const t = new SystemThumb();

    t.vector(79, 'irq63');
    t.mark('start');
    address(t, 0, NVIC_ISER1);
    t.movw(1, 0x0000).movt(1, 0x8000).strWord(1, 0, 0);
    address(t, 0, NVIC_ISPR1);
    t.movw(1, 0x0000).movt(1, 0x8000).strWord(1, 0, 0);
    t.spin();

    t.mark('irq63');
    increment(t, SRAM_BASE + 0x134);
    address(t, 0, NVIC_ICPR1);
    t.movw(1, 0x0000).movt(1, 0x8000).strWord(1, 0, 0).bx(14);

    const board = await systemBoard({ firmware: t.build(), clockFrequency: 16_000_000 });

    try {
      board.run(1_000_000_000);
      expect(board.faults).toEqual([]);
      expect(board.sramWord(0x134)).toBe(1);
    } finally {
      board.dispose();
    }
  });

  it('IPR 优先级决定两个同时挂起异常的先后', async () => {
    const t = new SystemThumb();

    t.vector(vectorOf(37), 'irq37').vector(vectorOf(40), 'irq40');
    t.mark('start');
    address(t, 0, NVIC_IPR + 0x24);
    t.movs(1, 0x40).strByte(1, 0, 1);
    address(t, 0, NVIC_IPR + 0x28);
    t.movs(1, 0x80).strByte(1, 0, 0);
    address(t, 0, NVIC_ISER1);
    t.movs(1, 0x00).movw(1, 0x0120).strWord(1, 0, 0);
    address(t, 0, NVIC_ISPR1);
    t.movw(1, 0x0120).strWord(1, 0, 0);
    t.spin();

    t.mark('irq37');
    address(t, 0, SRAM_BASE + 0x200);
    t.movs(1, 37).strWord(1, 0, 0);
    address(t, 0, NVIC_ICPR1);
    t.movs(1, 0x20).strWord(1, 0, 0).bx(14);

    t.mark('irq40');
    address(t, 0, SRAM_BASE + 0x204);
    t.movs(1, 40).strWord(1, 0, 0);
    address(t, 0, NVIC_ICPR1);
    t.movw(1, 0x0100).strWord(1, 0, 0).bx(14);

    const board = await systemBoard({ firmware: t.build(), clockFrequency: 16_000_000 });

    try {
      board.run(1_000_000_000);
      expect(board.faults).toEqual([]);
      expect(board.sramWord(0x200)).toBe(37);
      expect(board.sramWord(0x204)).toBe(40);
    } finally {
      board.dispose();
    }
  });

  it('PRIMASK 期间挂起保持，cpsie 后才进入 handler', async () => {
    const t = new SystemThumb();

    t.vector(vectorOf(37), 'irq37');
    t.mark('start');
    address(t, 0, NVIC_ISER1);
    t.movs(1, 0x20).strWord(1, 0, 0);
    t.cpsid();
    address(t, 0, NVIC_ISPR1);
    t.movs(1, 0x20).strWord(1, 0, 0);
    // 让 CPU 在屏蔽期执行一段时间；中断不得进入。
    address(t, 2, SRAM_BASE + 0x108);
    t.movs(3, 1).strWord(3, 2, 0);
    t.cpsie();
    t.spin();

    t.mark('irq37');
    increment(t, SRAM_BASE + 0x100);
    address(t, 0, NVIC_ICPR1);
    t.movs(1, 0x20).strWord(1, 0, 0).bx(14);

    const board = await systemBoard({ firmware: t.build(), clockFrequency: 16_000_000 });

    try {
      board.run(1_000_000_000);
      expect(board.faults).toEqual([]);
      expect(board.sramWord(0x108)).toBe(1);
      expect(board.sramWord(0x100)).toBe(1);
    } finally {
      board.dispose();
    }
  });

  it('NMI 先于 PendSV，且两者从 ICSR 取走', async () => {
    const t = new SystemThumb();

    t.vector(2, 'nmi').vector(14, 'pendsv');
    t.mark('start');
    address(t, 0, SCB_ICSR);
    t.movw(1, 0x0000).movt(1, 0x1000).strWord(1, 0, 0);
    t.movw(1, 0x0000).movt(1, 0x8000).strWord(1, 0, 0);
    t.spin();

    t.mark('nmi');
    address(t, 0, SRAM_BASE + 0x110);
    t.movs(1, 1).strWord(1, 0, 0).bx(14);

    t.mark('pendsv');
    address(t, 0, SRAM_BASE + 0x114);
    t.movs(1, 2).strWord(1, 0, 0);
    address(t, 0, SCB_ICSR);
    t.movw(1, 0x0000).movt(1, 0x0800).strWord(1, 0, 0).bx(14);

    const board = await systemBoard({ firmware: t.build(), clockFrequency: 16_000_000 });

    try {
      board.run(1_000_000_000);
      expect(board.faults).toEqual([]);
      expect(board.sramWord(0x110)).toBe(1);
      expect(board.sramWord(0x114)).toBe(2);
    } finally {
      board.dispose();
    }
  });

  it('低优先级 handler 被高优先级异常抢占并正确返回，EXC_RETURN 区分 MSP/handler', async () => {
    const t = new SystemThumb();

    t.vector(vectorOf(37), 'high').vector(vectorOf(40), 'low');
    t.mark('start');
    address(t, 0, NVIC_IPR + 0x25);
    t.movs(1, 0x20).strByte(1, 0, 0);
    address(t, 0, NVIC_IPR + 0x28);
    t.movs(1, 0x80).strByte(1, 0, 0);
    address(t, 0, NVIC_ISER1);
    t.movw(1, 0x0120).strWord(1, 0, 0);
    address(t, 0, NVIC_ISPR1);
    t.movw(1, 0x0100).strWord(1, 0, 0);
    t.spin();

    t.mark('low');
    t.push(0x100).pop(0x02);
    address(t, 0, SRAM_BASE + 0x210);
    t.strWord(1, 0, 0);
    address(t, 0, SRAM_BASE + 0x200);
    t.movs(1, 1).strWord(1, 0, 0);
    // 在低优先级 handler 内挂起高优先级 IRQ37。
    address(t, 0, NVIC_ISPR1);
    t.movs(1, 0x20).strWord(1, 0, 0);
    address(t, 0, SRAM_BASE + 0x20c);
    t.mark('wait');
    t.ldrWord(1, 0, 0).cmp(1, 0).bcond(0, 'wait');
    address(t, 0, SRAM_BASE + 0x208);
    t.movs(1, 3).strWord(1, 0, 0);
    address(t, 0, NVIC_ICPR1);
    t.movw(1, 0x0100).strWord(1, 0, 0).bx(14);

    t.mark('high');
    t.push(0x100).pop(0x02);
    address(t, 0, SRAM_BASE + 0x214);
    t.strWord(1, 0, 0);
    address(t, 0, SRAM_BASE + 0x204);
    t.movs(1, 2).strWord(1, 0, 0);
    address(t, 0, SRAM_BASE + 0x20c);
    t.movs(1, 1).strWord(1, 0, 0);
    address(t, 0, NVIC_ICPR1);
    t.movs(1, 0x20).strWord(1, 0, 0).bx(14);

    const board = await systemBoard({ firmware: t.build(), clockFrequency: 16_000_000 });

    try {
      board.run(1_000_000_000);
      expect(board.faults).toEqual([]);
      expect(board.sramWord(0x200)).toBe(1);
      expect(board.sramWord(0x204)).toBe(2);
      expect(board.sramWord(0x208)).toBe(3);
      // low handler 的 LR 是 thread/MSP；high 是嵌套 handler/MSP。
      expect(board.sramWord(0x210)).toBe(0xfffffff9);
      expect(board.sramWord(0x214)).toBe(0xfffffff1);
    } finally {
      board.dispose();
    }
  });
});
