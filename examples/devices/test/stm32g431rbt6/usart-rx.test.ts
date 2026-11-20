import { describe, expect, it } from 'vitest';
import { firmware } from './harness';
import { usartBoard } from './usart-rig';
import type { UsartBoard, UsartWiring } from './usart-rig';

const US = 1_000_000;
const SLICE_PS = 200 * US;
const BIT_PS = Math.round(1_000_000_000_000 / 115200);

function frame(value: number, stop = 1): number[] {
  const bits = [0];

  for (let index = 0; index < 8; index += 1) bits.push((value >> index) & 1);
  bits.push(stop);

  return bits;
}

function waitReady(board: UsartBoard, timeoutPs = 5_000_000 * US): void {
  const end = board.time + timeoutPs;

  while (board.time < end) {
    board.runUntil(Math.min(board.time + SLICE_PS, end));
    try {
      if (board.probe('ready') === 1) return;
    } catch {
      // 探针还没有第一批电平。
    }
  }

  throw new Error('USART firmware did not raise PA0 ready');
}

function runFor(board: UsartBoard, durationPs: number): void {
  const end = board.time + durationPs;

  while (board.time < end) board.runUntil(Math.min(board.time + SLICE_PS, end));
}

async function open(
  name: string,
  wiring: UsartWiring,
  options: { readonly baud?: number; readonly clockFrequency?: number } = {},
): Promise<UsartBoard> {
  const board = await usartBoard({
    firmware: firmware(name),
    wiring,
    baud: options.baud ?? 115200,
    clockFrequency: options.clockFrequency ?? 16_000_000,
  });

  waitReady(board);

  return board;
}

