import { describe, expect, it } from 'vitest';
import { createSourceHarness } from './source-harness.ts';

/**
 * SPI 主模式的源码级用例。
 *
 * 波形断言的做法：把 SCLK/MOSI 接到探针，按固定步长分步 `runUntil` 采样，再从采样序列里
 * 还原边沿与位序——比只检查寄存器更接近真实总线行为。
 */

const HALT = [0x80, 0xfe]; // SJMP $

/** 板级时间单位：皮秒。 */
const US = 1_000_000;
const MS = 1_000_000_000;

/** P2 推挽输出：后续把结果写到 P2 才能读到高电平。 */
const PUSH_PULL_P2 = [0x75, 0x96, 0xff, 0x75, 0x95, 0x00];

/** SPCTL：SSIG=1、SPEN=1、MSTR=1，其余位由用例给出。 */
const masterControl = (bits: number): number[] => [0x75, 0xce, 0x80 | 0x40 | 0x10 | bits];

const SPR_4 = 0b00;
const SPR_16 = 0b01;
const SPR_128 = 0b11;

const DORD_LSB = 0x20;
const CPOL_HIGH = 0x08;
const CPHA_EDGE = 0x04;

/** 轮询 SPIF（SPSTAT.7）：MOV A,SPSTAT; JNB ACC.7,$-5。 */
const WAIT_SPIF = [0xe5, 0xcd, 0x30, 0xe7, 0xfb];

interface Trace {
  readonly time: number;
  readonly sclk: number;
  readonly mosi: number;
}

interface CaptureOptions {
  readonly firmware: readonly number[];
  readonly sclk: string;
  readonly mosi: string;
  readonly until: number;
  readonly step: number;
}

async function captureTrace(options: CaptureOptions): Promise<Trace[]> {
  const harness = await createSourceHarness({
    firmware: Uint8Array.from(options.firmware),
    observe: [options.sclk, options.mosi],
  });
  const samples: Trace[] = [];

  try {
    for (let time = options.step; time <= options.until; time += options.step) {
      harness.board.runUntil(time);
      samples.push({ time, sclk: harness.level(options.sclk), mosi: harness.level(options.mosi) });
    }
  } finally {
    harness.dispose();
  }

  return samples;
}

/** 每个 SCLK 上升沿处采到的 MOSI 电平。 */
const bitsAtRisingEdges = (samples: readonly Trace[]): number[] => {
  const bits: number[] = [];

  for (let index = 1; index < samples.length; index += 1)
    if (samples[index - 1]!.sclk === 0 && samples[index]!.sclk === 1)
      bits.push(samples[index]!.mosi);

  return bits;
};

/** MOSI 在 SCLK 为高时跳变的次数：区分 CPHA 的换位边沿。 */
const transitionsWhileClockHigh = (samples: readonly Trace[]): number => {
  let count = 0;

  for (let index = 1; index < samples.length; index += 1)
    if (samples[index]!.mosi !== samples[index - 1]!.mosi && samples[index]!.sclk === 1) count += 1;

  return count;
};

interface PortRunOptions {
  readonly firmware: readonly number[];
  readonly until: number;
  readonly step: number;
}

/** 分步推进并把每步的 P2 记下来。 */
async function runPort(
  options: PortRunOptions,
): Promise<{ ports: { time: number; value: number }[]; faults: readonly string[] }> {
  const harness = await createSourceHarness({
    firmware: Uint8Array.from(options.firmware),
    observe: Array.from({ length: 8 }, (_, bit) => `P2_${bit}`),
  });
  const ports: { time: number; value: number }[] = [];

  try {
    for (let time = options.step; time <= options.until; time += options.step) {
      harness.board.runUntil(time);
      ports.push({ time, value: harness.port(2) });
    }

    return { ports, faults: [...harness.faults] };
  } finally {
    harness.dispose();
  }
}

/** 第一个等于 `expected` 的采样时刻；没出现时返回 Infinity。 */
const firstTimePortIs = (
  samples: readonly { time: number; value: number }[],
  expected: number,
): number => samples.find((sample) => sample.value === expected)?.time ?? Infinity;

/** 跑到底后读回 P2。MISO 用上拉给一个确定的电平。 */
const finalPort = async (firmware: readonly number[], milliseconds: number): Promise<number> => {
  const harness = await createSourceHarness({
    firmware: Uint8Array.from(firmware),
    observe: Array.from({ length: 8 }, (_, bit) => `P2_${bit}`),
    pullUp: { P1_4: 10_000 },
  });

  try {
    harness.board.runUntil(milliseconds * MS);

    return harness.port(2);
  } finally {
    harness.dispose();
  }
};

