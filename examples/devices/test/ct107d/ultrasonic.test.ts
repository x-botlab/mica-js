import { describe, expect, it } from 'vitest';
import { createTestBoard, readMetadata, US } from './harness.ts';
import type { NetDescription, TestBoard } from './harness.ts';

/**
 * 超声波收发器件行为基线：每个明确的高→低完整脉冲都是候选触发，最后一个完整脉冲
 * 撤销先前候选并以自己的下降沿建立回波；不设固定脉冲数量或 1 ms 拼串窗口。
 *
 * TRIG 由数字源驱动，未知/高阻用 source level 2 注入。ECHO 是推挽输出，直接接探针
 * 采样。所有期望时刻均由脉冲下降沿和 round(2 × (distanceCm / 100) / 340 × 1e6) 独立
 * 推导，不根据模型实测值回填。
 */

const PULSE_HIGH = 12 * US;
const PULSE_LOW = 12 * US;
const DISTANCE_CM = 100;
const ECHO_US = Math.round(((2 * (DISTANCE_CM / 100)) / 340) * 1_000_000);
const ECHO_WIDTH = ECHO_US * US;

const SHAPES = [
  { high: 6 * US, low: 18 * US },
  { high: 12 * US, low: 12 * US },
  { high: 20 * US, low: 8 * US },
] as const;

type TrigLevel = boolean | 'unknown';

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

function levelCode(level: TrigLevel): number {
  if (level === 'unknown') return 2;
  return level ? 1 : 0;
}

/** 推进到目标时刻；step 给定时用该步长细分，用于粗/细步长对照。 */
function advance(board: TestBoard, target: number, step?: number): void {
  if (step === undefined) {
    board.runUntil(target);
    return;
  }
  while (target - board.time > step) board.runUntil(board.time + step);
  board.runUntil(target);
}

/** 在绝对时刻 time 产生一次 TRIG 边沿。 */
function edgeAt(board: TestBoard, time: number, level: TrigLevel, step?: number): void {
  advance(board, time, step);
  board.send('trigSrc', 'level', levelCode(level));
  board.run(0);
}

/** 先给出明确低电平，使第一个高→低成为已配对脉冲。 */
function primeLow(board: TestBoard, time = 0): void {
  edgeAt(board, time, false);
}

/** 发送一个完整的 TRIG 脉冲，返回下降沿绝对时刻。 */
function sendPulse(board: TestBoard, start: number, high: number = PULSE_HIGH): number {
  edgeAt(board, start, true);
  const fallingAt = start + high;
  edgeAt(board, fallingAt, false);
  return fallingAt;
}

