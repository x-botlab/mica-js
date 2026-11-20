import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RCC_CSR_BORRSTF,
  RCC_CSR_IWDGRSTF,
  RCC_CSR_PINRSTF,
  RCC_CSR_WWDGRSTF,
} from '@mica-js/stm32g431rbt6-core/rcc';
import { RESET_CAUSE, RESET_COUNT } from '@mica-js/stm32g431rbt6-core/system-layout';
import { systemBoard } from './system-harness';

const FIRMWARE = join(import.meta.dirname, 'fixtures');

async function run(name: string) {
  const firmware = new Uint8Array(readFileSync(join(FIRMWARE, name)));
  const board = await systemBoard({ firmware, clockFrequency: 16_000_000 });

  board.run(1_000_000_000);

  return board;
}

/**
 * 真实标准 adapter + 真实固件：看门狗超时走 requestReset/applyReset，第二次启动
 * 从 RCC_CSR 读回复位源标志，再写 RMVF 验证清零。
 */
describe('RCC_CSR 真实看门狗复位源', () => {
  it('IWDG 超时后 CSR.IWDGRSTF=1，RMVF 清除', async () => {
    const board = await run('rcc-iwdg-csr.bin');

    try {
      expect(board.faults).toEqual([]);
      expect(board.sramWord(0x400)).toBe(2);
      expect(board.sysWord(RESET_COUNT)).toBe(1);
      expect(board.sysWord(RESET_CAUSE)).toBe(5);

      const csr = board.sramWord(0x408);
      expect(csr & RCC_CSR_IWDGRSTF).not.toBe(0);
      expect(csr & RCC_CSR_PINRSTF).toBe(0);
      expect(csr & RCC_CSR_BORRSTF).toBe(0);
      expect(board.sramWord(0x40c) & 0xfe000000).toBe(0);
    } finally {
      board.dispose();
    }
  });

  /**
   * `watchdog.ts` 已按 0x1=IWDG(5) / 0x2=WWDG(6) 传递 cause。本用例验证 WWDG
   * 只置 CSR bit30、不置 IWDG bit29，并在 RMVF 后清零；上面的 IWDG 用例保持 5。
   */
  it('WWDG 超时后 CSR.WWDGRSTF=1，RMVF 清除', async () => {
    const board = await run('rcc-wwdg-csr.bin');

    try {
      expect(board.faults).toEqual([]);
      expect(board.sramWord(0x400)).toBe(2);
      expect(board.sysWord(RESET_COUNT)).toBe(1);
      expect([6, 7]).toContain(board.sysWord(RESET_CAUSE));

      const csr = board.sramWord(0x408);
      expect(csr & RCC_CSR_WWDGRSTF).not.toBe(0);
      expect(csr & RCC_CSR_IWDGRSTF).toBe(0);
      expect(board.sramWord(0x40c) & 0xfe000000).toBe(0);
    } finally {
      board.dispose();
    }
  });
});
