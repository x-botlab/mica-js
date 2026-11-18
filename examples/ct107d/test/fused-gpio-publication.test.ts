import { describe, expect, it } from 'vitest';
import { createFusedCt107dBoard } from '../bench/fused';
import type { FusedBenchBoard } from '../bench/fused';
import { assemble } from './fixtures/8051/assemble';

/**
 * P0/P2 → U24（138 译码）→ U25（WR 选通）→ U7/U8（573 锁存）的独立回归。
 *
 * 用例只使用真实 8051 指令，并读取公开的锁存/译码通道与快照；不读取 `fusedSeq`、
 * dirty 标记、生成器内部函数或候选实现的命名。U7（段码，0xE0）、U8（COM，0xC0）
 * 和作为观察点的 U6（0x80）只在各自 YxC 为高时透明，其余时间必须保持原值。
 *
 * 每个场景都在 `throughput` 与 `precise` 下各跑一块板：两种模式允许批次粒度不同，
 * 但锁存数据、译码序列和最终状态必须一致。
 *
 * 切换用例在 `MOV P2,#0xE0` 前后各放 32 条 NOP，并分多次 `runUntil` 停在间隙中部，
 * 直接读取公开快照。断言的是同一时刻的 U24/U8/U7 联合状态，而不是同一批次内按
 * 通道集中投递的事件顺序。12 MHz、STC15 1T 的时钟数只用于放置检查点；32 条 NOP
 * 的余量吸收取整差异，不把单条指令耗时当作被测行为。
 */

/** 20 µs：足以执行全部用例并进入稳定的 SJMP 循环。 */
const HORIZON_PS = 20_000_000;
const U6_ADDRESS = 0x80;
const U8_ADDRESS = 0xc0;
const U7_ADDRESS = 0xe0;

/** 显式 12 MHz，避免检查点时间依赖默认的 11.0592 MHz。 */
const CLOCK_HZ = 12_000_000;
const CYCLE_PS = Math.round(1_000_000_000_000 / CLOCK_HZ);
/** 长 NOP 间隙，以及用于估算其中点的时钟数。 */
const NOP_GAP = 32;
const CHECK_NOP = 16;

const hex = (value: number): string => `0x${value.toString(16).padStart(2, '0')}`;

const nopGap = (count: number): string => '        NOP\n'.repeat(count);

const firmware = (body: string): Uint8Array =>
  assemble(`        ORG 0\n${body}\nEND:\n        SJMP END\n`);

interface Readings {
  readonly u6: number[];
  readonly u7: number[];
  readonly u8: number[];
  readonly select: number[];
  readonly enabled: number[];
  readonly codes: string[];
}

interface BoardState {
  readonly select: number;
  readonly enabled: boolean;
  readonly code: string;
  readonly latches: { readonly u6: number; readonly u7: number; readonly u8: number };
}

interface RunResult {
  readonly execution: 'throughput' | 'precise';
  readonly readings: Readings;
  readonly checkpoints: readonly BoardState[];
  readonly final: BoardState;
  readonly status: string;
  readonly faults: readonly string[];
}

interface SignalPayload {
  readonly designator: string;
  readonly port: string;
  readonly value: number;
}

interface BytesPayload {
  readonly designator: string;
  readonly port: string;
  readonly data: Uint8Array;
}

interface Snapshot {
  readonly latches: Record<'U6' | 'U7' | 'U8' | 'U9', number>;
  readonly decoder: { readonly select: number; readonly enabled: boolean; readonly code: string };
}

const snapshot = (fused: FusedBenchBoard): Snapshot => fused.methods.getSnapshot!(null) as Snapshot;

const stateOf = (fused: FusedBenchBoard): BoardState => {
  const value = snapshot(fused);

  return {
    select: value.decoder.select,
    enabled: value.decoder.enabled,
    code: value.decoder.code,
    latches: { u6: value.latches.U6, u7: value.latches.U7, u8: value.latches.U8 },
  };
};

