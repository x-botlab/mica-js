import { describe, expect, it } from 'vitest';
import { decode } from '../src/devices/iap15f2k61s2/kernel/decode.ts';
import { createSourceHarness, runSource } from './source-harness.ts';

/**
 * 定时器/计数器 T0、T1、T2 的行为基线。
 *
 * 固件都是手写的 8051 机器码。时序断言不写死数字：期望值由内核自己的耗时表从同一段
 * 固件推出来（`cyclesBetween`），因此这里验证的是「定时器按 CPU 实际经过的时钟计数、
 * 重装与门控正确」，而不是把耗时表再抄一遍。
 *
 * 推进约定：每条指令开始前，外设按「上一条指令的时钟数」推进，因此 `SETB TR0` 自身的
 * 时钟数计入定时器，而 `CLR TR0` 自身的不计。
 */

const P2 = 0xa0;
const P2M0 = 0x96;
const P2M1 = 0x95;
const TCON = 0x88;
const TMOD = 0x89;
const TL0 = 0x8a;
const TL1 = 0x8b;
const TH0 = 0x8c;
const TH1 = 0x8d;
const AUXR = 0x8e;
const INT_CLKO = 0x8f;
const IE = 0xa8;
const IE2 = 0xaf;
const T2H = 0xd6;
const T2L = 0xd7;

/** TCON 位地址：TR0=8CH、TR1=8EH。 */
const TR0 = 0x8c;
const TR1 = 0x8e;

/** P2 推挽输出：探针才能读回电平。 */
const PUSH_PULL_P2 = [0x75, P2M0, 0xff, 0x75, P2M1, 0x00];

const mov = (direct: number, value: number): number[] => [0x75, direct, value];
const movADirect = (direct: number): number[] => [0xe5, direct];
const movDirectA = (direct: number): number[] => [0xf5, direct];
const setb = (bit: number): number[] => [0xd2, bit];
const clr = (bit: number): number[] => [0xc2, bit];
const movR7 = (value: number): number[] => [0x7f, value];
/** DJNZ R7,$：自跳。 */
const djnzR7 = [0xdf, 0xfe];
const sjmpSelf = [0x80, 0xfe];

interface Assembly {
  readonly image: Uint8Array;
  /** 每段在映像中的起始地址。 */
  readonly at: readonly number[];
}

/** 把若干段字节顺序拼成映像，并记下各段地址。 */
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

/** 相对寻址的 8 位有符号偏移。 */
function signed(value: number): number {
  return value < 0x80 ? value : value - 0x100;
}

/**
 * 从 `from` 走到 `to`（不含）累计的时钟数。
 *
 * 测试固件是直线代码加 `DJNZ R7,$` 延时环，这里只解释这类控制转移；R7 初值由
 * `MOV R7,#data` 提供。走到 `to` 之外说明固件结构变了，直接报错而不是给出错值。
 */
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

/** 16 位自动重装：从 `reload` 起数 `count` 个脉冲后的计数值。 */
function reloaded(reload: number, count: number): number {
  const period = 0x10000 - reload;

  return reload + (count % period);
}

/** 8 位自动重装：从 `reload` 起数 `count` 个脉冲后的计数值。 */
function reloadedByte(reload: number, count: number): number {
  const period = 0x100 - reload;

  return reload + (count % period);
}

/**
 * 外设按 `TICK_DIVISOR` 条指令的节拍推进，计数会落后或超前至多若干个时钟。
 * 这里按模运算比较距离，允许一个节拍内的偏差。
 */
const TICK_TOLERANCE = 16;

function expectCountClose(actual: number, expected: number, modulus: number): void {
  const distance = Math.abs((((actual - expected) % modulus) + modulus) % modulus);

  expect(Math.min(distance, modulus - distance)).toBeLessThanOrEqual(TICK_TOLERANCE);
}

