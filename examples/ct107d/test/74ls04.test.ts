import { describe, expect, it } from 'vitest';
import { createTestBoard, readMetadata, US } from './harness.ts';
import type { NetDescription, TestBoard } from './harness.ts';

/**
 * 74LS04 的行为基线：六通道真值表 Y = !A、未知输入按低处理，以及 14 根引脚的元数据。
 *
 * 输入由数字源驱动，输出电平用探针在 `y1`–`y6` 网络上采样。
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

  const board = await createTestBoard('74ls04', { nets, probes, sources });

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

describe('74LS04', () => {
  it('元数据声明 14 根引脚且没有端口', () => {
    const metadata = readMetadata('74ls04') as {
      readonly pins: Readonly<Record<string, unknown>>;
      readonly ports?: Readonly<Record<string, unknown>>;
    };

    expect(Object.keys(metadata.pins)).toHaveLength(14);
    expect(metadata.ports).toBeUndefined();
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
