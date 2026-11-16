import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createCt107dBoard } from '../bench/board.ts';
import {
  PREVIEW_CLOCK_FREQUENCY,
  PREVIEW_FIRMWARE_NAME,
  PREVIEW_TICK_MS,
  PREVIEW_WARMUP_MS,
  previewFirmware,
} from '../bench/preview.ts';

/**
 * 真实预览固件 `digital-display-dynamic.bin` 的段码轨迹回归。
 *
 * 口径固定为画布预览的后端：11.0592 MHz + `throughput` + 64 ms 连续推进。
 * 板级装配、电气求解、seg4 稳定窗口与话题桥都走真实运行时；话题归属只用
 * `topicOrigin()` 返回的实例 ID，再加端口名与 `board.time`，位号（DS1/DS2）
 * 只做辅助映射。
 *
 * 两个用例分工：
 * - 主用例从 0 推进到 4096 ms，保留每个 64 ms 检查点的八位 digit 值与整段变化计数；
 * - 1 ms 控制用例跑满 0→4096 ms，保留 DS2 从初始 0 到 `0x5b` 的逐步快照与内部进位时刻。
 *
 * 统一模型以「整份显示快照」发事件：同一快照的四位共享 `simTime`，不再提供逐位提交事件。
 * 兼容投影把快照展开为 digit1–digit4 话题，供旧画布和本用例消费。
 */

const STEP_MS = PREVIEW_TICK_MS;
const END_MS = 4096;
const MS_PS = 1_000_000_000;
const EXPECTED_FIRMWARE_BYTES = 2_421;
const EXPECTED_FIRMWARE_SHA256 = 'b15a9f9f4232a70d88d080e2f6336359c701777951685a93177e3264b829bd25';

const DIGITS = ['digit1', 'digit2', 'digit3', 'digit4'] as const;
type DigitPort = (typeof DIGITS)[number];
const DIGIT_PORTS = new Set<string>(DIGITS);
const DISPLAYS = ['DS1', 'DS2'] as const;
type Display = (typeof DISPLAYS)[number];
const DISPLAY_SET = new Set<string>(DISPLAYS);

/** 固件实际用到的七段字形；`0x00` 是消隐，只允许出现在上电初值。 */
const GLYPHS = new Map<number, string>([
  [0x3f, '0'],
  [0x06, '1'],
  [0x5b, '2'],
  [0x4f, '3'],
  [0x66, '4'],
  [0x6d, '5'],
  [0x7d, '6'],
  [0x07, '7'],
  [0x7f, '8'],
  [0x6f, '9'],
  [0x40, '-'],
  [0x00, ' '],
]);

interface DigitChange {
  readonly timePs: number;
  readonly simMs: number;
  readonly instance: string;
  readonly designator: Display;
  readonly port: DigitPort;
  readonly value: number;
}

interface Checkpoint {
  readonly simMs: number;
  readonly digits: Readonly<Record<string, number>>;
  readonly texts: Readonly<Record<Display, string>>;
}

interface Trace {
  readonly events: readonly DigitChange[];
  readonly checkpoints: readonly Checkpoint[];
  readonly instanceByDesignator: ReadonlyMap<Display, string>;
  readonly clockFrequency: number;
  readonly firmwareBytes: number;
  readonly firmwareSha256: string;
  readonly faults: readonly string[];
}

function isDigitPort(port: string): port is DigitPort {
  return DIGIT_PORTS.has(port);
}

function glyph(mask: number): string {
  if (!Number.isInteger(mask) || mask < 0 || mask > 0xff) return '?';

  const base = GLYPHS.get(mask & 0x7f) ?? '?';

  return (mask & 0x80) === 0 ? base : `${base}.`;
}

function displayText(digits: Readonly<Record<string, number>>, designator: Display): string {
  return DIGITS.map((port) => glyph(digits[`${designator}/${port}`] ?? Number.NaN)).join('');
}

