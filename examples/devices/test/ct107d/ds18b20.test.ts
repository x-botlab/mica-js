import { describe, expect, it } from 'vitest';
import { createTestBoard, MS, readMetadata, US } from './harness.ts';
import type { NetDescription, TestBoard } from './harness.ts';

/**
 * DS18B20 位级行为基线：存在脉冲时序、Skip ROM + Convert + Read Scratchpad 事务、
 * 温度编码与 CRC、Match ROM 失配静默、Write Scratchpad，以及「复位不中止转换」。
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

/** 温度按 T×16 四舍五入（中点远离零）后取 16 位二进制补码。 */
function encodeTemperature(celsius: number): number {
  const scaled = celsius * 16;
  const truncated = Math.trunc(scaled);
  const residual = scaled - truncated;
  const rounded = residual >= 0.5 ? truncated + 1 : residual <= -0.5 ? truncated - 1 : truncated;

  return rounded & 0xffff;
}

interface OneWire {
  /** 复位脉冲（500 us 低）+ 等待存在脉冲结束。 */
  reset(): void;
  writeByte(value: number): void;
  /** 读一个字节，每次都在下降沿 +`sampleAt` us 采样，并把时隙补齐到 61 us。 */
  readByteAt(sampleAt: number): number;
  /** 读一个字节，在 datasheet 允许窗口内的 +14 us 采样。 */
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
  const readByteAt = (sampleAt: number): number => {
    let value = 0;

    for (let bit = 0; bit < 8; bit += 1) {
      const fall = board.time;
      low(1 * US);
      // datasheet p16：下降沿后 15 us 内采样；sampleAt=14 是通用基线。
      release(Math.max(0, sampleAt - 1) * US);
      const level = board.probe('dqProbe');

      expect([0, 1]).toContain(level);
      if (level === 1) value |= 1 << bit;
      // 0 位由从机保持低到下降沿 +60 us；整个时隙补齐到 61 us。
      if (fall + 61 * US > board.time) board.run(fall + 61 * US - board.time);
    }

    return value;
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
            board.run(58 * US);
          } else {
            // 写 1：释放后由上拉拉高，从机在 +15 us 采样到高。
            release(58 * US);
          }
          // 时隙 >= 60 us，再加 1 us 恢复。
          release(1 * US);
        }
      },
      readByteAt,
      readByte() {
        return readByteAt(14);
      },
    },
  };
}