describe('STM32G431RBT6 USART RX', () => {
  it('通过真实 PA10 引脚注入 8N1 字节并轮询回显', async () => {
    const board = await open('usart-rx-echo.bin', 'rx');

    try {
      board.injected([0x41]);
      runFor(board, 2_000 * US);
      expect(board.faults).toEqual([]);
      expect(board.received()).toEqual([0x41]);
    } finally {
      board.dispose();
    }
  });

  it('RXNEIE 中断收到字节并回显', async () => {
    const board = await open('usart-rx-irq.bin', 'rx');

    try {
      board.injected([0x42]);
      runFor(board, 2_000 * US);
      expect(board.faults).toEqual([]);
      expect(board.received()).toEqual([0x42]);
    } finally {
      board.dispose();
    }
  });

  it('IDLEIE 在线路空闲后中断，RDR 与 IDLECF 都可清除', async () => {
    const board = await open('usart-rx-idle.bin', 'rx');

    try {
      board.injected([0x43]);
      runFor(board, 2_000 * US);
      expect(board.faults).toEqual([]);
      // IDLE 中断处理程序在清 IDLECF 后发送 'I'。
      expect(board.received()).toEqual([0x49]);
    } finally {
      board.dispose();
    }
  });

  it('两个背靠背字节产生 ORE，RDR 保留第二个字节', async () => {
    const board = await open('usart-rx-overrun.bin', 'rx');

    try {
      board.injected([0x41, 0x42]);
      runFor(board, 3_000 * US);
      expect(board.faults).toEqual([]);
      // 状态字节 bit3(ORE)+bit5(RXNE)，随后是第二个字节。
      expect(board.received()).toEqual([0x28, 0x42]);
    } finally {
      board.dispose();
    }
  });

  it('EIE/RXNEIE 处理 FE 后恢复接收下一帧', async () => {
    const board = await open('usart-rx-error.bin', 'rx-trigger');

    try {
      // 首帧停止位为低（FE）；中间留几个空闲位，再发合法 0x55。
      board.injectBits([...frame(0x41, 0), 1, 1, 1, 1, ...frame(0x55, 1)]);
      runFor(board, 3_000 * US);
      expect(board.faults).toEqual([]);
      expect(board.received()).toEqual([0x22, 0x41, 0x20, 0x55]);
    } finally {
      board.dispose();
    }
  });

  it('RE 关闭时取消半帧，重新使能后只接收后续完整帧', async () => {
    const board = await open('usart-rx-disable.bin', 'rx-trigger');

    try {
      // 先发一个 10 位的 0x00 帧（9 低 1 高），约 2 个位后固件关闭 RE；随后再发 0xA5。
      board.injectBits([...frame(0x00, 1), ...frame(0xa5, 1)]);
      board.run(BIT_PS * 2);
      board.trigger(true);
      runFor(board, 4_000 * US);
      expect(board.faults).toEqual([]);
      expect(board.received()).toEqual([0xa5]);
    } finally {
      board.dispose();
    }
  });

  it('RDR 高保留字节不清 RXNE，ICR 窄写按 lane 生效，保留地址不别名', async () => {
    const board = await open('usart-regs.bin', 'rx');

    try {
      board.injected([0x41]);
      runFor(board, 3_000 * US);
      expect(board.faults).toEqual([]);
      // bit0 高字节后 RXNE 保留；bit1 低字节后清除；bit2 lane1 不清 IDLE；
      // bit3 lane0 清 IDLE；bit4 0x30 读 0；bit5 保留写不动 CR1。
      expect(board.received()).toEqual([0x3f]);
    } finally {
      board.dispose();
    }
  });

  it('RQR.RXFRQ 只在 lane0 清 RXNE，高 lane 写入无效', async () => {
    const board = await open('usart-rqr.bin', 'rx');

    try {
      board.injected([0x42]);
      runFor(board, 3_000 * US);
      expect(board.faults).toEqual([]);
      expect(board.received()).toEqual([0x03]);
    } finally {
      board.dispose();
    }
  });

  it('PA9→PA10 真实发收回环：发送 0x5A，RX 内容校验通过后才回 0x59', async () => {
    const board = await open('usart-loopback.bin', 'loopback');

    try {
      runFor(board, 5_000 * US);
      expect(board.faults).toEqual([]);
      // 固件把 RDR 与 0x5A 比较；不匹配会回 'N'，因此这里同时验证了真实 RX 数据。
      expect(board.received()).toEqual([0x5a, 0x59]);
    } finally {
      board.dispose();
    }
  });

  it('TX 引脚真实波形：独立 UART 探针复原 0x55、0xA6', async () => {
    const board = await open('usart-tx-wave.bin', 'tx');

    try {
      runFor(board, 5_000 * US);
      const bytes = (board.history.tx ?? []).flatMap((value) => [...(value as Uint8Array)]);

      expect(board.faults).toEqual([]);
      expect(bytes).toEqual([0x55, 0xa6]);
    } finally {
      board.dispose();
    }
  });

  it('16 MHz / 1 Mbaud 的位周期小于 1 µs，仍按真实采样边界接收', async () => {
    const board = await open('usart-rx-echo-highbaud.bin', 'rx', {
      baud: 1_000_000,
      clockFrequency: 16_000_000,
    });

    try {
      board.injected([0x5a]);
      runFor(board, 500 * US);
      expect(board.faults).toEqual([]);
      expect(board.received()).toEqual([0x5a]);
    } finally {
      board.dispose();
    }
  });

  it('USART1 + USART2 两路 1 Mbaud 并行接收，各自回显', async () => {
    const board = await open('usart-rx-dual.bin', 'rx2', {
      baud: 1_000_000,
      clockFrequency: 16_000_000,
    });

    try {
      board.injected([0x41]);
      board.injected2([0x42]);
      runFor(board, 500 * US);
      expect(board.faults).toEqual([]);
      expect(board.received()).toEqual([0x41]);
      expect(board.received2()).toEqual([0x42]);
    } finally {
      board.dispose();
    }
  });

  it('1 MHz / 200 baud 的真实 RX 不回绕 32 位皮秒', async () => {
    const board = await open('usart-rx-echo-lowbaud.bin', 'rx', {
      baud: 200,
      clockFrequency: 1_000_000,
    });

    try {
      board.injected([0x55]);
      runFor(board, 120_000 * US);
      expect(board.faults).toEqual([]);
      expect(board.received()).toEqual([0x55]);
    } finally {
      board.dispose();
    }
  });
});
