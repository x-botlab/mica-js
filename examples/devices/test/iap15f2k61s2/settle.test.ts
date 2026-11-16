import { describe, expect, it } from 'vitest';
import type { BlockIR, OperationIR, RegionIR } from '@mica-js/sdk/model';
import { SERVICE_PC, SETTLE_PC } from '../../src/devices/iap15f2k61s2/kernel/tick.ts';
import { decode } from '../../src/devices/iap15f2k61s2/kernel/decode.ts';
import create from '../../src/devices/iap15f2k61s2/index.ts';
import { createSourceHarness } from './source-harness.ts';

/**
 * 前置结算（`SETTLE_PC`）回归。
 *
 * 时间相关 SFR 的读-改-写必须在第一次读旧锁存器之前结算，但推进不能内联进每个
 * timed 指令块：那会让块体积与翻译成本随 PC 数量放大。现在的约定是：
 *
 * - timed 指令块只检查 `clockPs`，有待推进时间就保存当前 PC 常量并转到共享结算块；
 * - 共享结算块推进一次、不派中断、不耗时，然后回到同一 PC 重新执行；
 * - 指令体、`elapse` 与外设写因此仍只发生一次。
 *
 * 这里同时守住 IR 体积、定时器账本与中断派发时机。
 */

type Translate = (input: { pc: number; code: Uint8Array }) => unknown;

function translator(): Translate {
  let options: { translate: Translate } | undefined;
  const context = {
    props: { firmware: new Uint8Array(0), clockFrequency: 11_059_200 },
    attachJit(value: { translate: Translate }) {
      options = value;

      return { dispose() {} };
    },
    loadBytes() {},
  };

  create(context as never);

  if (options === undefined) throw new Error('attachJit was not called');

  return options.translate;
}

interface Stats {
  operations: number;
  readSamples: number;
  /** `advanceDevices` → `refreshService` 写出的期限 state。 */
  deadlineWrites: number;
  redirects: number;
}

function collect(region: RegionIR, stats: Stats): void {
  for (const operation of region.operations as readonly OperationIR[]) {
    stats.operations += 1;

    switch (operation.kind) {
      case 'readSample':
        stats.readSamples += 1;
        break;
      case 'redirect':
        stats.redirects += 1;
        break;
      case 'write':
        if (operation.resource === 'state' && operation.name === 'serviceDeadline')
          stats.deadlineWrites += 1;
        break;
      case 'if':
        collect(operation.yes, stats);
        if (operation.no !== undefined) collect(operation.no, stats);
        break;
      case 'match':
        for (const arm of operation.arms) collect(arm.body, stats);
        if (operation.otherwise !== undefined) collect(operation.otherwise, stats);
        break;
      case 'select':
        collect(operation.yes.body, stats);
        collect(operation.no.body, stats);
        break;
      case 'and':
      case 'or':
        collect(operation.right.body, stats);
        break;
      case 'assert':
        if (operation.message !== undefined) collect(operation.message.body, stats);
        break;
      case 'while':
        collect(operation.test.body, stats);
        collect(operation.body, stats);
        break;
      case 'loop':
        collect(operation.body, stats);
        break;
      default:
        break;
    }
  }
}

function statsOf(block: BlockIR): Stats {
  const stats: Stats = { operations: 0, readSamples: 0, deadlineWrites: 0, redirects: 0 };

  for (const instruction of block.instructions) collect(instruction.body, stats);

  return stats;
}

/**
 * 首个转到结算块的 `if` 的条件类型。
 *
 * `and` 表示「有待推进时间 && !门控」的 UART1 纯读路径；`binary` 表示只判断
 * `clockPs > 0` 的无门控路径。
 */
function settleGateKind(block: BlockIR): OperationIR['kind'] | undefined {
  const operations = block.instructions[0]?.body.operations ?? [];
  const gate = operations.find(
    (operation): operation is Extract<OperationIR, { kind: 'if' }> =>
      operation.kind === 'if' &&
      operation.yes.operations.some((inner) => inner.kind === 'redirect'),
  );

  if (gate === undefined) return undefined;

  // `condition` 是 `ResultId`，指向先前产生该值的操作；按 IR 的 `result` 字段定位定义。
  const defining = operations.find(
    (operation) => 'result' in operation && operation.result === gate.condition,
  );

  return defining?.kind;
}

function translateWith(
  translate: Translate,
  pc: number,
  bytes: readonly number[],
  code?: Uint8Array,
): BlockIR {
  const image = code ?? new Uint8Array(0x10000);

  bytes.forEach((value, index) => {
    image[(pc + index) & 0xffff] = value;
  });

  return translate({ pc, code: image }) as BlockIR;
}