function capture(fused: FusedBenchBoard): { readings: Readings; dispose(): void } {
  const u6: number[] = [];
  const u7: number[] = [];
  const u8: number[] = [];
  const select: number[] = [];
  const enabled: number[] = [];
  const codes: string[] = [];
  const subscription = fused.board.topics.onDidReceive((message) => {
    if (message.topic === 'signal') {
      const payload = message.payload as Partial<SignalPayload> | null;
      if (typeof payload?.value !== 'number') return;
      if (payload.designator === 'U6' && payload.port === 'latch') u6.push(payload.value);
      else if (payload.designator === 'U7' && payload.port === 'latch') u7.push(payload.value);
      else if (payload.designator === 'U8' && payload.port === 'latch') u8.push(payload.value);
      else if (payload.designator === 'U24' && payload.port === 'select')
        select.push(payload.value);
      else if (payload.designator === 'U24' && payload.port === 'enabled')
        enabled.push(payload.value);
      return;
    }
    if (message.topic !== 'bytes') return;
    const payload = message.payload as Partial<BytesPayload> | null;
    if (
      payload?.designator === 'U24' &&
      payload.port === 'code' &&
      payload.data instanceof Uint8Array
    )
      codes.push(String.fromCharCode(...payload.data));
  });
  return {
    readings: { u6, u7, u8, select, enabled, codes },
    dispose: () => subscription.dispose(),
  };
}

interface RunOptions {
  readonly clockFrequency?: number;
  readonly checkpoints?: readonly number[];
}

async function runFirmware(
  body: string,
  execution: 'throughput' | 'precise',
  options: RunOptions = {},
): Promise<RunResult> {
  const fused = await createFusedCt107dBoard({
    firmware: firmware(body),
    execution,
    ...(options.clockFrequency === undefined
      ? {}
      : { props: { clockFrequency: options.clockFrequency } }),
  });
  const captured = capture(fused);
  try {
    fused.board.runUntil(0);
    const checkpoints: BoardState[] = [];
    for (const target of options.checkpoints ?? []) {
      fused.board.runUntil(target);
      checkpoints.push(stateOf(fused));
    }
    fused.board.runUntil(HORIZON_PS);
    return {
      execution,
      readings: captured.readings,
      checkpoints,
      final: stateOf(fused),
      status: fused.board.status,
      faults: [...fused.faults],
    };
  } finally {
    captured.dispose();
    fused.dispose();
  }
}

/** 去掉相邻重复值；批次粒度不同不应改变锁存值序列，只可能改变重复次数。 */
function transitions<T>(values: readonly T[]): T[] {
  return values.filter((value, index) => index === 0 || value !== values[index - 1]);
}

function shape(result: RunResult): Record<string, unknown> {
  return {
    u6: transitions(result.readings.u6),
    u7: transitions(result.readings.u7),
    u8: transitions(result.readings.u8),
    select: transitions(result.readings.select),
    enabled: transitions(result.readings.enabled),
    codes: transitions(result.readings.codes),
    checkpoints: result.checkpoints,
    final: result.final,
  };
}

function expectReady(results: readonly RunResult[]): void {
  for (const result of results) {
    expect(result.status, `${result.execution} status`).toBe('ready');
    expect(result.faults, `${result.execution} faults`).toEqual([]);
  }
}

