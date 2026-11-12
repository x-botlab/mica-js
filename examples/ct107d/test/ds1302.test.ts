import { describe, expect, it } from 'vitest';
import { createTestBoard, readMetadata, US } from './harness.ts';
import type { NetDescription, TestBoard } from './harness.ts';

/**
 * DS1302 位级行为基线：写时间后跨日跨月走时、时钟/RAM 突发、WP 写保护、CH 停振，
 * 以及 `datetime`（ASCII bytes）与 `running` 端口。
 *
 * RST/SCLK 由数字源逐位驱动；IO 是开漏双向端，主机只拉低或释放，10 kΩ 外部上拉到
 * 5 V。读事务的第 0 位由命令第 8 个上升沿之后的下降沿输出，因此 `readByte` 复用
 * `writeByte` 收尾的那一拍，不再额外补一个下降沿。
 */

const STEP = 2 * US;
const SECOND = 1_000_000_000_000;

interface ThreeWire {
  /** RST 上升沿，开始一次事务。 */
  begin(): void;
  /** RST 下降沿，结束事务并释放 IO。 */
  end(): void;
  writeByte(value: number): void;
  readByte(): number;
}

interface Fixture {
  readonly board: TestBoard;
  readonly wire: ThreeWire;
}

function decode(board: TestBoard): string {
  const value = board.topics.datetime;

  expect(value).toBeDefined();
  return String.fromCharCode(...(value as unknown as Iterable<number>));
}

async function fixture(): Promise<Fixture> {
  const nets: NetDescription[] = [
    {
      id: 'vcc',
      pins: [
        { instance: 'dut', pin: 'vcc' },
        { instance: 'dut', pin: 'vcc1' },
        { instance: 'ioPull', pin: 'a' },
        { instance: 'rstSrc', pin: 'vcc' },
        { instance: 'sclkSrc', pin: 'vcc' },
        { instance: 'ioSrc', pin: 'vcc' },
      ],
      voltage: 5,
    },
    {
      id: 'gnd',
      pins: [
        { instance: 'dut', pin: 'gnd' },
        { instance: 'rstSrc', pin: 'gnd' },
        { instance: 'sclkSrc', pin: 'gnd' },
        { instance: 'ioSrc', pin: 'gnd' },
      ],
      voltage: 0,
    },
    {
      id: 'rst',
      pins: [
        { instance: 'dut', pin: 'rst' },
        { instance: 'rstSrc', pin: 'y' },
      ],
    },
    {
      id: 'sclk',
      pins: [
        { instance: 'dut', pin: 'sclk' },
        { instance: 'sclkSrc', pin: 'y' },
      ],
    },
    {
      id: 'io',
      pins: [
        { instance: 'dut', pin: 'io' },
        { instance: 'ioSrc', pin: 'y' },
        { instance: 'ioPull', pin: 'b' },
        { instance: 'ioProbe', pin: 'y' },
      ],
    },
  ];

  const board = await createTestBoard('ds1302', {
    resistors: [{ id: 'ioPull', resistance: 10_000 }],
    sources: ['rstSrc', 'sclkSrc', 'ioSrc'],
    probes: ['ioProbe'],
    nets,
  });

  const drive = (instance: string, level: number): void => {
    board.send(instance, 'level', level);
    board.run(STEP);
  };
  const sclk = (high: boolean): void => drive('sclkSrc', high ? 1 : 0);
  const io = (level: number): void => drive('ioSrc', level);
  const settle = (): void => board.run(STEP);

  drive('rstSrc', 0);
  sclk(false);
  io(2);

  // 读命令第 8 个上升沿之后的那一拍已经输出了数据 bit0，readByte 只补 7 拍。
  let pendingDataBit = false;

  return {
    board,
    wire: {
      begin() {
        io(2);
        sclk(false);
        pendingDataBit = false;
        drive('rstSrc', 1);
      },
      end() {
        drive('rstSrc', 0);
        io(2);
        pendingDataBit = false;
      },
      writeByte(value) {
        for (let bit = 0; bit < 8; bit += 1) {
          // 开漏主机：写 1 只释放，由上拉决定高电平。
          io(((value >> bit) & 1) === 1 ? 2 : 0);
          sclk(true);
          sclk(false);
        }
        io(2);
        pendingDataBit = value % 2 === 1;
      },
      readByte() {
        let value = 0;

        for (let bit = 0; bit < 8; bit += 1) {
          if (bit > 0 || !pendingDataBit) {
            sclk(true);
            sclk(false);
          }
          settle();
          const level = board.probe('ioProbe');

          expect([0, 1]).toContain(level);
          if (level === 1) value |= 1 << bit;
        }

        pendingDataBit = false;
        io(2);
        return value;
      },
    },
  };
}

