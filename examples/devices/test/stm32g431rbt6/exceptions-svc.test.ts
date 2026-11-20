import { describe, expect, it } from 'vitest';
import { systemBoard } from './system-harness';
import { SystemThumb } from './system-thumb';

/**
 * SVC 同步异常的真实指令路径：`svc #0` → 8 字栈帧 → SVCall handler (IPSR=11) →
 * BX LR 返回 SVC 的下一条指令。优先级掩蔽升级 HardFault 由 `enterSvc` 统一处理。
 */

const SRAM_BASE = 0x2000_0000;
const SCB_SHPR2 = 0xe000_ed1c;

function address(t: SystemThumb, register: number, value: number): void {
  t.movw(register, value & 0xffff).movt(register, value >>> 16);
}

describe('STM32G431RBT6 SVC 异常', () => {
  it('svc #0 压栈进入 SVCall，IPSR=11 并返回下一条指令', async () => {
    const t = new SystemThumb();

    t.vector(11, 'svc');
    t.mark('start');
    address(t, 0, SRAM_BASE + 0x100);
    t.svc(0);
    t.movs(1, 0x77);
    t.strWord(1, 0, 4);
    t.spin();

    t.mark('svc');
    // 读 IPSR 与栈帧里的返回 PC，写回 SRAM。
    t.mrs(1, 5);
    address(t, 0, SRAM_BASE + 0x100);
    t.strWord(1, 0, 0);
    t.mrs(2, 8);
    t.ldrWord(3, 2, 24);
    t.strWord(3, 0, 8);
    t.bx(14);

    const board = await systemBoard({ firmware: t.build(), clockFrequency: 16_000_000 });

    try {
      board.run(1_000_000_000);
      expect(board.faults).toEqual([]);
      expect(board.sramWord(0x100)).toBe(11);
      // 返回地址应指向 svc 之后、两个半字处的 movs。
      const returnPc = board.sramWord(0x108);
      expect(returnPc).toBeGreaterThan(0x0800_0000);
      expect(returnPc & 1).toBe(0);
      expect(board.sramWord(0x104)).toBe(0x77);
    } finally {
      board.dispose();
    }
  });

  it('BASEPRI 屏蔽的 SVC 升级为 HardFault', async () => {
    const t = new SystemThumb();

    t.vector(3, 'hardfault').vector(11, 'svc');
    t.mark('start');
    // SVCall 优先级 0x80；BASEPRI=0x40 屏蔽它。
    address(t, 0, SCB_SHPR2);
    t.movw(1, 0x0000).movt(1, 0x8000).strWord(1, 0, 0);
    t.movs(1, 0x40);
    t.msr(1, 17);
    t.svc(0);
    t.spin();

    t.mark('hardfault');
    address(t, 0, SRAM_BASE + 0x110);
    t.movs(1, 0xfa);
    t.strWord(1, 0, 0);
    t.bx(14);

    t.mark('svc');
    address(t, 0, SRAM_BASE + 0x114);
    t.movs(1, 0x5c);
    t.strWord(1, 0, 0);
    t.bx(14);

    const board = await systemBoard({ firmware: t.build(), clockFrequency: 16_000_000 });

    try {
      board.run(1_000_000_000);
      expect(board.faults).toEqual([]);
      expect(board.sramWord(0x110)).toBe(0xfa);
      expect(board.sramWord(0x114)).toBe(0);
    } finally {
      board.dispose();
    }
  });
});