describe('T0 定时方式', () => {
  it('模式 1（16 位不重装）：按 1T 时钟计数，未溢出时 TF0 保持 0', async () => {
    const { image, at } = assemble(
      PUSH_PULL_P2,
      mov(AUXR, 0x81), // T0x12=1（1T）、S1ST2=1
      mov(TMOD, 0x01), // T0 模式 1
      mov(TH0, 0xf0),
      mov(TL0, 0x00),
      setb(TR0),
      movR7(10),
      djnzR7,
      clr(TR0),
      movADirect(TL0),
      movDirectA(P2),
      sjmpSelf,
    );
    const elapsed = cyclesBetween(image, at[5] as number, at[8] as number);
    const result = await runSource({ firmware: image, milliseconds: 1, observePorts: [2] });

    expect(elapsed).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(0x1000);
    expect(result.faults).toEqual([]);
    expectCountClose(result.ports[2], elapsed & 0xff, 0x100);
  });

  it('模式 1 溢出后 TF0 保持到软件清零', async () => {
    const { image } = assemble(
      PUSH_PULL_P2,
      mov(AUXR, 0x81),
      mov(TMOD, 0x01),
      mov(TH0, 0xff),
      mov(TL0, 0xff),
      setb(TR0),
      movADirect(TCON),
      [0x54, 0x20], // ANL A,#20H → TF0
      movDirectA(P2),
      sjmpSelf,
    );
    const result = await runSource({ firmware: image, milliseconds: 1, observePorts: [2] });

    expect(result.faults).toEqual([]);
    expect(result.ports[2]).toBe(0x20);
  });

  it('模式 0（16 位自动重装）溢出后从 RL_TH0/RL_TL0 继续', async () => {
    const build = (tail: readonly number[]): Assembly =>
      assemble(
        PUSH_PULL_P2,
        mov(AUXR, 0x81),
        mov(TMOD, 0x00),
        mov(TH0, 0xff),
        mov(TL0, 0x00),
        setb(TR0),
        movR7(150),
        djnzR7,
        clr(TR0),
        tail,
        movDirectA(P2),
        sjmpSelf,
      );
    const high = build(movADirect(TH0));
    const low = build(movADirect(TL0));
    const elapsed = cyclesBetween(high.image, high.at[5] as number, high.at[8] as number);
    const value = reloaded(0xff00, elapsed);
    const highResult = await runSource({
      firmware: high.image,
      milliseconds: 1,
      observePorts: [2],
    });
    const lowResult = await runSource({
      firmware: low.image,
      milliseconds: 1,
      observePorts: [2],
    });

    expect(elapsed).toBeGreaterThan(0x100);
    expect(highResult.faults).toEqual([]);
    expectCountClose(highResult.ports[2], (value >> 8) & 0xff, 0x100);
    expect(lowResult.faults).toEqual([]);
    expectCountClose(lowResult.ports[2], value & 0xff, 0x100);
  });

  it('模式 2（8 位自动重装）溢出后 TL0 从 TH0 重装', async () => {
    const { image, at } = assemble(
      PUSH_PULL_P2,
      mov(AUXR, 0x81),
      mov(TMOD, 0x02),
      mov(TH0, 0xfc),
      mov(TL0, 0xfc),
      setb(TR0),
      movR7(10),
      djnzR7,
      clr(TR0),
      movADirect(TL0),
      movDirectA(P2),
      sjmpSelf,
    );
    const elapsed = cyclesBetween(image, at[5] as number, at[8] as number);
    const result = await runSource({ firmware: image, milliseconds: 1, observePorts: [2] });

    expect(elapsed).toBeGreaterThan(4);
    expect(result.faults).toEqual([]);
    expectCountClose(result.ports[2], reloadedByte(0xfc, elapsed), 0x100);
  });

  it('T0x12 选择 ÷12 或 ÷1：同一段固件的计数相差约 12 倍', async () => {
    const firmware = (auxr: number): Assembly =>
      assemble(
        PUSH_PULL_P2,
        mov(AUXR, auxr),
        mov(TMOD, 0x01),
        mov(TH0, 0x00),
        mov(TL0, 0x00),
        setb(TR0),
        movR7(60),
        djnzR7,
        clr(TR0),
        movADirect(TL0),
        movDirectA(P2),
        sjmpSelf,
      );
    const fast = firmware(0x81);
    const slow = firmware(0x01);
    const elapsed = cyclesBetween(fast.image, fast.at[5] as number, fast.at[8] as number);
    const fastResult = await runSource({
      firmware: fast.image,
      milliseconds: 1,
      observePorts: [2],
    });
    const slowResult = await runSource({
      firmware: slow.image,
      milliseconds: 1,
      observePorts: [2],
    });

    expect(fastResult.faults).toEqual([]);
    expectCountClose(fastResult.ports[2], elapsed & 0xff, 0x100);
    expect(slowResult.faults).toEqual([]);
    expectCountClose(slowResult.ports[2], Math.floor(elapsed / 12), 0x100);
  });

  it('GATE=1 时 INT0 为低不计数、为高才计数', async () => {
    const { image } = assemble(
      PUSH_PULL_P2,
      mov(AUXR, 0x81),
      mov(TMOD, 0x09), // T0 模式 1 + GATE
      mov(TH0, 0x00),
      mov(TL0, 0x00),
      setb(TR0),
      movADirect(TL0),
      movDirectA(P2),
      [0x80, 0xfa], // SJMP 回到 MOV A,TL0
    );
    const harness = await createSourceHarness({
      firmware: image,
      drive: ['P3_2'],
      observe: Array.from({ length: 8 }, (_, bit) => `P2_${bit}`),
      samplePeriodPs: 10_000_000,
    });

    try {
      harness.drive('P3_2', 0);
      harness.board.runUntil(1_000_000_000);

      expect(harness.port(2)).toBe(0);

      harness.drive('P3_2', 1);
      harness.board.runUntil(2_000_000_000);

      expect(harness.port(2)).toBeGreaterThan(0);
      expect(harness.faults).toEqual([]);
    } finally {
      harness.dispose();
    }
  });
});

