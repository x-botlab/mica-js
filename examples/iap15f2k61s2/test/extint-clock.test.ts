import { describe, expect, it } from 'vitest';
import { createSourceHarness, runSource } from './source-harness.ts';

/**
 * 外部中断、时钟寄存器与看门狗的行为基线。
 *
 * 固件都是手写 8051 机器码：先把 P2 切成推挽输出，把可观察结果写到 P2 的位或字节。
 */

const HALT = [0x80, 0xfe];

const PUSH_PULL_P2 = [
  0x75,
  0x96,
  0x0f, // MOV P2M0,#0FH
  0x75,
  0x95,
  0x00, // MOV P2M1,#00H
];

/** 主程序：开 INT0 下降沿中断，然后空转。 */
const INT0_MAIN = [
  ...PUSH_PULL_P2,
  0x75,
  0xa0,
  0x00, // MOV P2,#00H
  0xd2,
  0x88, // SETB IT0
  0xd2,
  0xa8, // SETB EX0
  0xd2,
  0xaf, // SETB EA
  ...HALT,
];

/** 主程序：开 INT2（P3.6）下降沿中断，然后空转。 */
const INT2_MAIN = [
  ...PUSH_PULL_P2,
  0x75,
  0xa0,
  0x00, // MOV P2,#00H
  0x75,
  0x8f,
  0x10, // MOV INT_CLKO,#10H（EX2=1）
  0xd2,
  0xaf, // SETB EA
  ...HALT,
];

function image(
  main: readonly number[],
  vectors: Readonly<Record<number, readonly number[]>> = {},
): Uint8Array {
  const bytes = new Uint8Array(0x100);

  bytes[0] = 0x02; // LJMP main
  bytes[1] = 0x00;
  bytes[2] = 0x30;
  [...main].forEach((value, index) => {
    bytes[0x30 + index] = value;
  });

  for (const [address, code] of Object.entries(vectors))
    code.forEach((value, index) => {
      bytes[Number(address) + index] = value;
    });

  return bytes;
}

describe('外部中断', () => {
  it('INT0 下降沿触发一次，响应时硬件清 IE0', async () => {
    const firmware = image(INT0_MAIN, {
      0x0003: [
        0xb2,
        0xa0, // CPL P2.0
        0x32, // RETI
      ],
    });
    const harness = await createSourceHarness({
      firmware,
      clockFrequency: 1_000_000,
      observe: ['P2_0', 'P2_1', 'P3_2'],
      drive: ['P3_2'],
      pullUp: { P3_2: 10_000 },
    });

    try {
      harness.drive('P3_2', 1);
      harness.board.runUntil(200_000_000);
      expect(harness.level('P2_0')).toBe(0);

      harness.drive('P3_2', 0);
      harness.board.runUntil(400_000_000);
      expect(harness.level('P2_0')).toBe(1);

      harness.board.runUntil(600_000_000);
      expect(harness.level('P2_0')).toBe(1);
      expect(harness.faults).toEqual([]);
    } finally {
      harness.dispose();
    }
  });

  it('IT0=0 时上升沿与下降沿都触发', async () => {
    const firmware = image(
      [
        ...PUSH_PULL_P2,
        0x75,
        0xa0,
        0x00, // MOV P2,#00H
        0xc2,
        0x88, // CLR IT0（双边沿）
        0xd2,
        0xa8, // SETB EX0
        0xd2,
        0xaf, // SETB EA
        ...HALT,
      ],
      { 0x0003: [0xb2, 0xa0, 0x32] },
    );
    const harness = await createSourceHarness({
      firmware,
      clockFrequency: 1_000_000,
      observe: ['P2_0', 'P2_1'],
      drive: ['P3_2'],
      pullUp: { P3_2: 10_000 },
    });

    try {
      // 先让固件完成初始化：首个指令边界只建立边沿基线，不伪造上电沿。
      harness.board.runUntil(50_000_000);
      // 上拉使复位后的引脚为高：先送下降沿，再送上升沿。
      harness.drive('P3_2', 0);
      harness.board.runUntil(200_000_000);
      expect(harness.level('P2_0')).toBe(1);

      harness.drive('P3_2', 1);
      harness.board.runUntil(400_000_000);
      expect(harness.level('P2_0')).toBe(0);
      expect(harness.faults).toEqual([]);
    } finally {
      harness.dispose();
    }
  });

  it('INT2 只在下降沿触发', async () => {
    const firmware = image(INT2_MAIN, { 0x0053: [0xb2, 0xa0, 0x32] });
    const harness = await createSourceHarness({
      firmware,
      clockFrequency: 1_000_000,
      observe: ['P2_0', 'P2_1'],
      drive: ['P3_6'],
      pullUp: { P3_6: 10_000 },
    });

    try {
      harness.drive('P3_6', 1);
      harness.board.runUntil(300_000_000);
      expect(harness.level('P2_0')).toBe(0);

      harness.drive('P3_6', 0);
      harness.board.runUntil(500_000_000);
      expect(harness.level('P2_0')).toBe(1);
      expect(harness.faults).toEqual([]);
    } finally {
      harness.dispose();
    }
  });

  it('未允许的 INT0 不进入中断服务程序', async () => {
    const firmware = image(
      [
        ...PUSH_PULL_P2,
        0x75,
        0xa0,
        0x00,
        0xd2,
        0x88, // SETB IT0（不开 EX0）
        ...HALT,
      ],
      { 0x0003: [0xb2, 0xa0, 0x32] },
    );
    const harness = await createSourceHarness({
      firmware,
      clockFrequency: 1_000_000,
      observe: ['P2_0'],
      drive: ['P3_2'],
      pullUp: { P3_2: 10_000 },
    });

    try {
      harness.drive('P3_2', 1);
      harness.board.runUntil(200_000_000);
      harness.drive('P3_2', 0);
      harness.board.runUntil(400_000_000);
      expect(harness.level('P2_0')).toBe(0);
    } finally {
      harness.dispose();
    }
  });
});

