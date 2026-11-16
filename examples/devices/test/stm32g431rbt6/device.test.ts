import { describe, expect, it } from 'vitest';
import { circuit, firmware } from './harness';

interface SerialMethods {
  readSerial(params: { readonly channel: string; readonly cursor: number }): {
    readonly start: number;
    readonly end: number;
    readonly dropped: number;
    readonly data: Uint8Array;
  };
  getSerialStatus(params: { readonly channel: string }): {
    readonly capacity: number;
    readonly oldest: number;
    readonly next: number;
    readonly droppedTotal: number;
  };
  getLastFault(params: null): number;
}

function serialMethods(value: unknown): SerialMethods {
  if (value === null || typeof value !== 'object') throw new Error('Missing model methods');

  const record = value as Record<string, unknown>;

  for (const name of ['readSerial', 'getSerialStatus', 'getLastFault'])
    if (typeof record[name] !== 'function') throw new Error(`Missing ${name}`);

  return value as SerialMethods;
}

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
      expect(
        (board.topics['serial2.tx'] as Uint8Array[]).flatMap((bytes) => [...bytes]),
      ).toEqual([0x4f, 0x4b]);

      const methods = serialMethods(board.methods);
      const status = methods.getSerialStatus({ channel: 'uart2Tx' });

      expect(status).toEqual({ capacity: 4096, oldest: 0, next: 2, droppedTotal: 0 });

      const chunk = methods.readSerial({ channel: 'uart2Tx', cursor: 0 });

      expect(chunk).toMatchObject({ start: 0, end: 2, dropped: 0 });
      expect([...chunk.data]).toEqual([0x4f, 0x4b]);

      chunk.data[0] = 0;
      expect([...methods.readSerial({ channel: 'uart2Tx', cursor: 0 }).data]).toEqual([
        0x4f, 0x4b,
      ]);
      expect(methods.getLastFault(null)).toBe(-1);

      let failure: unknown;

      try {
        methods.readSerial({ channel: 'uart9Tx', cursor: 0 });
      } catch (error) {
        failure = error;
      }

      expect(failure).toMatchObject({ name: 'MethodError', code: 'serial/unknown-channel' });

      failure = undefined;

      try {
        methods.readSerial({ channel: 'uart2Tx', cursor: -1 });
      } catch (error) {
        failure = error;
      }

      expect(failure).toMatchObject({ name: 'MethodError', code: 'serial/invalid-cursor' });
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
      // 首个采样发生在 PA5 尚未配置输出之前（未知电平 2）。夹具记录每个同步批内的
      // 全部变化后，8.5 ms 窗口内可见 9 次翻转；旧实现只保留批尾消息会漏掉其中一次。
      const levels = (board.history.PA5 ?? []).filter((value) => value !== 2);
      const changes = levels.filter((value, index) => index > 0 && value !== levels[index - 1]);

      expect(changes).toHaveLength(9);
      expect(levels).toContain(1);
      expect(levels).toContain(0);
    } finally {
      board.dispose();
    }
  });

  it('BSRR 同位 set/reset 时 set 胜出，并只刷新真正变化的引脚', async () => {
    const board = await circuit({
      firmware: firmware('gpio-bsrr-conflict.bin'),
      clockFrequency: 1_000_000,
    });

    try {
      board.run(10_000_000_000);
      expect(board.faults).toEqual([]);
      // PA5 先为高，随后同一 BSRR 同时 set/reset：保持高且不应被误清；
      // PA7 先为低，同样的冲突必须变为高；PA6 单独 reset 后为低。
      expect(board.levels.PA5).toBe(1);
      expect(board.levels.PA6).toBe(0);
      expect(board.levels.PA7).toBe(1);
    } finally {
      board.dispose();
    }
  });

  it('MODER/OTYPER/PUPDR 变化只影响目标引脚，未变化引脚保留旧意图', async () => {
    const board = await circuit({
      firmware: firmware('gpio-config-sync.bin'),
      clockFrequency: 1_000_000,
    });

    try {
      board.run(10_000_000_000);
      expect(board.faults).toEqual([]);
      // 固件先使能 GPIOA 时钟，再把 PA5/PA7/PA8 配成输出并拉高，PA6 配置上拉输入。
      // 当前模型沿用 rcc.ts 的已知简化：AHB2ENR 只保存使能位，不据此阻断 GPIO 寄存器
      // 访问；优化必须保持“先开时钟再配置 GPIO”的既有路径。
      // 随后只把 PA5 改成下拉输入、只把 PA7 改成开漏输出；未触碰的 PA8 必须仍为高。
      expect(board.levels.PA5).toBe(0);
      expect(board.levels.PA6).toBe(1);
      expect(board.levels.PA7).toBe(0);
      expect(board.levels.PA8).toBe(1);
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
