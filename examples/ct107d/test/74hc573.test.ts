import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compileDDL } from '@mica-js/sdk/ddl';
import { createBoardWith, createTestBoard, loadSourceDevice, readMetadata } from './harness.ts';
import type { DeviceModule, NetDescription, TestBoard } from './harness.ts';

/**
 * 74HC573 的行为基线：透明跟随、下降沿锁存、OE# 三态，以及 `latch` 端口。
 *
 * 输入由数字源 `d0`–`d7`、`le`、`oe` 驱动，输出电平由 `q0`–`q7` 上的探针在网络上采样，
 * 不读取器件自己发布的中间值。测试期复制模型并插入 `bit()` 断言与 follow 入口计数，
 * 证明非透明期间 D 变化既不执行 `dataByte` 也不唤醒 follow。
 */

const DATA = [0, 1, 2, 3, 4, 5, 6, 7] as const;
const PROBES = DATA.map((bit) => `q${bit}Probe`);
const SOURCES = ['leSrc', 'oeSrc', ...DATA.map((bit) => `d${bit}Src`)];
const STEP = 1_000_000;
const DEVICE_SOURCE = readFileSync(
  new URL('../src/devices/74hc573/model.ddl', import.meta.url),
  'utf8',
);

/** 由探针网络读取 Q0–Q7，不依赖器件内部 `stored`。 */
function readQ(board: TestBoard): number {
  let value = 0;

  for (const bit of DATA) {
    const level = board.probe(`q${bit}Probe`);

    expect([0, 1]).toContain(level);
    if (level === 1) value |= 1 << bit;
  }

  return value;
}

function driveData(board: TestBoard, byte: number): void {
  for (const bit of DATA) board.send(`d${bit}Src`, 'level', ((byte >> bit) & 1) === 1 ? 1 : 0);
}

function driveLevel(board: TestBoard, instance: string, high: boolean): void {
  board.send(instance, 'level', high ? 1 : 0);
}

/** 可切换输入源的网络布局；单器件夹具与计数夹具共用。 */
function latchOptions(): {
  readonly nets: NetDescription[];
  readonly sources: readonly string[];
  readonly probes: readonly string[];
} {
  const nets: NetDescription[] = [
    { id: 'vcc', pins: [{ instance: 'dut', pin: 'vcc' }], voltage: 5 },
    { id: 'gnd', pins: [{ instance: 'dut', pin: 'gnd' }], voltage: 0 },
    {
      id: 'le',
      pins: [
        { instance: 'dut', pin: 'le' },
        { instance: 'leSrc', pin: 'y' },
      ],
    },
    {
      id: 'oe',
      pins: [
        { instance: 'dut', pin: 'oe' },
        { instance: 'oeSrc', pin: 'y' },
      ],
    },
  ];

  for (const bit of DATA)
    nets.push({
      id: `d${bit}`,
      pins: [
        { instance: 'dut', pin: `d${bit}` },
        { instance: `d${bit}Src`, pin: 'y' },
      ],
    });

  for (const bit of DATA)
    nets.push({
      id: `q${bit}`,
      pins: [
        { instance: 'dut', pin: `q${bit}` },
        { instance: `q${bit}Probe`, pin: 'y' },
      ],
    });

  for (const id of SOURCES)
    nets.push(
      { id: `${id}-vcc`, pins: [{ instance: id, pin: 'vcc' }], voltage: 5 },
      { id: `${id}-gnd`, pins: [{ instance: id, pin: 'gnd' }], voltage: 0 },
    );

  return { nets, sources: SOURCES, probes: PROBES };
}

interface Fixture {
  readonly board: TestBoard;
  data(byte: number): void;
  le(high: boolean): void;
  oe(high: boolean): void;
  q(): number;
  release(): void;
}

