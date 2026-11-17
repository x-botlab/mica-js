import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { systemBoard } from './system-harness';

/**
 * 标准主 MCU 固件：LDREX 后的外部 IRQ 必须清 exclusive monitor；异常返回置 event
 * 让一次 WFE 立即通过并被消费，第二次 WFE 无事件阻塞。
 */
describe('STM32G431RBT6 exclusive / WFE 事件', () => {
  it('异常入口清 exclusive，异常返回 event 供一次 WFE 消费', async () => {
    const firmware = new Uint8Array(
      readFileSync(join(import.meta.dirname, 'fixtures', 'exclusive-wfe.bin')),
    );
    const board = await systemBoard({ firmware, clockFrequency: 16_000_000 });

    try {
      board.run(1_000_000_000);
      expect(board.faults).toEqual([]);
      expect(board.sramWord(0x100)).toBe(1); // STREX failed
      expect(board.sramWord(0x104)).toBe(0x11); // first WFE passed
      expect(board.sramWord(0x108)).toBe(0); // second WFE blocked
      expect(board.sramWord(0x10c)).toBe(1); // one IRQ
      expect(board.sysWord(0x14c)).toBe(0); // event consumed
    } finally {
      board.dispose();
    }
  });
});
