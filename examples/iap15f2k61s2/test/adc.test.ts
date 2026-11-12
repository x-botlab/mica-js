import { describe, expect, it } from 'vitest';
import { createSourceHarness } from './source-harness.ts';

/**
 * A/D 转换器用例（手册第 10 章）。
 *
 * 固件都是手写机器码：P2/P3 推挽输出当作 8 位探针，P1 全脚设为仅输入以保持高阻。
 * 板级时钟取 10 MHz（1 个系统时钟 = 0.1 µs），转换时钟数可以直接换算成时间。
 */

const CLOCK = 10_000_000;

const HALT = [0x80, 0xfe]; // SJMP $
const PUSH_PULL_P2 = [0x75, 0x96, 0xff, 0x75, 0x95, 0x00]; // MOV P2M0,#FFH；P2M1,#00H
const PUSH_PULL_P3 = [0x75, 0xb2, 0xff, 0x75, 0xb1, 0x00]; // MOV P3M0,#FFH；P3M1,#00H
const P1_INPUT_ONLY = [0x75, 0x92, 0x00, 0x75, 0x91, 0xff]; // P1 全部仅输入（高阻）

const MOV = (address: number, value: number): number[] => [0x75, address, value];
const MOV_A_DIRECT = (address: number): number[] => [0xe5, address];
const MOV_DIRECT_A = (address: number): number[] => [0xf5, address];

const ADC_CONTR = 0xbc;
const ADC_RES = 0xbd;
const ADC_RESL = 0xbe;
const P1ASF = 0x9d;
const CLK_DIV = 0x97;

const SPIED = (port: number): string[] => Array.from({ length: 8 }, (_, bit) => `P${port}_${bit}`);

/** 轮询 ADC_FLAG 后把 ADC_RES/ADC_RESL 分别送到 P2/P3，再停机。 */
const READ_RESULT = [
  ...MOV_A_DIRECT(ADC_CONTR),
  0x30,
  0xe4,
  0xfb, // JNB ACC.4,$ —— ADC_FLAG = ACC.4
  ...MOV_A_DIRECT(ADC_RES),
  ...MOV_DIRECT_A(0xa0),
  ...MOV_A_DIRECT(ADC_RESL),
  ...MOV_DIRECT_A(0xb0),
];

interface ConversionOptions {
  /** SPEED1:SPEED0，0…3 对应 540/360/180/90 个时钟。 */
  readonly speed: number;
  /** CHS2:CHS0。 */
  readonly channel?: number;
  readonly p1asf?: number;
  /** 置 CLK_DIV.ADRJ，让结果右对齐。 */
  readonly adrj?: boolean;
}

function conversionFirmware(options: ConversionOptions): Uint8Array {
  const speed = options.speed << 5;

  return Uint8Array.from([
    ...PUSH_PULL_P2,
    ...PUSH_PULL_P3,
    ...P1_INPUT_ONLY,
    ...MOV(P1ASF, options.p1asf ?? 0x00),
    ...(options.adrj === true ? MOV(CLK_DIV, 0x20) : []),
    ...MOV(ADC_CONTR, 0x80 | speed), // 上电
    0x00,
    0x00,
    0x00,
    0x00, // 4 个 NOP，等内部模拟电源稳定
    ...MOV(ADC_CONTR, 0x80 | speed | 0x08 | (options.channel ?? 0)), // 置 ADCS 启动
    ...READ_RESULT,
    ...HALT,
  ]);
}

const resultOf = (high: number, low: number): number => ((high & 0xff) << 2) | (low & 0x03);

const harnessOptions = (firmware: Uint8Array, drive?: readonly string[]) => ({
  clockFrequency: CLOCK,
  firmware,
  observe: [...SPIED(2), ...SPIED(3)],
  samplePeriodPs: 2_000_000,
  ...(drive === undefined ? {} : { drive }),
});

