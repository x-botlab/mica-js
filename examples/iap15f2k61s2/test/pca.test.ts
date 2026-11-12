import { describe, expect, it } from 'vitest';
import { createSourceHarness } from './source-harness.ts';

/**
 * CCP/PCA/PWM 用例（手册第 11 章）。
 *
 * 固件都是手写机器码；P2/P3 推挽输出当 8 位探针，CCP0 的引脚按 P_SW1 的组别观察。
 * CMOD 的 CPS2:CPS0 在 B3:B1，ECF 在 B0：0x08 = SYSclk，0x00 = SYSclk/12。
 */

const HALT = [0x80, 0xfe]; // SJMP $
const PUSH_PULL_P2 = [0x75, 0x96, 0xff, 0x75, 0x95, 0x00];
const PUSH_PULL_P3 = [0x75, 0xb2, 0xff, 0x75, 0xb1, 0x00];

const CMOD = 0xd9;
const CCON = 0xd8;
const CCAPM0 = 0xda;
const CCAP0L = 0xea;
const CCAP0H = 0xfa;
const PCA_PWM0 = 0xf2;
const CL = 0xe9;
const CH = 0xf9;
const P_SW1 = 0xa2;

/** CMOD：CPS=100B（SYSclk）；ECF 由参数决定。 */
const SYS_CLK = 0x08;

const MOV = (address: number, value: number): number[] => [0x75, address, value];
const MOV_A_DIRECT = (address: number): number[] => [0xe5, address];
const MOV_DIRECT_A = (address: number): number[] => [0xf5, address];

/** 轮询 `ACC.bit`，回到本轮 `MOV A,direct`：MOV 在上一条，JNB 的偏移是 -5。 */
const POLL = (address: number, bit: number): number[] => [0xe5, address, 0x30, 0xe0 | bit, 0xfb];

const SPIED = (port: number): string[] => Array.from({ length: 8 }, (_, bit) => `P${port}_${bit}`);

describe('PCA：16 位软件定时器模式', () => {
  it('计数到 CCAPnH:CCAPnL 时置 CCF0', async () => {
    const firmware = Uint8Array.from([
      ...PUSH_PULL_P2,
      ...MOV(CMOD, SYS_CLK),
      ...MOV(CL, 0x00),
      ...MOV(CH, 0x00),
      ...MOV(CCAP0L, 0x20),
      ...MOV(CCAP0H, 0x00),
      ...MOV(CCAPM0, 0x48), // ECOMn=1，MATn=1
      ...MOV(CCON, 0x40), // CR=1
      ...POLL(CCON, 0),
      ...MOV(0xa0, 0xa5),
      ...HALT,
    ]);
    const harness = await createSourceHarness({ firmware, observe: SPIED(2) });

    try {
      harness.board.runUntil(200_000_000);

      expect(harness.faults).toEqual([]);
      expect(harness.port(2)).toBe(0xa5);
    } finally {
      harness.dispose();
    }
  });

  it('CR=0 时计数器不前进，不会匹配', async () => {
    const firmware = Uint8Array.from([
      ...PUSH_PULL_P2,
      ...MOV(CMOD, SYS_CLK),
      ...MOV(CCAP0L, 0x04),
      ...MOV(CH, 0x00),
      ...MOV(CCAPM0, 0x48),
      ...MOV(CCON, 0x00), // CR=0
      ...MOV(0xa0, 0x00), // 先把 P2 清零：0 表示「什么都没发生」
      0x7f,
      0x14, // MOV R7,#20
      0xdf,
      0xfe, // DJNZ R7,$ 等一会儿
      ...MOV_A_DIRECT(CCON),
      ...MOV_DIRECT_A(0xa0),
      ...HALT,
    ]);
    const harness = await createSourceHarness({ firmware, observe: SPIED(2) });

    try {
      harness.board.runUntil(600_000_000);

      // CCON 的低 3 位（CCF2..CCF0）与 CF 都应是 0。
      expect(harness.port(2) & 0x87).toBe(0x00);
    } finally {
      harness.dispose();
    }
  });
});

describe('PCA：8 位 PWM', () => {
  async function duty(pwmValue: number, switchToP3 = false): Promise<number> {
    const firmware = Uint8Array.from([
      ...PUSH_PULL_P2,
      ...MOV(CMOD, 0x00), // CPS=000B：SYSclk/12 → PWM 周期 256 × 12 个时钟
      ...MOV(CL, 0x00),
      ...MOV(CH, 0x00),
      ...MOV(PCA_PWM0, 0x00), // EBS=00：8 位 PWM
      ...MOV(CCAP0H, pwmValue),
      ...MOV(CCAP0L, pwmValue),
      ...MOV(CCAPM0, 0xc2), // ECOMn=1，PWMn=1
      ...(switchToP3 ? MOV(P_SW1, 0x10) : []), // CCP_S1:CCP_S0=01B → CCP0 在 P3.5
      ...MOV(CCON, 0x40),
      ...HALT,
    ]);
    const pin = switchToP3 ? 'P3_5' : 'P1_1';
    const harness = await createSourceHarness({
      firmware,
      observe: [pin],
      samplePeriodPs: 1_000_000,
    });

    try {
      let high = 0;
      const steps = 100;

      for (let step = 0; step < steps; step += 1) {
        harness.board.runUntil(harness.board.time + 120_000_000);
        if (harness.level(pin) === 1) high += 1;
      }

      return high / steps;
    } finally {
      harness.dispose();
    }
  }

  it('CCAP0L=80H 时占空比约 50%，输出在 CCP0/P1.1 上', async () => {
    const ratio = await duty(0x80);

    expect(ratio).toBeGreaterThan(0.35);
    expect(ratio).toBeLessThan(0.65);
  }, 60_000);

  it('CCAP0L=C0H 时占空比约 25%', async () => {
    const ratio = await duty(0xc0);

    expect(ratio).toBeGreaterThan(0.1);
    expect(ratio).toBeLessThan(0.4);
  }, 60_000);

  it('CCP_S1:CCP_S0=01B 时 PWM 切到 P3.5', async () => {
    const ratio = await duty(0x80, true);

    expect(ratio).toBeGreaterThan(0.35);
    expect(ratio).toBeLessThan(0.65);
  }, 60_000);
});