describe('SPI 主模式收发', () => {
  it('MISO 恒高时收到 0xFF，并置 SPIF', async () => {
    const firmware = [
      ...PUSH_PULL_P2,
      0x75,
      0xa0,
      0x00, // MOV P2,#00H
      ...masterControl(SPR_128),
      0x75,
      0xcf,
      0x55, // MOV SPDAT,#55H
      ...WAIT_SPIF,
      0xe5,
      0xcf, // MOV A,SPDAT
      0xf5,
      0xa0, // MOV P2,A
      ...HALT,
    ];

    expect(await finalPort(firmware, 4)).toBe(0xff);
  });

  it('MISO 恒低时收到 0x00', async () => {
    const firmware = [
      ...PUSH_PULL_P2,
      0x75,
      0xa0,
      0xa5, // MOV P2,#0A5H（哨兵）
      ...masterControl(SPR_128),
      0x75,
      0xcf,
      0x55, // MOV SPDAT,#55H
      ...WAIT_SPIF,
      0xe5,
      0xcf, // MOV A,SPDAT
      0xf5,
      0xa0, // MOV P2,A
      ...HALT,
    ];
    const harness = await createSourceHarness({
      firmware: Uint8Array.from(firmware),
      observe: Array.from({ length: 8 }, (_, bit) => `P2_${bit}`),
      drive: ['P1_4'],
    });

    try {
      harness.drive('P1_4', 0);
      harness.board.runUntil(4 * MS);

      expect(harness.port(2)).toBe(0x00);
    } finally {
      harness.dispose();
    }
  });

  it('主机空闲时 SCLK 停在 CPOL 上', async () => {
    const idle = async (bits: number): Promise<number> => {
      const harness = await createSourceHarness({
        firmware: Uint8Array.from([...masterControl(SPR_128 | bits), ...HALT]),
        observe: ['P1_5', 'P1_3'],
      });

      try {
        harness.board.runUntil(20 * US);
        harness.board.runUntil(40 * US);

        return harness.level('P1_5');
      } finally {
        harness.dispose();
      }
    };

    expect(await idle(0)).toBe(0);
    expect(await idle(CPOL_HIGH)).toBe(1);
  });

  it('DORD=0 先送 MSB，DORD=1 先送 LSB', async () => {
    const trace = (bits: number): Promise<Trace[]> =>
      captureTrace({
        firmware: [...masterControl(SPR_128 | bits), 0x75, 0xcf, 0x55, ...HALT],
        sclk: 'P1_5',
        mosi: 'P1_3',
        until: 2 * MS,
        step: 8 * US,
      });

    expect(bitsAtRisingEdges(await trace(0))).toEqual([0, 1, 0, 1, 0, 1, 0, 1]);
    expect(bitsAtRisingEdges(await trace(DORD_LSB))).toEqual([1, 0, 1, 0, 1, 0, 1, 0]);
  });

  it('CPHA 决定换位边沿：=0 在后沿、=1 在前沿', async () => {
    const trace = (bits: number): Promise<Trace[]> =>
      captureTrace({
        firmware: [...masterControl(SPR_128 | bits), 0x75, 0xcf, 0x55, ...HALT],
        sclk: 'P1_5',
        mosi: 'P1_3',
        until: 2 * MS,
        step: 8 * US,
      });

    expect(transitionsWhileClockHigh(await trace(0))).toBe(0);
    expect(transitionsWhileClockHigh(await trace(CPHA_EDGE))).toBeGreaterThan(0);
  });

  it('SPI_S1:SPI_S0=01 时引脚切换到 P2', async () => {
    const samples = await captureTrace({
      firmware: [
        0x75,
        0xa2,
        0x04, // MOV P_SW1,#04H → SPI 在 P2
        ...masterControl(SPR_128),
        0x75,
        0xcf,
        0x55, // MOV SPDAT,#55H
        ...HALT,
      ],
      sclk: 'P2_1',
      mosi: 'P2_3',
      until: 2 * MS,
      step: 8 * US,
    });

    expect(bitsAtRisingEdges(samples)).toEqual([0, 1, 0, 1, 0, 1, 0, 1]);
  });
});

describe('SPI 时钟分频', () => {
  const duration = async (spr: number): Promise<number> => {
    const result = await runPort({
      firmware: [
        ...PUSH_PULL_P2,
        0x75,
        0xa0,
        0x00, // MOV P2,#00H
        ...masterControl(spr),
        0x75,
        0xcf,
        0x55, // MOV SPDAT,#55H
        ...WAIT_SPIF,
        0x75,
        0xa0,
        0xa5, // MOV P2,#0A5H（完成标记）
        ...HALT,
      ],
      until: 3 * MS,
      step: 4 * US,
    });

    expect(result.faults).toEqual([]);

    return firstTimePortIs(result.ports, 0xa5);
  };

  it('SPR=00 的传输明显快于 SPR=11', async () => {
    const fastest = await duration(SPR_4);
    const slowest = await duration(SPR_128);

    // 32 个时钟 vs 1024 个时钟；留出轮询与指令开销的余量。
    expect(fastest).toBeLessThan(200 * US);
    expect(slowest).toBeGreaterThan(900 * US);
    expect(slowest).toBeGreaterThan(fastest * 10);
  });

  it('SPR=01 介于两者之间', async () => {
    const fastest = await duration(SPR_4);
    const middle = await duration(SPR_16);

    expect(middle).toBeGreaterThan(fastest);
    expect(middle).toBeLessThan(400 * US);
  });
});

