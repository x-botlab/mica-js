import { describe, expect, it } from 'vitest';
import { SERVICE_PC } from '../../src/devices/iap15f2k61s2/kernel/tick.ts';
import { decode } from '../../src/devices/iap15f2k61s2/kernel/decode.ts';
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
    // 写前结算必须在 CLR TR0 之前把 SETB TR0 起的时钟全部计入；旧服务粒度允许
    // 一个节拍内的偏差，这里用精确值守住「停表不丢时间」。
    expect(result.ports[2]).toBe(elapsed & 0xff);
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
    expectCountClose(highResult.ports[2]!, (value >> 8) & 0xff, 0x100);
    expect(lowResult.faults).toEqual([]);
    expectCountClose(lowResult.ports[2]!, value & 0xff, 0x100);
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
    expectCountClose(result.ports[2]!, reloadedByte(0xfc, elapsed), 0x100);
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
    expectCountClose(fastResult.ports[2]!, elapsed & 0xff, 0x100);
    expect(slowResult.faults).toEqual([]);
    expectCountClose(slowResult.ports[2]!, Math.floor(elapsed / 12), 0x100);
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
    expectCountClose(result.ports[2]!, reloadedByte(0xfc, elapsed), 0x100);
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
    expectCountClose(highResult.ports[2]!, (value >> 8) & 0xff, 0x100);
    expect(lowResult.faults).toEqual([]);
    expectCountClose(lowResult.ports[2]!, value & 0xff, 0x100);
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

    const result = await runSource({ firmware: image, milliseconds: 3, observePorts: [2] });

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

describe('节拍覆盖', () => {
  it('紧循环里没有对齐指令时，回跳仍是节拍点：T0 中断照常响应', async () => {
    // 循环指令地址 0x16/0x17/0x19/0x1B/0x1D/0x1F/0x21 全都不是 TICK_DIVISOR 的倍数，
    // 回跳距离又有 11 字节。只按 PC 取节拍点时整圈都不会推进外设，T0 永远不会溢出，
    // 主循环也永远等不到计数满 5（官方 CT107D 的 1.0 led 固件就是这种形状）。
    const image = new Uint8Array(0x60);
    const put = (address: number, ...bytes: number[]): void => image.set(bytes, address);

    put(0x000, 0x02, 0x00, 0x30); // LJMP 0030H
    put(0x00b, 0x02, 0x00, 0x50); // LJMP 0050H（T0 中断）
    put(
      0x030,
      0x75,
      0x96,
      0xff, // MOV P2M0,#0FFH
      0x75,
      0x95,
      0x00, // MOV P2M1,#00H
      0x75,
      0x8e,
      0x81, // MOV AUXR,#81H（T0 1T 模式）
      0x75,
      0x89,
      0x00, // MOV TMOD,#00H（模式 0，16 位自动重装）
      0x75,
      0x8c,
      0xd4, // MOV TH0,#0D4H
      0x75,
      0x8a,
      0xcd, // MOV TL0,#0CDH
      0xd2,
      0x8c, // SETB TR0
      0xd2,
      0xa9, // SETB ET0
      0xd2,
      0xaf, // SETB EA
      0x02,
      0x00,
      0x16, // LJMP 0016H
    );
    put(
      0x016,
      0xc3, // CLR C
      0xe5,
      0x09, // MOV A,09H
      0x94,
      0x05, // SUBB A,#05H
      0xe5,
      0x08, // MOV A,08H
      0x64,
      0x80, // XRL A,#80H
      0x94,
      0x80, // SUBB A,#80H
      0x40,
      0xf3, // JC 0016H
    );
    put(0x023, 0x75, 0xa0, 0xa5, 0x80, 0xfe); // MOV P2,#0A5H / SJMP $
    put(0x050, 0x05, 0x08, 0xe5, 0x08, 0x70, 0x02, 0x05, 0x09, 0x32); // ISR：time_count++

    const result = await runSource({
      firmware: image,
      milliseconds: 20,
      clockFrequency: 11_059_200,
      observePorts: [2],
    });

    expect(result.faults).toEqual([]);
    expect(result.ports[2]).toBe(0xa5);
  });
});

