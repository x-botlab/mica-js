import { describe, expect, it } from 'vitest';
import { systemBoard } from './system-harness';
import { SystemThumb } from './system-thumb';

/**
 * 复位验收：AIRCR.SYSRESETREQ 与 NRST 都保留 Flash/SRAM，清 CPU/外设/IRQ/GPIO。
 * 手写固件用 SRAM 计数器区分“同一份固件重新执行”和“模型被重新装载”。
 */

const SRAM_BASE = 0x2000_0000;
const SCB_AIRCR = 0xe000_ed0c;

function address(t: SystemThumb, register: number, value: number): void {
  t.movw(register, value & 0xffff).movt(register, value >>> 16);
}

function bootCount(t: SystemThumb): void {
  address(t, 2, SRAM_BASE + 0x400);
  t.ldrWord(1, 2, 0).adds(1, 1).strWord(1, 2, 0);
}

function outputHighOnce(t: SystemThumb): void {
  address(t, 0, 0x4800_0000);
  t.movw(1, 0x0400).strWord(1, 0, 0);
  t.movs(1, 0x20);
  address(t, 0, 0x4800_0018);
  t.strWord(1, 0, 0);
}

describe('STM32G431RBT6 复位', () => {
  it('AIRCR.SYSRESETREQ 从向量表重启，SRAM 保留而 GPIO/NVIC/SysTick 复位', async () => {
    const t = new SystemThumb();

    t.mark('start');
    bootCount(t);
    address(t, 2, SRAM_BASE + 0x400);
    t.ldrWord(1, 2, 0).cmp(1, 2).bcond(0, 'skip');
    address(t, 0, SCB_AIRCR);
    t.movw(1, 0x0004).movt(1, 0x05fa).strWord(1, 0, 0);
    t.mark('skip');
    t.spin();

    const board = await systemBoard({
      firmware: t.build(),
      clockFrequency: 16_000_000,
    });

    try {
      board.run(200_000_000);
      expect(board.faults).toEqual([]);
      // 固件没有被重新装载：第二次启动看到 SRAM 计数 2 后停在 spin。
      expect(board.sramWord(0x400)).toBe(2);
      // 复位计数由同一 sys 区域的保留字记录。
      expect(board.sysWord(0x1fc)).toBe(1);
    } finally {
      board.dispose();
    }
  });

  it('NRST 保持低电平时不执行指令，释放后复位并从向量表重新启动', async () => {
    const t = new SystemThumb();

    t.mark('start');
    bootCount(t);
    address(t, 2, SRAM_BASE + 0x400);
    t.ldrWord(1, 2, 0).cmp(1, 2).bcond(0, 'loop');
    outputHighOnce(t);
    t.mark('loop');
    address(t, 2, SRAM_BASE + 0x404);
    t.ldrWord(1, 2, 0).adds(1, 1).strWord(1, 2, 0);
    t.b('loop');

    const board = await systemBoard({
      firmware: t.build(),
      clockFrequency: 16_000_000,
      pins: ['PA5', 'NRST'],
      initialLevels: { NRST: 1 },
    });

    try {
      board.run(200_000_000);
      expect(board.faults).toEqual([]);
      expect(board.sramWord(0x400)).toBe(1);
      expect(board.levels.PA5).toBe(1);
      expect(board.state('halted')).not.toBe(true);

      board.inputs.NRST!.send(0);
      board.run(200_000_000);
      expect(board.state('halted')).toBe(true);
      const frozen = board.sramWord(0x404);

      board.run(200_000_000);
      expect(board.sramWord(0x404)).toBe(frozen);
      // 低电平期间输出没有释放（复位发生在释放沿）。
      expect(board.levels.PA5).toBe(1);

      board.inputs.NRST!.send(1);
      board.run(200_000_000);
      expect(board.faults).toEqual([]);
      expect(board.sramWord(0x400)).toBe(2);
      expect(board.state('halted')).not.toBe(true);
      // 第二次启动跳过 outputHighOnce；NRST 释放复位必须释放 GPIO。
      expect(board.state('gpioOdr0')).toBe(0);
      expect(board.levels.PA5).toBe(2);
      expect(board.sysWord(0x1fc)).toBe(1);
      expect(board.sramWord(0x404)).toBeGreaterThanOrEqual(frozen);
    } finally {
      board.dispose();
    }
  });
});
