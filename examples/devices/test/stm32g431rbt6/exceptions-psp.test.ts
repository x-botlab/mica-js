import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { systemBoard } from './system-harness';
import { SystemThumb } from './system-thumb';

/** 标准主 MCU 固件（fixtures/psp-exception.S）：thread PSP + SVC 异常返回。 */
describe('STM32G431RBT6 PSP 异常返回', () => {
  it('SVC 压 PSP 栈、handler 用 MSP、EXC_RETURN=0xFFFFFFFD 并返回 PSP', async () => {
    const firmware = new Uint8Array(
      readFileSync(join(import.meta.dirname, 'fixtures', 'psp-exception.bin')),
    );
    const board = await systemBoard({ firmware, clockFrequency: 16_000_000 });

    try {
      board.run(1_000_000_000);
      expect(board.faults).toEqual([]);
      expect(board.sramWord(0x110)).toBe(0xfffffffd);
      expect(board.sramWord(0x114)).toBeGreaterThanOrEqual(0x2000_5700);
      expect(board.sramWord(0x114)).not.toBe(0x2000_5000);
      expect(board.sramWord(0x118)).toBe(11);
      // 返回后仍在 thread/PSP：0x100 是 PSP，0x104 是 SVC 后续指令写入。
      expect(board.sramWord(0x100)).toBe(0x2000_5000);
      expect(board.sramWord(0x104)).toBe(0x99);
      expect(board.sramWord(0x124)).toBe(0x2000_5800);
    } finally {
      board.dispose();
    }
  });
});

describe('STM32G431RBT6 exception stack alignment', () => {
  it.each([
    ['MSP', 8, 0x2000_5800],
    ['PSP', 9, 0x2000_5000],
  ] as const)('restores a word-aligned %s after SVC', async (_name, bank, stackTop) => {
    const t = new SystemThumb().vector(11, 'svc');
    if (bank === 9)
      t.movw(0, stackTop)
        .movt(0, stackTop >>> 16)
        .msr(0, 9)
        .movs(0, 2)
        .msr(0, 20);
    t.movt(4, 0x2000)
      .movs(2, 0x99)
      .push(1 << 2)
      .svc();
    t.half(0x466b).strWord(3, 4, 0); // MOV r3, sp
    t.pop(1 << 2)
      .strWord(2, 4, 4)
      .spin();
    t.mark('svc').mrs(3, bank).strWord(3, 4, 8).ldrWord(2, 3, 28).strWord(2, 4, 12).bx(14);

    const board = await systemBoard({ firmware: t.build() });
    try {
      board.run(1_000_000_000);
      expect(board.faults).toEqual([]);
      expect(board.sramWord(0)).toBe(stackTop - 4);
      expect(board.sramWord(4)).toBe(0x99);
      expect(board.sramWord(8)).toBe(stackTop - 40);
      expect(board.sramWord(12) & 0x200).toBe(0x200); // Stacked xPSR.STACKALIGN.
    } finally {
      board.dispose();
    }
  });
});