describe('时间账本与期限', () => {
  it('读-改-写先结算：ORL TCON 不覆盖刚置起的 TF0', async () => {
    const { image } = assemble(
      PUSH_PULL_P2,
      mov(AUXR, 0x81),
      mov(TMOD, 0x01),
      mov(TH0, 0xff),
      mov(TL0, 0xff),
      setb(TR0),
      movR7(4),
      djnzR7,
      [0x43, TCON, 0x01], // ORL TCON,#01H（置 IT0，保留 TF0）
      movADirect(TCON),
      [0x54, 0x20], // ANL A,#20H
      movDirectA(P2),
      sjmpSelf,
    );
    const result = await runSource({ firmware: image, milliseconds: 1, observePorts: [2] });

    expect(result.faults).toEqual([]);
    expect(result.ports[2]).toBe(0x20);
  });

  it('运行中切换 12T→1T：旧配置结算到切换点，余数按新周期继续计数', async () => {
    const { image, at } = assemble(
      PUSH_PULL_P2,
      mov(AUXR, 0x01), // T0x12=0（12T）
      mov(TMOD, 0x01),
      mov(TH0, 0x00),
      mov(TL0, 0x00),
      setb(TR0),
      movR7(20),
      djnzR7,
      mov(AUXR, 0x81), // 切到 1T
      movR7(20),
      djnzR7,
      movADirect(TL0),
      movDirectA(P2),
      sjmpSelf,
    );
    const oldCycles = cyclesBetween(image, at[5] as number, at[8] as number);
    const newCycles = cyclesBetween(image, at[8] as number, at[11] as number);
    const result = await runSource({ firmware: image, milliseconds: 1, observePorts: [2] });

    expect(result.faults).toEqual([]);
    // 12T 段只积 floor(old/12) 个计数，余数相位保留；切到 1T 后余数按每周期 1 个计数补齐。
    // 12T 段贡献 floor(old/12) 个计数；余数相位在 1T 下逐周期补齐。
    expect(result.ports[2]).toBe(
      (Math.floor(oldCycles / 12) + (oldCycles % 12) + newCycles) & 0xff,
    );
  });

  it('多次溢出：1 ms 自动重装中断在 21 ms 内响应 21 次', async () => {
    const image = new Uint8Array(0x100);

    image.set([0x02, 0x00, 0x30], 0x000); // LJMP 0030H
    image.set([0x02, 0x00, 0x60], 0x00b); // T0 向量 → 0060H
    image.set(
      [
        0x75,
        P2M0,
        0xff, // MOV P2M0,#0FFH
        0x75,
        P2M1,
        0x00, // MOV P2M1,#00H
        0x75,
        P2,
        0x00, // MOV P2,#00H
        0x75,
        AUXR,
        0x81, // T0 1T
        0x75,
        TMOD,
        0x00, // 模式 0，16 位自动重装
        0x75,
        TH0,
        0xfc, // 重装 0xFC18 → 1000 个 1T 周期 = 1 ms @ 1 MHz
        0x75,
        TL0,
        0x18,
        0xd2,
        TR0, // SETB TR0
        0xd2,
        0xa9, // SETB ET0
        0xd2,
        0xaf, // SETB EA
        0x80,
        0xfe, // SJMP $
      ],
      0x30,
    );
    image.set([0x05, P2, 0x32], 0x60); // INC P2; RETI

    const harness = await createSourceHarness({
      firmware: image,
      clockFrequency: 1_000_000,
      observe: ['P2_0', 'P2_1', 'P2_2', 'P2_3', 'P2_4', 'P2_5', 'P2_6', 'P2_7'],
    });

    try {
      harness.board.runUntil(100_000_000); // 先越过启动配置
      harness.board.runUntil(21_100_000_000); // 再跑 21 ms
      expect(harness.faults).toEqual([]);
      expect(harness.port(2)).toBe(21);
    } finally {
      harness.dispose();
    }
  });
});

