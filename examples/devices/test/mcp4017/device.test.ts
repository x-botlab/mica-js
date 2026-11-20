import { describe, expect, it } from 'vitest';
import { readMetadata } from '../harness.ts';
import type { TestBoard } from '../harness.ts';
import { createMcpBoard, expectedResistance, expectedVoltage, makeBus, VDD } from './harness.ts';
import type { I2cBus } from './harness.ts';

/**
 * MCP4017 基线：7 位 wiper、固定地址 0x2F、POR midscale、W–B rheostat、
 * 数据只在应答位写入、重复 START/连续读、NACK 与 CT117E 的 R17 上拉分压。
 */

const WRITE_ADDRESS = 0x5e;
const READ_ADDRESS = 0x5f;

async function wiperOf(board: TestBoard): Promise<number> {
  return (await board.query('dut', 'getWiper')) as number;
}

async function resistanceOf(board: TestBoard): Promise<number> {
  return (await board.query('dut', 'getResistance')) as number;
}

async function voltageOf(board: TestBoard): Promise<number> {
  return (await board.query('dut', 'getVoltage')) as number;
}

function writeWiper(bus: I2cBus, code: number): void {
  bus.start();
  expect(bus.writeByte(WRITE_ADDRESS)).toBe(0);
  expect(bus.writeByte(code)).toBe(0);
  bus.stop();
}

function readWiper(bus: I2cBus): number {
  bus.start();
  expect(bus.writeByte(READ_ADDRESS)).toBe(0);
  const value = bus.readByte(false);
  bus.stop();
  return value;
}

function eventValues(board: TestBoard, name: string): number[] {
  return board.events.filter((event) => event.name === name).map((event) => event.value as number);
}

describe('器件声明', () => {
  it('清单声明 6 根引脚、3 个查询方法与 3 个事件', () => {
    const metadata = readMetadata('mcp4017');

    expect(Object.keys(metadata.pins ?? {}).sort()).toEqual(['b', 'scl', 'sda', 'vdd', 'vss', 'w']);
    expect(metadata.properties?.rab?.default).toBe(100000);
    expect(metadata.properties?.wiperResistance?.default).toBe(100);

    for (const name of ['getWiper', 'getResistance', 'getVoltage'])
      expect(metadata.model.methods[name]).toBeDefined();
    for (const name of ['onDidWiper', 'onDidResistance', 'onDidVoltage'])
      expect(metadata.model.events[name]).toMatchObject({ type: 'number' });
  });
});