function translateAt(pc: number, bytes: readonly number[], code?: Uint8Array): BlockIR {
  return translateWith(translator(), pc, bytes, code);
}

const TIMED_ACCESSES: readonly {
  pc: number;
  bytes: readonly number[];
  label: string;
  kind: 'read' | 'write';
}[] = [
  { pc: 0x0a00, bytes: [0xc5, 0x8a], label: 'XCH A,TL0', kind: 'write' },
  { pc: 0x0a03, bytes: [0xd2, 0x8c], label: 'SETB TR0', kind: 'write' },
  { pc: 0x0a06, bytes: [0x75, 0x88, 0x10], label: 'MOV TCON,#10H', kind: 'write' },
  { pc: 0x0a09, bytes: [0xe5, 0x8a], label: 'MOV A,TL0', kind: 'read' },
];

describe('前置结算块', () => {
  it('timed 指令块只请求结算，不再内联外设推进', () => {
    const translate = translator();
    const settle = statsOf(translateWith(translate, SETTLE_PC, []));

    for (const { pc, bytes, label, kind } of TIMED_ACCESSES) {
      const stats = statsOf(translateWith(translate, pc, bytes));

      // 有待推进时间时转到共享结算块；指令体前的这一条 redirect 是唯一出口。
      expect(stats.redirects, `${label} settle redirect`).toBeGreaterThan(0);

      if (kind === 'read') {
        // 只读 timed 指令不执行外设写钩子：块里不能出现推进产物。
        expect(stats.deadlineWrites, `${label} inlined advance`).toBe(0);
        expect(stats.readSamples, `${label} sampled pins`).toBe(0);
        expect(stats.operations, `${label} IR 操作数`).toBeLessThan(200);
        continue;
      }

      // 写钩子可以合法地采样引脚或刷新期限（例如 TCON 写会同步计数器引脚）。
      // 判据是体积占比：内联整段 advanceDevices 会让块接近共享结算块大小。
      expect(stats.operations, `${label} IR 操作数`).toBeLessThan(settle.operations / 4);
    }
  });

  it('UART1 纯读门控不覆盖 timed 写：RMW 仍按待推进时间无条件结算', () => {
    const translate = translator();
    const pureRead = settleGateKind(translateWith(translate, 0x0b00, [0xe5, 0x98])); // MOV A,SCON
    const rmw = [
      { pc: 0x0b03, bytes: [0x10, 0x98, 0x00], label: 'JBC RI,rel' },
      { pc: 0x0b06, bytes: [0xc2, 0x98], label: 'CLR RI' },
      { pc: 0x0b09, bytes: [0xc5, 0x99], label: 'XCH A,SBUF' },
    ];

    // 纯读 SCON/SBUF 走 `uart1`：结算条件是「有待推进时间 && !UART1 空闲谓词」。
    expect(pureRead).toBe('and');

    for (const { pc, bytes, label } of rmw) {
      // timed 写/读-改-写走 `always`：条件只剩 `clockPs > 0`，不能套用纯读门控。
      expect(settleGateKind(translateWith(translate, pc, bytes)), `${label} 门控`).toBe('binary');
    }
  });

  it('共享结算块推进一次，体积远大于 timed 指令块', () => {
    const settle = statsOf(translateAt(SETTLE_PC, []));
    const timed = statsOf(translateAt(0x0a00, [0xe5, 0x8a]));

    expect(settle.deadlineWrites).toBeGreaterThan(0);
    expect(settle.readSamples).toBeGreaterThan(0);
    expect(settle.operations).toBeGreaterThan(timed.operations * 8);
  });

  it('结算块缓存键不读代码空间，也不与服务块冲突', () => {
    const translate = translator();
    const zero = translate({ pc: SETTLE_PC, code: new Uint8Array(0x10000) });
    const ones = translate({ pc: SETTLE_PC, code: new Uint8Array(0x10000).fill(0xff) });
    const service = translate({ pc: SERVICE_PC, code: new Uint8Array(0x10000) });

    expect(ones).toBe(zero);
    expect(service).not.toBe(zero);
  });
});

const P2 = 0xa0;
const P2M0 = 0x96;
const P2M1 = 0x95;
const P1 = 0x90;
const P1M0 = 0x92;
const P1M1 = 0x91;
const TCON = 0x88;
const TMOD = 0x89;
const TL0 = 0x8a;
const TH0 = 0x8c;
const AUXR = 0x8e;
const TR0 = 0x8c;
const ET0 = 0xa9;
const EA = 0xaf;

