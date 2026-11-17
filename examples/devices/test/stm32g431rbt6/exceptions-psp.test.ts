import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { systemBoard } from './system-harness';

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