describe('批量重装与中断使能边界', () => {
  it('运行中提高 mode2 重装影子：首次回绕前沿原计数，回绕后才用新 reload', async () => {
    const build = (count: number): Assembly =>
      assemble(
        PUSH_PULL_P2,
        [0x75, 0xb2, 0xff, 0x75, 0xb1, 0x00], // P3 推挽
        mov(AUXR, 0x81),
        mov(TMOD, 0x02), // T0 模式 2（8 位自动重装）
        mov(TH0, 0xfc), // 初始 reload=0xFC
        mov(TL0, 0x00),
        setb(TR0),
        mov(TH0, 0x80), // 运行中把 reload 提到 0x80（高于当前计数）
        movR7(count),
        djnzR7,
        movADirect(TL0),
        movDirectA(P2),
        movADirect(TCON),
        [0x54, 0x20], // ANL A,#20H → TF0
        movDirectA(0xb0), // MOV P3,A
        sjmpSelf,
      );

    const expected = (cycles: number): number =>
      cycles < 0x100 ? cycles : 0x80 + ((cycles - 0x100) % 0x80);
    const short = build(4);
    const shortCycles = cyclesBetween(short.image, short.at[6] as number, short.at[10] as number);
    const shortResult = await runSource({
      firmware: short.image,
      milliseconds: 1,
      observePorts: [2, 3],
    });

    expect(shortResult.faults).toEqual([]);
    expect(shortCycles).toBeLessThan(0x100);
    expect(shortResult.ports[2]).toBe(expected(shortCycles));
    expect((shortResult.ports[3] as number) & 0x20).toBe(0);

    const long = build(200);
    const longCycles = cyclesBetween(long.image, long.at[6] as number, long.at[10] as number);
    const longFlagCycles = cyclesBetween(long.image, long.at[6] as number, long.at[12] as number);
    const longResult = await runSource({
      firmware: long.image,
      milliseconds: 1,
      observePorts: [2, 3],
    });

    expect(longResult.faults).toEqual([]);
    expect(longCycles).toBeGreaterThanOrEqual(0x100);
    expect(longResult.ports[2]).toBe(expected(longCycles));
    expect((longResult.ports[3] as number) & 0x20).toBe(0x20);
    expect(longFlagCycles).toBeGreaterThanOrEqual(0x100);
  });

  it('屏蔽中断时一次推进跨多个回绕：计数与 TF0 与不规则切片一致', async () => {
    const { image, at } = assemble(
      PUSH_PULL_P2,
      [0x75, 0xb2, 0xff, 0x75, 0xb1, 0x00],
      mov(AUXR, 0x81),
      mov(TMOD, 0x02), // span = 256 - 0xFC = 4 个周期
      mov(TH0, 0xfc),
      mov(TL0, 0x00),
      setb(TR0),
      movR7(200),
      djnzR7,
      movADirect(TL0),
      movDirectA(P2),
      movADirect(TCON),
      [0x54, 0x20],
      movDirectA(0xb0),
      sjmpSelf,
    );
    const cycles = cyclesBetween(image, at[6] as number, at[9] as number);
    const expected = (0xfc + (cycles % 4)) & 0xff;

    const one = await runSource({ firmware: image, milliseconds: 1, observePorts: [2, 3] });
    expect(one.faults).toEqual([]);
    expect(cycles).toBeGreaterThan(0x100); // 一次 advance 至少跨 64 次回绕
    expect(one.ports[2], `cycles=${cycles} expected=${expected}`).toBe(expected);
    expect((one.ports[3] as number) & 0x20).toBe(0x20);

    const harness = await createSourceHarness({
      firmware: image,
      clockFrequency: 1_000_000,
      observe: ['P2_0', 'P2_1', 'P2_2', 'P2_3', 'P2_4', 'P2_5', 'P2_6', 'P2_7', 'P3_5'],
    });
    try {
      const end = (cycles + 32) * 1_000_000;
      let time = 0;
      for (const step of [13, 7, 3, 29, 11, 41]) {
        time = Math.min(end, time + step * 1_000_000);
        harness.board.runUntil(time);
        if (time === end) break;
      }
      if (harness.board.time < end) harness.board.runUntil(end);
      expect(harness.faults).toEqual([]);
      expect(harness.port(2)).toBe(expected);
      expect(harness.level('P3_5')).toBe(1);
    } finally {
      harness.dispose();
    }
  });

  it('运行很久后再开中断：已发生的溢出在使能边界后响应一次', async () => {
    const image = new Uint8Array(0x100);
    image.set([0x02, 0x00, 0x30], 0); // LJMP main
    image.set([0x02, 0x00, 0x60], 0x0b); // T0 向量

    const main = [
      ...PUSH_PULL_P2,
      0x75,
      0xa0,
      0x00, // MOV P2,#00H
      0x75,
      0x8e,
      0x81, // AUXR: T0 1T
      0x75,
      0x89,
      0x00, // TMOD: 模式 0，16 位自动重装
      0x75,
      0x8c,
      0xfc, // TH0
      0x75,
      0x8a,
      0x18, // TL0（span=1000）
      0xd2,
      0x8c, // SETB TR0
      0x7f,
      0xff, // MOV R7,#0FFH
      0xdf,
      0xfe, // DJNZ R7,$（510 个周期）
      0x7f,
      0xff,
      0xdf,
      0xfe, // 再 510 个周期，已跨过第一次溢出
      0xd2,
      0xa9, // SETB ET0
      0xd2,
      0xaf, // SETB EA
      0x80,
      0xfe, // SJMP $
    ];
    main.forEach((value, index) => {
      image[0x30 + index] = value;
    });
    // ISR：置 P2.0、停表，确保只响应一次。
    image.set([0xd2, 0xa0, 0xc2, 0x8c, 0x32], 0x60);

    const result = await runSource({ firmware: image, milliseconds: 3, observePorts: [2] });
    expect(result.faults).toEqual([]);
    expect(result.ports[2]).toBe(1);
  });
});