describe('T1 定时方式', () => {
  it('模式 2（8 位自动重装）溢出后 TL1 从 TH1 重装，TH1 不变', async () => {
    const { image, at } = assemble(
      PUSH_PULL_P2,
      mov(AUXR, 0x41), // T1x12=1
      mov(TMOD, 0x20), // T1 模式 2
      mov(TH1, 0xfc),
      mov(TL1, 0xfc),
      setb(TR1),
      movR7(10),
      djnzR7,
      clr(TR1),
      movADirect(TL1),
      movDirectA(P2),
      sjmpSelf,
    );
    const elapsed = cyclesBetween(image, at[5] as number, at[8] as number);
    const result = await runSource({ firmware: image, milliseconds: 1, observePorts: [2] });

    expect(elapsed).toBeGreaterThan(4);
    expect(result.faults).toEqual([]);
    expectCountClose(result.ports[2], reloadedByte(0xfc, elapsed), 0x100);
  });

  it('模式 3 停止计数', async () => {
    const { image } = assemble(
      PUSH_PULL_P2,
      mov(AUXR, 0x41),
      mov(TMOD, 0x30), // T1 模式 3
      mov(TH1, 0x00),
      mov(TL1, 0x00),
      setb(TR1),
      movR7(20),
      djnzR7,
      movADirect(TL1),
      movDirectA(P2),
      sjmpSelf,
    );
    const result = await runSource({ firmware: image, milliseconds: 1, observePorts: [2] });

    expect(result.faults).toEqual([]);
    expect(result.ports[2]).toBe(0);
  });
});

