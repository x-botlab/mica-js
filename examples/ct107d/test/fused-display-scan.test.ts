import { describe, expect, it } from 'vitest';
import { createFusedCt107dBoard } from '../bench/fused';
import { assemble } from './fixtures/8051/assemble';

/**
 * DS1/DS2 扫描候选的定窗回归。
 *
 * 固件只用 U7（段码）和 U8（COM 选择）两个锁存器，按固定顺序改值后进入长时间空转，
 * 因此候选的变化时刻可以由锁存器信号反推，而不依赖预览固件。seg4 的稳定窗口是
 * `settleUs = 50`（微秒）：锁存信号在 1 µs 批次边界才可见，实际写入落在
 * `[boundary - 1 µs, boundary]`，所以新值最早在 `boundary + 49 µs`、最晚在
 * `boundary + 50 µs` 提交。检查点取 `boundary + 48 µs`（必然还是旧值）和
 * `boundary + 50 µs`（必然已有新值）。
 */

const US_PS = 1_000_000;
const SETTLE_US = 50;
/** 锁存事件比实际写入晚不超过 1 µs，提前 2 µs 足以保证仍在稳定窗口内。 */
const PRE_US = SETTLE_US - 2;
const STEP_US = 1;
const U7_SEGMENT = 0xe0;
const U8_COM = 0xc0;

const ZERO = { DS1: [0, 0, 0, 0], DS2: [0, 0, 0, 0] } as const;

interface Signal {
  readonly timePs: number;
  readonly designator: string;
  readonly port: string;
  readonly value: number;
}

interface Displays {
  readonly DS1: readonly number[];
  readonly DS2: readonly number[];
}

interface Snapshot {
  readonly displays: Displays;
}

interface DisplayFrame {
  readonly timePs: number;
  readonly designator: 'DS1' | 'DS2';
  readonly digits: readonly number[];
}

interface LatchEvent {
  readonly timePs: number;
  readonly value: number;
  readonly index: number;
}

interface Board {
  readonly fused: Awaited<ReturnType<typeof createFusedCt107dBoard>>;
  readonly signals: Signal[];
  runToPs(targetPs: number): void;
  snapshot(): Displays;
  dispose(): void;
}

const hex = (value: number): string => `0x${value.toString(16).padStart(2, '0')}`;

/** 写锁存器：U7 段码地址 0xE0，U8 COM 地址 0xC0。 */
const latch = (value: number, address: number): string =>
  [`        MOV P0,#${hex(value)}`, `        MOV P2,#${hex(address)}`, '        MOV P2,#0x00'].join(
    '\n',
  );

/** 共阳段码点亮为低电平；显示值 `mask` 对应 U7 输出 `~mask`。 */
const segment = (mask: number): string => latch(mask ^ 0xff, U7_SEGMENT);
const segmentLatch = (mask: number): number => mask ^ 0xff;

/**
 * 1T 内核、DJNZ 4 个时钟。外层 1 / 中层 2 / 内层 250 约 180 µs（11.0592 MHz），
 * 用于阶段之间留出大于 50 µs 稳定窗口的空转。
 */
const wait = (label: string, outer: number, middle = 250): string =>
  [
    `        MOV R5,#${outer}`,
    `${label}_OUTER:`,
    `        MOV R6,#${middle}`,
    `${label}_MIDDLE:`,
    '        MOV R7,#250',
    `${label}_INNER:`,
    `        DJNZ R7,${label}_INNER`,
    `        DJNZ R6,${label}_MIDDLE`,
    `        DJNZ R5,${label}_OUTER`,
  ].join('\n');

/** `MOV R7,#count` + 4 时钟 DJNZ：count=55 约 20 µs，用于稳定窗口内的段码变化。 */
const shortWait = (label: string, count: number): string =>
  [`        MOV R7,#${count}`, `${label}_LOOP:`, `        DJNZ R7,${label}_LOOP`].join('\n');

const firmware = (body: string): Uint8Array =>
  assemble(`        ORG 0\n${body}\nEND:\n        SJMP END\n`);