/** 按事件时间重放，得到 `atMs`（含）之前的八位最新值。 */
function digitsAt(events: readonly DigitChange[], atMs: number): Record<string, number> {
  const latest = new Map<string, number>();

  for (const event of events) {
    if (event.simMs > atMs) break;
    latest.set(`${event.designator}/${event.port}`, event.value);
  }

  return Object.fromEntries(latest);
}

function countChanges(events: readonly DigitChange[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};

  for (const event of events) {
    const key = `${event.designator}/${event.port}`;

    counts[key] = (counts[key] ?? 0) + 1;
  }

  return counts;
}

async function runTrace(
  stepMs: number,
  endMs: number,
  captureFromMs = PREVIEW_WARMUP_MS,
): Promise<Trace> {
  const firmware = previewFirmware();
  const built = await createCt107dBoard({
    firmware,
    props: { clockFrequency: PREVIEW_CLOCK_FREQUENCY },
    execution: 'throughput',
  });
  const instanceByDesignator = new Map<Display, string>();
  const events: DigitChange[] = [];

  for (const [instance, designator] of built.designators) {
    if (DISPLAY_SET.has(designator) && !instanceByDesignator.has(designator as Display)) {
      instanceByDesignator.set(designator as Display, instance);
    }
  }

  if (instanceByDesignator.size !== DISPLAYS.length) {
    built.dispose();
    throw new Error(`expected two displays, got ${instanceByDesignator.size}`);
  }

  const subscription = built.board.topics.onDidReceive((message) => {
    if (!isDigitPort(message.topic)) return;

    const instance = built.topicOrigin();
    if (instance === undefined) {
      throw new Error(`digit topic ${message.topic} was published outside a device sync`);
    }
    const designator = built.designators.get(instance);
    if (designator === undefined || !DISPLAY_SET.has(designator)) return;
    if (typeof message.payload !== 'number') {
      throw new TypeError(`digit topic ${message.topic} payload is not a number`);
    }

    events.push({
      timePs: built.board.time,
      simMs: built.board.time / MS_PS,
      instance,
      designator: designator as Display,
      port: message.topic,
      value: message.payload,
    });
  });

  const checkpoints: Checkpoint[] = [];
  const latest = new Map<string, number>();
  let consumed = 0;

  try {
    built.board.runUntil(0);

    for (let ms = stepMs; ms <= endMs; ms += stepMs) {
      built.board.runUntil(ms * MS_PS);

      while (consumed < events.length) {
        const event = events[consumed]!;
        latest.set(`${event.designator}/${event.port}`, event.value);
        consumed += 1;
      }

      if (ms >= captureFromMs) {
        const digits = Object.fromEntries(latest) as Record<string, number>;

        checkpoints.push({
          simMs: ms,
          digits,
          texts: {
            DS1: displayText(digits, 'DS1'),
            DS2: displayText(digits, 'DS2'),
          },
        });
      }
    }

    return {
      events,
      checkpoints,
      instanceByDesignator,
      clockFrequency: built.clockFrequency,
      firmwareBytes: firmware.length,
      firmwareSha256: createHash('sha256').update(firmware).digest('hex'),
      faults: [...built.faults],
    };
  } finally {
    subscription.dispose();
    built.dispose();
  }
}

