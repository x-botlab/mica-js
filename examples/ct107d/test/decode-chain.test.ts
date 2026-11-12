import { describe, expect, it } from 'vitest';
import { createBoardWith } from './harness.ts';
import type { NetDescription, TestBoard } from './harness.ts';

/**
 * CT107D 的片选—锁存链路：P2.5/P2.6/P2.7 → 74HC138（U24）→ Y4# → 74HC02（U25）与 WR
 * 或非 → LE → 74HC573（U6–U9）。
 *
 * 这条链路是整块板所有外设访问的公共通路，因此单独做一次端到端验证：三颗器件、真实
 * 电气网络、探针观察每一级电平。板上 U6–U9 的 LE 由 Y4C–Y7C 分别产生，这里只接 Y4#。
 */

const DATA = [0, 1, 2, 3, 4, 5, 6, 7] as const;

interface Fixture {
  readonly board: TestBoard;
  /** 设置 P2 的高三位（P2.5–P2.7）。 */
  selectP2(high: number): void;
  /** WR 引脚电平。 */
  write(high: boolean): void;
  /** 数据总线字节。 */
  data(byte: number): void;
  /** 读回锁存输出。 */
  q(): number;
  /** 读 Y4# 引脚电平（0 = 选中）。 */
  y4(): number;
  /** 读 LE 引脚电平。 */
  le(): number;
}

async function chain(): Promise<Fixture> {
  const sources = ['p25', 'p26', 'p27', 'wr', ...DATA.map((bit) => `d${bit}`)];
  const probes = ['y4Probe', 'leProbe', ...DATA.map((bit) => `q${bit}Probe`)];
  const nets: NetDescription[] = [
    {
      id: 'vcc',
      pins: [
        { instance: 'decoder', pin: 'vcc' },
        { instance: 'nor', pin: 'vcc' },
        { instance: 'latch', pin: 'vcc' },
      ],
      voltage: 5,
    },
    {
      id: 'gnd',
      pins: [
        { instance: 'decoder', pin: 'gnd' },
        { instance: 'nor', pin: 'gnd' },
        { instance: 'latch', pin: 'gnd' },
        { instance: 'decoder', pin: 'e1' },
        { instance: 'decoder', pin: 'e2' },
        { instance: 'latch', pin: 'oe' },
      ],
      voltage: 0,
    },
    { id: 'e3', pins: [{ instance: 'decoder', pin: 'e3' }], voltage: 5 },
    {
      id: 'a',
      pins: [
        { instance: 'decoder', pin: 'a' },
        { instance: 'p25', pin: 'y' },
      ],
    },
    {
      id: 'b',
      pins: [
        { instance: 'decoder', pin: 'b' },
        { instance: 'p26', pin: 'y' },
      ],
    },
    {
      id: 'c',
      pins: [
        { instance: 'decoder', pin: 'c' },
        { instance: 'p27', pin: 'y' },
      ],
    },
    {
      id: 'y4',
      pins: [
        { instance: 'decoder', pin: 'y4' },
        { instance: 'nor', pin: 'a1' },
        { instance: 'y4Probe', pin: 'y' },
      ],
    },
    {
      id: 'wr',
      pins: [
        { instance: 'nor', pin: 'b1' },
        { instance: 'wr', pin: 'y' },
      ],
    },
    {
      id: 'le',
      pins: [
        { instance: 'nor', pin: 'y1' },
        { instance: 'latch', pin: 'le' },
        { instance: 'leProbe', pin: 'y' },
      ],
    },
  ];

  for (const bit of DATA)
    nets.push(
      {
        id: `d${bit}`,
        pins: [
          { instance: 'latch', pin: `d${bit}` },
          { instance: `d${bit}`, pin: 'y' },
        ],
      },
      {
        id: `q${bit}`,
        pins: [
          { instance: 'latch', pin: `q${bit}` },
          { instance: `q${bit}Probe`, pin: 'y' },
        ],
      },
    );

  for (const id of sources)
    nets.push(
      { id: `${id}-vcc`, pins: [{ instance: id, pin: 'vcc' }], voltage: 5 },
      { id: `${id}-gnd`, pins: [{ instance: id, pin: 'gnd' }], voltage: 0 },
    );

  const board = await createBoardWith(
    [
      { id: 'decoder', type: '74hc138' },
      { id: 'nor', type: '74hc02' },
      { id: 'latch', type: '74hc573' },
    ],
    { nets, probes, sources },
  );
  const drive = (instance: string, high: boolean): void =>
    board.send(instance, 'level', high ? 1 : 0);

  return {
    board,
    selectP2(high) {
      drive('p25', (high & 1) !== 0);
      drive('p26', (high & 2) !== 0);
      drive('p27', (high & 4) !== 0);
    },
    write(high) {
      drive('wr', high);
    },
    data(byte) {
      for (const bit of DATA) drive(`d${bit}`, ((byte >> bit) & 1) === 1);
    },
    q() {
      let value = 0;

      for (const bit of DATA) if (board.probe(`q${bit}Probe`) === 1) value |= 1 << bit;

      return value;
    },
    y4: () => board.probe('y4Probe'),
    le: () => board.probe('leProbe'),
  };
}

