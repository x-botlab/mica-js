import { describe, expect, it } from 'vitest';
import { circuit, firmware } from './harness';

/**
 * 本轮明确不实现 FPU/VFP 执行（与 USB 一并豁免）。这里用标准主 MCU adapter +
 * 正常 decode（不替换 translate）运行 GCC hard-float 固件，确认：
 *
 * - 首条 VFP 立即产生模型定义的 unsupported fault，payload 低字节为 0x20；
 * - 固件先打开 CPACR（CP10/CP11 full），因此首条 VFP 的 0x20 不是 CPACR
 *   门控造成的架构 NOCP，而是模型对“VFP 未实现”的显式 unsupported fault；
 * - 固件不会进入 VFP 之后的效果路径（PA0/PA1 都不会被写成成功标记）。
 */
describe('FPU unsupported on production decode', () => {
  it('faults hard-float firmware with 0x20 instead of executing VFP', async () => {
    const board = await circuit({
      firmware: firmware('fpu-smoke.bin'),
      pins: ['PA0', 'PA1'],
    });

    try {
      board.run(100_000_000); // 100 µs @16 MHz：足够执行到首条 VFP；fault 后无需继续长跑

      const faults = (board.topics.fault ?? []) as readonly number[];
      expect(faults.length).toBeGreaterThan(0);
      expect(faults.some((payload) => (payload & 0xff) === 0x20)).toBe(true);

      // 固件没有 GPIO 成功路径；VFP 被错误执行时也不应出现 PA0/PA1=1。
      expect(board.levels.PA0 ?? 0).not.toBe(1);
      expect(board.levels.PA1 ?? 0).not.toBe(1);

      // fault 是模型主动报告的指令级 unsupported，而不是板级崩溃。
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });
});