describe(`seg4 真实预览固件 ${PREVIEW_FIRMWARE_NAME}`, () => {
  it('64 ms 连续推进 0→4096 ms：DS1 固定 2018，DS2 从 --02 计数到 --05', async () => {
    const trace = await runTrace(STEP_MS, END_MS);

    expect(trace.faults).toEqual([]);
    expect(trace.firmwareBytes).toBe(EXPECTED_FIRMWARE_BYTES);
    expect(trace.firmwareSha256).toBe(EXPECTED_FIRMWARE_SHA256);
    expect(trace.clockFrequency).toBe(PREVIEW_CLOCK_FREQUENCY);
    expect(trace.instanceByDesignator.size).toBe(DISPLAYS.length);

    const ds1 = trace.instanceByDesignator.get('DS1')!;
    const ds2 = trace.instanceByDesignator.get('DS2')!;
    expect(ds1).not.toBe(ds2);

    // 每条 digit 消息都用 topicOrigin() 归属到真实实例 ID；位号不能当唯一键。
    for (const event of trace.events) {
      expect(event.instance).toBe(trace.instanceByDesignator.get(event.designator));
      expect(Number.isInteger(event.simMs)).toBe(true);
      expect(event.timePs % (STEP_MS * MS_PS)).toBe(0);
    }

    // 统一模型只在状态变化时发事件；上电零值通过 `getDisplay` 查询，不补发历史事件。
    expect(trace.events.filter((event) => event.simMs === 0)).toHaveLength(0);

    // 首帧在第一个 64 ms 批次边界出现；内部提交时间见下面的 1 ms 控制用例。
    const firstFrame = trace.events.filter((event) => event.simMs === STEP_MS);
    expect(firstFrame).toHaveLength(DIGITS.length * DISPLAYS.length);
    expect(displayText(digitsAt(trace.events, STEP_MS), 'DS1')).toBe('2018');
    expect(displayText(digitsAt(trace.events, STEP_MS), 'DS2')).toBe('--02');

    // 预热 512 ms 结束：八位完整、可解码、没有残留的 0 或未知段码。
    expect(trace.checkpoints).toHaveLength((END_MS - PREVIEW_WARMUP_MS) / STEP_MS + 1);
    expect(trace.checkpoints[0]!.simMs).toBe(PREVIEW_WARMUP_MS);
    expect(trace.checkpoints[0]!.texts).toEqual({ DS1: '2018', DS2: '--02' });

    for (const checkpoint of trace.checkpoints) {
      expect(checkpoint.texts.DS1).toBe('2018');
      expect(checkpoint.texts.DS2).toMatch(/^--\d\d$/);

      for (const designator of DISPLAYS) {
        for (const port of DIGITS) {
          const mask = checkpoint.digits[`${designator}/${port}`];

          expect(mask).toBeDefined();
          expect(mask).not.toBe(0);
          expect(GLYPHS.has(mask!)).toBe(true);
          expect(checkpoint.texts[designator]).not.toContain('?');
        }
      }
    }

    // 整段轨迹：--02 保持到 1088 ms，随后在 64 ms 网格上逐次进位。
    const expectedDs2 = trace.checkpoints.map(({ simMs }) => {
      if (simMs < 1152) return '--02';
      if (simMs < 2304) return '--03';
      if (simMs < 3392) return '--04';

      return '--05';
    });

    expect(trace.checkpoints.map((checkpoint) => checkpoint.texts.DS2)).toEqual(expectedDs2);
    expect(new Set(trace.checkpoints.map((checkpoint) => checkpoint.texts.DS2)).size).toBe(4);

    // 变化计数（首帧 + 预热后的进位）：只有 DS2 digit4 在预热后继续变化。
    const counts = countChanges(trace.events);

    expect(counts).toEqual({
      'DS1/digit1': 1,
      'DS1/digit2': 1,
      'DS1/digit3': 1,
      'DS1/digit4': 1,
      'DS2/digit1': 4,
      'DS2/digit2': 4,
      'DS2/digit3': 4,
      'DS2/digit4': 4,
    });

    const afterWarmup = trace.events.filter((event) => event.simMs >= PREVIEW_WARMUP_MS);

    // 统一事件按一次完整显示快照发出：同一快照内的四位共享 simTime。
    const snapshots = new Map<number, Map<string, number>>();
    for (const event of afterWarmup) {
      const snapshot = snapshots.get(event.simMs) ?? new Map<string, number>();
      snapshot.set(event.port, event.value);
      snapshots.set(event.simMs, snapshot);
    }
    expect([...snapshots.keys()]).toEqual([1152, 2304, 3392]);
    for (const [simMs, snapshot] of snapshots) {
      expect(snapshot.size).toBe(4);
      expect(snapshot.get('digit4')).toBe(
        simMs === 1152 ? 0x4f : simMs === 2304 ? 0x66 : 0x6d,
      );
    }
    // 两片 seg4 各自扫描；预热后只有 DS2 发出新快照，不假设两片同步刷新。
    expect(new Set(afterWarmup.map((event) => event.instance))).toEqual(new Set([ds2]));

    for (const event of afterWarmup) {
      expect(event.value).not.toBe(0);
      expect(GLYPHS.has(event.value)).toBe(true);
    }

    process.stdout.write(
      `SEG4_TRACE ${JSON.stringify({
        firmware: { bytes: trace.firmwareBytes, sha256: trace.firmwareSha256 },
        clockFrequency: trace.clockFrequency,
        stepMs: STEP_MS,
        endMs: END_MS,
        events: trace.events.length,
        changesByKey: counts,
        checkpoints: trace.checkpoints.length,
        postWarmup: afterWarmup.map((event) => ({
          simMs: event.simMs,
          designator: event.designator,
          port: event.port,
          value: `0x${event.value.toString(16)}`,
        })),
        displays: {
          DS1: [...new Set(trace.checkpoints.map((checkpoint) => checkpoint.texts.DS1))],
          DS2: [...new Set(trace.checkpoints.map((checkpoint) => checkpoint.texts.DS2))],
        },
      })}\n`,
    );
  }, 900_000);

  it('1 ms 控制：显示快照从 0 逐步到 0x5b，内部进位早于 64 ms 边界', async () => {
    const trace = await runTrace(1, END_MS, Number.POSITIVE_INFINITY);

    expect(trace.faults).toEqual([]);
    expect(trace.firmwareSha256).toBe(EXPECTED_FIRMWARE_SHA256);

    const ds2 = trace.instanceByDesignator.get('DS2')!;
    const firstFrameMs = new Map<string, number>();

    for (const event of trace.events) {
      if (event.simMs > STEP_MS) continue;
      firstFrameMs.set(`${event.designator}/${event.port}`, event.simMs);
    }

    // 每片显示器的四位在同一个快照事件里共享 simTime；两片各自扫描，稳定时刻不同。
    expect(Object.fromEntries(firstFrameMs)).toEqual({
      'DS1/digit1': 3,
      'DS1/digit2': 3,
      'DS1/digit3': 3,
      'DS1/digit4': 3,
      'DS2/digit1': 11,
      'DS2/digit2': 11,
      'DS2/digit3': 11,
      'DS2/digit4': 11,
    });

    // 1 ms 批次保留 DS2 第 4 位从 0 到 0x06、0x5b 的中间快照；后面的
    // 1126/2241/3355 是真实内部进位，主用例只会看到 1152/2304/3392 的批次边界。
    const ds2Digit4 = trace.events.filter(
      (event) => event.instance === ds2 && event.port === 'digit4',
    );

    expect(ds2Digit4.map((event) => [event.simMs, event.value])).toEqual([
      [3, 0x00],
      [4, 0x00],
      [5, 0x06],
      [11, 0x5b],
      [1126, 0x4f],
      [2241, 0x66],
      [3355, 0x6d],
    ]);
    expect(displayText(digitsAt(trace.events, STEP_MS), 'DS2')).toBe('--02');
    expect(displayText(digitsAt(trace.events, END_MS), 'DS2')).toBe('--05');
    expect(displayText(digitsAt(trace.events, END_MS), 'DS1')).toBe('2018');

    for (const event of trace.events.filter((item) => item.simMs >= 11)) {
      expect(event.value).not.toBe(0);
      expect(GLYPHS.has(event.value)).toBe(true);
    }

    process.stdout.write(
      `SEG4_TRACE_1MS ${JSON.stringify({
        firstFrameMs: Object.fromEntries(firstFrameMs),
        DS2Digit4: ds2Digit4.map((event) => ({
          simMs: event.simMs,
          value: `0x${event.value.toString(16)}`,
        })),
        DS1At4096: displayText(digitsAt(trace.events, END_MS), 'DS1'),
        DS2At4096: displayText(digitsAt(trace.events, END_MS), 'DS2'),
      })}\n`,
    );
  }, 900_000);
});