describe('CT107D 片选—锁存链路', () => {
  it('Y4C 选中时写周期透明、WR 上升沿锁存，取消选中后保持', async () => {
    const built = await chain();

    try {
      // P2.7=1 → C=1,B=0,A=0 → 选中 Y4#；138 的 select 端口应发布 4。
      built.selectP2(4);
      built.write(false);
      built.board.run(1_000_000);

      expect(built.board.faults).toEqual([]);
      expect(built.y4()).toBe(0);
      expect(built.le()).toBe(1);
      expect(built.board.topics.select).toBe(4);
      expect(built.board.topics.enabled).toBe(true);

      built.data(0x5a);
      built.board.run(1_000_000);
      expect(built.q()).toBe(0x5a);

      // WR 上升沿 → LE 下降沿 → 锁存 0x5a。
      built.write(true);
      built.board.run(1_000_000);
      expect(built.le()).toBe(0);
      expect(built.board.topics.latch).toBe(0x5a);

      built.data(0xc3);
      built.board.run(1_000_000);
      expect(built.q()).toBe(0x5a);

      // 取消片选：Y4# 回高，锁存值不受影响。
      built.selectP2(0);
      built.board.run(1_000_000);
      expect(built.y4()).toBe(1);
      expect(built.le()).toBe(0);
      expect(built.q()).toBe(0x5a);
    } finally {
      built.board.dispose();
    }
  });

  it('再次选中时透明跟随新数据，WR 上升沿再次锁存', async () => {
    const built = await chain();

    try {
      built.selectP2(4);
      built.write(false);
      built.data(0x33);
      built.board.run(1_000_000);
      expect(built.q()).toBe(0x33);

      built.write(true);
      built.board.run(1_000_000);
      expect(built.q()).toBe(0x33);
      expect(built.board.topics.latch).toBe(0x33);

      // 换一个通道（Y5#）不会产生 LE，数据总线变化被忽略。
      built.selectP2(5);
      built.data(0x7e);
      built.board.run(1_000_000);
      expect(built.y4()).toBe(1);
      expect(built.le()).toBe(0);
      expect(built.q()).toBe(0x33);
    } finally {
      built.board.dispose();
    }
  });

  it('WR 保持低时片选脉冲直接穿透，WR 为高时片选不产生锁存沿', async () => {
    const built = await chain();

    try {
      // WR 已为高：选中 Y4# 不改变 LE（保持低），也不捕获数据。
      built.write(true);
      built.data(0x11);
      built.selectP2(4);
      built.board.run(1_000_000);
      expect(built.le()).toBe(0);
      expect(built.q()).toBe(0x00);

      // 拉低 WR → 透明；数据 0x11 出现在 Q 上。
      built.write(false);
      built.board.run(1_000_000);
      expect(built.le()).toBe(1);
      expect(built.q()).toBe(0x11);

      // 取消片选的同时 WR 仍低：LE 变低并锁存 0x11。
      built.selectP2(0);
      built.board.run(1_000_000);
      expect(built.le()).toBe(0);
      expect(built.board.topics.latch).toBe(0x11);
    } finally {
      built.board.dispose();
    }
  });
});