describe('PCA：16 位捕获', () => {
  const captureFirmware = Uint8Array.from([
    ...PUSH_PULL_P2,
    ...PUSH_PULL_P3,
    ...MOV(CMOD, SYS_CLK), // SYSclk
    ...MOV(CCAPM0, 0x20), // CAPP0=1：上升沿捕获
    ...MOV(CCON, 0x40),
    ...POLL(CCON, 0),
    ...MOV_A_DIRECT(CCAP0L),
    ...MOV_DIRECT_A(0xa0),
    ...MOV_A_DIRECT(CCAP0H),
    ...MOV_DIRECT_A(0xb0),
    ...HALT,
  ]);

  it('CCP0 上升沿把 CH:CL 装入 CCAP0H:CCAP0L 并置 CCF0', async () => {
    const harness = await createSourceHarness({
      firmware: captureFirmware,
      observe: [...SPIED(2), ...SPIED(3)],
      drive: ['P1_1'],
    });

    try {
      harness.drive('P1_1', 0);
      harness.board.runUntil(50_000_000);
      harness.drive('P1_1', 1);
      harness.board.runUntil(400_000_000);

      const captured = ((harness.port(3) & 0xff) << 8) | (harness.port(2) & 0xff);

      // 捕获值应落在「拉高之后」的计数窗口里；高字节必须还是 0。
      expect(harness.faults).toEqual([]);
      expect(harness.port(3)).toBe(0x00);
      expect(captured).toBeGreaterThan(20);
      expect(captured).toBeLessThan(250);
    } finally {
      harness.dispose();
    }
  });

  it('CR=0 时不捕获', async () => {
    const firmware = Uint8Array.from([
      ...PUSH_PULL_P2,
      ...MOV(CMOD, SYS_CLK),
      ...MOV(CCAP0L, 0x00),
      ...MOV(CCAP0H, 0x00),
      ...MOV(CCAPM0, 0x20),
      ...MOV(CCON, 0x00), // CR=0
      ...MOV(0xa0, 0x00), // 先把 P2 清零：0 表示「什么都没发生」
      0x7f,
      0x14, // MOV R7,#20
      0xdf,
      0xfe, // DJNZ R7,$
      ...MOV_A_DIRECT(CCAP0L),
      ...MOV_DIRECT_A(0xa0),
      ...HALT,
    ]);
    const harness = await createSourceHarness({
      firmware,
      observe: SPIED(2),
      drive: ['P1_1'],
    });

    try {
      harness.drive('P1_1', 0);
      harness.board.runUntil(20_000_000);
      harness.drive('P1_1', 1);
      harness.board.runUntil(600_000_000);

      expect(harness.port(2)).toBe(0x00);
    } finally {
      harness.dispose();
    }
  });
});

describe('PCA：计数器溢出与中断', () => {
  /** 预装 0FFF0H，16 个 PCA 时钟后 CF 置位；中断服务程序清 CF 并把 0A5H 写到 P2。 */
  function interruptFirmware(): Uint8Array {
    const image = new Array<number>(0x40).fill(0);
    const main = [
      ...PUSH_PULL_P2,
      ...MOV(CMOD, SYS_CLK | 0x01), // CPS=100B（SYSclk）+ ECF=1
      ...MOV(CH, 0xff),
      ...MOV(CL, 0xf0),
      ...MOV(CCON, 0x40),
      ...MOV(0xa8, 0xc0), // IE = EA | EPCA
      ...HALT,
    ];

    main.forEach((value, index) => {
      image[index] = value;
    });
    [...MOV(CCON, 0x40), ...MOV(0xa0, 0xa5), ...HALT].forEach((value, index) => {
      image[0x3b + index] = value; // PCA 中断向量 003BH
    });

    return Uint8Array.from(image);
  }

  it('ECF=1 且 EA/EPCA 使能时，溢出进入 003BH', async () => {
    const harness = await createSourceHarness({
      firmware: interruptFirmware(),
      observe: SPIED(2),
    });

    try {
      harness.board.runUntil(300_000_000);

      expect(harness.faults).toEqual([]);
      expect(harness.port(2)).toBe(0xa5);
    } finally {
      harness.dispose();
    }
  });

  it('ECF=0 时 CF 仍由硬件置位，只是不产生中断', async () => {
    const firmware = Uint8Array.from([
      ...PUSH_PULL_P2,
      ...MOV(CMOD, SYS_CLK), // ECF=0
      ...MOV(CH, 0xff),
      ...MOV(CL, 0xf0),
      ...MOV(CCON, 0x40),
      ...MOV(0xa8, 0xc0), // 中断全开也没有 PCA 请求
      ...POLL(CCON, 7),
      ...MOV(0xa0, 0xa5),
      ...HALT,
    ]);
    const harness = await createSourceHarness({ firmware, observe: SPIED(2) });

    try {
      harness.board.runUntil(300_000_000);

      expect(harness.port(2)).toBe(0xa5);
    } finally {
      harness.dispose();
    }
  });
});
