import { describe, expect, it } from 'vitest';
import { createTestBoard, readMetadata, runRuntimeOnce, US } from './harness.ts';
import type { NetDescription, TestBoard } from './harness.ts';

/**
 * AT24C02 位级行为基线：写事务、随机读、连续读与整阵列回绕、8 字节页写回绕、
 * WP 写保护，以及 `dump` 存储映像端口。
 *
 * 总线由数字源 `sclSrc` / `sdaSrc` 逐位驱动；SDA 通过 10 kΩ 外部上拉到 5 V，
 * 主机只拉低或释放（开漏），器件拉低时用 `sdaProbe` 探针确认 ADK 与数据位。
 */

const STEP = 2 * US;

interface I2cBus {
  start(): void;
  stop(): void;
  /** 发送一个字节，返回第 9 个时钟上采样到的 SDA 电平（0=ACK，1=NACK）。 */
  writeByte(value: number): number;
  /** 读取一个字节；`ack` 为主机是否在第 9 个时钟拉低应答。 */
  readByte(ack: boolean): number;
}

function makeBus(board: TestBoard): I2cBus {
  const scl = (high: boolean): void => {
    board.send('sclSrc', 'level', high ? 1 : 0);
    board.run(STEP);
  };
  const sda = (high: boolean): void => {
    // 开漏主机：高电平只释放，由上拉电阻决定。
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

      // 第 9 个时钟：ACK 拉低，NACK 释放。
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
    {
      id: 'wp',
      pins: [
        { instance: 'dut', pin: 'wp' },
        { instance: 'wpSrc', pin: 'y' },
      ],
    },
    { id: 'sclSrc-vcc', pins: [{ instance: 'sclSrc', pin: 'vcc' }], voltage: 5 },
    { id: 'sclSrc-gnd', pins: [{ instance: 'sclSrc', pin: 'gnd' }], voltage: 0 },
    { id: 'sdaSrc-vcc', pins: [{ instance: 'sdaSrc', pin: 'vcc' }], voltage: 5 },
    { id: 'sdaSrc-gnd', pins: [{ instance: 'sdaSrc', pin: 'gnd' }], voltage: 0 },
    { id: 'wpSrc-vcc', pins: [{ instance: 'wpSrc', pin: 'vcc' }], voltage: 5 },
    { id: 'wpSrc-gnd', pins: [{ instance: 'wpSrc', pin: 'gnd' }], voltage: 0 },
  ];

  const board = await createTestBoard('at24c02', {
    resistors: [{ id: 'sdaPull', resistance: 10_000 }],
    sources: ['sclSrc', 'sdaSrc', 'wpSrc'],
    probes: ['sdaProbe'],
    nets,
  });

  board.send('wpSrc', 'level', 0);
  board.run(STEP);

  return { board, bus: makeBus(board) };
}

function dump(board: TestBoard): number[] {
  const value = board.topics.dump;

  expect(value).toBeDefined();
  return [...(value as unknown as Iterable<number>)];
}