describe('A/D 转换器：转换结果', () => {
  it('P1ASF.0=1 时转换 P1.0 的满量程电压（ADRJ=0：ADC_RES 高 8 位）', async () => {
    const harness = await createSourceHarness(
      harnessOptions(conversionFirmware({ speed: 3, p1asf: 0x01 }), ['P1_0']),
    );

    try {
      harness.drive('P1_0', 1);
      harness.board.runUntil(120_000_000);

      expect(harness.faults).toEqual([]);
      expect(resultOf(harness.port(2), harness.port(3))).toBe(1023);
    } finally {
      harness.dispose();
    }
  });

  it('输入接地时结果为 0', async () => {
    const harness = await createSourceHarness(
      harnessOptions(conversionFirmware({ speed: 3, p1asf: 0x01 }), ['P1_0']),
    );

    try {
      harness.drive('P1_0', 0);
      harness.board.runUntil(120_000_000);

      // 节点求解与量化会留下几个 LSB 的零点偏移，按 ≤3 LSB 断言。
      expect(resultOf(harness.port(2), harness.port(3))).toBeLessThanOrEqual(3);
    } finally {
      harness.dispose();
    }
  });

  it('未接外部激励（浮空）按 0 V 处理', async () => {
    const harness = await createSourceHarness(
      harnessOptions(conversionFirmware({ speed: 3, p1asf: 0x02, channel: 1 })),
    );

    try {
      harness.board.runUntil(120_000_000);

      expect(harness.faults).toEqual([]);
      expect(resultOf(harness.port(2), harness.port(3))).toBeLessThanOrEqual(3);
    } finally {
      harness.dispose();
    }
  });

  it('P1ASF=0 且 CHS=0 时读内部 BandGap（第 9 通道）', async () => {
    // 1.19 V / 5 V × 1023 = 243.47 → 243。手册公式用 1024 刻度，这里按约定用 1023。
    const harness = await createSourceHarness(
      harnessOptions(conversionFirmware({ speed: 3, channel: 0, p1asf: 0x00 })),
    );

    try {
      harness.board.runUntil(120_000_000);

      expect(harness.faults).toEqual([]);
      expect(resultOf(harness.port(2), harness.port(3))).toBe(243);
    } finally {
      harness.dispose();
    }
  });

  it('ADRJ=1 时结果右对齐：ADC_RES 存低 2 位、ADC_RESL 存高 8 位', async () => {
    const harness = await createSourceHarness(
      harnessOptions(conversionFirmware({ speed: 3, p1asf: 0x01, adrj: true }), ['P1_0']),
    );

    try {
      harness.drive('P1_0', 1);
      harness.board.runUntil(120_000_000);

      expect(harness.port(2) & 0x03).toBe(1023 & 0x03);
      expect(harness.port(3)).toBe(1023 >> 2);
    } finally {
      harness.dispose();
    }
  });
});

/** 主程序启动一次转换后等待；中断服务程序清 ADC_FLAG 并把 0A5H 写到 P2。 */
function interruptFirmware(speed: number): Uint8Array {
  const image = new Array<number>(0x40).fill(0);
  const control = 0x80 | (speed << 5);
  const main = [
    ...PUSH_PULL_P2,
    ...P1_INPUT_ONLY,
    ...MOV(P1ASF, 0x00), // 全 0：CHS=0 读内部 BandGap
    ...MOV(ADC_CONTR, control),
    0x00,
    0x00,
    0x00,
    0x00,
    ...MOV(0xa8, 0xa0), // IE = EA | EADC
    ...MOV(ADC_CONTR, control | 0x08),
    ...HALT,
  ];

  main.forEach((value, index) => {
    image[index] = value;
  });
  [...MOV(ADC_CONTR, control), ...MOV(0xa0, 0xa5), ...HALT].forEach((value, index) => {
    image[0x2b + index] = value; // ADC 中断向量 002BH
  });

  return Uint8Array.from(image);
}

describe('A/D 转换器：转换速度与中断', () => {
  async function run(speed: number, at: number): Promise<number> {
    const harness = await createSourceHarness({
      clockFrequency: CLOCK,
      firmware: interruptFirmware(speed),
      observe: SPIED(2),
      samplePeriodPs: 1_000_000,
    });

    try {
      harness.board.runUntil(at);

      return harness.port(2);
    } finally {
      harness.dispose();
    }
  }

  it('SPEED=11B（90 个时钟）比 SPEED=00B（540 个时钟）先完成', async () => {
    // 90 个时钟 = 9 µs，540 个时钟 = 54 µs；取 25 µs 与 80 µs 两个观察点。
    expect(await run(3, 25_000_000)).toBe(0xa5);
    // 主程序没有清 P2，未完成时读回的是 P2 锁存的 0FFH。
    expect(await run(0, 25_000_000)).not.toBe(0xa5);
    expect(await run(0, 80_000_000)).toBe(0xa5);
  });

  it('SPEED=10B（180 个时钟）落在两者之间', async () => {
    expect(await run(2, 25_000_000)).toBe(0xa5); // 18 µs
    expect(await run(1, 25_000_000)).not.toBe(0xa5); // 36 µs：此时还没转换完
    expect(await run(1, 60_000_000)).toBe(0xa5);
  });

  it('ADC_POWER=0 时不启动转换', async () => {
    const harness = await createSourceHarness(
      harnessOptions(
        Uint8Array.from([
          ...PUSH_PULL_P2,
          ...PUSH_PULL_P3,
          ...P1_INPUT_ONLY,
          ...MOV(P1ASF, 0x00),
          ...MOV(ADC_CONTR, 0x08), // POWER=0，ADCS=1：不启动转换
          0x00,
          0x00,
          ...MOV_A_DIRECT(ADC_CONTR),
          ...MOV_DIRECT_A(0xa0), // 把 ADC_CONTR 送到 P2 检查 ADCS/ADC_FLAG
          ...HALT,
        ]),
      ),
    );

    try {
      harness.board.runUntil(120_000_000);

      // ADCS 保持置位但转换从未完成：ADC_FLAG 仍为 0。
      expect(harness.port(2)).toBe(0x08);
      expect(harness.faults).toEqual([]);
    } finally {
      harness.dispose();
    }
  });
});