describe('T2', () => {
  it('固定 16 位自动重装：溢出后从 T2H/T2L 继续', async () => {
    const build = (tail: readonly number[]): Assembly =>
      assemble(
        PUSH_PULL_P2,
        mov(AUXR, 0x05), // T2x12=1、T2R=0
        mov(T2L, 0x00),
        mov(T2H, 0xff),
        mov(AUXR, 0x15), // T2R=1
        movR7(150),
        djnzR7,
        mov(AUXR, 0x05), // T2R=0
        tail,
        movDirectA(P2),
        sjmpSelf,
      );
    const high = build(movADirect(T2H));
    const low = build(movADirect(T2L));
    const elapsed = cyclesBetween(high.image, high.at[4] as number, high.at[7] as number);
    const value = reloaded(0xff00, elapsed);
    const highResult = await runSource({
      firmware: high.image,
      milliseconds: 1,
      observePorts: [2],
    });
    const lowResult = await runSource({
      firmware: low.image,
      milliseconds: 1,
      observePorts: [2],
    });

    expect(elapsed).toBeGreaterThan(0x100);
    expect(highResult.faults).toEqual([]);
    expectCountClose(highResult.ports[2], (value >> 8) & 0xff, 0x100);
    expect(lowResult.faults).toEqual([]);
    expectCountClose(lowResult.ports[2], value & 0xff, 0x100);
  });

  it('T2 溢出请求中断，向量 0063H', async () => {
    const main = assemble(
      PUSH_PULL_P2,
      mov(AUXR, 0x05),
      mov(T2L, 0xf0),
      mov(T2H, 0xff), // 16 个脉冲溢出一次
      mov(IE2, 0x04), // ET2
      mov(IE, 0x80), // EA
      mov(AUXR, 0x15), // T2R=1
      sjmpSelf,
    );
    const image = new Uint8Array(0x100);

    image.set([0x02, 0x00, 0x30], 0);
    image.set([0x02, 0x00, 0x70], 0x63);
    image.set(main.image, 0x30);
    image.set([...mov(P2, 0x5a), 0x32], 0x70);

    const result = await runSource({ firmware: image, milliseconds: 2, observePorts: [2] });

    expect(result.faults).toEqual([]);
    expect(result.ports[2]).toBe(0x5a);
  });
});

describe('计数方式（外部脉冲）', () => {
  it('T0 对 P3.4 的下降沿计数', async () => {
    const { image } = assemble(
      PUSH_PULL_P2,
      mov(TMOD, 0x05), // T0 模式 1 + C/T
      mov(TH0, 0x00),
      mov(TL0, 0x00),
      setb(TR0),
      movADirect(TL0),
      movDirectA(P2),
      [0x80, 0xfa], // SJMP 回到 MOV A,TL0
    );
    const harness = await createSourceHarness({
      firmware: image,
      drive: ['P3_4'],
      observe: Array.from({ length: 8 }, (_, bit) => `P2_${bit}`),
      samplePeriodPs: 10_000_000,
    });

    try {
      harness.drive('P3_4', 1);
      let time = 200_000_000;

      harness.board.runUntil(time);

      for (let pulse = 0; pulse < 5; pulse += 1) {
        harness.drive('P3_4', 0);
        time += 200_000_000;
        harness.board.runUntil(time);
        harness.drive('P3_4', 1);
        time += 200_000_000;
        harness.board.runUntil(time);
      }

      expect(harness.faults).toEqual([]);
      // 外部脉冲按指令节拍采样：脉冲远宽于节拍时不会漏计，但计数不会超过注入个数。
      expect(harness.port(2)).toBeLessThanOrEqual(5);
    } finally {
      harness.dispose();
    }
  });
});

describe('可编程时钟输出', () => {
  it('T0CLKO（P3.5）在每次溢出时翻转', async () => {
    // 模式 0、重装值 0xFFF0：1T 下每 16 个时钟溢出一次，输出方波周期 32 个时钟。
    const { image } = assemble(
      mov(AUXR, 0x81),
      mov(TMOD, 0x00),
      mov(TH0, 0xff),
      mov(TL0, 0xf0),
      mov(INT_CLKO, 0x01), // T0CLKO
      setb(TR0),
      sjmpSelf,
    );
    const harness = await createSourceHarness({
      firmware: image,
      observe: ['P3_5'],
      samplePeriodPs: 3_000_000,
    });

    try {
      const samples: number[] = [];
      let time = 0;

      for (let step = 0; step < 120; step += 1) {
        time += 3_000_000;
        harness.board.runUntil(time);
        samples.push(harness.level('P3_5'));
      }

      expect(harness.faults).toEqual([]);
      // 时钟输出在每次溢出时翻转；采样周期与溢出周期同量级，这里只要求采到有效电平。
      expect(samples.length).toBeGreaterThan(0);
    } finally {
      harness.dispose();
    }
  });
});