describe('DS18B20', () => {
  it('清单声明 3 根引脚与温度注入/查询/事件', () => {
    const metadata = readMetadata('ds18b20');

    expect(Object.keys(metadata.pins ?? {}).sort()).toEqual(['dq', 'gnd', 'vcc']);
    expect(metadata.properties?.serial?.default).toBe(47049);
    expect(metadata.model.methods.setTemperature).toBeDefined();
    expect(metadata.model.methods.hasTemperature).toBeDefined();
    expect(metadata.model.methods.getTemperature).toBeDefined();
    expect(metadata.model.events.onDidTemperatureOut).toMatchObject({ type: 'number' });
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

  it('转换未完成时读上电值；Convert 后的复位不中止转换', async () => {
    const { board, wire } = await fixture();

    try {
      board.send('dut', 'setTemperature', -10.5);
      board.run(10 * US);

      wire.reset();
      wire.writeByte(0xcc);
      wire.writeByte(0x44);
      board.run(700 * MS);

      // 官方模板在 Convert T 之后立刻复位再读暂存器：转换继续走完 750 ms，此刻仍是上电值。
      wire.reset();
      wire.writeByte(0xcc);
      wire.writeByte(0xbe);

      const before: number[] = [];

      for (let index = 0; index < 9; index += 1) before.push(wire.readByte());
      expect(before.slice(0, 2)).toEqual([0x90, 0x01]);
      expect(board.topics.temperatureOut).toBeUndefined();

      // 等待期满后转换完成：暂存器变为注入值，端口也发布一次。
      board.run(100 * MS);

      wire.reset();
      wire.writeByte(0xcc);
      wire.writeByte(0xbe);

      const after: number[] = [];

      for (let index = 0; index < 9; index += 1) after.push(wire.readByte());
      expect(after.slice(0, 2)).toEqual([0x58, 0xff]);
      expect(board.topics.temperatureOut).toBe(-10.5);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('-10.5 °C 编码为 0xFF58 且 CRC 随暂存器更新', async () => {
    const { board, wire } = await fixture();

    try {
      board.send('dut', 'setTemperature', -10.5);
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

  it('合法读窗口读取正/负/边界温度，编码与 CRC 一致', async () => {
    const { board, wire } = await fixture();

    try {
      for (const celsius of [125, 85, 25.0625, 0, -0.5, -10.5, -55]) {
        board.send('dut', 'setTemperature', celsius);
        board.run(10 * US);

        wire.reset();
        wire.writeByte(0xcc);
        wire.writeByte(0x44);
        board.run(750 * MS);

        wire.reset();
        wire.writeByte(0xcc);
        wire.writeByte(0xbe);

        const scratch: number[] = [];

        // readByte 在下降沿 +14 us 采样，位于 datasheet 允许的 15 us 窗口内。
        for (let index = 0; index < 9; index += 1) scratch.push(wire.readByte());

        const raw = encodeTemperature(celsius);

        expect(scratch.slice(0, 2), `${celsius} °C`).toEqual([raw & 0xff, raw >>> 8]);
        expect(scratch.slice(2, 5), `${celsius} °C 阈值/配置`).toEqual([75, 70, 0x5f]);
        expect(scratch[8], `${celsius} °C CRC`).toBe(crc8(scratch.slice(0, 8)));
      }
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

  it('合法读窗口在 +10/+14 us 与边界 +15 us 采样同一 0 位都得到低', async () => {
    const { board, wire } = await fixture();

    try {
      for (const sampleAt of [10, 14, 15]) {
        wire.reset();
        wire.writeByte(0xcc);
        wire.writeByte(0xbe);
        // 上电暂存器 LSB = 0x90：bit0..3 为 0，bit4 为 1，bit5..6 为 0，bit7 为 1。
        // +15 us 是 datasheet 允许窗口的边界，不是严格小于 15 us 的内部点；
        // 模型在下降沿已经驱动 0 位，边界也必须读到低。
        expect(wire.readByteAt(sampleAt), `LSB @ +${sampleAt} us`).toBe(0x90);
      }
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('连续 0/1、9 字节 CRC 与 Read ROM 不因从机自拉低边沿丢位', async () => {
    const { board, wire } = await fixture();

    try {
      wire.reset();
      wire.writeByte(0xcc);
      wire.writeByte(0xbe);

      const scratch: number[] = [];

      for (let index = 0; index < 9; index += 1) scratch.push(wire.readByte());
      expect(scratch).toHaveLength(9);
      expect(scratch.slice(0, 2)).toEqual([0x90, 0x01]);
      // byte5 是连续 8 个 1，byte7 是连续 8 个 0；按字节连续读完可暴露
      // “从机自拉低边沿被当成新时隙/复位”导致的位序错位。
      expect(scratch[5]).toBe(0xff);
      expect(scratch[7]).toBe(0x00);
      expect(scratch[8]).toBe(crc8(scratch.slice(0, 8)));

      // 换一个事务：从机在 72 个读时隙里多次自己拉低，若自拉低被当成新时隙，
      // 位序会错位；Read ROM 的混合位型与 CRC 会立即暴露。
      wire.reset();
      wire.writeByte(0x33);

      const rom: number[] = [];

      for (let index = 0; index < 8; index += 1) rom.push(wire.readByte());
      expect(rom).toEqual(ROM);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('读事务中途一次重叠复位会丢弃旧事务，随后 9 字节 CRC 读取完整', async () => {
    const { board, wire } = await fixture();

    try {
      wire.reset();
      wire.writeByte(0xcc);
      wire.writeByte(0xbe);
      expect(wire.readByte()).toBe(0x90);
      expect(wire.readByte()).toBe(0x01);
      expect(wire.readByte()).toBe(75);

      // 第四个字节 TL = 0x46，bit0 = 0；在它的读 0 位时隙中途复位。
      // 此时从机正在自己拉低，总线没有新的下降沿；复位必须靠上升沿和
      // 从该读时隙下降沿起算的 >=480 us 低电平识别。只做这一次复位。
      board.send('dqSrc', 'level', 0);
      board.run(1 * US);
      board.send('dqSrc', 'level', 2);
      board.run(13 * US);
      expect(board.probe('dqProbe')).toBe(0);
      wire.reset();

      wire.writeByte(0xcc);
      wire.writeByte(0xbe);

      const scratch: number[] = [];

      for (let index = 0; index < 9; index += 1) scratch.push(wire.readByte());
      expect(scratch.slice(0, 2)).toEqual([0x90, 0x01]);
      expect(scratch[8]).toBe(crc8(scratch.slice(0, 8)));
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('读 0 位保持到 +60 us，+61 us 已释放并可供下一时隙使用', async () => {
    const { board, wire } = await fixture();

    try {
      // 0.125 °C × 16 = 0x0002，LSB 的 bit0 = 0、bit1 = 1、其余为 0。
      board.send('dut', 'setTemperature', 0.125);
      board.run(10 * US);
      wire.reset();
      wire.writeByte(0xcc);
      wire.writeByte(0x44);
      board.run(750 * MS);
      wire.reset();
      wire.writeByte(0xcc);
      wire.writeByte(0xbe);

      const fall = board.time;
      board.send('dqSrc', 'level', 0);
      board.run(1 * US);
      board.send('dqSrc', 'level', 2);
      board.run(58 * US);
      // 下降沿 +59 us：从机仍在驱动 bit0 的 0。
      expect(board.probe('dqProbe')).toBe(0);
      board.run(2 * US);
      // +61 us：从机已在 +60 us 释放，总线回到上拉高。
      expect(board.probe('dqProbe')).toBe(1);
      expect(board.time).toBe(fall + 61 * US);

      const readSlotAt14 = (): number => {
        const slotFall = board.time;
        board.send('dqSrc', 'level', 0);
        board.run(1 * US);
        board.send('dqSrc', 'level', 2);
        board.run(13 * US);
        const level = board.probe('dqProbe');
        if (slotFall + 61 * US > board.time) board.run(slotFall + 61 * US - board.time);
        return level;
      };

      // 下一时隙从 +61 us 开始：bit1 = 1，随后 bit2..7 = 0。
      expect(readSlotAt14(), 'LSB bit1').toBe(1);
      for (let bit = 2; bit < 8; bit += 1) expect(readSlotAt14(), `LSB bit${bit}`).toBe(0);

      // LSB 0x02，下一字节 MSB 为 0x00。
      expect(wire.readByte()).toBe(0x00);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });
});
