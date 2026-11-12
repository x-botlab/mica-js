import { describe, expect, it } from 'vitest';
import { createTestBoard, readMetadata, US } from './harness.ts';
import type { NetDescription, TestBoard } from './harness.ts';

/**
 * ULN2003 的行为基线：IN=1 时 OUT 灌低、IN=0 时 OUT 释放并被 10 kΩ 上拉读高，`mask` /
 * `channels` 端口，以及 COM 被动不驱动。
 *
 * OUT 网络都带 10 kΩ 上拉到 5 V，这样释放状态可以用探针区分高阻与拉低。
 */

const CHANNELS = [1, 2, 3, 4, 5, 6, 7] as const;
const PULL_UP = 10_000;

interface Fixture {
  readonly board: TestBoard;
  drive(channel: number, level: number): void;
  out(channel: number): number;
}

function text(value: unknown): string {
  return Array.from(value as Iterable<number>, (byte) => String.fromCharCode(byte)).join('');
}

async function fixture(): Promise<Fixture> {
  const sources = CHANNELS.map((channel) => `in${channel}Src`);
  const probes = CHANNELS.map((channel) => `out${channel}Probe`);
  const nets: NetDescription[] = [
    {
      id: 'vcc',
      pins: [
        ...CHANNELS.map((channel) => ({ instance: `pull${channel}`, pin: 'a' })),
        ...sources.map((id) => ({ instance: id, pin: 'vcc' })),
      ],
      voltage: 5,
    },
    {
      id: 'gnd',
      pins: [
        { instance: 'dut', pin: 'gnd' },
        ...sources.map((id) => ({ instance: id, pin: 'gnd' })),
      ],
      voltage: 0,
    },
    {
      id: 'com',
      pins: [
        { instance: 'dut', pin: 'com' },
        { instance: 'comProbe', pin: 'y' },
      ],
    },
  ];

  for (const channel of CHANNELS) {
    nets.push(
      {
        id: `in${channel}`,
        pins: [
          { instance: 'dut', pin: `in${channel}` },
          { instance: `in${channel}Src`, pin: 'y' },
        ],
      },
      {
        id: `out${channel}`,
        pins: [
          { instance: 'dut', pin: `out${channel}` },
          { instance: `pull${channel}`, pin: 'b' },
          { instance: `out${channel}Probe`, pin: 'y' },
        ],
      },
    );
  }

  const board = await createTestBoard('uln2003', {
    nets,
    probes: [...probes, 'comProbe'],
    resistors: CHANNELS.map((channel) => ({ id: `pull${channel}`, resistance: PULL_UP })),
    sources,
  });

  return {
    board,
    drive(channel, level) {
      board.send(`in${channel}Src`, 'level', level);
    },
    out(channel) {
      return board.probe(`out${channel}Probe`);
    },
  };
}

describe('ULN2003', () => {
  it('元数据声明 16 根引脚（无 VCC）与 mask/channels 端口', () => {
    const metadata = readMetadata('uln2003') as {
      readonly pins: Readonly<Record<string, unknown>>;
      readonly ports: Readonly<Record<string, { readonly type: string }>>;
    };

    expect(Object.keys(metadata.pins)).toHaveLength(16);
    expect(metadata.pins.vcc).toBeUndefined();
    expect(metadata.pins.com).toBeDefined();
    expect(metadata.ports.mask?.type).toBe('number');
    expect(metadata.ports.channels?.type).toBe('bytes');
  });

  it('IN=1 逐路灌低，IN=0 释放并由上拉读高', async () => {
    const built = await fixture();

    try {
      for (const channel of CHANNELS) {
        for (const other of CHANNELS) built.drive(other, 0);
        built.drive(channel, 1);
        built.board.run(US);

        expect(built.out(channel)).toBe(0);
        expect(built.board.topics.mask).toBe(1 << (channel - 1));
        expect(text(built.board.topics.channels)).toBe(
          CHANNELS.map((item) => (item === channel ? '1' : '0')).join(''),
        );

        built.drive(channel, 0);
        built.board.run(US);

        expect(built.out(channel)).toBe(1);
        expect(built.board.topics.mask).toBe(0);
        expect(text(built.board.topics.channels)).toBe('0000000');
        expect(built.board.faults).toEqual([]);
      }
    } finally {
      built.board.dispose();
    }
  });

  it('混合模式同时驱动多路，mask 与 channels 与引脚一致', async () => {
    const built = await fixture();

    try {
      // 打开 IN1、IN3、IN5，关闭其余通道。
      const pattern = [1, 0, 1, 0, 1, 0, 0] as const;

      for (const channel of CHANNELS) built.drive(channel, pattern[channel - 1]!);
      built.board.run(US);

      expect(CHANNELS.map((channel) => built.out(channel))).toEqual([0, 1, 0, 1, 0, 1, 1]);
      expect(built.board.topics.mask).toBe(1 + 4 + 16);
      expect(text(built.board.topics.channels)).toBe('1010100');

      for (const channel of CHANNELS) built.drive(channel, 0);
      built.board.run(US);

      for (const channel of CHANNELS) expect(built.out(channel)).toBe(1);
      expect(built.board.topics.mask).toBe(0);
      expect(built.board.faults).toEqual([]);
    } finally {
      built.board.dispose();
    }
  });

  it('初始化发布全释放状态，七路都被上拉读高', async () => {
    const built = await fixture();

    try {
      built.board.run(US);

      for (const channel of CHANNELS) expect(built.out(channel)).toBe(1);
      expect(built.board.topics.mask).toBe(0);
      expect(text(built.board.topics.channels)).toBe('0000000');
      expect(built.board.faults).toEqual([]);
    } finally {
      built.board.dispose();
    }
  });

  it('COM 是被动引脚，没有驱动也不参与通道逻辑', async () => {
    const built = await fixture();

    try {
      for (const channel of CHANNELS) built.drive(channel, 1);
      built.board.run(US);

      expect(built.board.probe('comProbe')).toBe(2);
      for (const channel of CHANNELS) expect(built.out(channel)).toBe(0);
      expect(built.board.faults).toEqual([]);
    } finally {
      built.board.dispose();
    }
  });
});
