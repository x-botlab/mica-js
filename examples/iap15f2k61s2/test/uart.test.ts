import { describe, expect, it } from 'vitest';
import { createSourceHarness } from './source-harness.ts';
import type { SourceHarness } from './source-harness.ts';

/**
 * 串口 1/2 的行为测试（源码级夹具，不需要 `mica build`）。
 *
 * 时序单位都是皮秒。默认 1 MHz 时钟下一个系统时钟周期是 1 µs；各用例把波特率分频设成
 * 几十个周期，因此位时间落在几十微秒，探针按 0.1 µs 采样足够分辨位中点。
 */

const HALT = [0x80, 0xfe]; // SJMP $
const PUSH_PULL_P2 = [0x75, 0x96, 0xff, 0x75, 0x95, 0x00]; // MOV P2M0,#0FFH ; MOV P2M1,#00H

const US_PER_PS = 1_000_000;

const P2_PINS = Array.from({ length: 8 }, (_, bit) => `P2_${bit}`);

interface Stepper {
  readonly harness: SourceHarness;
  /** 采样 P2 并返回字节。 */
  port2(): number;
  /** 按 `stepPs` 推进到 `untilPs`。 */
  runTo(untilPs: number, stepPs?: number): void;
  /** 逐步推进，返回 `pin` 第一次读到 `level` 的时刻（没有出现时返回 -1）。 */
  waitFor(pin: string, level: 0 | 1, untilPs: number, stepPs?: number): number;
  dispose(): void;
}

function stepper(harness: SourceHarness): Stepper {
  return {
    harness,
    port2: () => harness.port(2),
    runTo(untilPs, stepPs = US_PER_PS) {
      while (harness.board.time < untilPs) {
        harness.board.runUntil(Math.min(untilPs, harness.board.time + stepPs));
      }
    },
    waitFor(pin, level, untilPs, stepPs = US_PER_PS) {
      while (harness.board.time < untilPs) {
        harness.board.runUntil(Math.min(untilPs, harness.board.time + stepPs));

        if (harness.level(pin) === level) return harness.board.time;
      }

      return -1;
    },
    dispose: () => harness.dispose(),
  };
}

/** 一帧异步串口的电平序列：起始位、8 数据位（低位先）、可选第 9 位、停止位。 */
function frameLevels(data: number, ninth?: number): (0 | 1)[] {
  const levels: (0 | 1)[] = [0];

  for (let bit = 0; bit < 8; bit += 1) levels.push(((data >> bit) & 1) as 0 | 1);

  if (ninth !== undefined) levels.push(ninth as 0 | 1);

  levels.push(1);

  return levels;
}

/** 从 `startPs` 起按位时间依次注入一帧。 */
function driveFrame(
  harness: SourceHarness,
  pin: string,
  levels: readonly (0 | 1)[],
  startPs: number,
  bitPs: number,
): number {
  levels.forEach((level, index) => {
    harness.drive(pin, level);
    harness.board.runUntil(startPs + (index + 1) * bitPs);
  });

  return startPs + levels.length * bitPs;
}

