import { describe, expect, it } from 'vitest';
import { circuit, firmware } from './harness';

/**
 * halt 合同回归：未知 opcode 只能产生一次 fault，后续长 run 不得继续翻译数据；
 * NRST/reset 必须能恢复（由中央 guard/复位路径提供，CPU 侧 halt 不清 code/sram）。
 *
 * 中央 `buildBatch` 已按 `/tmp/opencode/g431-halt-guard-contract.md` 把 pc 固定回
 * `faultPc`；本用例已启用。
 */
describe('halt fixed-PC contract', () => {
  it('faults once and does not translate past the fault until reset', async () => {
    const board = await circuit({
      firmware: firmware('cpu-halt.bin'),
      pins: [],
    });

    try {
      board.run(2_000_000_000);
      const firstFaults = (board.topics.fault ?? []).length;
      const firstJit = board.jit();

      expect(firstFaults).toBe(1);
      expect(firstJit.cache).toBeGreaterThan(0);

      board.run(20_000_000_000);
      expect((board.topics.fault ?? []).length).toBe(1);
      expect(board.jit().cache).toBe(firstJit.cache);
      expect(board.jit().programs).toBe(firstJit.programs);
    } finally {
      board.dispose();
    }
  });
});
