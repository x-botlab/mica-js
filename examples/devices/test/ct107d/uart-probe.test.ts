import { describe, expect, it } from 'vitest';
import { createTestBoard, readMetadata } from './harness.ts';
import type { NetDescription, TestBoard } from './harness.ts';

/**
 * UART 探针行为基线：8N1 中点采样、LSB first、停止位校验、未知按低，以及注入时序与取消。
 *
 * RXD 由数字源逐位驱动，TXD 用电平探针读取；整个用例不依赖 MCU 或固件。
 */

const BAUD = 9600;
const BIT_TIME = Math.round(1e12 / BAUD);
const HALF_BIT_TIME = Math.floor(BIT_TIME / 2);

async function fixture(props: Readonly<Record<string, number>> = {}): Promise<TestBoard> {
  const nets: NetDescription[] = [
    {
      id: 'vcc',
      pins: [
        { instance: 'dut', pin: 'vcc' },
        { instance: 'rxdSrc', pin: 'vcc' },
      ],
      voltage: 5,
    },
    {
      id: 'gnd',
      pins: [
        { instance: 'dut', pin: 'gnd' },
        { instance: 'rxdSrc', pin: 'gnd' },
      ],
      voltage: 0,
    },
    {
      id: 'rxd',
      pins: [
        { instance: 'dut', pin: 'rxd' },
        { instance: 'rxdSrc', pin: 'y' },
      ],
    },
    {
      id: 'txd',
      pins: [
        { instance: 'dut', pin: 'txd' },
        { instance: 'txdProbe', pin: 'y' },
      ],
    },
  ];

  const board = await createTestBoard('uart-probe', {
    props,
    nets,
    sources: ['rxdSrc'],
    probes: ['txdProbe'],
  });

  // 空闲高，同时交付启动批次。
  board.send('rxdSrc', 'level', 1);
  board.run(0);

  return board;
}

function setRxd(board: TestBoard, level: number): void {
  board.send('rxdSrc', 'level', level);
  board.run(0);
}

/** 从下降沿起逐位发送一个 8N1 帧；数据位按 LSB first。 */
function receiveByte(board: TestBoard, value: number, stopLevel = 1): void {
  setRxd(board, 0);
  board.run(BIT_TIME);

  for (let bit = 0; bit < 8; bit += 1) {
    setRxd(board, (value >> bit) & 1);
    board.run(BIT_TIME);
  }

  setRxd(board, stopLevel);
  board.run(BIT_TIME);
}

function bytesOn(board: TestBoard, topic: 'tx' | 'rx'): number[][] {
  return (board.history[topic] ?? []).map((value) => [...(value as Iterable<number>)]);
}

