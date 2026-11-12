import { describe, expect, it } from 'vitest';
import { createTestBoard, MS, readMetadata, US } from './harness.ts';
import type { NetDescription, TestBoard } from './harness.ts';

/**
 * DS18B20 位级行为基线：存在脉冲时序、Skip ROM + Convert + Read Scratchpad 事务、
 * 温度编码与 CRC、Match ROM 失配静默、Write Scratchpad，以及复位中止转换。
 *
 * 主机用数字源 `dqSrc` 逐位驱动 DQ（拉低或释放），10 kΩ 外部上拉到 5 V；从机驱动
 * 的低电平由 `dqProbe` 探针确认。所有时间按整微秒推进。
 */

const SERIAL = 47049;

/** Dallas CRC8（多项式 0x31 的反向形式 0x8C）。 */
function crc8(bytes: readonly number[]): number {
  let crc = 0;

  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) === 1 ? (crc >> 1) ^ 0x8c : crc >> 1;
  }

  return crc & 0xff;
}

const ROM_BODY = [0x28, SERIAL & 0xff, (SERIAL >>> 8) & 0xff, 0x00, 0x00, 0x00, 0x00];
const ROM = [...ROM_BODY, crc8(ROM_BODY)];

interface OneWire {
  /** 复位脉冲（500 us 低）+ 等待存在脉冲结束。 */
  reset(): void;
  writeByte(value: number): void;
  readByte(): number;
}

interface Fixture {
  readonly board: TestBoard;
  readonly wire: OneWire;
}

async function fixture(): Promise<Fixture> {
  const nets: NetDescription[] = [
    {
      id: 'vcc',
      pins: [
        { instance: 'dut', pin: 'vcc' },
        { instance: 'dqPull', pin: 'a' },
        { instance: 'dqSrc', pin: 'vcc' },
      ],
      voltage: 5,
    },
    {
      id: 'gnd',
      pins: [
        { instance: 'dut', pin: 'gnd' },
        { instance: 'dqSrc', pin: 'gnd' },
      ],
      voltage: 0,
    },
    {
      id: 'dq',
      pins: [
        { instance: 'dut', pin: 'dq' },
        { instance: 'dqSrc', pin: 'y' },
        { instance: 'dqPull', pin: 'b' },
        { instance: 'dqProbe', pin: 'y' },
      ],
    },
  ];

  const board = await createTestBoard('ds18b20', {
    resistors: [{ id: 'dqPull', resistance: 10_000 }],
    sources: ['dqSrc'],
    probes: ['dqProbe'],
    nets,
  });

  const low = (ps: number): void => {
    board.send('dqSrc', 'level', 0);
    board.run(ps);
  };
  const release = (ps: number): void => {
    board.send('dqSrc', 'level', 2);
    board.run(ps);
  };

  return {
    board,
    wire: {
      reset() {
        low(500 * US);
        // 存在脉冲位于释放后 +30..+120 us。
        release(140 * US);
      },
      writeByte(value) {
        for (let bit = 0; bit < 8; bit += 1) {
          low(2 * US);
          if (((value >> bit) & 1) === 0) {
            // 写 0：整个时隙保持低，从机在 +15 us 采样到低。
            board.run(60 * US);
          } else {
            // 写 1：释放后由上拉拉高，从机在 +15 us 采样到高。
            release(13 * US);
          }
          release(10 * US);
        }
      },
      readByte() {
        let value = 0;

        for (let bit = 0; bit < 8; bit += 1) {
          low(1 * US);
          // 从机在下降沿 +15 us 决定输出，0 位保持低到 +60 us。
          release(30 * US);
          const level = board.probe('dqProbe');

          expect([0, 1]).toContain(level);
          if (level === 1) value |= 1 << bit;
          board.run(40 * US);
        }

        return value;
      },
    },
  };
}

