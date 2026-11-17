import { describe, expect, it } from 'vitest';
import { circuit, firmware } from './harness';

const DESCRIPTOR = [0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0];

/**
 * GCC -O2 把普通 C 半字打包循环优化成：
 *   ldrb.w ip,[r1,#1]
 *   ldrb.w r2,[r1],#2       ; post-index writeback
 *   strh.w r2,[r5,r0,lsl#1]
 *
 * 固件只使用 CPU 专属 SRAM 和 GPIO 结果路径，不依赖 USB/PMA 公共 API：
 * - 0x20005010 起必须得到完整 descriptor；
 * - PA0=1/PA1=0 表示编译 C 的复制与比较循环都正确；
 * - 这是通用优化 C 回归，不是 USB 高级功能。
 */
describe('compiled -O2 post-index load loop', () => {
  it('keeps all bytes and succeeds through the CPU SRAM/GPIO path', async () => {
    const board = await circuit({
      firmware: firmware('cpu-postindex-o2.bin'),
      pins: ['PA0', 'PA1'],
    });

    try {
      board.run(2_000_000_000);
      expect([...board.memory('sram').slice(0x5010, 0x5018)]).toEqual(DESCRIPTOR);
      expect(board.levels.PA0).toBe(1);
      expect(board.levels.PA1).toBe(0);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });
});

/**
 * IT 条件回归（通用优化 C 里的 iteq/ne 路径）：`it ne` 在 Z=1 时必须跳过，
 * `it eq` 必须执行；两者都通过标准 adapter 的 GPIO 结果路径验证。
 */
describe('compiled IT condition', () => {
  it('executes only the instruction matching APSR', async () => {
    const board = await circuit({
      firmware: firmware('cpu-it.bin'),
      pins: ['PA0', 'PA1'],
    });

    try {
      board.run(10_000_000);
      expect(board.levels.PA0).toBe(1);
      expect(board.levels.PA1).toBe(0);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });
});
