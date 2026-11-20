import { describe, expect, it } from 'vitest';
import { circuit, firmware } from './harness';

describe('SEV/WFE production adapter', () => {
  it('consumes a pending SEV event and continues through normal decode', async () => {
    const board = await circuit({ firmware: firmware('cpu-sev-wfe.bin'), pins: ['PA0'] });

    try {
      board.run(20_000_000); // 20 µs @16 MHz
      expect(board.levels.PA0).toBe(1);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });
});

describe('WFI deadline without IRQ', () => {
  // 回归：cpuWaitAdvance.serviceResume=pc + DISPATCH 使用 waitExceptionReturnPc。
  // DAC 的 10 µs deadline 只能推进时间，不能把 WFI 推到 afterWait marker。
  it('does not wake on DAC-only deadlines; SysTick IRQ wakes at nextPC', async () => {
    const board = await circuit({ firmware: firmware('cpu-wait-irq.bin'), pins: ['PA0'] });

    try {
      // 100 µs = 10 个 DAC 刷新 deadline，但 SysTick 1 ms 尚未到期。
      board.run(100_000_000);
      expect(board.levels.PA0 ?? 0).not.toBe(1);

      // 到 1 ms SysTick IRQ 才允许 WFI 落到 nextPC 并写 afterWait marker。
      board.run(2_000_000_000);
      expect(board.levels.PA0).toBe(1);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });
});

/**
 * 标准主 MCU adapter + 正常 decode 的 WFI→SysTick 唤醒回归。
 *
 * 中央已接线 `cpuWaitPolling`，并用 `waitExceptionReturnPc` 区分
 * “无 IRQ 回等待 PC”与“取走 IRQ 时异常栈返回 nextPC”。
 */
describe('WFI production polling hook', () => {
  it('wakes from WFI on SysTick and runs the loop body once per interrupt', async () => {
    const board = await circuit({ firmware: firmware('cpu-wait.bin'), pins: ['PA0', 'PA1'] });

    try {
      board.run(10_000_000_000); // 10 ms @ 16 MHz, SysTick 1 ms, 3 wakeups
      expect(board.levels.PA0).toBe(1);
      expect(board.levels.PA1).toBe(1);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });
});
