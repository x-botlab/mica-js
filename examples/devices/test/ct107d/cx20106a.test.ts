import { describe, expect, it } from 'vitest';
import { createTestBoard, readMetadata, US } from './harness.ts';
import type { NetDescription, TestBoard } from './harness.ts';

/**
 * CX20106A 解调去抖的行为基线：100 µs 检出、150 µs 释放、翻转取消与 `receiving` 端口。
 *
 * OUT 是开漏输出，测试用 10 kΩ 上拉到 5 V，探针读到的高电平来自板级上拉；
 * 载波经输入通道注入，不经过任何引脚。
 */

const DETECT = 100 * US;
const RELEASE = 150 * US;

async function fixture(): Promise<TestBoard> {
  const nets: NetDescription[] = [
    {
      id: 'vcc',
      pins: [
        { instance: 'dut', pin: 'vcc' },
        { instance: 'outPull', pin: 'b' },
      ],
      voltage: 5,
    },
    { id: 'gnd', pins: [{ instance: 'dut', pin: 'gnd' }], voltage: 0 },
    {
      id: 'out',
      pins: [
        { instance: 'dut', pin: 'out' },
        { instance: 'outPull', pin: 'a' },
        { instance: 'outProbe', pin: 'y' },
      ],
    },
  ];

  const board = await createTestBoard('cx20106a', {
    nets,
    probes: ['outProbe'],
    resistors: [{ id: 'outPull', resistance: 10_000 }],
  });

  // 先把启动批次单独交付，后面才能把 receiving 的初值当成一条独立历史。
  board.run(0);

  return board;
}

function carrier(board: TestBoard, on: boolean): void {
  board.send('dut', 'carrier', on);
}

describe('CX20106A', () => {
  it('元数据声明 8 根引脚与布尔端口', () => {
    const metadata = readMetadata('cx20106a') as {
      readonly pins: Readonly<Record<string, unknown>>;
      readonly ports: Readonly<
        Record<string, { readonly direction: string; readonly type: string }>
      >;
    };

    expect(Object.keys(metadata.pins)).toHaveLength(8);
    expect(metadata.ports.carrier).toMatchObject({ direction: 'input', type: 'boolean' });
    expect(metadata.ports.receiving).toMatchObject({ direction: 'output', type: 'boolean' });
  });

  it('载波出现后 99 µs 仍释放，100 µs 已把 OUT 拉低', async () => {
    const board = await fixture();

    try {
      board.run(0);
      expect(board.probe('outProbe')).toBe(1);
      expect(board.topics.receiving).toBe(false);

      carrier(board, true);
      board.run(DETECT - US);
      expect(board.probe('outProbe')).toBe(1);
      expect(board.topics.receiving).toBe(false);

      board.run(2 * US);
      expect(board.probe('outProbe')).toBe(0);
      expect(board.topics.receiving).toBe(true);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('载波消失后 149 µs 仍拉低，150 µs 才释放 OUT', async () => {
    const board = await fixture();

    try {
      carrier(board, true);
      board.run(DETECT);
      expect(board.probe('outProbe')).toBe(0);

      carrier(board, false);
      board.run(RELEASE - US);
      expect(board.probe('outProbe')).toBe(0);
      expect(board.topics.receiving).toBe(true);

      board.run(2 * US);
      expect(board.probe('outProbe')).toBe(1);
      expect(board.topics.receiving).toBe(false);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('检出中途翻转会取消定时器：OUT 从不拉低，端口也不发布', async () => {
    const board = await fixture();

    try {
      carrier(board, true);
      board.run(50 * US);
      expect(board.probe('outProbe')).toBe(1);

      carrier(board, false);
      // 原来的检出期限已过：若没取消，这里会看到低电平。
      for (let step = 0; step < 100; step++) {
        board.run(10 * US);
        expect(board.probe('outProbe')).toBe(1);
      }

      expect(board.history.receiving).toEqual([false]);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('重复的载波电平不重新计时', async () => {
    const board = await fixture();

    try {
      carrier(board, true);
      board.run(90 * US);
      carrier(board, true);
      board.run(9 * US);
      expect(board.probe('outProbe')).toBe(1);

      board.run(2 * US);
      expect(board.probe('outProbe')).toBe(0);
      expect(board.topics.receiving).toBe(true);
      expect(board.history.receiving).toEqual([false, true]);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('已检出时重新检出保持 OUT 与端口不变', async () => {
    const board = await fixture();

    try {
      carrier(board, true);
      board.run(DETECT);
      expect(board.topics.receiving).toBe(true);

      // 短暂消失后又出现：释放定时器被取消，检出定时器到点时状态本来就是检出。
      carrier(board, false);
      board.run(50 * US);
      carrier(board, true);
      board.run(DETECT);

      expect(board.probe('outProbe')).toBe(0);
      expect(board.history.receiving).toEqual([false, true]);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('释放定时挂起时再次出现载波，检出按新的更早期限触发', async () => {
    const board = await fixture();

    try {
      // true→false 让释放定时挂在 10+150=160 µs；随后 true 的检出期限是 20+100=120 µs，
      // 比挂起的释放唤醒更早，必须按 120 µs 检出而不是被旧的唤醒拖到 160 µs。
      carrier(board, true);
      board.run(10 * US);
      carrier(board, false);
      board.run(10 * US);
      carrier(board, true);

      board.run(99 * US);
      expect(board.probe('outProbe')).toBe(1);

      board.run(2 * US);
      expect(board.probe('outProbe')).toBe(0);
      expect(board.topics.receiving).toBe(true);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });
});