async function open(body: string): Promise<Board> {
  const fused = await createFusedCt107dBoard({ firmware: firmware(body) });
  const signals: Signal[] = [];
  const subscription = fused.board.topics.onDidReceive((message) => {
    if (message.topic !== 'signal') return;
    const payload = message.payload;
    if (payload === null || typeof payload !== 'object') return;
    const record = payload as Record<string, unknown>;
    if (
      typeof record.designator !== 'string' ||
      typeof record.port !== 'string' ||
      typeof record.value !== 'number'
    )
      return;
    signals.push({
      timePs: fused.board.time,
      designator: record.designator,
      port: record.port,
      value: record.value,
    });
  });
  try {
    fused.board.runUntil(0);
  } catch (error) {
    subscription.dispose();
    fused.dispose();
    throw error;
  }
  return {
    fused,
    signals,
    runToPs(targetPs) {
      const target = Math.round(targetPs);
      if (target < fused.board.time)
        throw new Error(`cannot run backwards: ${target} < ${fused.board.time}`);
      fused.board.runUntil(target);
    },
    snapshot() {
      const value = fused.methods.getSnapshot!(null) as Snapshot;
      return { DS1: [...value.displays.DS1], DS2: [...value.displays.DS2] };
    },
    dispose() {
      subscription.dispose();
      fused.dispose();
    },
  };
}

/**
 * 以 1 µs 批次推进到下一个锁存器写入。返回批次边界时间，而不是精确写入时刻；
 * 调用方按 `boundary + 48..50 µs` 取稳定窗口检查点。
 */
function waitForLatch(
  board: Board,
  designator: 'U7' | 'U8',
  wanted: (value: number) => boolean,
  fromIndex: number,
  maxUs = 10_000,
): LatchEvent {
  let index = fromIndex;
  for (;;) {
    while (index < board.signals.length) {
      const event = board.signals[index]!;
      index += 1;
      if (event.designator === designator && event.port === 'latch' && wanted(event.value))
        return { timePs: event.timePs, value: event.value, index };
    }
    const currentPs = board.fused.board.time;
    if (currentPs > maxUs * US_PS)
      throw new Error(`timed out waiting for ${designator} latch after ${maxUs} µs`);
    board.runToPs(currentPs + STEP_US * US_PS);
  }
}

/** 每个同步批次对一片显示只发一次整屏快照；按键值归并回四位。 */
function displayFrames(signals: readonly Signal[], fromIndex: number): DisplayFrame[] {
  const byBatch = new Map<
    string,
    { timePs: number; designator: 'DS1' | 'DS2'; digits: number[] }
  >();
  for (let index = fromIndex; index < signals.length; index += 1) {
    const event = signals[index]!;
    if (event.designator !== 'DS1' && event.designator !== 'DS2') continue;
    const match = /^digit([1-4])$/.exec(event.port);
    if (match === null) continue;
    const digit = Number.parseInt(match[1]!, 10) - 1;
    const key = `${event.timePs}:${event.designator}`;
    let frame = byBatch.get(key);
    if (frame === undefined) {
      frame = {
        timePs: event.timePs,
        designator: event.designator,
        digits: [Number.NaN, Number.NaN, Number.NaN, Number.NaN],
      };
      byBatch.set(key, frame);
    }
    frame.digits[digit] = event.value;
  }
  return [...byBatch.values()].sort(
    (left, right) => left.timePs - right.timePs || left.designator.localeCompare(right.designator),
  );
}

/**
 * 在 `[fromPs, toPs]` 内找每个被选位第一次改变的时刻。步长 0.1 µs 远小于 50 µs
 * 窗口，能区分“同一 COM 写入选中的多位共享同一提交时刻”。
 */
function firstChanges(
  board: Board,
  fromPs: number,
  toPs: number,
  probes: readonly { readonly name: string; readonly read: (displays: Displays) => number }[],
  stepPs = US_PS / 10,
): Record<string, number> {
  const result: Record<string, number> = {};
  for (let target = fromPs; target <= toPs + stepPs / 2; target += stepPs) {
    board.runToPs(target);
    const displays = board.snapshot();
    for (const probe of probes) {
      if (result[probe.name] !== undefined) continue;
      if (probe.read(displays) !== 0) result[probe.name] = target;
    }
    if (probes.every((probe) => result[probe.name] !== undefined)) return result;
  }
  throw new Error(`display probes did not change by ${toPs} ps: ${JSON.stringify(result)}`);
}

