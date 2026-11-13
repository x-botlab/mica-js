import { describe, expect, it } from 'vitest';
import { circuit, firmware } from './harness';

/**
 * 手写的 IT 块固件：开 GPIOA 时钟、PA5/PA6 推挽输出，然后两段 `it eq` 各做一次 BSRR 写。
 *
 * 第一段 EQ 成立，PA5 被拉高；第二段 EQ 不成立，写 PA6 的 BSRR 必须被跳过。两条断言
 * 都只看**最终电平**，不依赖探针对瞬时脉冲的采样。
 *
 * 编码是 Thumb 小端半字，前两字是初始 SP 与复位入口。
 */
function itBlockFirmware(): Uint8Array {
  const code = [
    0x41,
    0xf2,
    0x00,
    0x00, // movw r0, #0x1000
    0xc4,
    0xf2,
    0x02,
    0x00, // movt r0, #0x4002
    0x01,
    0x21, // movs r1, #1
    0xc0,
    0xf8,
    0x48,
    0x10, // str r1, [r0, #0x48]   RCC->AHB2ENR
    0x40,
    0xf2,
    0x00,
    0x00, // movw r0, #0
    0xc4,
    0xf6,
    0x00,
    0x00, // movt r0, #0x4800      GPIOA
    0x41,
    0xf2,
    0x00,
    0x41, // movw r1, #0x1400      PA5/PA6 输出
    0xc0,
    0xf8,
    0x00,
    0x10, // str r1, [r0, #0]      MODER
    0x20,
    0x21, // movs r1, #0x20        PA5
    0x00,
    0x22, // movs r2, #0
    0x00,
    0x2a, // cmp r2, #0            Z=1 → EQ 成立
    0x08,
    0xbf, // it eq
    0xc0,
    0xf8,
    0x18,
    0x10, // str r1, [r0, #0x18]   BSRR：拉高 PA5
    0x40,
    0x21, // movs r1, #0x40        PA6
    0x01,
    0x22, // movs r2, #1
    0x00,
    0x2a, // cmp r2, #0            Z=0 → EQ 不成立
    0x08,
    0xbf, // it eq
    0xc0,
    0xf8,
    0x18,
    0x10, // str r1, [r0, #0x18]   BSRR：应被跳过
    0xfe,
    0xe7, // b .
  ];
  const image = new Uint8Array(8 + code.length);

  new DataView(image.buffer).setUint32(0, 0x2000_5800, true);
  new DataView(image.buffer).setUint32(4, 0x0800_0009, true);
  image.set(code, 8);

  return image;
}

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
      // LOAD = 15999 即每 16000 个周期（16 MHz 下 1 ms）一次中断，8.5 ms 内恰好 8 次翻转。
      for (let step = 0; step < 17; step += 1) board.run(500_000_000);
      expect(board.faults).toEqual([]);
      // 首个采样发生在 PA5 尚未配置输出之前（未知电平 2），此后每毫秒翻转一次。
      const levels = (board.history.PA5 ?? []).filter((value) => value !== 2);
      const changes = levels.filter((value, index) => index > 0 && value !== levels[index - 1]);

      expect(changes).toHaveLength(8);
      expect(levels).toContain(1);
      expect(levels).toContain(0);
    } finally {
      board.dispose();
    }
  });

  it('IT 块只执行条件成立的那一条', async () => {
    const board = await circuit({
      firmware: itBlockFirmware(),
      clockFrequency: 16_000_000,
    });

    try {
      for (let step = 0; step < 10; step += 1) board.run(1_000_000);
      expect(board.faults).toEqual([]);
      // 第一段 EQ 成立，PA5 被 BSRR 拉高；第二段 EQ 不成立，写 PA6 的 BSRR 必须被跳过。
      // 若把 IT 受控指令当成无条件执行，PA6 也会变成高电平。
      expect(board.levels.PA5).toBe(1);
      expect(board.levels.PA6).not.toBe(1);
    } finally {
      board.dispose();
    }
  });
});
