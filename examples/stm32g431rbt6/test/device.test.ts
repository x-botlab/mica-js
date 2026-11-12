import { describe, expect, it } from 'vitest';
import { circuit, firmware } from './harness';

describe('STM32G431RBT6 源码级行为', () => {
  it('从向量表复位并驱动 GPIOA 推挽输出', async () => {
    const board = await circuit({
      firmware: firmware('gpio-blink.bin'),
      clockFrequency: 1_000_000,
    });

    try {
      for (let step = 0; step < 100; step += 1) board.run(100_000_000);
      expect(board.faults).toEqual([]);
      expect(board.history.PA5).toContain(1);
      expect(board.history.PA5).toContain(0);
    } finally {
      board.dispose();
    }
  });

  it('通过 USART2 发送字节并发布串口话题', async () => {
    const board = await circuit({
      firmware: firmware('uart2-tx.bin'),
      clockFrequency: 16_000_000,
    });

    try {
      board.run(20_000_000_000);
      expect(board.faults).toEqual([]);
      expect(board.topics['serial2.tx']).toEqual([0x4f, 0x4b]);
    } finally {
      board.dispose();
    }
  });

  it('读取 IDR 并由 GPIOA 镜像输出', async () => {
    const board = await circuit({
      firmware: firmware('gpio-input.bin'),
      clockFrequency: 1_000_000,
    });

    try {
      board.run(1_000_000);
      board.inputs.PA0!.send(1);
      for (let step = 0; step < 5; step += 1) board.run(10_000_000);
      expect(board.levels.PA1).toBe(1);
      board.inputs.PA0!.send(0);
      for (let step = 0; step < 5; step += 1) board.run(10_000_000);
      expect(board.levels.PA1).toBe(0);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('执行 32 位逻辑/位段/条件分支并输出结果', async () => {
    const board = await circuit({
      firmware: firmware('arith.bin'),
      clockFrequency: 1_000_000,
    });

    try {
      for (let step = 0; step < 20; step += 1) board.run(10_000_000);
      expect(board.faults).toEqual([]);
      const bits = [0, 1, 2, 3, 4, 5, 6, 7].map((index) => board.levels[`PA${index}`]);
      expect(bits).toEqual([0, 0, 0, 0, 1, 1, 0, 0]);
    } finally {
      board.dispose();
    }
  });

  it('通过 SysTick 中断周期翻转 GPIO', async () => {
    const board = await circuit({
      firmware: firmware('systick.bin'),
      clockFrequency: 16_000_000,
    });

    try {
      for (let step = 0; step < 8; step += 1) board.run(1_000_000_000);
      expect(board.faults).toEqual([]);
      const history = board.history.PA5 ?? [];
      const changes = history.filter((value, index) => index > 0 && value !== history[index - 1]);

      expect(changes.length).toBeGreaterThanOrEqual(4);
      expect(history).toContain(1);
      expect(history).toContain(0);
    } finally {
      board.dispose();
    }
  });
});