/** 独立核对 F 起始的高等待、低脉宽和恢复时刻。 */
function expectEcho(board: TestBoard, fallingAt: number, width: number): void {
  expect(width).toBeGreaterThan(0);

  board.runUntil(fallingAt + width - 1);
  expect(board.probe('echoProbe')).toBe(1);

  board.runUntil(fallingAt + width);
  expect(board.probe('echoProbe')).toBe(0);

  board.runUntil(fallingAt + 2 * width - 1);
  expect(board.probe('echoProbe')).toBe(0);

  board.runUntil(fallingAt + 2 * width);
  expect(board.probe('echoProbe')).toBe(1);
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

  it('1、5、8、10、20 个完整脉冲与非均匀高/低宽度都由最后一个下降沿触发', async () => {
    for (const count of [1, 5, 8, 10, 20]) {
      const board = await fixture();

      try {
        primeLow(board);

        let next = 1 * US;
        let fallingAt = 0;
        for (let index = 0; index < count; index += 1) {
          const shape = SHAPES[index % SHAPES.length]!;
          fallingAt = sendPulse(board, next, shape.high);
          next = fallingAt + shape.low;
        }

        expect(fallingAt).toBeGreaterThan(0);
        expect(board.probe('echoProbe')).toBe(1);
        expectEcho(board, fallingAt, ECHO_WIDTH);
        expect(board.faults).toEqual([]);
      } finally {
        board.dispose();
      }
    }
  });

  it('distanceCm = 20 时按往返路径折算 1176 µs 传播时间', async () => {
    const board = await fixture({ distanceCm: 20 });
    const width = Math.round(((2 * (20 / 100)) / 340) * 1_000_000) * US;

    try {
      expect(width).toBe(1176 * US);
      primeLow(board);
      const fallingAt = sendPulse(board, 10 * US);

      expectEcho(board, fallingAt, width);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('echoUs 非负时直接覆盖距离折算值', async () => {
    const explicitUs = 1_234;
    const board = await fixture({ echoUs: explicitUs });

    try {
      primeLow(board);
      const fallingAt = sendPulse(board, 10 * US);

      expectEcho(board, fallingAt, explicitUs * US);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('新请求在旧回波到达前撤销旧低电平，并从自己的下降沿重新计时', async () => {
    const board = await fixture();

    try {
      primeLow(board);
      const firstFall = sendPulse(board, 10 * US);
      const oldLowAt = firstFall + ECHO_WIDTH;

      const secondRise = oldLowAt - 2_000 * US;
      const secondFall = secondRise + 100 * US;
      expect(secondFall).toBeLessThan(oldLowAt);

      edgeAt(board, secondRise, true);
      expect(board.probe('echoProbe')).toBe(1);
      edgeAt(board, secondFall, false);

      // 旧请求的到达时刻已经过去；它的低电平定时必须已经失效。
      board.runUntil(oldLowAt);
      expect(board.probe('echoProbe')).toBe(1);

      expectEcho(board, secondFall, ECHO_WIDTH);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('新请求在旧回波低电平期间撤销旧高电平截止', async () => {
    const board = await fixture();

    try {
      primeLow(board);
      const firstFall = sendPulse(board, 10 * US);
      const oldLowAt = firstFall + ECHO_WIDTH;
      const oldHighAt = firstFall + 2 * ECHO_WIDTH;

      board.runUntil(oldLowAt);
      expect(board.probe('echoProbe')).toBe(0);

      const secondRise = oldLowAt + 500 * US;
      const secondFall = secondRise + 100 * US;

      edgeAt(board, secondRise, true);
      // 上升沿立即撤销仍处在低电平的旧回波。
      expect(board.probe('echoProbe')).toBe(1);
      edgeAt(board, secondFall, false);

      // 旧恢复截止已经过去；若旧高电平任务未失效，这里会留下伪边沿。
      board.runUntil(oldHighAt);
      expect(board.probe('echoProbe')).toBe(1);

      expectEcho(board, secondFall, ECHO_WIDTH);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('新脉冲下降沿恰在旧恢复截止同刻到达时，旧任务不污染新回波', async () => {
    const board = await fixture();

    try {
      primeLow(board);
      const firstFall = sendPulse(board, 10 * US);
      const oldHighAt = firstFall + 2 * ECHO_WIDTH;
      const secondRise = oldHighAt - 60 * US;

      edgeAt(board, secondRise, true);
      expect(board.probe('echoProbe')).toBe(1);

      // 旧恢复截止先到；请求已被上升沿撤销，不得再改动线路。
      board.runUntil(oldHighAt);
      expect(board.probe('echoProbe')).toBe(1);

      // 新完整脉冲的下降沿与旧恢复截止同刻，新请求接管绝对计时。
      edgeAt(board, oldHighAt, false);
      expect(board.probe('echoProbe')).toBe(1);

      expectEcho(board, oldHighAt, ECHO_WIDTH);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('脉冲间隔长于 D 但短于 1 ms 时按两个候选触发解释', async () => {
    const widthUs = 100;
    const width = widthUs * US;
    const board = await fixture({ echoUs: widthUs });

    try {
      primeLow(board);
      const firstFall = sendPulse(board, 10 * US);
      expectEcho(board, firstFall, width);

      const secondStart = firstFall + 300 * US;
      expect(secondStart - firstFall).toBeGreaterThan(width);
      expect(secondStart - firstFall).toBeLessThan(1_000 * US);

      edgeAt(board, secondStart, true);
      expect(board.probe('echoProbe')).toBe(1);
      const secondFall = secondStart + PULSE_HIGH;
      edgeAt(board, secondFall, false);
      expect(board.probe('echoProbe')).toBe(1);

      expectEcho(board, secondFall, width);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('初始高、未配对下降、未知电平与持续电平都不伪造完整触发', async () => {
    const board = await fixture();
    const wide = 2 * ECHO_WIDTH;

    try {
      // 初始观察为 unknown；unknown→高不是已知低→高，不武装候选。
      edgeAt(board, 0, true);
      board.runUntil(100 * US);
      expect(board.probe('echoProbe')).toBe(1);

      // 高→低但没有配对上升沿：不建立请求；在可能到达、结束的时刻都保持高。
      edgeAt(board, 200 * US, false);
      board.runUntil(200 * US + ECHO_WIDTH + 1);
      expect(board.probe('echoProbe')).toBe(1);
      board.runUntil(200 * US + wide);
      expect(board.probe('echoProbe')).toBe(1);

      // 低→高完成配对，但在下降沿之前进入未知态：清除配对并撤销请求。
      const armedAt = 200 * US + wide + 100 * US;
      edgeAt(board, armedAt, true);
      edgeAt(board, armedAt + 10 * US, 'unknown');
      const unpairedFallAt = armedAt + 20 * US;
      edgeAt(board, unpairedFallAt, false);
      board.runUntil(unpairedFallAt + ECHO_WIDTH);
      expect(board.probe('echoProbe')).toBe(1);
      board.runUntil(unpairedFallAt + wide);
      expect(board.probe('echoProbe')).toBe(1);

      // 持续高：撤销旧请求后不再产生下降沿，因此没有新回波。
      const sustainedAt = armedAt + 20 * US + wide + 100 * US;
      primeLow(board, sustainedAt);
      const fallingAt = sendPulse(board, sustainedAt + PULSE_LOW);
      const sustainedRise = fallingAt + 100 * US;
      edgeAt(board, sustainedRise, true);
      board.runUntil(sustainedRise + ECHO_WIDTH);
      expect(board.probe('echoProbe')).toBe(1);
      board.runUntil(sustainedRise + wide);
      expect(board.probe('echoProbe')).toBe(1);

      // 持续低：完整脉冲结束后保持低，不重复生成候选。
      const sustainedLowStart = fallingAt + 100 * US + wide + 100 * US;
      const lowFall = sendPulse(board, sustainedLowStart);
      expectEcho(board, lowFall, ECHO_WIDTH);
      board.runUntil(lowFall + 2 * ECHO_WIDTH + ECHO_WIDTH / 2);
      expect(board.probe('echoProbe')).toBe(1);
      board.runUntil(lowFall + 3 * ECHO_WIDTH);
      expect(board.probe('echoProbe')).toBe(1);

      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('已建立回波在等待高电平或低电平期间遇到未知态都立即撤销，旧截止不影响后续新回波', async () => {
    for (const phase of ['pending', 'low'] as const) {
      const board = await fixture();

      try {
        primeLow(board);
        const firstFall = sendPulse(board, 10 * US);
        const oldLowAt = firstFall + ECHO_WIDTH;
        const oldHighAt = firstFall + 2 * ECHO_WIDTH;
        const unknownAt = phase === 'pending' ? oldLowAt - 500 * US : oldLowAt + 500 * US;

        if (phase === 'low') {
          board.runUntil(oldLowAt);
          expect(board.probe('echoProbe')).toBe(0);
        }

        edgeAt(board, unknownAt, 'unknown');
        // 未知态立即回到空闲高。
        expect(board.probe('echoProbe')).toBe(1);

        const secondRise = unknownAt + 100 * US;
        // 未知态之后先给出明确低电平，再建立一条全新的有效完整脉冲。
        edgeAt(board, secondRise - PULSE_LOW, false);
        edgeAt(board, secondRise, true);
        expect(board.probe('echoProbe')).toBe(1);
        const secondFall = secondRise + PULSE_HIGH;
        edgeAt(board, secondFall, false);
        expect(board.probe('echoProbe')).toBe(1);

        const newLowAt = secondFall + ECHO_WIDTH;
        const newHighAt = secondFall + 2 * ECHO_WIDTH;
        const checkpoints =
          phase === 'pending'
            ? [
                // 旧到达截止落在新请求高电平期内，必须已被未知态撤销。
                { at: oldLowAt, level: 1 },
                { at: newLowAt - 1, level: 1 },
                { at: newLowAt, level: 0 },
                // 旧恢复截止落在新请求低电平期内，不得提前拉高。
                { at: oldHighAt, level: 0 },
                { at: newHighAt - 1, level: 0 },
                { at: newHighAt, level: 1 },
              ]
            : [
                // 旧恢复截止落在新请求高电平期内；低电平期间已被未知态立即撤销。
                { at: oldHighAt, level: 1 },
                { at: newLowAt - 1, level: 1 },
                { at: newLowAt, level: 0 },
                { at: newHighAt - 1, level: 0 },
                { at: newHighAt, level: 1 },
              ];

        for (const checkpoint of checkpoints) {
          board.runUntil(checkpoint.at);
          expect(board.probe('echoProbe'), `${phase} at ${checkpoint.at / US} µs`).toBe(
            checkpoint.level,
          );
        }

        expect(board.faults).toEqual([]);
      } finally {
        board.dispose();
      }
    }
  });

  it('D = 0 时稳定保持高，不制造正宽度伪脉冲', async () => {
    const board = await fixture({ echoUs: 0 });

    try {
      primeLow(board);
      const fallingAt = sendPulse(board, 10 * US);

      expect(board.probe('echoProbe')).toBe(1);
      for (let offset = 0; offset <= 100; offset += 1) {
        board.runUntil(fallingAt + offset * US);
        expect(board.probe('echoProbe')).toBe(1);
      }

      // 后续完整脉冲同样不产生低电平。
      const secondFall = sendPulse(board, fallingAt + 200 * US);
      board.runUntil(secondFall);
      expect(board.probe('echoProbe')).toBe(1);
      board.runUntil(secondFall + 100 * US);
      expect(board.probe('echoProbe')).toBe(1);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('回波恢复截止超出时间上限时拒绝请求并报告故障', async () => {
    const board = await fixture({ echoUs: 4_000_000_000 });

    try {
      primeLow(board);
      edgeAt(board, 10 * US, true);

      expect(() => edgeAt(board, 22 * US, false)).toThrow(/echo release deadline/);
      expect(board.faults.join('\n')).toContain('echo release deadline');
    } finally {
      board.dispose();
    }
  });

  it('同一输入时间线在粗、细 runUntil 下产生一致的引脚电平', async () => {
    const widthUs = 1_000;
    const script: readonly { readonly at: number; readonly edge?: TrigLevel }[] = [
      { at: 0, edge: false },
      { at: 10 * US, edge: true },
      { at: 30 * US, edge: false },
      { at: 600 * US, edge: true },
      { at: 700 * US, edge: false },
      { at: 1_029 * US },
      { at: 1_030 * US },
      { at: 1_500 * US, edge: true },
      { at: 1_600 * US, edge: false },
      { at: 1_699 * US },
      { at: 1_700 * US },
      { at: 2_599 * US },
      { at: 2_600 * US },
      { at: 2_700 * US },
      { at: 3_599 * US },
      { at: 3_600 * US },
    ];
    // 2_700 µs 时新的 F3 请求正处于低电平阶段，旧 F2 的恢复截止不得再改动线路。
    const expected = [1, 1, 1, 1, 1, 0, 0, 0, 1];

    async function sample(step?: number): Promise<number[]> {
      const board = await fixture({ echoUs: widthUs });
      const levels: number[] = [];
      try {
        for (const event of script) {
          if (event.edge !== undefined) {
            edgeAt(board, event.at, event.edge, step);
          } else {
            advance(board, event.at, step);
            levels.push(board.probe('echoProbe'));
          }
        }
        return levels;
      } finally {
        board.dispose();
      }
    }

    const coarse = await sample();
    const fine = await sample(17 * US);

    expect(coarse).toEqual(expected);
    expect(fine).toEqual(expected);
  });
});
