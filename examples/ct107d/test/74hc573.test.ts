import { describe, expect, it } from 'vitest';
import { createTestBoard, readMetadata } from './harness.ts';
import type { NetDescription, TestBoard } from './harness.ts';

/**
 * 74HC573 的行为基线：透明跟随、下降沿锁存、OE# 三态，以及 `latch` 端口。
 *
 * 输入由数字源 `d0`–`d7`、`le`、`oe` 驱动，输出电平由 `q0`–`q7` 上的探针在网络上采样，
 * 不读取器件自己发布的中间值。
 */

const DATA = [0, 1, 2, 3, 4, 5, 6, 7] as const;

interface Fixture {
  readonly board: TestBoard;
  data(byte: number): void;
  le(high: boolean): void;
  oe(high: boolean): void;
  q(): number;
  release(): void;
}

async function fixture(): Promise<Fixture> {
  const nets: NetDescription[] = [
    { id: 'vcc', pins: [{ instance: 'dut', pin: 'vcc' }], voltage: 5 },
    { id: 'gnd', pins: [{ instance: 'dut', pin: 'gnd' }], voltage: 0 },
    {
      id: 'le',
      pins: [
        { instance: 'dut', pin: 'le' },
        { instance: 'leSrc', pin: 'y' },
      ],
    },
    {
      id: 'oe',
      pins: [
        { instance: 'dut', pin: 'oe' },
        { instance: 'oeSrc', pin: 'y' },
      ],
    },
  ];
  const sources = ['leSrc', 'oeSrc', ...DATA.map((bit) => `d${bit}Src`)];

  for (const bit of DATA)
    nets.push({
      id: `d${bit}`,
      pins: [
        { instance: 'dut', pin: `d${bit}` },
        { instance: `d${bit}Src`, pin: 'y' },
      ],
    });

  for (const bit of DATA)
    nets.push({
      id: `q${bit}`,
      pins: [
        { instance: 'dut', pin: `q${bit}` },
        { instance: `q${bit}Probe`, pin: 'y' },
      ],
    });

  for (const id of sources)
    nets.push(
      { id: `${id}-vcc`, pins: [{ instance: id, pin: 'vcc' }], voltage: 5 },
      { id: `${id}-gnd`, pins: [{ instance: id, pin: 'gnd' }], voltage: 0 },
    );

  const board = await createTestBoard('74hc573', {
    nets,
    probes: DATA.map((bit) => `q${bit}Probe`),
    sources,
  });

  const drive = (instance: string, high: boolean): void =>
    board.send(instance, 'level', high ? 1 : 0);

  return {
    board,
    data(byte) {
      for (const bit of DATA) drive(`d${bit}Src`, ((byte >> bit) & 1) === 1);
    },
    le(high) {
      drive('leSrc', high);
    },
    oe(high) {
      drive('oeSrc', high);
    },
    q() {
      let value = 0;

      for (const bit of DATA) {
        const level = board.probe(`q${bit}Probe`);

        expect([0, 1]).toContain(level);
        if (level === 1) value |= 1 << bit;
      }

      return value;
    },
    release() {
      for (const bit of DATA) expect(board.probe(`q${bit}Probe`)).not.toBe(1);
    },
  };
}

describe('74HC573', () => {
  it('元数据声明 20 根引脚与 latch 端口', () => {
    const metadata = readMetadata('74hc573') as {
      readonly pins: Readonly<Record<string, unknown>>;
      readonly ports: Readonly<Record<string, { readonly type: string }>>;
    };

    expect(Object.keys(metadata.pins)).toHaveLength(20);
    expect(metadata.ports.latch?.type).toBe('number');
  });

  it('LE 高时透明跟随 D，下降沿锁存当时的字节', async () => {
    const built = await fixture();

    try {
      built.le(true);
      built.oe(false);
      built.data(0xa5);
      built.board.run(1_000_000);

      expect(built.board.faults).toEqual([]);
      expect(built.q()).toBe(0xa5);
      expect(built.board.topics.latch).toBe(0xa5);

      built.le(false);
      built.data(0x3c);
      built.board.run(1_000_000);

      // LE 已经为低：后续数据变化不再影响 Q。
      expect(built.q()).toBe(0xa5);

      built.le(true);
      built.board.run(1_000_000);
      expect(built.q()).toBe(0x3c);

      built.le(false);
      built.board.run(1_000_000);
      expect(built.q()).toBe(0x3c);
      expect(built.board.topics.latch).toBe(0x3c);
    } finally {
      built.board.dispose();
    }
  });

  it('OE# 高时八路输出全部释放，恢复低后回到锁存值', async () => {
    const built = await fixture();

    try {
      built.le(true);
      built.oe(false);
      built.data(0x5a);
      built.board.run(1_000_000);
      expect(built.q()).toBe(0x5a);

      built.oe(true);
      built.board.run(1_000_000);
      built.release();

      built.oe(false);
      built.board.run(1_000_000);
      expect(built.q()).toBe(0x5a);
      expect(built.board.faults).toEqual([]);
    } finally {
      built.board.dispose();
    }
  });

  it('悬空的输入按低处理，输出不会停在未知电平', async () => {
    const built = await fixture();

    try {
      for (const bit of DATA) built.board.send(`d${bit}Src`, 'level', 2);
      built.le(true);
      built.oe(false);
      built.board.run(1_000_000);

      expect(built.q()).toBe(0x00);
      expect(built.board.faults).toEqual([]);
    } finally {
      built.board.dispose();
    }
  });
});