async function fixture(): Promise<Fixture> {
  const { nets, sources, probes } = latchOptions();
  const board = await createTestBoard('74hc573', { nets, probes, sources });

  return {
    board,
    data(byte) {
      driveData(board, byte);
    },
    le(high) {
      driveLevel(board, 'leSrc', high);
    },
    oe(high) {
      driveLevel(board, 'oeSrc', high);
    },
    q() {
      return readQ(board);
    },
    release() {
      for (const bit of DATA) expect(board.probe(`q${bit}Probe`)).not.toBe(1);
    },
  };
}

/** 替换一次并确认目标唯一；用于从生产 `model.ddl` 生成测试期复制。 */
function replaceOnce(source: string, from: string, to: string): string {
  const at = source.indexOf(from);

  if (at < 0) throw new Error(`instrumentation target missing: ${from.slice(0, 48)}`);
  if (source.indexOf(from, at + from.length) >= 0)
    throw new Error(`instrumentation target is not unique: ${from.slice(0, 48)}`);

  return source.slice(0, at) + to + source.slice(at + from.length);
}

/**
 * 测试期复制生产模型，插入三处观测：
 *
 * - `bit()` 内的断言：`dataByte` 一旦在探测启用时执行就产生模型错误。
 * - `process follow` 入口计数：记录 follow 被真正唤醒的次数（不是静态订阅次数）。
 * - 启动过程末尾常驻的 `probeCommand` 接收循环：`process start` 是唯一启动入口，
 *   接收循环放在其正文之后，不依赖 `on derived` 过程在初始化时自动运行。
 *
 * `reportWake` 只在 `wakeCount` 变化后触发，初始化没有输出；启动过程显式发布计数
 * 基线，使测试能区分「没有唤醒」与「根本没有输出」。
 */
function instrumentedSource(source: string): string {
  let text = replaceOnce(
    source,
    '  output channel latch: number(capacity: 8, overflow: Overflow.drop_oldest);',
    `  output channel latch: number(capacity: 8, overflow: Overflow.drop_oldest);
  output channel wakeLog: number(capacity: 8, overflow: Overflow.drop_oldest);
  input channel probeCommand: number(capacity: 8, overflow: Overflow.drop_oldest);
  state probeArmed: bool = false;
  state wakeCount: number = 0;
  derived wakeView: number = wakeCount;`,
  );

  text = replaceOnce(
    text,
    '  process start {',
    `  process reportWake on wakeView {
    wakeLog.send(wakeView);
  }

  process start {`,
  );

  text = replaceOnce(
    text,
    `  process start {
    const current = inputs;
    stored = current;
    latch.send(current);
    publishAll();
  }`,
    `  process start {
    const current = inputs;
    stored = current;
    latch.send(current);
    publishAll();
    wakeLog.send(wakeCount);
    loop {
      const command = await probeCommand.receive();
      probeArmed = command == 1;
    }
  }`,
  );

  text = replaceOnce(
    text,
    `  pure fn bit(level: Logic) -> number {
    if level == Logic.high {`,
    `  pure fn bit(level: Logic) -> number {
    assert !probeArmed, "dataByte evaluated";
    if level == Logic.high {`,
  );

  return replaceOnce(
    text,
    `  process follow on followState {
    if !followState.transparent {`,
    `  process follow on followState {
    wakeCount = wakeCount + 1;
    if !followState.transparent {`,
  );
}

/** 计数输出缺失时直接失败，不再用 0 兜底掩盖未发布的观测。 */
function wakes(board: TestBoard): number {
  const value = board.outputs.wakeLog;

  if (typeof value !== 'number') throw new Error('wakeLog 未发布');

  return value;
}

let instrumented: Promise<DeviceModule> | undefined;

/** 编译一次测试期模型；夹具只替换模型，适配器仍用生产实现。 */
function instrumentedDevice(): Promise<DeviceModule> {
  instrumented ??= (async () => {
    const device = await loadSourceDevice('74hc573');
    const model = await compileDDL(instrumentedSource(DEVICE_SOURCE));

    return { model, create: device.create };
  })();

  return instrumented;
}

