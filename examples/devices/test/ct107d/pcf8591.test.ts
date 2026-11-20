import { describe, expect, it } from 'vitest';
import { createTestBoard, readMetadata, US } from './harness.ts';
import type { NetDescription, TestBoard } from './harness.ts';

/**
 * PCF8591 行为基线：DAC 写与 aout 端口、通道选择读、自动递增、控制字节边界，
 * 以及未命中地址时的 NACK。模拟输入通过 `ain0`–`ain3` 输入通道注入；I²C 由
 * 数字源逐位驱动，SDA 由 10 kΩ 外部上拉到 5 V，并用探针确认应答电平。
 */

const STEP = 2 * US;

interface I2cBus {
  start(): void;
  stop(): void;
  writeByte(value: number): number;
  readByte(ack: boolean): number;
}

function makeBus(board: TestBoard): I2cBus {
  const scl = (high: boolean): void => {
    board.send('sclSrc', 'level', high ? 1 : 0);
    board.run(STEP);
  };
  const sda = (high: boolean): void => {
    board.send('sdaSrc', 'level', high ? 2 : 0);
    board.run(STEP);
  };

  return {
    start() {
      sda(true);
      scl(true);
      sda(false);
    },
    stop() {
      scl(false);
      sda(false);
      scl(true);
      sda(true);
    },
    writeByte(value) {
      // 数据位只在 SCL 低期间变化；START 之后先拉低 SCL。
      scl(false);
      for (let bit = 7; bit >= 0; bit -= 1) {
        sda(((value >> bit) & 1) === 1);
        scl(true);
        scl(false);
      }

      sda(true);
      scl(true);
      const ack = board.probe('sdaProbe');
      scl(false);
      return ack;
    },
    readByte(ack) {
      let value = 0;

      sda(true);
      for (let bit = 0; bit < 8; bit += 1) {
        scl(true);
        value = (value << 1) | (board.probe('sdaProbe') === 1 ? 1 : 0);
        scl(false);
      }

      sda(!ack);
      scl(true);
      scl(false);
      sda(true);
      return value;
    },
  };
}

async function fixture(): Promise<{ board: TestBoard; bus: I2cBus }> {
  const nets: NetDescription[] = [
    {
      id: 'vcc',
      pins: [
        { instance: 'dut', pin: 'vcc' },
        { instance: 'sdaPull', pin: 'b' },
      ],
      voltage: 5,
    },
    {
      id: 'gnd',
      pins: [
        { instance: 'dut', pin: 'gnd' },
        { instance: 'dut', pin: 'a0' },
        { instance: 'dut', pin: 'a1' },
        { instance: 'dut', pin: 'a2' },
      ],
      voltage: 0,
    },
    {
      id: 'sda',
      pins: [
        { instance: 'dut', pin: 'sda' },
        { instance: 'sdaSrc', pin: 'y' },
        { instance: 'sdaPull', pin: 'a' },
        { instance: 'sdaProbe', pin: 'y' },
      ],
    },
    {
      id: 'scl',
      pins: [
        { instance: 'dut', pin: 'scl' },
        { instance: 'sclSrc', pin: 'y' },
      ],
    },
    { id: 'sclSrc-vcc', pins: [{ instance: 'sclSrc', pin: 'vcc' }], voltage: 5 },
    { id: 'sclSrc-gnd', pins: [{ instance: 'sclSrc', pin: 'gnd' }], voltage: 0 },
    { id: 'sdaSrc-vcc', pins: [{ instance: 'sdaSrc', pin: 'vcc' }], voltage: 5 },
    { id: 'sdaSrc-gnd', pins: [{ instance: 'sdaSrc', pin: 'gnd' }], voltage: 0 },
  ];

  const board = await createTestBoard('pcf8591', {
    resistors: [{ id: 'sdaPull', resistance: 10_000 }],
    sources: ['sclSrc', 'sdaSrc'],
    probes: ['sdaProbe'],
    nets,
  });

  // 让 process start 与四个输入通道接收过程进入等待。
  board.run(10 * US);

  return { board, bus: makeBus(board) };
}

function inject(board: TestBoard, channel: string, value: number): void {
  const method = `set${channel[0]?.toUpperCase() ?? ''}${channel.slice(1)}`;
  board.send('dut', method, value);
  board.run(STEP);
}