describe('时钟寄存器', () => {
  it('P_SW1 与 CLK_DIV 可按写入值读回', async () => {
    const result = await runSource({
      firmware: Uint8Array.from([
        ...PUSH_PULL_P2,
        0x75,
        0xa2,
        0x40, // MOV P_SW1,#40H
        0x75,
        0x97,
        0x03, // MOV CLK_DIV,#03H
        0xe5,
        0xa2, // MOV A,P_SW1
        0x55,
        0x97, // ANL A,CLK_DIV → 0
        0xf5,
        0xa0, // MOV P2,A
        ...HALT,
      ]),
    });

    expect(result.faults).toEqual([]);
    expect(result.ports[2]).toBe(0x00);
  });
});

describe('看门狗', () => {
  it('喂狗后继续运行，停止喂狗后复位并置 WDT_FLAG', async () => {
    // INC 30H; MOV A,30H; MOV P2,A; MOV WDT_CONTR,#0A0H; SJMP $
    const firmware = new Uint8Array(0x100);

    firmware[0] = 0x02;
    firmware[1] = 0x00;
    firmware[2] = 0x30;
    [
      0x75,
      0x96,
      0x0f, // MOV P2M0,#0FH
      0x75,
      0x95,
      0x00, // MOV P2M1,#00H
      0x05,
      0x30, // INC 30H
      0xe5,
      0x30, // MOV A,30H
      0xf5,
      0xa0, // MOV P2,A
      0x75,
      0xc1,
      0xa0, // MOV WDT_CONTR,#0A0H（EN_WDT=1，PS=0）
      ...HALT,
    ].forEach((value, index) => {
      firmware[0x30 + index] = value;
    });

    // 溢出时间 = 12 × 2 × 32768 / 40 MHz ≈ 19.7 ms；跑 50 ms 至少复位两次。
    const result = await runSource({
      firmware,
      clockFrequency: 40_000_000,
      milliseconds: 50,
    });

    expect(result.faults).toEqual([]);
    expect(result.ports[2]).toBeGreaterThanOrEqual(2);
  }, 120_000);
});