describe('上电与可采电压', () => {
  it('POR 为 midscale 0x3F，RWB = RAB×63/127 + RW', async () => {
    const board = await createMcpBoard();

    try {
      expect(await wiperOf(board)).toBe(0x3f);
      expect(await resistanceOf(board)).toBeCloseTo(expectedResistance(0x3f), 12);
      expect(await voltageOf(board)).toBeCloseTo(expectedVoltage(0x3f), 12);
      expect(await voltageOf(board)).toBeCloseTo(2.747, 3);
      expect(eventValues(board, 'onDidWiper')[0]).toBe(0x3f);
      expect(eventValues(board, 'onDidResistance')[0]).toBeCloseTo(expectedResistance(0x3f), 12);
      expect(eventValues(board, 'onDidVoltage')[0]).toBeCloseTo(expectedVoltage(0x3f), 12);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('CT117E 等效接线：3.3 V—R17 10 kΩ—W—RWB—B=GND，I²C 改变分压', async () => {
    const board = await createMcpBoard();
    const bus = makeBus(board);

    try {
      writeWiper(bus, 0x00);
      expect(await wiperOf(board)).toBe(0);
      expect(await resistanceOf(board)).toBeCloseTo(100, 12);
      expect(await voltageOf(board)).toBeCloseTo(expectedVoltage(0), 12);
      expect(await voltageOf(board)).toBeGreaterThan(0);
      expect(await voltageOf(board)).toBeLessThan(0.1);

      writeWiper(bus, 0x7f);
      expect(await wiperOf(board)).toBe(0x7f);
      expect(await resistanceOf(board)).toBeCloseTo(100_100, 9);
      expect(await voltageOf(board)).toBeCloseTo(expectedVoltage(0x7f), 12);
      expect(await voltageOf(board)).toBeCloseTo(3.0, 3);
      expect(await voltageOf(board)).toBeLessThan(VDD);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('没有 R17 上拉时 W 只经 W–B 变阻器到地，电压为 0', async () => {
    const board = await createMcpBoard({ r17: false });

    try {
      expect(await voltageOf(board)).toBe(0);
      expect(await resistanceOf(board)).toBeCloseTo(expectedResistance(0x3f), 12);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('B 浮空时 W–B 电阻不提供到地通路，W 被 R17 拉到 VDD', async () => {
    const board = await createMcpBoard({ connectB: false });
    const bus = makeBus(board);

    try {
      writeWiper(bus, 0x00);
      expect(await voltageOf(board)).toBeCloseTo(VDD, 12);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('全浮空时没有有效采样，getVoltage 返回可恢复的 MethodError', async () => {
    const board = await createMcpBoard({ floating: true });

    try {
      expect(await wiperOf(board)).toBe(0x3f);
      await expect(board.query('dut', 'getVoltage')).rejects.toMatchObject({
        name: 'MethodError',
        code: 'voltage/unavailable',
      });
      expect(eventValues(board, 'onDidVoltage')).toEqual([]);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });
});

describe('I²C 读写语义', () => {
  it('写 0x80 得到 code 0，写 0xFF 得到 code 127；读回只含 7 位', async () => {
    const board = await createMcpBoard();
    const bus = makeBus(board);

    try {
      writeWiper(bus, 0x80);
      expect(await wiperOf(board)).toBe(0);
      expect(readWiper(bus)).toBe(0);

      writeWiper(bus, 0xff);
      expect(await wiperOf(board)).toBe(0x7f);
      expect(readWiper(bus)).toBe(0x7f);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('一个写事务中的每个数据字节都更新 wiper', async () => {
    const board = await createMcpBoard();
    const bus = makeBus(board);

    try {
      bus.start();
      expect(bus.writeByte(WRITE_ADDRESS)).toBe(0);
      expect(bus.writeByte(0x10)).toBe(0);
      expect(bus.writeByte(0x20)).toBe(0);
      expect(bus.writeByte(0x30)).toBe(0);
      bus.stop();

      expect(await wiperOf(board)).toBe(0x30);
      expect(eventValues(board, 'onDidWiper').slice(-3)).toEqual([0x10, 0x20, 0x30]);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('写后重复 START 可直接读；主机 ACK 连续读返回同一 wiper', async () => {
    const board = await createMcpBoard();
    const bus = makeBus(board);

    try {
      bus.start();
      expect(bus.writeByte(WRITE_ADDRESS)).toBe(0);
      expect(bus.writeByte(0x40)).toBe(0);
      bus.start();
      expect(bus.writeByte(READ_ADDRESS)).toBe(0);
      expect(bus.readByte(true)).toBe(0x40);
      expect(bus.readByte(false)).toBe(0x40);
      bus.stop();

      expect(await wiperOf(board)).toBe(0x40);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('wiper 只在第 9 个时钟应答位结束后写入', async () => {
    const board = await createMcpBoard();
    const bus = makeBus(board);

    try {
      bus.start();
      expect(bus.writeByte(WRITE_ADDRESS)).toBe(0);
      expect(bus.writeDataUntilAck(0x22)).toBe(0);
      // 8 个数据位已收齐、SDA 已应答，但第 9 个下降沿尚未到来。
      expect(await wiperOf(board)).toBe(0x3f);
      bus.completeAck();
      expect(await wiperOf(board)).toBe(0x22);
      bus.stop();
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('读完 NACK 后释放 SDA，继续时钟不会发送更多数据', async () => {
    const board = await createMcpBoard();
    const bus = makeBus(board);

    try {
      bus.start();
      expect(bus.writeByte(READ_ADDRESS)).toBe(0);
      expect(bus.readByte(false)).toBe(0x3f);
      expect(bus.readSda()).toBe(1);

      for (let clock = 0; clock < 3; clock += 1) expect(bus.pulseClock()).toBe(1);

      bus.stop();
      expect(await wiperOf(board)).toBe(0x3f);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('重复写同一 code 不重复发布 wiper 事件', async () => {
    const board = await createMcpBoard();
    const bus = makeBus(board);

    try {
      writeWiper(bus, 0x10);
      const wiperEvents = eventValues(board, 'onDidWiper').length;
      const resistanceEvents = eventValues(board, 'onDidResistance').length;

      writeWiper(bus, 0x10);
      expect(eventValues(board, 'onDidWiper')).toHaveLength(wiperEvents);
      expect(eventValues(board, 'onDidResistance')).toHaveLength(resistanceEvents);

      writeWiper(bus, 0x11);
      expect(eventValues(board, 'onDidWiper')).toHaveLength(wiperEvents + 1);
      expect(eventValues(board, 'onDidWiper').at(-1)).toBe(0x11);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('SDA 浮空时专属探针使 ACK 采样失败，而不是当作高电平', async () => {
    const board = await createMcpBoard({ sdaPullup: false });
    const bus = makeBus(board);

    try {
      bus.start();
      expect(() => bus.writeByte(0x5c)).toThrow(/SDA is not a valid logic level/);
    } finally {
      board.dispose();
    }
  });

  it('地址不匹配与 general call 都不应答，随后正确地址可恢复', async () => {
    const board = await createMcpBoard();
    const bus = makeBus(board);

    try {
      bus.start();
      expect(bus.writeByte(0x00)).toBe(1);
      expect(bus.writeByte(0xaa)).toBe(1);
      bus.stop();

      bus.start();
      expect(bus.writeByte(0x5c)).toBe(1);
      expect(bus.writeByte(0x11)).toBe(1);
      bus.stop();

      expect(await wiperOf(board)).toBe(0x3f);

      writeWiper(bus, 0x05);
      expect(await wiperOf(board)).toBe(0x05);
      expect(readWiper(bus)).toBe(0x05);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });
});

describe('参数边界', () => {
  it('RAB 与 wiper 电阻改变 W–B 电阻和分压，但不改变 7 位码', async () => {
    const board = await createMcpBoard({
      props: { rab: 10_000, wiperResistance: 170 },
    });
    const bus = makeBus(board);

    try {
      writeWiper(bus, 0x3f);
      expect(await resistanceOf(board)).toBeCloseTo(
        expectedResistance(0x3f, { rab: 10_000, wiperResistance: 170 }),
        12,
      );
      expect(await voltageOf(board)).toBeCloseTo(
        expectedVoltage(0x3f, { rab: 10_000, wiperResistance: 170 }),
        12,
      );
      expect(await wiperOf(board)).toBe(0x3f);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('非法电阻参数在创建期被拒绝', async () => {
    await expect(createMcpBoard({ props: { rab: 0 } })).rejects.toThrow(/rab/);
    await expect(createMcpBoard({ props: { wiperResistance: 0 } })).rejects.toThrow(
      /wiperResistance/,
    );
    await expect(
      createMcpBoard({ props: { rab: 1_000_000_000, wiperResistance: 1 } }),
    ).rejects.toThrow(/1 GΩ/);
  });
});