describe('DS18B20', () => {
  it('元数据声明 3 根引脚与温度端口', () => {
    const metadata = readMetadata('ds18b20') as {
      readonly pins: Readonly<Record<string, unknown>>;
      readonly properties: Readonly<Record<string, { readonly default?: number }>>;
      readonly ports: Readonly<
        Record<string, { readonly type: string; readonly direction: string }>
      >;
    };

    expect(Object.keys(metadata.pins).sort()).toEqual(['dq', 'gnd', 'vcc']);
    expect(metadata.properties.serial?.default).toBe(47049);
    expect(metadata.ports.temperature?.type).toBe('number');
    expect(metadata.ports.temperature?.direction).toBe('input');
    expect(metadata.ports.temperatureOut?.type).toBe('number');
    expect(metadata.ports.temperatureOut?.direction).toBe('output');
  });

  it('复位存在脉冲落在 +30..+120 us，短脉冲不判复位', async () => {
    const { board } = await fixture();

    try {
      board.send('dqSrc', 'level', 0);
      board.run(500 * US);
      board.send('dqSrc', 'level', 2);
      board.run(20 * US);
      // 释放后 +20 us：存在脉冲还没开始。
      expect(board.probe('dqProbe')).toBe(1);

      board.run(15 * US);
      // +35 us：从机正在拉低。
      expect(board.probe('dqProbe')).toBe(0);

      board.run(95 * US);
      // +130 us：存在脉冲结束，总线回到上拉高。
      expect(board.probe('dqProbe')).toBe(1);

      // 只有 100 us 的低脉冲不开复位，也没有存在脉冲。
      board.send('dqSrc', 'level', 0);
      board.run(100 * US);
      board.send('dqSrc', 'level', 2);
      board.run(40 * US);
      expect(board.probe('dqProbe')).toBe(1);

      board.run(120 * US);
      expect(board.probe('dqProbe')).toBe(1);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('Skip ROM -> Convert T -> Read Scratchpad 返回 25 °C 与匹配 CRC', async () => {
    const { board, wire } = await fixture();

    try {
      wire.reset();
      wire.writeByte(0xcc);
      wire.writeByte(0x44);

      board.run(750 * MS);

      expect(board.topics.temperatureOut).toBe(25);

      wire.reset();
      wire.writeByte(0xcc);
      wire.writeByte(0xbe);

      const scratch: number[] = [];

      for (let index = 0; index < 9; index += 1) scratch.push(wire.readByte());

      expect(scratch.slice(0, 2)).toEqual([0x90, 0x01]);
      expect(scratch.slice(2, 5)).toEqual([75, 70, 0x5f]);
      expect(scratch.slice(5, 8)).toEqual([0xff, 0x0c, 0x00]);
      expect(scratch[8]).toBe(crc8(scratch.slice(0, 8)));
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('转换完成前 Read Scratchpad 仍返回上电值，750 ms 后才更新', async () => {
    const { board, wire } = await fixture();

    try {
      board.send('dut', 'temperature', -10.5);
      board.run(10 * US);

      wire.reset();
      wire.writeByte(0xcc);
      wire.writeByte(0x44);
      board.run(700 * MS);

      wire.reset();
      wire.writeByte(0xcc);
      wire.writeByte(0xbe);

      const before: number[] = [];

      for (let index = 0; index < 9; index += 1) before.push(wire.readByte());
      expect(before.slice(0, 2)).toEqual([0x90, 0x01]);
      expect(board.topics.temperatureOut).toBeUndefined();

      // 复位会中止进行中的转换：等待期过后仍是上电值。
      board.run(100 * MS);

      wire.reset();
      wire.writeByte(0xcc);
      wire.writeByte(0xbe);

      const after: number[] = [];

      for (let index = 0; index < 9; index += 1) after.push(wire.readByte());
      expect(after.slice(0, 2)).toEqual([0x90, 0x01]);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('-10.5 °C 编码为 0xFF58 且 CRC 随暂存器更新', async () => {
    const { board, wire } = await fixture();

    try {
      board.send('dut', 'temperature', -10.5);
      board.run(10 * US);

      wire.reset();
      wire.writeByte(0xcc);
      wire.writeByte(0x44);
      board.run(750 * MS);

      expect(board.topics.temperatureOut).toBe(-10.5);

      wire.reset();
      wire.writeByte(0xcc);
      wire.writeByte(0xbe);

      const scratch: number[] = [];

      for (let index = 0; index < 9; index += 1) scratch.push(wire.readByte());

      expect(scratch[0]).toBe(0x58);
      expect(scratch[1]).toBe(0xff);
      expect(scratch[8]).toBe(crc8(scratch.slice(0, 8)));
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('Read ROM 返回工厂 ROM，Match ROM 命中可继续、失配后静默', async () => {
    const { board, wire } = await fixture();

    try {
      wire.reset();
      wire.writeByte(0x33);

      const rom: number[] = [];

      for (let index = 0; index < 8; index += 1) rom.push(wire.readByte());
      expect(rom).toEqual(ROM);

      // 命中：8 字节逐一匹配后进入功能命令阶段。
      wire.reset();
      wire.writeByte(0x55);
      for (const byte of ROM) wire.writeByte(byte);
      wire.writeByte(0xbe);

      const matched: number[] = [];

      for (let index = 0; index < 9; index += 1) matched.push(wire.readByte());
      expect(matched.slice(0, 2)).toEqual([0x90, 0x01]);
      expect(matched[8]).toBe(crc8(matched.slice(0, 8)));

      // 失配：从机静默，后续命令不再响应，读到的全是上拉高。
      wire.reset();
      wire.writeByte(0x55);
      wire.writeByte(0x28);
      for (let index = 1; index < 8; index += 1) wire.writeByte(0x00);
      wire.writeByte(0xbe);

      const silent: number[] = [];

      for (let index = 0; index < 9; index += 1) silent.push(wire.readByte());
      expect(silent).toEqual(Array.from({ length: 9 }, () => 0xff));
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('Write Scratchpad 写入 TH/TL/Cfg 并可回读', async () => {
    const { board, wire } = await fixture();

    try {
      wire.reset();
      wire.writeByte(0xcc);
      wire.writeByte(0x4e);
      wire.writeByte(0x40);
      wire.writeByte(0x10);
      wire.writeByte(0x1f);

      wire.reset();
      wire.writeByte(0xcc);
      wire.writeByte(0xbe);

      const scratch: number[] = [];

      for (let index = 0; index < 9; index += 1) scratch.push(wire.readByte());

      expect(scratch.slice(2, 5)).toEqual([0x40, 0x10, 0x1f]);
      // 保留字节固定，CRC 按新内容重算。
      expect(scratch.slice(5, 8)).toEqual([0xff, 0x0c, 0x00]);
      expect(scratch[8]).toBe(crc8(scratch.slice(0, 8)));
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });
});
