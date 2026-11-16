import { describe, expect, it } from 'vitest';
import { createTestBoard, readMetadata, US } from './harness.ts';
import type { NetDescription, TestBoard } from './harness.ts';

/**
 * 超声波收发器件行为基线：8 个 TRIG 上升沿确认脉冲串，第 8 个下降沿触发 ECHO、
 * 高脉宽按距离折算、显式 echoUs 覆盖、1 ms 脉冲间隔重置不完整脉冲串，以及新请求
 * 取消旧回波截止时刻。
 *
 * TRIG 由数字源逐脉冲驱动；ECHO 是推挽输出，直接接探针采样。
 */

const PULSE_HIGH = 12 * US;
const PULSE_LOW = 12 * US;
const BURST_GAP = 1_000 * US;
const DISTANCE_CM = 100;
const ECHO_US = Math.round(((2 * (DISTANCE_CM / 100)) / 340) * 1_000_000);

async function fixture(props: Readonly<Record<string, number>> = {}): Promise<TestBoard> {
  const nets: NetDescription[] = [
    {
      id: 'vcc',
      pins: [
        { instance: 'dut', pin: 'vcc' },
        { instance: 'trigSrc', pin: 'vcc' },
      ],
      voltage: 5,
    },
    {
      id: 'gnd',
      pins: [
        { instance: 'dut', pin: 'gnd' },
        { instance: 'trigSrc', pin: 'gnd' },
      ],
      voltage: 0,
    },
    {
      id: 'trig',
      pins: [
        { instance: 'dut', pin: 'trig' },
        { instance: 'trigSrc', pin: 'y' },
      ],
    },
    {
      id: 'echo',
      pins: [
        { instance: 'dut', pin: 'echo' },
        { instance: 'echoProbe', pin: 'y' },
      ],
    },
  ];

  const board = await createTestBoard('ultrasonic', {
    props: { distanceCm: DISTANCE_CM, ...props },
    nets,
    probes: ['echoProbe'],
    sources: ['trigSrc'],
  });

  board.run(0);
  return board;
}

function trig(board: TestBoard, high: boolean): void {
  board.send('trigSrc', 'level', high ? 1 : 0);
}

/** 完整发送一个 12 µs 高、12 µs 低的 TRIG 脉冲。 */
function pulse(board: TestBoard): void {
  trig(board, true);
  board.run(PULSE_HIGH);
  trig(board, false);
  board.run(PULSE_LOW);
}

/** 发送完整 8 脉冲串，返回第 8 个下降沿（ECHO 高脉冲起点）的绝对时刻。 */
function finishBurst(board: TestBoard): number {
  for (let index = 0; index < 7; index += 1) pulse(board);

  trig(board, true);
  board.run(PULSE_HIGH);
  trig(board, false);
  board.run(0);
  return board.time;
}

describe('Ultrasonic', () => {
  it('元数据声明 TRIG/ECHO/电源引脚与距离属性', () => {
    const metadata = readMetadata('ultrasonic') as {
      readonly pins: Readonly<Record<string, unknown>>;
      readonly properties: Readonly<Record<string, { readonly default?: number }>>;
    };

    expect(Object.keys(metadata.pins).sort()).toEqual(['echo', 'gnd', 'trig', 'vcc']);
    expect(metadata.properties.distanceCm?.default).toBe(100);
    expect(metadata.properties.echoUs?.default).toBe(-1);
  });

  it('空闲为高，前 7 个脉冲不触发，第 8 个下降沿后按传播时间拉低', async () => {
    const board = await fixture();

    try {
      expect(board.probe('echoProbe')).toBe(1);

      for (let index = 0; index < 7; index += 1) {
        pulse(board);
        expect(board.probe('echoProbe')).toBe(1);
      }

      trig(board, true);
      board.run(PULSE_HIGH);
      expect(board.probe('echoProbe')).toBe(1);

      trig(board, false);
      board.run(0);
      expect(board.probe('echoProbe')).toBe(1);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('ECHO 在往返传播时间后拉低，低脉宽等于同一折算值', async () => {
    const board = await fixture();
    const width = ECHO_US * US;

    try {
      const startedAt = finishBurst(board);
      expect(board.probe('echoProbe')).toBe(1);

      board.runUntil(startedAt + width - 1);
      expect(board.probe('echoProbe')).toBe(1);

      board.runUntil(startedAt + width);
      expect(board.probe('echoProbe')).toBe(0);

      board.runUntil(startedAt + 2 * width - 1);
      expect(board.probe('echoProbe')).toBe(0);

      board.runUntil(startedAt + 2 * width);
      expect(board.probe('echoProbe')).toBe(1);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('echoUs 非负时直接覆盖距离折算值', async () => {
    const explicitUs = 1_234;
    const board = await fixture({ echoUs: explicitUs });

    try {
      const startedAt = finishBurst(board);
      expect(board.probe('echoProbe')).toBe(1);

      board.runUntil(startedAt + explicitUs * US - 1);
      expect(board.probe('echoProbe')).toBe(1);

      board.runUntil(startedAt + explicitUs * US);
      expect(board.probe('echoProbe')).toBe(0);

      board.runUntil(startedAt + 2 * explicitUs * US);
      expect(board.probe('echoProbe')).toBe(1);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('不足 8 个脉冲时，1 ms 无新边沿会丢弃已累计计数', async () => {
    const board = await fixture();

    try {
      for (let index = 0; index < 7; index += 1) pulse(board);
      expect(board.probe('echoProbe')).toBe(1);

      // 最后一个上升沿之后满 1 ms，累计计数被清零。
      board.run(BURST_GAP);
      pulse(board);
      expect(board.probe('echoProbe')).toBe(1);

      // 补齐新的 8 脉冲串仍可正常触发。
      for (let index = 0; index < 7; index += 1) pulse(board);
      expect(board.probe('echoProbe')).toBe(1);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('第二次完整触发会取消旧请求的 ECHO 截止时刻', async () => {
    const board = await fixture();
    const width = ECHO_US * US;

    try {
      const firstAt = finishBurst(board);
      expect(board.probe('echoProbe')).toBe(1);

      board.runUntil(firstAt + width / 2);
      const secondAt = finishBurst(board);
      expect(board.probe('echoProbe')).toBe(1);

      // 第一个请求的拉低时刻已过；若旧定时未失效，这里会误拉低。
      board.runUntil(firstAt + width + 1);
      expect(board.probe('echoProbe')).toBe(1);

      board.runUntil(secondAt + width - 1);
      expect(board.probe('echoProbe')).toBe(1);

      board.runUntil(secondAt + width);
      expect(board.probe('echoProbe')).toBe(0);

      board.runUntil(secondAt + 2 * width);
      expect(board.probe('echoProbe')).toBe(1);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });
});
