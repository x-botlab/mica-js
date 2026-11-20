import { describe, expect, it } from 'vitest';
import { createTestBoard, readMetadata, US } from './harness.ts';
import type { NetDescription, TestBoard } from './harness.ts';

/**
 * 74HC14 的行为基线：六通道真值表 Y = !A、施密特迟滞、未知输入保持，以及 14 根引脚的元数据。
 *
 * 普通真值表用数字源驱动 0 / 5 V；迟滞用例用两个 10 kΩ 电阻把输入节点拉到两个数字源，
 * 通过 0/0、5/0、5/5 组合得到 0 V、2.5 V、5 V，验证 2.5 V 处于默认 1.5–2.8 V 迟滞带时
 * 输出保持上一次状态。
 */

const CHANNELS = [1, 2, 3, 4, 5, 6] as const;

interface Fixture {
  readonly board: TestBoard;
  drive(channel: number, level: number): void;
  y(channel: number): number;
}

async function fixture(): Promise<Fixture> {
  const nets: NetDescription[] = [
    { id: 'vcc', pins: [{ instance: 'dut', pin: 'vcc' }], voltage: 5 },
    { id: 'gnd', pins: [{ instance: 'dut', pin: 'gnd' }], voltage: 0 },
  ];
  const sources = CHANNELS.map((channel) => `a${channel}Src`);
  const probes = CHANNELS.map((channel) => `y${channel}Probe`);

  for (const channel of CHANNELS) {
    nets.push(
      {
        id: `a${channel}`,
        pins: [
          { instance: 'dut', pin: `a${channel}` },
          { instance: `a${channel}Src`, pin: 'y' },
        ],
      },
      {
        id: `y${channel}`,
        pins: [
          { instance: 'dut', pin: `y${channel}` },
          { instance: `y${channel}Probe`, pin: 'y' },
        ],
      },
    );
  }

  for (const id of sources) {
    nets.push(
      { id: `${id}-vcc`, pins: [{ instance: id, pin: 'vcc' }], voltage: 5 },
      { id: `${id}-gnd`, pins: [{ instance: id, pin: 'gnd' }], voltage: 0 },
    );
  }

  const board = await createTestBoard('74hc14', { nets, probes, sources });

  return {
    board,
    drive(channel, level) {
      board.send(`a${channel}Src`, 'level', level);
    },
    y(channel) {
      return board.probe(`y${channel}Probe`);
    },
  };
}

async function hysteresisFixture(): Promise<{
  readonly board: TestBoard;
  set(left: number, right: number): void;
  y(): number;
}> {
  const nets: NetDescription[] = [
    {
      id: 'vcc',
      voltage: 5,
      pins: [
        { instance: 'dut', pin: 'vcc' },
        { instance: 'leftSrc', pin: 'vcc' },
        { instance: 'rightSrc', pin: 'vcc' },
      ],
    },
    {
      id: 'gnd',
      voltage: 0,
      pins: [
        { instance: 'dut', pin: 'gnd' },
        { instance: 'leftSrc', pin: 'gnd' },
        { instance: 'rightSrc', pin: 'gnd' },
      ],
    },
    {
      id: 'input',
      pins: [
        { instance: 'dut', pin: 'a1' },
        { instance: 'left', pin: 'b' },
        { instance: 'right', pin: 'b' },
      ],
    },
    {
      id: 'leftDrive',
      pins: [
        { instance: 'leftSrc', pin: 'y' },
        { instance: 'left', pin: 'a' },
      ],
    },
    {
      id: 'rightDrive',
      pins: [
        { instance: 'rightSrc', pin: 'y' },
        { instance: 'right', pin: 'a' },
      ],
    },
    {
      id: 'output',
      pins: [
        { instance: 'dut', pin: 'y1' },
        { instance: 'outputProbe', pin: 'y' },
      ],
    },
  ];
  const board = await createTestBoard('74hc14', {
    nets,
    resistors: [
      { id: 'left', resistance: 10_000 },
      { id: 'right', resistance: 10_000 },
    ],
    probes: ['outputProbe'],
    sources: ['leftSrc', 'rightSrc'],
  });

  return {
    board,
    set(left, right) {
      board.send('leftSrc', 'level', left);
      board.send('rightSrc', 'level', right);
      board.run(US);
    },
    y() {
      return board.probe('outputProbe');
    },
  };
}

describe('74HC14', () => {
  it('清单声明 14 根引脚，模型没有公共方法与事件', () => {
    const metadata = readMetadata('74hc14');

    expect(Object.keys(metadata.pins ?? {})).toHaveLength(14);
    expect(Object.keys(metadata.model.methods)).toEqual([]);
    expect(Object.keys(metadata.model.events)).toEqual([]);
  });

  it('六通道在 A=0 / A=1 下逐路反相', async () => {
    const built = await fixture();

    try {
      for (const channel of CHANNELS) built.drive(channel, 0);
      built.board.run(US);
      for (const channel of CHANNELS) expect(built.y(channel)).toBe(1);
      expect(built.board.faults).toEqual([]);

      for (const channel of CHANNELS) built.drive(channel, 1);
      built.board.run(US);
      for (const channel of CHANNELS) expect(built.y(channel)).toBe(0);

      // 单通道切换只影响自己的输出。
      built.drive(3, 0);
      built.board.run(US);
      expect(built.y(3)).toBe(1);
      for (const channel of [1, 2, 4, 5, 6]) expect(built.y(channel)).toBe(0);
      expect(built.board.faults).toEqual([]);
    } finally {
      built.board.dispose();
    }
  });

  it('输入停留在迟滞带时保持上一次判定结果', async () => {
    const built = await hysteresisFixture();

    try {
      // 0 V：输入低，输出高。
      built.set(0, 0);
      expect(built.y()).toBe(1);

      // 2.5 V：位于默认 1.5–2.8 V 迟滞带内，仍保持输入低，输出高。
      built.set(1, 0);
      expect(built.y()).toBe(1);

      // 5 V：输入高，输出低。
      built.set(1, 1);
      expect(built.y()).toBe(0);

      // 回到 2.5 V：保持输入高，输出低。
      built.set(0, 1);
      expect(built.y()).toBe(0);

      // 再回到 0 V：恢复输入低，输出高。
      built.set(0, 0);
      expect(built.y()).toBe(1);
      expect(built.board.faults).toEqual([]);
    } finally {
      built.board.dispose();
    }
  });

  it('释放的输入按低处理，对应输出为高', async () => {
    const built = await fixture();

    try {
      for (const channel of CHANNELS) built.drive(channel, 2);
      built.board.run(US);

      for (const channel of CHANNELS) expect(built.y(channel)).toBe(1);
      expect(built.board.faults).toEqual([]);
    } finally {
      built.board.dispose();
    }
  });
});
