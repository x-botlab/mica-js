import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RESET_CAUSE_IWDG,
  RESET_CAUSE_WWDG,
} from '@mica-js/stm32g431rbt6-core/reset';
import {
  RESET_CAUSE,
  RESET_COUNT,
  RESET_REQUEST,
} from '@mica-js/stm32g431rbt6-core/system-layout';
import { systemBoard } from './system-harness';

/**
 * 真实固件看门狗超时：第一次启动在 SRAM 写启动次数并启动短超时看门狗；
 * 超时经既有 reset sink 复位，第二次启动不再启动看门狗。启动次数为 2
 * 证明复位向量确实重新执行，而不是只留下 pending 标志。
 */
describe('STM32G431RBT6 看门狗超时复位', () => {
  it('WWDG 到期复位并重新执行向量，第二次启动不复位', async () => {
    const firmware = new Uint8Array(
      readFileSync(join(import.meta.dirname, 'fixtures', 'wwdg-reset.bin')),
    );
    const board = await systemBoard({ firmware, clockFrequency: 16_000_000 });

    try {
      board.run(1_000_000_000);
      expect(board.faults).toEqual([]);
      expect(board.sramWord(0x400)).toBe(2);
      expect(board.sramWord(0x404)).toBe(1);
      expect(board.sysWord(RESET_COUNT)).toBe(1);
      expect(board.sysWord(RESET_CAUSE)).toBe(RESET_CAUSE_WWDG);
      expect(board.sysWord(RESET_REQUEST)).toBe(0);
    } finally {
      board.dispose();
    }
  });

  it('IWDG 到期复位并重新执行向量，第二次启动不复位', async () => {
    const firmware = new Uint8Array(
      readFileSync(join(import.meta.dirname, 'fixtures', 'iwdg-reset.bin')),
    );
    const board = await systemBoard({ firmware, clockFrequency: 16_000_000 });

    try {
      board.run(1_000_000_000);
      expect(board.faults).toEqual([]);
      expect(board.sramWord(0x400)).toBe(2);
      expect(board.sramWord(0x404)).toBe(1);
      expect(board.sysWord(RESET_COUNT)).toBe(1);
      expect(board.sysWord(RESET_CAUSE)).toBe(RESET_CAUSE_IWDG);
      expect(board.sysWord(RESET_REQUEST)).toBe(0);
    } finally {
      board.dispose();
    }
  });
});