const PUSH_PULL_P2 = [0x75, P2M0, 0xff, 0x75, P2M1, 0x00];
const PUSH_PULL_P1 = [0x75, P1M0, 0xff, 0x75, P1M1, 0x00];

const mov = (direct: number, value: number): number[] => [0x75, direct, value];
const movADirect = (direct: number): number[] => [0xe5, direct];
const movDirectA = (direct: number): number[] => [0xf5, direct];
const setb = (bit: number): number[] => [0xd2, bit];
const movR7 = (value: number): number[] => [0x7f, value];
const djnzR7 = [0xdf, 0xfe];
const sjmpSelf = [0x80, 0xfe];
const nop = [0x00];

const P2_PINS = Array.from({ length: 8 }, (_, bit) => `P2_${bit}`);
const P1_PINS = Array.from({ length: 8 }, (_, bit) => `P1_${bit}`);

interface Assembly {
  readonly image: Uint8Array;
  readonly at: readonly number[];
}

function assemble(...parts: readonly (readonly number[])[]): Assembly {
  const at: number[] = [];
  let size = 0;

  for (const part of parts) {
    at.push(size);
    size += part.length;
  }

  const image = new Uint8Array(size);

  parts.forEach((part, index) => image.set(part, at[index] as number));

  return { image, at };
}

function signed(value: number): number {
  return value < 0x80 ? value : value - 0x100;
}

/** 从 `from` 走到 `to`（不含）累计的时钟数。只解释测试固件里的直线与 DJNZ 环。 */
function cyclesBetween(image: Uint8Array, from: number, to: number): number {
  let pc = from;
  let total = 0;
  let r7 = 0;

  for (let steps = 0; steps < 200_000; steps += 1) {
    if (pc === to) return total;

    const opcode = image[pc] as number;
    const instruction = decode(image as never, pc);

    total += instruction.cycles;

    if (opcode === 0x7f) {
      r7 = image[pc + 1] as number;
      pc += instruction.size;

      continue;
    }

    if (opcode >= 0xd8 && opcode <= 0xdf) {
      const next = (r7 - 1) & 0xff;

      r7 = next;
      pc =
        next === 0
          ? pc + instruction.size
          : pc + instruction.size + signed(image[pc + 1] as number);

      continue;
    }

    if (opcode === 0x80) {
      pc = pc + instruction.size + signed(image[pc + 1] as number);

      continue;
    }

    pc += instruction.size;
  }

  throw new Error(`firmware never reaches ${to}`);
}

interface JitLike {
  readonly cache: Map<number, { execute: (...args: never[]) => unknown }>;
}

interface SettleProbe {
  translations: number;
  executions: number;
  /** 标记 PC（待测 timed 指令）的执行次数：先跳结算、再回到同一 PC，应当至少两次。 */
  markRuns: number;
  markFirstExecutions: number;
  markLastExecutions: number;
}

/**
 * 统计本板 `SETTLE_PC` 的翻译与执行次数；共享块应当只翻译一次。
 *
 * 传入 `markPc` 时，同时记录该 PC 每次执行时的结算次数：若前置结算真的发生，
 * 该块会先跳到共享结算块、再回到同一 PC，最后一次执行前结算次数必须增加。
 */
function probeSettle(harness: { readonly board: unknown }, markPc?: number): SettleProbe {
  const jit = (harness.board as { readonly jits?: readonly JitLike[] }).jits?.[0];

  if (jit === undefined) throw new Error('MCU JIT is missing');

  const probe: SettleProbe = {
    translations: 0,
    executions: 0,
    markRuns: 0,
    markFirstExecutions: -1,
    markLastExecutions: -1,
  };
  const cache = jit.cache;
  const insert = cache.set.bind(cache);

  cache.set = (pc, instruction) => {
    if (pc === SETTLE_PC) {
      probe.translations += 1;

      const execute = instruction.execute;

      instruction.execute = (...args) => {
        probe.executions += 1;

        return execute(...args);
      };
    }

    if (markPc !== undefined && pc === markPc) {
      const execute = instruction.execute;

      instruction.execute = (...args) => {
        if (probe.markFirstExecutions < 0) probe.markFirstExecutions = probe.executions;
        probe.markLastExecutions = probe.executions;
        probe.markRuns += 1;

        return execute(...args);
      };
    }

    return insert(pc, instruction);
  };

  return probe;
}

/** 正向探针：标记 PC 确实因前置结算被重新执行，且指令体前已经跑过共享结算。 */
function expectSettledBefore(probe: SettleProbe, label: string): void {
  expect(probe.translations, `${label} SETTLE translated`).toBe(1);
  expect(probe.executions, `${label} SETTLE executed`).toBeGreaterThan(0);
  expect(probe.markRuns, `${label} re-executed after settle`).toBeGreaterThan(1);
  expect(probe.markLastExecutions, `${label} settle before body`).toBeGreaterThan(
    probe.markFirstExecutions,
  );
}