describe('串口 1', () => {
  it('模式 0：同步移位时钟在 TXD 上输出 8 个脉冲，发送完成置 TI', async () => {
    const harness = await createSourceHarness({
      firmware: Uint8Array.from([
        ...PUSH_PULL_P2,
        0x75,
        0x98,
        0x00, // MOV SCON,#00H  模式 0、REN=0
        0x75,
        0x99,
        0xa5, // MOV SBUF,#0A5H
        0x30,
        0x99,
        0xfd, // JNB TI,$
        0xe5,
        0x98, // MOV A,SCON
        0xf5,
        0xa0, // MOV P2,A
        ...HALT,
      ]),
      observe: ['P3_1', ...P2_PINS],
      samplePeriodPs: 200_000,
    });
    const board = stepper(harness);

    try {
      // 先等 TXD 被复用功能驱动到空闲高电平，再数移位时钟的跳变。
      expect(board.waitFor('P3_1', 1, 200 * US_PER_PS)).toBeGreaterThanOrEqual(0);

      let previous = harness.level('P3_1');
      let edges = 0;

      for (let step = 0; step < 120; step += 1) {
        board.runTo(harness.board.time + US_PER_PS);

        const current = harness.level('P3_1');

        if (current !== previous) {
          edges += 1;
          previous = current;
        }
      }

      // 8 个位 = 16 次半位跳变（末尾回到空闲高电平）。
      expect(edges).toBeGreaterThanOrEqual(14);
      expect(harness.faults).toEqual([]);
      expect(board.port2()).toBe(0x02); // SCON = TI（模式 0 的 SM0/SM1 为 0）
    } finally {
      board.dispose();
    }
  });

  it('模式 1：T2 作波特率发生器时按起始位 + 8 数据位 + 停止位输出', async () => {
    const harness = await createSourceHarness({
      firmware: Uint8Array.from([
        ...PUSH_PULL_P2,
        0x75,
        0x98,
        0x40, // MOV SCON,#40H  模式 1
        0x75,
        0x8e,
        0x05, // MOV AUXR,#05H  S1ST2=1（T2）、T2x12=1
        0x75,
        0xd7,
        0xf6, // MOV T2L,#0F6H  65536-10
        0x75,
        0xd6,
        0xff, // MOV T2H,#0FFH
        0x75,
        0x99,
        0x55, // MOV SBUF,#55H
        0x30,
        0x99,
        0xfd, // JNB TI,$
        0xe5,
        0x98, // MOV A,SCON
        0xf5,
        0xa0, // MOV P2,A
        ...HALT,
      ]),
      observe: ['P3_1', ...P2_PINS],
      samplePeriodPs: 200_000,
    });
    const board = stepper(harness);

    try {
      // 波特率 = SYSclk / (65536-[T2H,T2L]) / 4 → 位时间 4*10 个时钟 = 40 µs。
      const bitPs = 40 * US_PER_PS;

      expect(board.waitFor('P3_1', 1, 200 * US_PER_PS)).toBeGreaterThanOrEqual(0);

      const start = board.waitFor('P3_1', 0, 200 * US_PER_PS);

      expect(start).toBeGreaterThan(0);

      const levels = frameLevels(0x55);
      const sampled: number[] = [];

      for (let index = 0; index < levels.length; index += 1) {
        board.runTo(start + Math.floor((index + 0.5) * bitPs));
        sampled.push(harness.level('P3_1'));
      }

      expect(sampled).toEqual(levels);

      board.runTo(start + 30 * bitPs);
      expect(harness.faults).toEqual([]);
      expect(board.port2()).toBe(0x42); // SCON = SM1（模式 1）+ TI
    } finally {
      board.dispose();
    }
  });

  it('模式 1：按位中点采样注入的波形，装载 SBUF 并置 RI', async () => {
    const harness = await createSourceHarness({
      firmware: Uint8Array.from([
        ...PUSH_PULL_P2,
        0x75,
        0x98,
        0x50, // MOV SCON,#50H  模式 1、REN=1
        0x75,
        0x8e,
        0x05, // MOV AUXR,#05H
        0x75,
        0xd7,
        0xf6, // MOV T2L,#0F6H
        0x75,
        0xd6,
        0xff, // MOV T2H,#0FFH
        0x30,
        0x98,
        0xfd, // JNB RI,$
        0xe5,
        0x99, // MOV A,SBUF
        0xf5,
        0xa0, // MOV P2,A
        ...HALT,
      ]),
      observe: [...P2_PINS, 'P3_1'],
      drive: ['P3_0'],
      samplePeriodPs: 200_000,
    });
    const board = stepper(harness);

    try {
      harness.drive('P3_0', 1);
      board.runTo(20 * US_PER_PS);

      const bitPs = 40 * US_PER_PS;

      driveFrame(harness, 'P3_0', frameLevels(0x3c), 20 * US_PER_PS, bitPs);
      board.runTo(20 * US_PER_PS + 16 * bitPs);

      expect(harness.faults).toEqual([]);
      expect(board.port2()).toBe(0x3c);
    } finally {
      board.dispose();
    }
  });

  it('模式 3 + SM2：第 9 位为 0 的数据帧被丢弃，地址帧才置 RI', async () => {
    const harness = await createSourceHarness({
      firmware: Uint8Array.from([
        ...PUSH_PULL_P2,
        0x75,
        0x98,
        0xf0, // MOV SCON,#0F0H 模式 3、REN=1、SM2=1
        0x75,
        0x8e,
        0x05, // MOV AUXR,#05H
        0x75,
        0xd7,
        0xf6, // MOV T2L,#0F6H
        0x75,
        0xd6,
        0xff, // MOV T2H,#0FFH
        0x30,
        0x98,
        0xfd, // JNB RI,$
        0xe5,
        0x99, // MOV A,SBUF
        0xf5,
        0xa0, // MOV P2,A
        ...HALT,
      ]),
      observe: [...P2_PINS],
      drive: ['P3_0'],
      samplePeriodPs: 200_000,
    });
    const board = stepper(harness);

    try {
      harness.drive('P3_0', 1);
      board.runTo(20 * US_PER_PS);

      const bitPs = 40 * US_PER_PS;
      const start = 20 * US_PER_PS;

      // 第 9 位为 0：SM2=1 时是数据帧，应丢弃且不置 RI（P2 保持锁存初值）。
      driveFrame(harness, 'P3_0', frameLevels(0x11, 0), start, bitPs);
      board.runTo(start + 24 * bitPs);

      expect(board.port2()).toBe(0xff);

      // 第 9 位为 1：地址帧，装载 SBUF 并置 RI。
      const secondStart = start + 24 * bitPs;

      driveFrame(harness, 'P3_0', frameLevels(0x22, 1), secondStart, bitPs);
      board.runTo(secondStart + 16 * bitPs);

      expect(harness.faults).toEqual([]);
      expect(board.port2()).toBe(0x22);
    } finally {
      board.dispose();
    }
  });

  it('定时器 1 模式 2 给出位时间：SMOD=1 时位宽随系统时钟成比例', async () => {
    const firmware = Uint8Array.from([
      0x75,
      0x98,
      0x40, // MOV SCON,#40H
      0x75,
      0x89,
      0x20, // MOV TMOD,#20H  定时器 1 模式 2
      0x75,
      0x8d,
      0xf6, // MOV TH1,#0F6H   256-10
      0x75,
      0x87,
      0xb0, // MOV PCON,#0B0H  SMOD=1
      0x75,
      0x8e,
      0x40, // MOV AUXR,#40H   T1x12=1、S1ST2=0
      0x75,
      0x99,
      0x55, // MOV SBUF,#55H
      ...HALT,
    ]);

    const measure = async (clockFrequency: number): Promise<number> => {
      const harness = await createSourceHarness({
        firmware,
        clockFrequency,
        observe: ['P3_1'],
        samplePeriodPs: 100_000,
      });
      const board = stepper(harness);

      try {
        // 先等复用功能把 TXD 驱动到空闲高电平，避免把复位后的浮空电平当成起始位。
        expect(board.waitFor('P3_1', 1, 2_000 * US_PER_PS, 2 * US_PER_PS)).toBeGreaterThanOrEqual(
          0,
        );

        const low = board.waitFor('P3_1', 0, 2_000 * US_PER_PS, 2 * US_PER_PS);
        const high = board.waitFor('P3_1', 1, 2_000 * US_PER_PS, 2 * US_PER_PS);

        expect(low).toBeGreaterThan(0);
        expect(harness.faults).toEqual([]);

        return high - low;
      } finally {
        board.dispose();
      }
    };

    // 位时间 = (SMOD ? 16 : 32) × (T1x12 ? 1 : 12) × (256-TH1) × cyclePs = 160 个时钟。
    const atOneMhz = await measure(1_000_000);
    const atTwoMhz = await measure(2_000_000);

    expect(atOneMhz).toBeGreaterThan(150 * US_PER_PS);
    expect(atOneMhz).toBeLessThan(175 * US_PER_PS);
    expect(atTwoMhz).toBeGreaterThan(72 * US_PER_PS);
    expect(atTwoMhz).toBeLessThan(90 * US_PER_PS);
    expect(atOneMhz / atTwoMhz).toBeGreaterThan(1.8);
    expect(atOneMhz / atTwoMhz).toBeLessThan(2.2);
  });

  it('中断：ES/EA 打开后 TI 触发 0023H 向量，中断服务程序清 TI', async () => {
    const image = new Array<number>(0x120).fill(0);

    image[0] = 0x02; // LJMP 0030H
    image[1] = 0x00;
    image[2] = 0x30;
    image[0x23] = 0x02; // LJMP 0100H（串口 1 向量）
    image[0x24] = 0x01;
    image[0x25] = 0x00;

    const main = [
      0x7f,
      0x00, // MOV R7,#00H
      ...PUSH_PULL_P2,
      0x75,
      0x98,
      0x40, // MOV SCON,#40H
      0x75,
      0x8e,
      0x05, // MOV AUXR,#05H
      0x75,
      0xd7,
      0xf6, // MOV T2L,#0F6H
      0x75,
      0xd6,
      0xff, // MOV T2H,#0FFH
      0xd2,
      0xac, // SETB ES
      0xd2,
      0xaf, // SETB EA
      0x75,
      0x99,
      0x5a, // MOV SBUF,#5AH
      0xef, // MOV A,R7
      0x60,
      0xfd, // JZ $-1（等待中断）
      0xf5,
      0xa0, // MOV P2,A
      ...HALT,
    ];
    const isr = [
      0xc2,
      0x99, // CLR TI
      0x75,
      0xa0,
      0xa5, // MOV P2,#0A5H
      0x0f, // INC R7
      0x32, // RETI
    ];

    main.forEach((value, index) => {
      image[0x30 + index] = value;
    });
    isr.forEach((value, index) => {
      image[0x100 + index] = value;
    });

    const harness = await createSourceHarness({
      firmware: Uint8Array.from(image),
      observe: [...P2_PINS],
      samplePeriodPs: 200_000,
    });
    const board = stepper(harness);
    const seen = new Set<number>();

    try {
      while (harness.board.time < 800 * US_PER_PS) {
        harness.board.runUntil(harness.board.time + 2 * US_PER_PS);
        seen.add(board.port2());
      }

      expect(harness.faults).toEqual([]);
      expect(seen.has(0xa5)).toBe(true); // 中断服务程序确实执行了
      expect(board.port2()).toBe(0x01); // TI 只被清一次，没有重复进入中断
    } finally {
      board.dispose();
    }
  });
});