describe('UART 探针', () => {
  it('清单声明 4 根引脚、波特率/驱动电阻属性与 binary 方法/事件', () => {
    const metadata = readMetadata('uart-probe');

    expect(Object.keys(metadata.pins ?? {}).sort()).toEqual(['gnd', 'rxd', 'txd', 'vcc']);
    expect(metadata.properties?.baud).toMatchObject({ type: 'number', default: 9600 });
    expect(metadata.properties?.driveResistance).toMatchObject({ type: 'number', default: 25 });
    expect(metadata.model.methods.send).toBeDefined();
    expect(metadata.model.events.onDidTx).toMatchObject({ type: 'binary' });
    expect(metadata.model.events.onDidRx).toMatchObject({ type: 'binary' });
  });

  it('空闲时 TXD 为高，RXD 上逐位发送的字节按 LSB first 从 tx 复原', async () => {
    const board = await fixture();

    try {
      expect(board.probe('txdProbe')).toBe(1);
      expect(bytesOn(board, 'tx')).toEqual([]);

      // 0xA5 = 1010_0101，LSB first 的位序能区分位序错误。
      receiveByte(board, 0xa5);

      expect(bytesOn(board, 'tx')).toEqual([[0xa5]]);
      expect(board.topics.tx).toBeInstanceOf(Uint8Array);
      expect([...(board.topics.tx as Uint8Array)]).toEqual([0xa5]);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('每一位都在位中点采样：中点之后才拉高的数据位不会被读到', async () => {
    const board = await fixture();

    try {
      // 起始位完整一个位时间。
      setRxd(board, 0);
      board.run(BIT_TIME);

      // bit0 前半个位时间为低，采样中点过后才拉高。
      setRxd(board, 0);
      board.run(HALF_BIT_TIME + 1);
      setRxd(board, 1);
      board.run(BIT_TIME - HALF_BIT_TIME - 1);

      // 其余数据位保持低，停止位拉高。
      for (let bit = 1; bit < 8; bit += 1) {
        setRxd(board, 0);
        board.run(BIT_TIME);
      }
      setRxd(board, 1);
      board.run(BIT_TIME);

      // 中点之后才拉高不应计入 bit0；该帧应被复原为 0x00，而不是 0x01。
      expect(bytesOn(board, 'tx')).toEqual([[0x00]]);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('未知数据电平按低处理，未知/低停止位按帧错误丢弃', async () => {
    const board = await fixture();

    try {
      // 0xFF 中把 bit3 释放为未知电平：该位按 0 采样，应得到 0xF7。
      setRxd(board, 0);
      board.run(BIT_TIME);
      for (let bit = 0; bit < 8; bit += 1) {
        setRxd(board, bit === 3 ? 2 : 1);
        board.run(BIT_TIME);
      }
      setRxd(board, 1);
      board.run(BIT_TIME);

      expect(bytesOn(board, 'tx')).toEqual([[0xf7]]);

      // 停止位为低：不发布；未知停止位同样不发布。
      receiveByte(board, 0x55, 0);
      setRxd(board, 1);
      board.run(BIT_TIME);
      receiveByte(board, 0xaa, 2);
      setRxd(board, 1);
      board.run(BIT_TIME);

      expect(bytesOn(board, 'tx')).toEqual([[0xf7]]);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('send 注入按 start/8 data/stop 的位边界驱动 TXD，并在停止位结束后发布 rx', async () => {
    const board = await fixture();
    const value = 0x35;

    try {
      const start = board.time;
      board.send('dut', 'send', new Uint8Array([value]));
      board.run(0);

      // 起始位立即拉低。
      expect(board.probe('txdProbe')).toBe(0);
      expect(bytesOn(board, 'rx')).toEqual([]);

      for (let bit = 0; bit < 8; bit += 1) {
        board.runUntil(start + (bit + 1) * BIT_TIME - 1);
        expect(board.probe('txdProbe')).toBe(bit === 0 ? 0 : (value >> (bit - 1)) & 1);
        board.runUntil(start + (bit + 1) * BIT_TIME);
        expect(board.probe('txdProbe')).toBe((value >> bit) & 1);
      }

      // 第 9 个位时间开始停止位；rx 在完整停止位结束后发布。
      board.runUntil(start + 9 * BIT_TIME);
      expect(board.probe('txdProbe')).toBe(1);
      board.runUntil(start + 10 * BIT_TIME - 1);
      expect(bytesOn(board, 'rx')).toEqual([]);
      board.runUntil(start + 10 * BIT_TIME);

      expect(bytesOn(board, 'rx')).toEqual([[value]]);
      expect(board.topics.rx).toBeInstanceOf(Uint8Array);
      expect([...(board.topics.rx as Uint8Array)]).toEqual([value]);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('新注入按序号取消旧注入；低电平中断时先补高电平再发新起始位', async () => {
    const board = await fixture();

    try {
      const start = board.time;
      board.send('dut', 'send', new Uint8Array([0x00]));
      board.run(0);
      expect(board.probe('txdProbe')).toBe(0);

      // 旧注入进入 bit0 低电平后改发 0x80。运行时会等到旧过程下一次定时醒来再重排；
      // 该时刻发现序号已过时，新注入随即开始。旧帧尚未完成，不应发布到 rx。
      board.runUntil(start + BIT_TIME);
      board.send('dut', 'send', new Uint8Array([0x80]));
      board.run(0);
      board.runUntil(start + 2 * BIT_TIME);
      expect(board.probe('txdProbe')).toBe(1);

      // 取消时原线为低，恢复一个位时间后新的起始位才下降。
      board.runUntil(start + 3 * BIT_TIME - 1);
      expect(board.probe('txdProbe')).toBe(1);
      board.runUntil(start + 3 * BIT_TIME);
      expect(board.probe('txdProbe')).toBe(0);

      // 新帧从恢复位结束处起算：8 个数据位之后是停止位。
      for (let bit = 0; bit < 8; bit += 1) {
        board.runUntil(start + (4 + bit) * BIT_TIME);
        expect(board.probe('txdProbe')).toBe((0x80 >> bit) & 1);
      }
      board.runUntil(start + 12 * BIT_TIME);
      expect(board.probe('txdProbe')).toBe(1);
      board.runUntil(start + 13 * BIT_TIME);

      // 旧 0x00 帧被取消，只有新 0x80 完成。
      expect(bytesOn(board, 'rx')).toEqual([[0x80]]);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('自定义波特率按 round(1e12 / baud) 换算注入位时间', async () => {
    const baud = 19_200;
    const bitTime = Math.round(1e12 / baud);
    const board = await fixture({ baud });

    try {
      const start = board.time;
      board.send('dut', 'send', new Uint8Array([0x01]));
      board.run(0);
      expect(board.probe('txdProbe')).toBe(0);

      board.runUntil(start + bitTime - 1);
      expect(board.probe('txdProbe')).toBe(0);
      board.runUntil(start + bitTime);
      expect(board.probe('txdProbe')).toBe(1);

      board.runUntil(start + 10 * bitTime);
      expect(bytesOn(board, 'rx')).toEqual([[0x01]]);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });
});