describe('fused display scan stable window', () => {
  it('a selected digit replaces a displayed glyph with legal mask 0 after one settle', async () => {
    const board = await open(
      [
        segment(0x06),
        latch(0x01, U8_COM),
        wait('SHOW', 1, 2),
        segment(0x00),
        wait('BLANK', 1, 2),
      ].join('\n'),
    );
    try {
      expect(board.snapshot()).toEqual(ZERO);
      const base = board.signals.length;

      const select = waitForLatch(board, 'U8', (value) => value === 0x01, base);
      board.runToPs(select.timePs + PRE_US * US_PS);
      expect(board.snapshot()).toEqual(ZERO);
      expect(displayFrames(board.signals, base)).toEqual([]);

      board.runToPs(select.timePs + SETTLE_US * US_PS);
      expect(board.snapshot()).toEqual({ DS1: [0x06, 0, 0, 0], DS2: [0, 0, 0, 0] });
      const first = displayFrames(board.signals, base);
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({ designator: 'DS1', digits: [0x06, 0, 0, 0] });
      expect(first[0]!.timePs).toBe(select.timePs + SETTLE_US * US_PS);

      const blankBase = board.signals.length;
      const blank = waitForLatch(board, 'U7', (value) => value === segmentLatch(0x00), blankBase);
      board.runToPs(blank.timePs + PRE_US * US_PS);
      expect(board.snapshot()).toEqual({ DS1: [0x06, 0, 0, 0], DS2: [0, 0, 0, 0] });
      expect(displayFrames(board.signals, blankBase)).toEqual([]);

      board.runToPs(blank.timePs + SETTLE_US * US_PS);
      expect(board.snapshot()).toEqual(ZERO);
      const blanked = displayFrames(board.signals, blankBase);
      expect(blanked).toHaveLength(1);
      expect(blanked[0]).toMatchObject({ designator: 'DS1', digits: [0, 0, 0, 0] });
      expect(blanked[0]!.timePs).toBe(blank.timePs + SETTLE_US * US_PS);
    } finally {
      board.dispose();
    }
  }, 120_000);

  it('an unselected digit keeps its glyph across segment changes; reselect starts a fresh settle', async () => {
    const board = await open(
      [
        segment(0x06),
        latch(0x01, U8_COM),
        wait('FIRST', 1, 2),
        latch(0x00, U8_COM),
        wait('OFF1', 1, 2),
        segment(0x5b),
        wait('OFF2', 1, 2),
        latch(0x01, U8_COM),
        wait('RESELECT', 1, 2),
        latch(0x00, U8_COM),
        wait('OFF3', 1, 2),
        segment(0x00),
        wait('OFF4', 1, 2),
        latch(0x01, U8_COM),
        wait('ZERO', 1, 2),
      ].join('\n'),
    );
    try {
      expect(board.snapshot()).toEqual(ZERO);
      const base = board.signals.length;

      const first = waitForLatch(board, 'U8', (value) => value === 0x01, base);
      board.runToPs(first.timePs + SETTLE_US * US_PS);
      expect(board.snapshot()).toEqual({ DS1: [0x06, 0, 0, 0], DS2: [0, 0, 0, 0] });
      expect(displayFrames(board.signals, base)).toHaveLength(1);

      // 取消选择后段码移动；旧字形保持，且不产生新的显示快照。
      const offBase = board.signals.length;
      const off = waitForLatch(board, 'U8', (value) => value === 0x00, offBase);
      const moved = waitForLatch(board, 'U7', (value) => value === segmentLatch(0x5b), off.index);
      board.runToPs(moved.timePs + SETTLE_US * US_PS);
      expect(board.snapshot()).toEqual({ DS1: [0x06, 0, 0, 0], DS2: [0, 0, 0, 0] });
      expect(displayFrames(board.signals, offBase)).toEqual([]);

      // 同位重选必须使用重选时刻的新稳定窗口，不能沿用取消前的 dsSince。
      const reselectBase = board.signals.length;
      const reselect = waitForLatch(board, 'U8', (value) => value === 0x01, reselectBase);
      board.runToPs(reselect.timePs + PRE_US * US_PS);
      expect(board.snapshot()).toEqual({ DS1: [0x06, 0, 0, 0], DS2: [0, 0, 0, 0] });
      expect(displayFrames(board.signals, reselectBase)).toEqual([]);

      board.runToPs(reselect.timePs + SETTLE_US * US_PS);
      expect(board.snapshot()).toEqual({ DS1: [0x5b, 0, 0, 0], DS2: [0, 0, 0, 0] });
      const reselected = displayFrames(board.signals, reselectBase);
      expect(reselected).toHaveLength(1);
      expect(reselected[0]).toMatchObject({ designator: 'DS1', digits: [0x5b, 0, 0, 0] });
      expect(reselected[0]!.timePs).toBe(reselect.timePs + SETTLE_US * US_PS);

      // 同一位置再次重选，但当前段码是合法 mask 0：仍要覆盖已显示字形。
      const offAgainBase = board.signals.length;
      const offAgain = waitForLatch(board, 'U8', (value) => value === 0x00, offAgainBase);
      const zeroSegments = waitForLatch(
        board,
        'U7',
        (value) => value === segmentLatch(0x00),
        offAgain.index,
      );
      board.runToPs(zeroSegments.timePs + SETTLE_US * US_PS);
      expect(board.snapshot()).toEqual({ DS1: [0x5b, 0, 0, 0], DS2: [0, 0, 0, 0] });
      expect(displayFrames(board.signals, offAgainBase)).toEqual([]);

      const zeroBase = board.signals.length;
      const zeroSelect = waitForLatch(board, 'U8', (value) => value === 0x01, zeroBase);
      board.runToPs(zeroSelect.timePs + PRE_US * US_PS);
      expect(board.snapshot()).toEqual({ DS1: [0x5b, 0, 0, 0], DS2: [0, 0, 0, 0] });
      expect(displayFrames(board.signals, zeroBase)).toEqual([]);

      board.runToPs(zeroSelect.timePs + SETTLE_US * US_PS);
      expect(board.snapshot()).toEqual(ZERO);
      const zeroed = displayFrames(board.signals, zeroBase);
      expect(zeroed).toHaveLength(1);
      expect(zeroed[0]).toMatchObject({ designator: 'DS1', digits: [0, 0, 0, 0] });
      expect(zeroed[0]!.timePs).toBe(zeroSelect.timePs + SETTLE_US * US_PS);
    } finally {
      board.dispose();
    }
  }, 180_000);

  it('one COM write settles all selected digits together; later unselect freezes one digit', async () => {
    const body = [
      segment(0x06),
      // DS1 digit1 + digit2 and DS2 digit4 share one U8 latch write.
      latch(0x83, U8_COM),
      wait('ALL', 1, 2),
      segment(0x5b),
      // Keep DS1 digit1 + DS2 digit4 selected; DS1 digit2 becomes unselected.
      latch(0x81, U8_COM),
      wait('NEXT', 1, 2),
    ].join('\n');
    const board = await open(body);
    try {
      expect(board.snapshot()).toEqual(ZERO);
      const base = board.signals.length;

      const select = waitForLatch(board, 'U8', (value) => value === 0x83, base);
      board.runToPs(select.timePs + PRE_US * US_PS);
      expect(board.snapshot()).toEqual(ZERO);
      expect(displayFrames(board.signals, base)).toEqual([]);

      // 0.1 µs 分辨率：三个被选位必须在同一步从 0 变为 0x06。
      const changes = firstChanges(
        board,
        select.timePs + (SETTLE_US - 1) * US_PS,
        select.timePs + SETTLE_US * US_PS,
        [
          { name: 'ds1-digit1', read: (displays) => displays.DS1[0]! },
          { name: 'ds1-digit2', read: (displays) => displays.DS1[1]! },
          { name: 'ds2-digit4', read: (displays) => displays.DS2[3]! },
        ],
      );
      expect(new Set(Object.values(changes)).size).toBe(1);
      const committedAt = Object.values(changes)[0]!;
      expect(committedAt).toBeGreaterThan(select.timePs + (SETTLE_US - 1) * US_PS);
      expect(committedAt).toBeLessThanOrEqual(select.timePs + SETTLE_US * US_PS);
      expect(board.snapshot()).toEqual({
        DS1: [0x06, 0x06, 0, 0],
        DS2: [0, 0, 0, 0x06],
      });

      const frames = displayFrames(board.signals, base);
      expect(frames).toHaveLength(2);
      expect(frames[0]).toMatchObject({ designator: 'DS1', digits: [0x06, 0x06, 0, 0] });
      expect(frames[1]).toMatchObject({ designator: 'DS2', digits: [0, 0, 0, 0x06] });
      expect(frames[0]!.timePs).toBe(frames[1]!.timePs);

      // 段码改 0x5b 后只更新仍被选中的 digit1 / DS2 digit4；digit2 保持 0x06。
      const nextBase = board.signals.length;
      const segmentEvent = waitForLatch(
        board,
        'U7',
        (value) => value === segmentLatch(0x5b),
        nextBase,
      );
      const com = waitForLatch(board, 'U8', (value) => value === 0x81, segmentEvent.index);
      expect(com.timePs).toBeGreaterThanOrEqual(segmentEvent.timePs);

      board.runToPs(segmentEvent.timePs + PRE_US * US_PS);
      expect(board.snapshot()).toEqual({
        DS1: [0x06, 0x06, 0, 0],
        DS2: [0, 0, 0, 0x06],
      });
      expect(displayFrames(board.signals, nextBase)).toEqual([]);

      board.runToPs(segmentEvent.timePs + SETTLE_US * US_PS);
      expect(board.snapshot()).toEqual({
        DS1: [0x5b, 0x06, 0, 0],
        DS2: [0, 0, 0, 0x5b],
      });
      const updated = displayFrames(board.signals, nextBase);
      expect(updated).toHaveLength(2);
      expect(updated[0]).toMatchObject({ designator: 'DS1', digits: [0x5b, 0x06, 0, 0] });
      expect(updated[1]).toMatchObject({ designator: 'DS2', digits: [0, 0, 0, 0x5b] });
      expect(updated[0]!.timePs).toBe(updated[1]!.timePs);
      expect(updated[0]!.timePs).toBe(segmentEvent.timePs + SETTLE_US * US_PS);
    } finally {
      board.dispose();
    }
  }, 180_000);

  it('a segment change during settle restarts the window and the superseded glyph never appears', async () => {
    const board = await open(
      [
        segment(0x06),
        latch(0x01, U8_COM),
        shortWait('EARLY', 55),
        segment(0x5b),
        wait('LATE', 1, 2),
      ].join('\n'),
    );
    try {
      expect(board.snapshot()).toEqual(ZERO);
      const base = board.signals.length;

      const select = waitForLatch(board, 'U8', (value) => value === 0x01, base);
      const segmentEvent = waitForLatch(
        board,
        'U7',
        (value) => value === segmentLatch(0x5b),
        select.index,
      );
      // 约 20 µs 延迟 + 1 µs 批次量化：确认段码变化确实发生在第一个稳定窗口内。
      expect(segmentEvent.timePs - select.timePs).toBeGreaterThan(10 * US_PS);
      expect(segmentEvent.timePs - select.timePs).toBeLessThan(35 * US_PS);

      // 第一个候选 0x06 的 50 µs 到期时，若未重计时就会在这里提交。
      board.runToPs(select.timePs + SETTLE_US * US_PS);
      expect(board.snapshot()).toEqual(ZERO);
      expect(displayFrames(board.signals, base)).toEqual([]);

      board.runToPs(segmentEvent.timePs + PRE_US * US_PS);
      expect(board.snapshot()).toEqual(ZERO);
      expect(displayFrames(board.signals, base)).toEqual([]);

      board.runToPs(segmentEvent.timePs + SETTLE_US * US_PS);
      expect(board.snapshot()).toEqual({ DS1: [0x5b, 0, 0, 0], DS2: [0, 0, 0, 0] });
      const frames = displayFrames(board.signals, base);
      expect(frames).toHaveLength(1);
      expect(frames[0]).toMatchObject({ designator: 'DS1', digits: [0x5b, 0, 0, 0] });
      expect(frames[0]!.timePs).toBe(segmentEvent.timePs + SETTLE_US * US_PS);
    } finally {
      board.dispose();
    }
  }, 120_000);
});