describe('AT24C02', () => {
  it('元数据声明 8 根引脚与 bytes 类型的 dump 端口', () => {
    const metadata = readMetadata('at24c02') as {
      readonly pins: Readonly<Record<string, unknown>>;
      readonly ports: Readonly<
        Record<string, { readonly type: string; readonly direction: string }>
      >;
    };

    expect(Object.keys(metadata.pins)).toHaveLength(8);
    expect(metadata.ports.dump?.type).toBe('bytes');
    expect(metadata.ports.dump?.direction).toBe('output');
  });

  it('位级写入两个字节后可随机读回，且应答脚为低', async () => {
    const { board, bus } = await fixture();

    try {
      bus.start();
      expect(bus.writeByte(0xa0)).toBe(0);
      expect(bus.writeByte(0x10)).toBe(0);
      expect(bus.writeByte(0x5a)).toBe(0);
      expect(bus.writeByte(0xc3)).toBe(0);
      bus.stop();

      // 随机读：dummy write 设地址，重复 START，再以读地址回读。
      bus.start();
      expect(bus.writeByte(0xa0)).toBe(0);
      expect(bus.writeByte(0x10)).toBe(0);
      bus.start();
      expect(bus.writeByte(0xa1)).toBe(0);
      expect(bus.readByte(true)).toBe(0x5a);
      expect(bus.readByte(false)).toBe(0xc3);
      bus.stop();

      const image = dump(board);

      expect(image).toHaveLength(256);
      expect(image[0x10]).toBe(0x5a);
      expect(image[0x11]).toBe(0xc3);
      expect(image[0x12]).toBe(0);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('当前地址连续读跨过 0xFF 回绕到 0x00', async () => {
    const { board, bus } = await fixture();

    try {
      bus.start();
      bus.writeByte(0xa0);
      bus.writeByte(0xfe);
      bus.writeByte(0x11);
      bus.writeByte(0x22);
      bus.stop();

      bus.start();
      bus.writeByte(0xa0);
      bus.writeByte(0xff);
      bus.start();
      bus.writeByte(0xa1);
      expect(bus.readByte(true)).toBe(0x22);
      expect(bus.readByte(true)).toBe(0x00);
      expect(bus.readByte(false)).toBe(0x00);
      bus.stop();

      const image = dump(board);

      expect(image[0xfe]).toBe(0x11);
      expect(image[0xff]).toBe(0x22);
      expect(image[0x00]).toBe(0x00);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('页写在第 8 字节边界回绕到页首', async () => {
    const { board, bus } = await fixture();

    try {
      bus.start();
      bus.writeByte(0xa0);
      bus.writeByte(0x06);
      for (let value = 0x11; value <= 0x18; value += 1) expect(bus.writeByte(value)).toBe(0);
      bus.stop();

      const image = dump(board);

      // 0x06 所在页是 0x00..0x07：写完 0x07 后第 3 个字节回绕到页首 0x00。
      expect(image[0x06]).toBe(0x11);
      expect(image[0x07]).toBe(0x12);
      expect(image[0x00]).toBe(0x13);
      expect(image[0x01]).toBe(0x14);
      expect(image[0x02]).toBe(0x15);
      expect(image[0x03]).toBe(0x16);
      expect(image[0x04]).toBe(0x17);
      expect(image[0x05]).toBe(0x18);
      expect(image[0x08]).toBe(0x00);

      // 再从 0x0F 连写两字节：第二个字节回到该页页首 0x08。
      bus.start();
      bus.writeByte(0xa0);
      bus.writeByte(0x0f);
      bus.writeByte(0xaa);
      bus.writeByte(0xbb);
      bus.stop();

      const after = dump(board);

      expect(after[0x0f]).toBe(0xaa);
      expect(after[0x08]).toBe(0xbb);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('WP 为高时数据被丢弃但仍应答，解除保护后可正常写入', async () => {
    const { board, bus } = await fixture();

    try {
      board.send('wpSrc', 'level', 1);
      board.run(STEP);

      bus.start();
      expect(bus.writeByte(0xa0)).toBe(0);
      expect(bus.writeByte(0x20)).toBe(0);
      expect(bus.writeByte(0xaa)).toBe(0);
      bus.stop();

      const protectedImage = dump(board);

      expect(protectedImage[0x20]).toBe(0x00);
      expect(protectedImage.every((value) => value === 0)).toBe(true);

      board.send('wpSrc', 'level', 0);
      board.run(STEP);

      bus.start();
      bus.writeByte(0xa0);
      bus.writeByte(0x20);
      bus.writeByte(0xaa);
      bus.writeByte(0xbb);
      bus.stop();

      const written = dump(board);

      expect(written[0x20]).toBe(0xaa);
      expect(written[0x21]).toBe(0xbb);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('未命中地址时不应答，事务被忽略且下一个 START 可恢复', async () => {
    const { board, bus } = await fixture();

    try {
      bus.start();
      expect(bus.writeByte(0xa2)).toBe(1);
      // 忽略阶段的数据字节也不应答。
      expect(bus.writeByte(0x5a)).toBe(1);
      bus.stop();

      bus.start();
      expect(bus.writeByte(0xa0)).toBe(0);
      expect(bus.writeByte(0x40)).toBe(0);
      expect(bus.writeByte(0x5a)).toBe(0);
      bus.stop();

      expect(dump(board)[0x40]).toBe(0x5a);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('dump 上电发布全零快照，内容变化后更新且重复写入不重复发布', async () => {
    const { board, bus } = await fixture();

    try {
      const initial = dump(board);

      expect(initial).toHaveLength(256);
      expect(initial.every((value) => value === 0)).toBe(true);
      expect([...(board.outputs.dump as unknown as Iterable<number>)]).toEqual(initial);
      const initialPublishes = board.history.dump?.length ?? 0;

      bus.start();
      bus.writeByte(0xa0);
      bus.writeByte(0x30);
      bus.writeByte(0x42);
      bus.stop();

      expect(dump(board)[0x30]).toBe(0x42);
      const changedPublishes = board.history.dump?.length ?? 0;

      expect(changedPublishes).toBeGreaterThan(initialPublishes);

      // 相同内容重写不应产生新的 dump 消息。
      bus.start();
      bus.writeByte(0xa0);
      bus.writeByte(0x30);
      bus.writeByte(0x42);
      bus.stop();

      expect(board.history.dump?.length ?? 0).toBe(changedPublishes);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('dump 端口发布真实 Uint8Array，运行时不再产生 device/output-failed', async () => {
    const { board } = await fixture();

    try {
      expect(board.topics.dump).toBeInstanceOf(Uint8Array);
      expect(dump(board)).toHaveLength(256);

      // 走真实 simulation-runtime：只读代理会被 payloadMatches 拒绝并记入诊断。
      const runtime = await runRuntimeOnce('at24c02');

      expect(runtime.publishes.dump).toBeInstanceOf(Uint8Array);
      expect((runtime.publishes.dump as Uint8Array).length).toBe(256);
      expect(runtime.diagnostics.filter((entry) => entry.code === 'device/output-failed')).toEqual(
        [],
      );
    } finally {
      board.dispose();
    }
  });
});