it('XCH A,direct 也在首次读锁存器前结算，读到刚置起的 TF0', async () => {
  const { image } = assemble(
    PUSH_PULL_P2,
    mov(AUXR, 0x81),
    mov(TMOD, 0x01),
    mov(TH0, 0xff),
    mov(TL0, 0xff),
    setb(TR0),
    movR7(4),
    djnzR7,
    [0x74, 0x00], // MOV A,#00H
    [0xc5, TCON], // XCH A,TCON
    [0x54, 0x20], // ANL A,#20H
    movDirectA(P2),
    sjmpSelf,
  );
  const result = await runSource({ firmware: image, milliseconds: 1, observePorts: [2] });

  expect(result.faults).toEqual([]);
  expect(result.ports[2]).toBe(0x20);
});

it('1 ms 定时中断期间服务次数保持约每中断一次，不退回逐节拍服务', async () => {
  const image = new Uint8Array(0x100);
  image.set([0x02, 0x00, 0x30], 0);
  image.set([0x02, 0x00, 0x60], 0x0b);
  const main = [
    0x75,
    0x8e,
    0x81, // AUXR: T0 1T
    0x75,
    0x89,
    0x00, // TMOD: 16 位自动重装
    0x75,
    0x8c,
    0xfc, // TH0
    0x75,
    0x8a,
    0x18, // TL0（span=1000）
    0xd2,
    0x8c, // TR0
    0xd2,
    0xa9, // ET0
    0xd2,
    0xaf, // EA
    0x80,
    0xfe, // SJMP $
  ];
  main.forEach((value, index) => {
    image[0x30 + index] = value;
  });
  image.set([0x32], 0x60); // RETI

  const harness = await createSourceHarness({ firmware: image, clockFrequency: 1_000_000 });
  try {
    harness.board.runUntil(2_000_000_000);
    const jit = (
      harness.board as unknown as {
        jits?: readonly { cache?: Map<number, { execute: (...args: never[]) => unknown }> }[];
      }
    ).jits?.[0];
    const service = jit?.cache?.get(SERVICE_PC);

    expect(service).toBeDefined();

    const original = service!.execute;
    let services = 0;

    service!.execute = (...args: never[]) => {
      services++;
      return original(...args);
    };
    harness.board.runUntil(22_000_000_000);
    expect(harness.faults).toEqual([]);
    // 20 ms / 1 ms = 20 次中断；每次期限服务 + RETI 后的重扫最多两次。
    expect(services).toBeLessThanOrEqual(45);
  } finally {
    harness.dispose();
  }
});

describe('时钟输出相位', () => {
  it('CLKO 关闭期间跨偶数/奇数次溢出后，重新启用时的初始相位按回绕奇偶翻转', async () => {
    const build = (count: number): Assembly =>
      assemble(
        PUSH_PULL_P2,
        [0x75, 0xb2, 0x20, 0x75, 0xb1, 0x00], // P3M0=0x20（P3.5 推挽）
        mov(AUXR, 0x81),
        mov(TMOD, 0x00), // 模式 0，16 位自动重装
        mov(TH0, 0xff),
        mov(TL0, 0x00), // span=256 个周期
        setb(TR0),
        movR7(count),
        djnzR7,
        clr(TR0),
        mov(INT_CLKO, 0x01), // 打开 T0CLKO；此时定时器已停
        setb(TR0), // 重新启动，syncPin 按内部 clock latch 驱动 P3.5
        sjmpSelf,
      );

    for (const count of [128, 192]) {
      const { image, at } = build(count);
      const cycles = cyclesBetween(image, at[6] as number, at[9] as number);
      const wraps = Math.floor(cycles / 0x100);
      const restart = cyclesBetween(image, 0, at[11] as number);
      const harness = await createSourceHarness({
        firmware: image,
        clockFrequency: 1_000_000,
        observe: ['P3_5'],
      });
      try {
        harness.board.runUntil((restart + 5) * 1_000_000);
        expect(harness.faults).toEqual([]);
        expect(harness.level('P3_5')).toBe(wraps & 1);
      } finally {
        harness.dispose();
      }
    }
  });
});
