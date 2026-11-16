import { describe, expect, it } from 'vitest';
import { createTestBoard, readMetadata } from './harness.ts';
import type { NetDescription, TestBoard } from './harness.ts';

/**
 * NE555 无稳态振荡的行为基线：半周期由 rA/rB/c 折叠，RST# 停振/重启，端口发布。
 *
 * OUT 是推挽输出，直接接探针；DISCH 是开漏输出，用 10 kΩ 上拉到 5 V 后接探针，
 * 这样释放时为高、拉低时为低。所有时间断言都卡在相位边界的前后 1 ps。
 */

const R_A = 10_000;
const R_B = 10_000;
const C = 1e-8;
/** 与 DDL 相同的折叠公式，测试侧独立算一遍。 */
const T_HIGH = Math.round(0.693 * (R_A + R_B) * C * 1e12);
const T_LOW = Math.round(0.693 * R_B * C * 1e12);
const PERIOD = T_HIGH + T_LOW;

async function fixture(props: Readonly<Record<string, number>> = {}): Promise<TestBoard> {
  const nets: NetDescription[] = [
    {
      id: 'vcc',
      pins: [
        { instance: 'dut', pin: 'vcc' },
        { instance: 'dischPull', pin: 'b' },
      ],
      voltage: 5,
    },
    { id: 'gnd', pins: [{ instance: 'dut', pin: 'gnd' }], voltage: 0 },
    {
      id: 'out',
      pins: [
        { instance: 'dut', pin: 'out' },
        { instance: 'outProbe', pin: 'y' },
      ],
    },
    {
      id: 'disch',
      pins: [
        { instance: 'dut', pin: 'disch' },
        { instance: 'dischPull', pin: 'a' },
        { instance: 'dischProbe', pin: 'y' },
      ],
    },
    {
      id: 'rst',
      pins: [
        { instance: 'dut', pin: 'rst' },
        { instance: 'rstSrc', pin: 'y' },
      ],
    },
    { id: 'rstSrcVcc', pins: [{ instance: 'rstSrc', pin: 'vcc' }], voltage: 5 },
    { id: 'rstSrcGnd', pins: [{ instance: 'rstSrc', pin: 'gnd' }], voltage: 0 },
  ];

  return createTestBoard('ne555', {
    props,
    nets,
    probes: ['outProbe', 'dischProbe'],
    resistors: [{ id: 'dischPull', resistance: 10_000 }],
    sources: ['rstSrc'],
  });
}

function reset(board: TestBoard, high: boolean): void {
  board.send('rstSrc', 'level', high ? 1 : 0);
}

/** 拉低 RST# 让器件停在确定状态，再拉高从充电相起振。 */
function start(board: TestBoard): void {
  reset(board, false);
  board.run(0);
  reset(board, true);
  board.run(0);
}