describe('DS1302', () => {
  it('元数据声明 8 根引脚与 datetime/running 端口', () => {
    const metadata = readMetadata('ds1302') as {
      readonly pins: Readonly<Record<string, unknown>>;
      readonly ports: Readonly<
        Record<string, { readonly type: string; readonly direction: string }>
      >;
    };

    expect(Object.keys(metadata.pins).sort()).toEqual([
      'gnd',
      'io',
      'rst',
      'sclk',
      'vcc',
      'vcc1',
      'x1',
      'x2',
    ]);
    expect(metadata.ports.datetime?.type).toBe('bytes');
    expect(metadata.ports.datetime?.direction).toBe('output');
    expect(metadata.ports.running?.type).toBe('boolean');
    expect(metadata.ports.running?.direction).toBe('output');
  });

  it('上电发布 2026-01-01 00:00:00，写入 23:59:58 后 3 秒跨日跨月', async () => {
    const { board, wire } = await fixture();

    try {
      expect(decode(board)).toBe('2026-01-01 00:00:00');
      expect(board.topics.running).toBe(true);

      // 时钟突发写：秒、分、时、日、月、星期、年、WP。
      wire.begin();
      wire.writeByte(0xbe);
      for (const byte of [0x58, 0x59, 0x23, 0x31, 0x01, 0x06, 0x26, 0x00]) wire.writeByte(byte);
      wire.end();

      expect(decode(board)).toBe('2026-01-31 23:59:58');

      const publishes = board.history.datetime?.length ?? 0;

      // 每秒推进一次，逐次确认端口发布。
      board.run(SECOND);
      expect(decode(board)).toBe('2026-01-31 23:59:59');
      board.run(SECOND);
      expect(decode(board)).toBe('2026-02-01 00:00:00');
      board.run(SECOND);

      expect(decode(board)).toBe('2026-02-01 00:00:01');
      // 每秒走时都发布一次。
      expect(board.history.datetime?.length ?? 0).toBeGreaterThanOrEqual(publishes + 3);

      wire.begin();
      wire.writeByte(0xbf);
      const readback: number[] = [];

      for (let index = 0; index < 8; index += 1) readback.push(wire.readByte());
      wire.end();

      expect(readback).toEqual([0x01, 0x00, 0x00, 0x01, 0x02, 0x07, 0x26, 0x00]);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('时钟突发与 RAM 突发整段回读（含 WP 字节与 31 字节 RAM）', async () => {
    const { board, wire } = await fixture();

    try {
      wire.begin();
      wire.writeByte(0xbe);
      for (const byte of [0x10, 0x20, 0x03, 0x15, 0x06, 0x03, 0x24]) wire.writeByte(byte);
      // 突发第 8 字节是 WP 寄存器。
      wire.writeByte(0x00);
      wire.end();

      wire.begin();
      wire.writeByte(0xbf);
      const clock: number[] = [];

      for (let index = 0; index < 8; index += 1) clock.push(wire.readByte());
      wire.end();

      expect(clock).toEqual([0x10, 0x20, 0x03, 0x15, 0x06, 0x03, 0x24, 0x00]);

      // RAM 突发写 31 字节（0xFE），再整段读回（0xFF）。
      wire.begin();
      wire.writeByte(0xfe);
      for (let index = 0; index < 31; index += 1) wire.writeByte(0xa0 + index);
      wire.end();

      wire.begin();
      wire.writeByte(0xff);
      const ram: number[] = [];

      for (let index = 0; index < 31; index += 1) ram.push(wire.readByte());
      wire.end();

      expect(ram).toEqual(Array.from({ length: 31 }, (_, index) => 0xa0 + index));

      // 单字节 RAM 访问：地址 0 写 0x5a，再读回。
      wire.begin();
      wire.writeByte(0xc0);
      wire.writeByte(0x5a);
      wire.end();

      wire.begin();
      wire.writeByte(0xc1);
      expect(wire.readByte()).toBe(0x5a);
      wire.end();

      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('WP = 1 时时钟与 RAM 写被忽略，但 WP 寄存器自身仍可写', async () => {
    const { board, wire } = await fixture();

    try {
      // 清 WP 后写秒，确认可写。
      wire.begin();
      wire.writeByte(0x8e);
      wire.writeByte(0x00);
      wire.end();

      wire.begin();
      wire.writeByte(0x80);
      wire.writeByte(0x30);
      wire.end();

      wire.begin();
      wire.writeByte(0x81);
      expect(wire.readByte()).toBe(0x30);
      wire.end();

      // 置 WP：秒与 RAM 写被忽略，读不受影响。
      wire.begin();
      wire.writeByte(0x8e);
      wire.writeByte(0x80);
      wire.end();

      wire.begin();
      wire.writeByte(0x80);
      wire.writeByte(0x45);
      wire.end();

      wire.begin();
      wire.writeByte(0x81);
      expect(wire.readByte()).toBe(0x30);
      wire.end();

      wire.begin();
      wire.writeByte(0xc0);
      wire.writeByte(0x77);
      wire.end();

      wire.begin();
      wire.writeByte(0xc1);
      expect(wire.readByte()).toBe(0x00);
      wire.end();

      // WP = 1 时时钟突发整体被丢弃，包括末尾的 WP 字节。
      wire.begin();
      wire.writeByte(0xbe);
      for (const byte of [0x11, 0x22, 0x03, 0x04, 0x05, 0x06, 0x24, 0x00]) wire.writeByte(byte);
      wire.end();

      wire.begin();
      wire.writeByte(0x8f);
      expect(wire.readByte()).toBe(0x80);
      wire.end();

      wire.begin();
      wire.writeByte(0x81);
      expect(wire.readByte()).toBe(0x30);
      wire.end();

      // RAM 突发同样整段丢弃。
      wire.begin();
      wire.writeByte(0xfe);
      for (let index = 0; index < 31; index += 1) wire.writeByte(0x99);
      wire.end();

      wire.begin();
      wire.writeByte(0xff);
      for (let index = 0; index < 31; index += 1) expect(wire.readByte()).toBe(0x00);
      wire.end();

      // WP 寄存器自身可写：清保护后秒恢复可写。
      wire.begin();
      wire.writeByte(0x8e);
      wire.writeByte(0x00);
      wire.end();

      wire.begin();
      wire.writeByte(0x80);
      wire.writeByte(0x45);
      wire.end();

      wire.begin();
      wire.writeByte(0x81);
      expect(wire.readByte()).toBe(0x45);
      wire.end();

      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('CH = 1 停振：datetime 冻结、running 变假，清 CH 后继续走时', async () => {
    const { board, wire } = await fixture();

    try {
      wire.begin();
      wire.writeByte(0x8e);
      wire.writeByte(0x00);
      wire.end();

      // 秒寄存器 bit7 = CH = 1，秒值 00。
      wire.begin();
      wire.writeByte(0x80);
      wire.writeByte(0x80);
      wire.end();

      expect(board.topics.running).toBe(false);
      expect(decode(board)).toBe('2026-01-01 00:00:00');

      board.run(2 * SECOND);

      expect(decode(board)).toBe('2026-01-01 00:00:00');
      expect(board.topics.running).toBe(false);

      // 清 CH：走时恢复，1 秒后秒值进位。
      wire.begin();
      wire.writeByte(0x80);
      wire.writeByte(0x00);
      wire.end();

      expect(board.topics.running).toBe(true);

      board.run(SECOND);

      expect(decode(board)).toBe('2026-01-01 00:00:01');
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('闰年二月：2028-02-28 23:59:59 走 1 秒进入 02-29', async () => {
    const { board, wire } = await fixture();

    try {
      wire.begin();
      wire.writeByte(0xbe);
      for (const byte of [0x59, 0x59, 0x23, 0x28, 0x02, 0x02, 0x28, 0x00]) wire.writeByte(byte);
      wire.end();

      expect(decode(board)).toBe('2028-02-28 23:59:59');

      board.run(SECOND);

      expect(decode(board)).toBe('2028-02-29 00:00:00');
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });
});