describe('串口 2', () => {
  it('在 P1.0/P1.1 上收发，并置 S2TI/S2RI', async () => {
    const harness = await createSourceHarness({
      firmware: Uint8Array.from([
        ...PUSH_PULL_P2,
        0x75,
        0x9a,
        0x10, // MOV S2CON,#10H  8 位 UART、S2REN=1
        0x75,
        0x8e,
        0x05, // MOV AUXR,#05H   T2x12=1
        0x75,
        0xd7,
        0xf6, // MOV T2L,#0F6H
        0x75,
        0xd6,
        0xff, // MOV T2H,#0FFH
        0x75,
        0x9b,
        0x96, // MOV S2BUF,#96H
        0xe5,
        0x9a, // MOV A,S2CON
        0x30,
        0xe1,
        0xfb, // JNB ACC.1,$（等 S2TI）
        0xe5,
        0x9a, // MOV A,S2CON
        0xf5,
        0xa0, // MOV P2,A
        ...HALT,
      ]),
      observe: ['P1_1', ...P2_PINS],
      samplePeriodPs: 200_000,
    });
    const board = stepper(harness);

    try {
      const bitPs = 40 * US_PER_PS;

      expect(board.waitFor('P1_1', 1, 200 * US_PER_PS)).toBeGreaterThanOrEqual(0);

      const start = board.waitFor('P1_1', 0, 200 * US_PER_PS);

      expect(start).toBeGreaterThan(0);

      const levels = frameLevels(0x96);
      const sampled: number[] = [];

      for (let index = 0; index < levels.length; index += 1) {
        board.runTo(start + Math.floor((index + 0.5) * bitPs));
        sampled.push(harness.level('P1_1'));
      }

      expect(sampled).toEqual(levels);

      board.runTo(start + 30 * bitPs);
      expect(harness.faults).toEqual([]);
      expect(board.port2()).toBe(0x12); // S2CON = S2REN + S2TI
    } finally {
      board.dispose();
    }
  });

  it('从 P1.0 接收一帧并置 S2RI', async () => {
    const harness = await createSourceHarness({
      firmware: Uint8Array.from([
        ...PUSH_PULL_P2,
        0x75,
        0x9a,
        0x10, // MOV S2CON,#10H
        0x75,
        0x8e,
        0x05, // MOV AUXR,#05H
        0x75,
        0xd7,
        0xf6, // MOV T2L,#0F6H
        0x75,
        0xd6,
        0xff, // MOV T2H,#0FFH
        0xe5,
        0x9a, // MOV A,S2CON
        0x30,
        0xe0,
        0xfb, // JNB ACC.0,$（等 S2RI）
        0xe5,
        0x9b, // MOV A,S2BUF
        0xf5,
        0xa0, // MOV P2,A
        ...HALT,
      ]),
      observe: [...P2_PINS, 'P1_1'],
      drive: ['P1_0'],
      samplePeriodPs: 200_000,
    });
    const board = stepper(harness);

    try {
      harness.drive('P1_0', 1);
      board.runTo(20 * US_PER_PS);

      const bitPs = 40 * US_PER_PS;

      driveFrame(harness, 'P1_0', frameLevels(0x69), 20 * US_PER_PS, bitPs);
      board.runTo(20 * US_PER_PS + 16 * bitPs);

      expect(harness.faults).toEqual([]);
      expect(board.port2()).toBe(0x69);
    } finally {
      board.dispose();
    }
  });
});