describe('fused P0/P2 latch publication', () => {
  it('closes U8 and opens U7 across a single decoder selection change', async () => {
    // P2=0x00 先关闭所有锁存；两个不相关的 P0 值不能进入 U7/U8。
    // P2=0xC0 只让 U8 透明，P0 的 0x5E→0x3C 都应跟随到 U8；U7 必须保持关闭。
    // P2=0xE0 是一条指令同时让 Y6 关闭、Y7 打开：U8 锁存 0x3C，U7 从 0x3C 开始透明。
    // 随后 P0=0x96 只更新 U7；P2=0x00 关闭 U7，最后 P0=0x00 不得改变任一锁存。
    // 两个 32 条 NOP 的间隙让多次 `runUntil` 能停在切换前后各自的间隙内部。
    const body = [
      '        MOV P2,#0x00\n',
      '        MOV P0,#0x11\n',
      '        MOV P0,#0x5E\n',
      `        MOV P2,#${hex(U8_ADDRESS)}\n`,
      '        MOV P0,#0x3C\n',
      nopGap(NOP_GAP),
      `        MOV P2,#${hex(U7_ADDRESS)}\n`,
      nopGap(NOP_GAP),
      '        MOV P0,#0x96\n',
      '        MOV P2,#0x00\n',
      '        MOV P0,#0x00\n',
    ].join('');
    // 前置 5 条 MOV direct,#imm。用指令时钟数估算间隙中点，不依赖具体 NOP 边界。
    const SETUP_CYCLES = 5 * 3;
    const SWITCH_CYCLES = 3;
    const beforeSwitchPs = (SETUP_CYCLES + CHECK_NOP) * CYCLE_PS + (CYCLE_PS >> 1);
    const afterSwitchPs =
      (SETUP_CYCLES + NOP_GAP + SWITCH_CYCLES + CHECK_NOP) * CYCLE_PS + (CYCLE_PS >> 1);
    const options = {
      clockFrequency: CLOCK_HZ,
      checkpoints: [beforeSwitchPs, afterSwitchPs],
    };
    const results = [
      await runFirmware(body, 'throughput', options),
      await runFirmware(body, 'precise', options),
    ];

    expectReady(results);
    for (const result of results) {
      const beforeSwitch = result.checkpoints[0]!;
      const afterSwitch = result.checkpoints[1]!;
      // 进入 Y6 的 NOP 间隙：U7 仍关闭并保持 0xFF，U8 已跟随 0x3C，译码仍是 Y6。
      expect(beforeSwitch, `${result.execution} before MOV P2,#0xE0`).toEqual({
        select: 6,
        enabled: true,
        code: 'Y6',
        latches: { u6: 0, u7: 0xff, u8: 0x3c },
      });
      // 同一条 MOV P2,#0xE0 之后：Y7 已选中，U8 锁存 0x3C，U7 跟随同一条 P0 总线值。
      expect(afterSwitch, `${result.execution} after MOV P2,#0xE0`).toEqual({
        select: 7,
        enabled: true,
        code: 'Y7',
        latches: { u6: 0, u7: 0x3c, u8: 0x3c },
      });
      expect(transitions(result.readings.u7), `${result.execution} U7 transitions`).toEqual([
        0, 0xff, 0x3c, 0x96,
      ]);
      expect(transitions(result.readings.u8), `${result.execution} U8 transitions`).toEqual([
        0, 0x5e, 0x3c,
      ]);
      expect(transitions(result.readings.u6), `${result.execution} U6 untouched`).toEqual([0]);
      expect(transitions(result.readings.select), `${result.execution} U24 decode`).toEqual([
        7, 0, 6, 7, 0,
      ]);
      expect(transitions(result.readings.codes), `${result.execution} U24 code`).toEqual([
        'Y7',
        'Y0',
        'Y6',
        'Y7',
        'Y0',
      ]);
      expect(result.final).toEqual({
        select: 0,
        enabled: true,
        code: 'Y0',
        latches: { u6: 0, u7: 0x96, u8: 0x3c },
      });
    }
    // 批次粒度可以不同，但有效的锁存/译码变化序列和终态必须一致。
    expect(shape(results[0]!)).toEqual(shape(results[1]!));
  }, 120_000);

  it('reads P0 back immediately after a write and latches the read byte through U6', async () => {
    // 复位时 Y7 已选中，U7 处于透明阶段：P0=0x5A 应直接出现在 U7。
    // 紧接着 MOV A,P0；随后先把 P0 改成 0xFF 再写回 A，使 U6 只能看到读回值。
    // P2=0x00 关闭 U7（锁存 0x5A），P2=0x80 打开 U6，P2=0x00 锁存读回值。
    // 若 P0 读回滞后于写入，A 会是 0xFF/0x00，U6 与 U7 不再一致。
    const body = `
        MOV P0,#0x5A
        MOV A,P0
        MOV P2,#0x00
        MOV P0,#0xFF
        MOV P0,A
        MOV P2,#${hex(U6_ADDRESS)}
        MOV P2,#0x00
`;
    const results = [await runFirmware(body, 'throughput'), await runFirmware(body, 'precise')];

    expectReady(results);
    for (const result of results) {
      expect(transitions(result.readings.u7), `${result.execution} U7 transitions`).toEqual([
        0, 0xff, 0x5a,
      ]);
      expect(transitions(result.readings.u6), `${result.execution} U6 readback`).toEqual([0, 0x5a]);
      expect(transitions(result.readings.u8), `${result.execution} U8 untouched`).toEqual([0]);
      expect(transitions(result.readings.select), `${result.execution} U24 decode`).toEqual([
        7, 0, 4, 0,
      ]);
      expect(transitions(result.readings.codes), `${result.execution} U24 code`).toEqual([
        'Y7',
        'Y0',
        'Y4',
        'Y0',
      ]);
      expect(result.final).toEqual({
        select: 0,
        enabled: true,
        code: 'Y0',
        latches: { u6: 0x5a, u7: 0x5a, u8: 0 },
      });
      // 读回值与透明阶段看到的同一个字节。
      expect(result.final.latches.u6).toBe(result.final.latches.u7);
    }
    expect(shape(results[0]!)).toEqual(shape(results[1]!));
  }, 120_000);
});