describe('SPI 状态与冲突', () => {
  it('SPIF 只能靠写 1 清零', async () => {
    const firmware = [
      ...PUSH_PULL_P2,
      0x75,
      0xa0,
      0x00, // MOV P2,#00H
      ...masterControl(SPR_128),
      0x75,
      0xcf,
      0x55, // MOV SPDAT,#55H
      ...WAIT_SPIF,
      0xe5,
      0xcd, // MOV A,SPSTAT
      0xfa, // MOV R2,A
      0x75,
      0xcd,
      0x80, // MOV SPSTAT,#80H → 清 SPIF
      0xe5,
      0xcd, // MOV A,SPSTAT
      0x4a, // ORL A,R2
      0xf5,
      0xa0, // MOV P2,A
      ...HALT,
    ];

    // 清零前读到 0x80，清零后读到 0x00。
    expect(await finalPort(firmware, 4)).toBe(0x80);
  });

  it('写 SPSTAT 的 0 位不影响其它位', async () => {
    const firmware = [
      ...PUSH_PULL_P2,
      0x75,
      0xa0,
      0x00, // MOV P2,#00H
      ...masterControl(SPR_128),
      0x75,
      0xcf,
      0x55, // MOV SPDAT,#55H
      ...WAIT_SPIF,
      0x75,
      0xcd,
      0x00, // MOV SPSTAT,#00H → 不清任何位
      0xe5,
      0xcd, // MOV A,SPSTAT
      0xf5,
      0xa0, // MOV P2,A
      ...HALT,
    ];

    expect(await finalPort(firmware, 4)).toBe(0x80);
  });

  it('传输过程中写 SPDAT 置 WCOL，当前数据继续发送', async () => {
    const firmware = [
      ...PUSH_PULL_P2,
      0x75,
      0xa0,
      0x00, // MOV P2,#00H
      ...masterControl(SPR_128),
      0x75,
      0xcf,
      0x55, // MOV SPDAT,#55H
      0x75,
      0xcf,
      0xaa, // MOV SPDAT,#0AAH → 写冲突
      ...WAIT_SPIF,
      0xe5,
      0xcd, // MOV A,SPSTAT
      0xf5,
      0xa0, // MOV P2,A
      ...HALT,
    ];

    expect(await finalPort(firmware, 4)).toBe(0xc0);

    const samples = await captureTrace({
      firmware: [...masterControl(SPR_128), 0x75, 0xcf, 0x55, 0x75, 0xcf, 0xaa, ...HALT],
      sclk: 'P1_5',
      mosi: 'P1_3',
      until: 2 * MS,
      step: 8 * US,
    });

    // 冲突只丢弃新数据：总线上仍然是 0x55。
    expect(bitsAtRisingEdges(samples)).toEqual([0, 1, 0, 1, 0, 1, 0, 1]);
  });
});

describe('SPI 中断', () => {
  it('传输完成后进入 004BH 向量', async () => {
    const image = new Array<number>(0x60).fill(0x00);

    const program = [
      ...PUSH_PULL_P2,
      0x75,
      0xa0,
      0x00, // MOV P2,#00H
      0x75,
      0xaf,
      0x02, // MOV IE2,#02H → ESPI
      0xd2,
      0xaf, // SETB EA
      ...masterControl(SPR_128),
      0x75,
      0xcf,
      0x55, // MOV SPDAT,#55H
      ...HALT,
    ];

    image[0] = 0x02; // LJMP 0030H
    image[1] = 0x00;
    image[2] = 0x30;
    program.forEach((value, index) => {
      image[0x30 + index] = value;
    });

    // 004BH：写标记、清 SPIF/WCOL、返回。
    [
      0x75,
      0xa0,
      0xa5, // MOV P2,#0A5H
      0x75,
      0xcd,
      0xc0, // MOV SPSTAT,#0C0H
      0x32, // RETI
    ].forEach((value, index) => {
      image[0x4b + index] = value;
    });

    const harness = await createSourceHarness({
      firmware: Uint8Array.from(image),
      observe: Array.from({ length: 8 }, (_, bit) => `P2_${bit}`),
    });

    try {
      harness.board.runUntil(200 * US);
      expect(harness.port(2)).toBe(0x00);

      harness.board.runUntil(4 * MS);
      expect(harness.faults).toEqual([]);
      expect(harness.port(2)).toBe(0xa5);
    } finally {
      harness.dispose();
    }
  });

  it('ESPI=0 时不进入中断', async () => {
    const firmware = [
      ...PUSH_PULL_P2,
      0x75,
      0xa0,
      0x5a, // MOV P2,#5AH（哨兵）
      0xd2,
      0xaf, // SETB EA（未开 ESPI）
      ...masterControl(SPR_128),
      0x75,
      0xcf,
      0x55, // MOV SPDAT,#55H
      ...HALT,
    ];

    expect(await finalPort(firmware, 4)).toBe(0x5a);
  });
});