async function instrumentedBoard(): Promise<TestBoard> {
  const { nets, sources, probes } = latchOptions();

  return createBoardWith([{ id: 'dut', type: '74hc573', device: await instrumentedDevice() }], {
    nets,
    probes,
    sources,
  });
}

function poweredNets(byte: number): NetDescription[] {
  const nets: NetDescription[] = [
    { id: 'vcc', pins: [{ instance: 'dut', pin: 'vcc' }], voltage: 5 },
    { id: 'gnd', pins: [{ instance: 'dut', pin: 'gnd' }], voltage: 0 },
    { id: 'le', pins: [{ instance: 'dut', pin: 'le' }], voltage: 0 },
    { id: 'oe', pins: [{ instance: 'dut', pin: 'oe' }], voltage: 0 },
  ];

  for (const bit of DATA)
    nets.push({
      id: `d${bit}`,
      pins: [{ instance: 'dut', pin: `d${bit}` }],
      voltage: (byte >> bit) & 1 ? 5 : 0,
    });

  for (const bit of DATA)
    nets.push({
      id: `q${bit}`,
      pins: [
        { instance: 'dut', pin: `q${bit}` },
        { instance: `q${bit}Probe`, pin: 'y' },
      ],
    });

  return nets;
}

describe('74HC573', () => {
  it('元数据声明 20 根引脚与 latch 端口', () => {
    const metadata = readMetadata('74hc573') as {
      readonly pins: Readonly<Record<string, unknown>>;
      readonly ports: Readonly<Record<string, { readonly type: string }>>;
    };

    expect(Object.keys(metadata.pins)).toHaveLength(20);
    expect(metadata.ports.latch?.type).toBe('number');
  });

  it('LE 高时透明跟随 D，下降沿锁存当时的字节', async () => {
    const built = await fixture();

    try {
      built.le(true);
      built.oe(false);
      built.data(0xa5);
      built.board.run(1_000_000);

      expect(built.board.faults).toEqual([]);
      expect(built.q()).toBe(0xa5);
      expect(built.board.topics.latch).toBe(0xa5);

      built.le(false);
      built.data(0x3c);
      built.board.run(1_000_000);

      // LE 已经为低：后续数据变化不再影响 Q。
      expect(built.q()).toBe(0xa5);

      built.le(true);
      built.board.run(1_000_000);
      expect(built.q()).toBe(0x3c);

      built.le(false);
      built.board.run(1_000_000);
      expect(built.q()).toBe(0x3c);
      expect(built.board.topics.latch).toBe(0x3c);
    } finally {
      built.board.dispose();
    }
  });

  it('OE# 高时八路输出全部释放，恢复低后回到锁存值', async () => {
    const built = await fixture();

    try {
      built.le(true);
      built.oe(false);
      built.data(0x5a);
      built.board.run(1_000_000);
      expect(built.q()).toBe(0x5a);

      built.oe(true);
      built.board.run(1_000_000);
      built.release();

      built.oe(false);
      built.board.run(1_000_000);
      expect(built.q()).toBe(0x5a);
      expect(built.board.faults).toEqual([]);
    } finally {
      built.board.dispose();
    }
  });

  it('悬空的输入按低处理，输出不会停在未知电平', async () => {
    const built = await fixture();

    try {
      for (const bit of DATA) built.board.send(`d${bit}Src`, 'level', 2);
      built.le(true);
      built.oe(false);
      built.board.run(1_000_000);

      expect(built.q()).toBe(0x00);
      expect(built.board.faults).toEqual([]);
    } finally {
      built.board.dispose();
    }
  });

  it('OE# 释放期间 1 ps 的 LE 脉冲仍透明更新，恢复使能后输出新值', async () => {
    const built = await fixture();

    try {
      built.le(true);
      built.oe(false);
      built.data(0x0f);
      built.board.run(STEP);
      built.le(false);
      built.board.run(STEP);
      expect(built.q()).toBe(0x0f);

      built.oe(true);
      built.board.run(STEP);
      built.release();

      built.data(0xf0);
      built.le(true);
      built.board.run(1);
      // 1 ps 的透明窗口已把新字节写入锁存，但输出仍被 OE# 释放。
      expect(built.board.topics.latch).toBe(0xf0);
      built.release();

      built.le(false);
      built.board.run(STEP);
      built.release();

      built.oe(false);
      built.board.run(STEP);
      expect(built.q()).toBe(0xf0);
      expect(built.board.faults).toEqual([]);
    } finally {
      built.board.dispose();
    }
  });

  it('LE 低时上电仍把固定 D 字节锁存', async () => {
    const byte = 0x96;
    const device = await loadSourceDevice('74hc573');
    const board = await createBoardWith([{ id: 'dut', type: '74hc573', device }], {
      nets: poweredNets(byte),
      probes: PROBES,
    });

    try {
      board.run(STEP);

      expect(readQ(board)).toBe(byte);
      expect(board.topics.latch).toBe(byte);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('LE 低时翻转 D 不执行 dataByte 也不唤醒 follow', async () => {
    const board = await instrumentedBoard();

    try {
      driveLevel(board, 'leSrc', false);
      driveLevel(board, 'oeSrc', false);
      driveData(board, 0x00);
      board.run(STEP);

      // 启动过程发布 0 基线；探针接收循环常驻在同一启动过程内。
      const baseline = wakes(board);

      expect(baseline).toBe(0);

      board.send('dut', 'probeCommand', 1);
      board.run(STEP);
      expect(wakes(board)).toBe(baseline);
      expect(board.faults).toEqual([]);

      for (const byte of [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80]) {
        driveData(board, byte);
        board.run(STEP);
      }

      expect(wakes(board)).toBe(baseline);
      expect(board.faults).toEqual([]);
      expect(readQ(board)).toBe(0x00);
    } finally {
      board.dispose();
    }
  });

  it('未启用探针时 LE 高改变 D 会真正唤醒 follow', async () => {
    const board = await instrumentedBoard();

    try {
      driveLevel(board, 'leSrc', false);
      driveLevel(board, 'oeSrc', false);
      driveData(board, 0x00);
      board.run(STEP);

      driveLevel(board, 'leSrc', true);
      board.run(STEP);
      expect(board.faults).toEqual([]);

      const before = wakes(board);

      // LE 高本身已经唤醒过 follow，计数不是永远不会更新的死值。
      expect(before).toBeGreaterThan(0);

      driveData(board, 0xa5);
      board.run(STEP);

      expect(wakes(board)).toBeGreaterThan(before);
      expect(board.faults).toEqual([]);
      expect(readQ(board)).toBe(0xa5);
    } finally {
      board.dispose();
    }
  });

  it('启用探针后 LE 高透明跟随触发 dataByte 断言', async () => {
    const board = await instrumentedBoard();

    try {
      driveLevel(board, 'leSrc', false);
      driveData(board, 0x00);
      board.run(STEP);

      board.send('dut', 'probeCommand', 1);
      board.run(STEP);
      expect(board.faults).toEqual([]);

      driveLevel(board, 'leSrc', true);
      expect(() => board.run(STEP)).toThrow('dataByte evaluated');

      expect(board.faults).toContain('dataByte evaluated');
    } finally {
      board.dispose();
    }
  });

  it('启用探针后 LE 下降沿锁存触发 dataByte 断言', async () => {
    const board = await instrumentedBoard();

    try {
      driveLevel(board, 'leSrc', true);
      driveData(board, 0x0f);
      board.run(STEP);
      expect(board.faults).toEqual([]);

      // 同一批内启用探针并拉低 LE，形成一次带探针的下降沿锁存捕获。
      board.send('dut', 'probeCommand', 1);
      driveLevel(board, 'leSrc', false);
      expect(() => board.run(STEP)).toThrow('dataByte evaluated');

      expect(board.faults).toContain('dataByte evaluated');
    } finally {
      board.dispose();
    }
  });
});