describe('PCF8591', () => {
  it('清单声明 14 根引脚、四路输入方法与两路查询/事件', () => {
    const metadata = readMetadata('pcf8591');

    expect(Object.keys(metadata.pins ?? {})).toHaveLength(14);

    for (const name of ['ain0', 'ain1', 'ain2', 'ain3'])
      expect(
        metadata.model.methods[`set${name[0]?.toUpperCase() ?? ''}${name.slice(1)}`],
      ).toBeDefined();

    expect(metadata.model.methods.getAout).toBeDefined();
    expect(metadata.model.methods.getChannel).toBeDefined();
    expect(metadata.model.events.onDidAout).toMatchObject({ type: 'number' });
    expect(metadata.model.events.onDidChannel).toMatchObject({ type: 'number' });
  });

  it('DAC 使能位为 0 时写入数据仍更新 aout 端口', async () => {
    const { board, bus } = await fixture();

    try {
      bus.start();
      expect(bus.writeByte(0x90)).toBe(0);
      expect(bus.writeByte(0x00)).toBe(0);
      expect(bus.writeByte(0x80)).toBe(0);
      bus.stop();

      expect(board.topics.aout).toBeCloseTo(128 / 255, 12);
      expect(board.outputs.aout).toBeCloseTo(128 / 255, 12);
      expect(board.topics.channel).toBe(0);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('通道选择读返回 round(255 × ain[channel])', async () => {
    const { board, bus } = await fixture();

    try {
      inject(board, 'ain2', 0.5);

      bus.start();
      expect(bus.writeByte(0x90)).toBe(0);
      expect(bus.writeByte(0x02)).toBe(0);
      bus.start();
      expect(bus.writeByte(0x91)).toBe(0);
      expect(bus.readByte(false)).toBe(128);
      bus.stop();

      expect(board.topics.channel).toBe(2);
      expect(board.topics.aout).toBe(0);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('自动递增读取各通道最新电平，并在 3 后回绕到 0', async () => {
    const { board, bus } = await fixture();

    try {
      const inputs = { setAin0: 0, setAin1: 0.25, setAin2: 0.5, setAin3: 1 };
      // Interleave updates without advancing simulated time; the inputs must not share a slot.
      for (let i = 0; i < 64; i += 1) {
        for (const method of Object.keys(inputs)) board.send('dut', method, i / 64);
      }
      for (const [method, value] of Object.entries(inputs)) board.send('dut', method, value);
      board.run(STEP);

      bus.start();
      expect(bus.writeByte(0x90)).toBe(0);
      expect(bus.writeByte(0x04)).toBe(0);
      bus.start();
      expect(bus.writeByte(0x91)).toBe(0);
      expect(bus.readByte(true)).toBe(0);
      expect(bus.readByte(true)).toBe(64);
      expect(bus.readByte(true)).toBe(128);
      expect(bus.readByte(false)).toBe(255);
      bus.stop();

      expect(board.history.channel?.slice(-5)).toEqual([0, 1, 2, 3, 0]);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('模拟输入超出 0..1 时按边界钳位', async () => {
    const { board, bus } = await fixture();

    try {
      inject(board, 'ain0', 2);
      inject(board, 'ain1', -1);

      bus.start();
      expect(bus.writeByte(0x90)).toBe(0);
      expect(bus.writeByte(0x00)).toBe(0);
      bus.start();
      expect(bus.writeByte(0x91)).toBe(0);
      expect(bus.readByte(true)).toBe(255);
      bus.stop();

      bus.start();
      expect(bus.writeByte(0x90)).toBe(0);
      expect(bus.writeByte(0x01)).toBe(0);
      bus.start();
      expect(bus.writeByte(0x91)).toBe(0);
      expect(bus.readByte(false)).toBe(0);
      bus.stop();

      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('控制字节边界：bit6/bit2/bit1:0 与未命中地址 NACK', async () => {
    const { board, bus } = await fixture();

    try {
      // 0xA0 是 AT24C02 的写地址，PCF8591 不应答。
      bus.start();
      expect(bus.writeByte(0xa0)).toBe(1);
      bus.stop();

      // 0xFF：DAC 使能 + 自动递增 + 通道 3；bit5/bit4 被接受但不模拟。
      bus.start();
      expect(bus.writeByte(0x90)).toBe(0);
      expect(bus.writeByte(0xff)).toBe(0);
      expect(bus.writeByte(0x7f)).toBe(0);
      bus.stop();

      expect(board.topics.channel).toBe(3);
      expect(board.topics.aout).toBeCloseTo(127 / 255, 12);

      bus.start();
      expect(bus.writeByte(0x90)).toBe(0);
      bus.start();
      expect(bus.writeByte(0x91)).toBe(0);
      expect(bus.readByte(false)).toBe(0);
      bus.stop();

      // 读完一字节后自动递增从 3 回绕到 0。
      expect(board.topics.channel).toBe(0);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });
});
