import { describe, expect, it } from 'vitest';
import { createTestBoard, readMetadata, US } from './harness.ts';
import type { NetDescription, TestBoard } from './harness.ts';

/**
 * VS1838 一体化接收头的行为基线：50 µs 检出、200 µs 释放、毛刺抑制、翻转取消与端口。
 *
 * OUT 是开漏输出，测试用 10 kΩ 上拉到 5 V；照明没有引脚，只经输入通道注入。
 */

const DETECT = 50 * US;
const RELEASE = 200 * US;

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

  const board = await createTestBoard('vs1838', {
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

describe('VS1838', () => {
  it('元数据声明 3 根引脚与布尔端口', () => {
    const metadata = readMetadata('vs1838') as {
      readonly pins: Readonly<Record<string, unknown>>;
      readonly ports: Readonly<
        Record<string, { readonly direction: string; readonly type: string }>
      >;
    };

    expect(Object.keys(metadata.pins)).toHaveLength(3);
    expect(metadata.ports.carrier).toMatchObject({ direction: 'input', type: 'boolean' });
    expect(metadata.ports.receiving).toMatchObject({ direction: 'output', type: 'boolean' });
  });

  it('载波出现 49 µs 仍释放，50 µs 已把 OUT 拉低', async () => {
    const board = await fixture();

    try {
      expect(board.probe('outProbe')).toBe(1);

      carrier(board, true);
      board.run(DETECT - 1);
      expect(board.probe('outProbe')).toBe(1);
      expect(board.topics.receiving).toBe(false);

      board.run(2);
      expect(board.probe('outProbe')).toBe(0);
      expect(board.topics.receiving).toBe(true);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('短于检出时限的毛刺不触发', async () => {
    const board = await fixture();

    try {
      carrier(board, true);
      board.run(30 * US);
      expect(board.probe('outProbe')).toBe(1);

      carrier(board, false);
      for (let step = 0; step < 50; step++) {
        board.run(10 * US);
        expect(board.probe('outProbe')).toBe(1);
      }

      expect(board.history.receiving).toEqual([false]);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('载波消失 199 µs 仍拉低，200 µs 才释放 OUT', async () => {
    const board = await fixture();

    try {
      carrier(board, true);
      board.run(DETECT);
      expect(board.probe('outProbe')).toBe(0);

      carrier(board, false);
      board.run(RELEASE - 1);
      expect(board.probe('outProbe')).toBe(0);
      expect(board.topics.receiving).toBe(true);

      board.run(2);
      expect(board.probe('outProbe')).toBe(1);
      expect(board.topics.receiving).toBe(false);
      expect(board.history.receiving).toEqual([false, true, false]);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('检出中途翻转取消定时，之后仍能正常检出', async () => {
    const board = await fixture();

    try {
      carrier(board, true);
      board.run(20 * US);
      carrier(board, false);
      board.run(500 * US);

      // 被取消的检出定时到点后什么也不做。
      expect(board.probe('outProbe')).toBe(1);
      expect(board.history.receiving).toEqual([false]);

      // 取消没有破坏后续的检出路径。
      carrier(board, true);
      board.run(DETECT);
      expect(board.probe('outProbe')).toBe(0);
      expect(board.topics.receiving).toBe(true);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('重复的载波电平不重新计时', async () => {
    const board = await fixture();

    try {
      carrier(board, true);
      board.run(40 * US);
      carrier(board, true);
      board.run(DETECT - 40 * US - 1);
      expect(board.probe('outProbe')).toBe(1);

      board.run(2);
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
      // true→false 让释放定时挂在 10+200=210 µs；随后 true 的检出期限是 20+50=70 µs，
      // 比挂起的释放唤醒更早，必须按 70 µs 检出而不是被旧的唤醒拖到 210 µs。
      carrier(board, true);
      board.run(10 * US);
      carrier(board, false);
      board.run(10 * US);
      carrier(board, true);

      board.run(DETECT - 1);
      expect(board.probe('outProbe')).toBe(1);

      board.run(2);
      expect(board.probe('outProbe')).toBe(0);
      expect(board.topics.receiving).toBe(true);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });
});