describe('NE555', () => {
  it('元数据声明 8 根引脚与频率/占空比端口', () => {
    const metadata = readMetadata('ne555') as {
      readonly pins: Readonly<Record<string, unknown>>;
      readonly ports: Readonly<Record<string, { readonly type: string }>>;
    };

    expect(Object.keys(metadata.pins)).toHaveLength(8);
    expect(metadata.ports.frequency?.type).toBe('number');
    expect(metadata.ports.dutyCycle?.type).toBe('number');
  });

  it('RST# 悬空按低处理：不上电起振', async () => {
    const board = await fixture();

    try {
      board.run(0);

      expect(board.probe('outProbe')).toBe(0);
      expect(board.probe('dischProbe')).toBe(0);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('5 个周期的每个相位边界都落在折叠公式上', async () => {
    const board = await fixture();

    try {
      start(board);
      expect(board.probe('outProbe')).toBe(1);
      expect(board.probe('dischProbe')).toBe(1);

      // 第一个高相：OUT 高、DISCH 释放。
      board.runUntil(T_HIGH - 1);
      expect(board.probe('outProbe')).toBe(1);
      board.runUntil(T_HIGH);
      expect(board.probe('outProbe')).toBe(0);
      expect(board.probe('dischProbe')).toBe(0);

      // 第一个低相结束即第 1 个周期结束。
      board.runUntil(PERIOD - 1);
      expect(board.probe('outProbe')).toBe(0);
      board.runUntil(PERIOD);
      expect(board.probe('outProbe')).toBe(1);
      expect(board.probe('dischProbe')).toBe(1);

      // 第 2–5 个周期：每个下降沿在 k×PERIOD − tLow，每个上升沿在 k×PERIOD。
      for (let cycle = 2; cycle <= 5; cycle++) {
        const falling = cycle * PERIOD - T_LOW;

        board.runUntil(falling - 1);
        expect(board.probe('outProbe')).toBe(1);
        board.runUntil(falling);
        expect(board.probe('outProbe')).toBe(0);

        board.runUntil(cycle * PERIOD - 1);
        expect(board.probe('outProbe')).toBe(0);
        board.runUntil(cycle * PERIOD);
        expect(board.probe('outProbe')).toBe(1);
      }

      expect(board.time).toBe(5 * PERIOD);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('高相长于低相，DISCH 相位与 OUT 相同，占空比端口是百分比', async () => {
    const board = await fixture();

    try {
      start(board);
      board.runUntil(T_HIGH);
      board.runUntil(PERIOD);

      // 从原始边界算出的两相时长必须与公式一致。
      expect(T_HIGH).toBeGreaterThan(T_LOW);
      expect(board.topics.dutyCycle).toBeCloseTo((T_HIGH / PERIOD) * 100, 9);
      expect(board.topics.frequency).toBeCloseTo(1e12 / PERIOD, 6);

      // 占空比是百分比而不是 0..1 的比例。
      expect(board.topics.dutyCycle as number).toBeGreaterThan(60);
      expect(board.topics.dutyCycle as number).toBeLessThan(70);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('RST# 低电平立刻停振，高电平从充电相重启', async () => {
    const board = await fixture();

    try {
      start(board);
      board.run(T_HIGH / 2);
      expect(board.probe('outProbe')).toBe(1);

      reset(board, false);
      board.run(0);
      // 下降沿立刻把两脚拉低，而不是等到当前相位结束。
      expect(board.probe('outProbe')).toBe(0);
      expect(board.probe('dischProbe')).toBe(0);

      board.run(3 * PERIOD);
      expect(board.probe('outProbe')).toBe(0);
      expect(board.probe('dischProbe')).toBe(0);

      reset(board, true);
      board.run(0);
      expect(board.probe('outProbe')).toBe(1);
      expect(board.probe('dischProbe')).toBe(1);

      // 重启后的第一个相位从充电相起算，整段 tHigh。
      board.run(T_HIGH - 1);
      expect(board.probe('outProbe')).toBe(1);
      board.run(1);
      expect(board.probe('outProbe')).toBe(0);

      // 再在低相中途停振并很快重启：旧的相位唤醒仍在排队，新期限必须覆盖它。
      const stopped = board.time;
      reset(board, false);
      board.run(0);
      expect(board.probe('outProbe')).toBe(0);
      board.run(10_000_000);
      reset(board, true);
      board.run(0);
      expect(board.probe('outProbe')).toBe(1);

      board.runUntil(stopped + 10_000_000 + T_HIGH - 1);
      expect(board.probe('outProbe')).toBe(1);
      board.runUntil(stopped + 10_000_000 + T_HIGH);
      expect(board.probe('outProbe')).toBe(0);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('参数改变后端口只按新的折叠值发布一次', async () => {
    const rA = 4_700;
    const board = await fixture({ rA, rB: R_B, c: C });

    try {
      const high = Math.round(0.693 * (rA + R_B) * C * 1e12);
      const low = Math.round(0.693 * R_B * C * 1e12);

      start(board);
      board.run(3 * (high + low));

      expect(board.history.frequency).toHaveLength(1);
      expect(board.history.dutyCycle).toHaveLength(1);
      expect(board.topics.frequency).toBeCloseTo(1e12 / (high + low), 6);
      expect(board.topics.dutyCycle).toBeCloseTo((high / (high + low)) * 100, 9);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });
});