describe('结算时序', () => {
  it('ANL TCON 在结算后保留结算中置起的 TF0，并在同一指令停表', async () => {
    const { image, at } = assemble(
      PUSH_PULL_P2,
      mov(AUXR, 0x81), // T0 1T
      mov(TMOD, 0x01), // 16 位不重装
      mov(TH0, 0xff),
      mov(TL0, 0xff), // 1 个时钟后溢出
      setb(TR0),
      [0x53, TCON, 0xef], // ANL TCON,#EFH：停 T0，保留结算中置起的 TF0
      movADirect(TCON),
      [0x54, 0x20], // ANL A,#20H → TF0
      movDirectA(P2),
      sjmpSelf,
    );
    const harness = await createSourceHarness({
      firmware: image,
      clockFrequency: 1_000_000,
      observe: P2_PINS,
    });
    const probe = probeSettle(harness, at[6] as number);

    try {
      harness.board.runUntil(1_000_000_000);
      expect(harness.faults).toEqual([]);
      // 结算把 TF0 置起；同一条 ANL 随即停表，后续推进不会再把标志补上。
      expect(harness.port(2)).toBe(0x20);
      expectSettledBefore(probe, 'ANL TCON');
    } finally {
      harness.dispose();
    }
  });

  it('停表值精确等于一次性时间账：结算没有重复推进或重复计时', async () => {
    const { image, at } = assemble(
      PUSH_PULL_P2,
      mov(AUXR, 0x81), // T0 1T
      mov(TMOD, 0x01), // 16 位不重装
      mov(TH0, 0x00),
      mov(TL0, 0x00),
      setb(TR0),
      movR7(10),
      djnzR7,
      [0xc2, TR0], // CLR TR0：写前结算
      movADirect(TL0),
      movDirectA(P2),
      sjmpSelf,
    );
    const elapsed = cyclesBetween(image, at[5] as number, at[8] as number);
    const harness = await createSourceHarness({
      firmware: image,
      clockFrequency: 1_000_000,
      observe: P2_PINS,
    });
    const probe = probeSettle(harness, at[8] as number);

    try {
      harness.board.runUntil(1_000_000_000);
      expect(harness.faults).toEqual([]);
      expect(harness.port(2)).toBe(elapsed & 0xff);
      expectSettledBefore(probe, 'CLR TR0');
    } finally {
      harness.dispose();
    }
  });

  it('前置结算不提前派发中断：ISR 在定时指令之后的下一个节拍才运行', async () => {
    const image = new Uint8Array(0x100);

    image.set([0x02, 0x00, 0x30], 0x00); // LJMP main
    image.set([0x02, 0x00, 0x60], 0x0b); // T0 向量 → ISR

    const main = assemble(
      PUSH_PULL_P2,
      PUSH_PULL_P1,
      mov(AUXR, 0x81), // T0 1T
      mov(TMOD, 0x01), // 16 位不重装
      mov(TH0, 0xff),
      mov(TL0, 0xfc), // 4 个周期后溢出
      setb(TR0),
      movR7(10),
      djnzR7,
      setb(ET0),
      nop, // 让 SETB EA 落在非节拍点
      setb(EA),
      movADirect(TCON), // timed read：此前已有待推进时间，进入共享结算块
      movADirect(0x20), // ISR 标记：若结算提前派发，这里会读到 1
      movDirectA(P2),
      sjmpSelf,
    );
    const tconPc = 0x30 + (main.at[12] as number);

    image.set(main.image, 0x30);
    image.set([0x75, P1, 0x5a, 0xd2, 0x00, 0x32], 0x60); // ISR：P1=5AH，置 20H.0，RETI

    const harness = await createSourceHarness({
      firmware: image,
      clockFrequency: 1_000_000,
      observe: [...P2_PINS, ...P1_PINS],
    });
    const probe = probeSettle(harness, tconPc);

    try {
      harness.board.runUntil(1_000_000_000);
      expect(harness.faults).toEqual([]);
      // 结算只推进外设，不派中断：标记仍为 0。
      expect(harness.port(2)).toBe(0);
      // 下一个节拍（SJMP $ 回跳）正常响应，ISR 确实运行过。
      expect(harness.port(1)).toBe(0x5a);
      // 正向探针：TCON 读本身确实先跳到共享结算，而不是依赖此前已服务的 TF0。
      expectSettledBefore(probe, 'MOV A,TCON');
    } finally {
      harness.dispose();
    }
  });
});
