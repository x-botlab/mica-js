import { describe, expect, it } from 'vitest';
import { circuit, firmware } from './harness';

/**
 * 编译后的 C 循环回归（与 USB owner 的 pmaWrite 同形）：
 * data[index] | data[index+1] << 8 写入半字数组，再逐字节比较。
 * reset 失败时 PA1 高；成功时 PA0 高。命中过 CMP/BGE 的减法 V 标志错误。
 */
describe('compiled C halfword packing loop', () => {
  it('keeps both bytes of every packed halfword', async () => {
    const board = await circuit({
      firmware: firmware('cpu-cmp-loop.bin'),
      pins: ['PA0', 'PA1'],
    });

    try {
      board.run(2_000_000_000); // 2 ms
      expect(board.levels.PA0).toBe(1);
      expect(board.levels.PA1).toBe(0);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });
});
