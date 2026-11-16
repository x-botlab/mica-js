import { describe, expect, it } from 'vitest';
import { createSourceHarness } from './source-harness.ts';
import type { SourceHarness } from './source-harness.ts';

/**
 * UART1 默认通道（P3_0、异步模式、位时间 >= 32 个系统时钟）边沿接收的配置写入专项。
 *
 * `uart-edge.test.ts` 覆盖空闲服务次数、沿相位、毛刺与 REN 打开时机；这里补的是
 * 「帧进行中或帧前写配置寄存器」的五条性质：
 *
 * 1. 帧中写同一模式的 SCON、只清 RI/TI/SM2，不取消当前帧；
 * 2. 真正关闭 REN 会取消当前帧，重新打开后可接收恢复帧；
 * 3. 有效位时间、模式或引脚复用变化会丢弃旧帧，旧帧不写 SBUF/话题；
 * 4. UART1 与 UART2 同时 REN 且位时间不同时，各自按自己的相位推进；
 * 5. 位时间已配置、线上已经为低时再打开 REN：候选沿锚定在使能时刻（启动阶段的
 *    多次配置取消不属于这一情形）。
 *
 * 时序单位均为皮秒；1 MHz 时钟下 1 个系统时钟是 1 µs，MOV direct,#imm 为 3 µs。
 * 各固件里的延时循环与注释给出明确的写入时刻，测试按这些时刻安排注入。
 */

const US = 1_000_000;
const BIT = 40 * US;

const PUSH_PULL_P0 = [0x75, 0x94, 0xff, 0x75, 0x93, 0x00]; // MOV P0M0,#0FFH ; MOV P0M1,#00H
const PUSH_PULL_P1 = [0x75, 0x92, 0xff, 0x75, 0x91, 0x00]; // MOV P1M0,#0FFH ; MOV P1M1,#00H
const PUSH_PULL_P2 = [0x75, 0x96, 0xff, 0x75, 0x95, 0x00]; // MOV P2M0,#0FFH ; MOV P2M1,#00H

const P0_PINS = Array.from({ length: 8 }, (_, bit) => `P0_${bit}`);
const P1_PINS = Array.from({ length: 8 }, (_, bit) => `P1_${bit}`);
const P2_PINS = Array.from({ length: 8 }, (_, bit) => `P2_${bit}`);

/** 起始位、8 个数据位（低位先）、停止位。 */
function frameLevels(data: number): (0 | 1)[] {
  const levels: (0 | 1)[] = [0];

  for (let bit = 0; bit < 8; bit += 1) levels.push(((data >> bit) & 1) as 0 | 1);
  levels.push(1);

  return levels;
}

/**
 * 从 `startPs` 起按位时间注入 `count` 个电平，返回最后一个电平的结束时刻。
 *
 * `count` 小于完整帧长度时，调用方随后自行把引脚拉高，用来模拟配置改变后旧帧
 * 不再继续到达的情况。
 */
function driveFrame(
  harness: SourceHarness,
  pin: string,
  levels: readonly (0 | 1)[],
  startPs: number,
  bitPs: number,
  count = levels.length,
): number {
  harness.board.runUntil(startPs);

  for (let index = 0; index < count; index += 1) {
    harness.drive(pin, levels[index] as 0 | 1);
    harness.board.runUntil(startPs + (index + 1) * bitPs);
  }

  return startPs + count * bitPs;
}

interface Rig {
  readonly harness: SourceHarness;
  readonly received: number[];
  close(): void;
}

/** 源码级板级夹具，并收集 `uart1Rx` 话题发布的每个字节。 */
async function boot(
  firmware: Uint8Array,
  observe: readonly string[],
  drive: readonly string[],
): Promise<Rig> {
  const harness = await createSourceHarness({
    firmware,
    observe,
    drive,
    samplePeriodPs: 200_000,
  });
  const received: number[] = [];
  const subscription = harness.board.topics.onDidReceive(({ topic, payload }) => {
    if (topic === 'uart1Rx') received.push(...(payload as Uint8Array));
  });

  return {
    harness,
    received,
    close() {
      subscription.dispose();
      harness.dispose();
    },
  };
}

/**
 * 帧进行中改变配置的固件。
 *
 * 24 µs 完成 P1/P2 推挽、T2 位时间（40 µs）与 SCON=0x50；延时 178 µs（起始沿在
 * 80 µs，因此约在帧内第 3 位）执行 `change`；再延时 50 µs 执行 `restore`，随后把
 * SCON&3 快照写到 P1（取消后 RI 应为 0），再等恢复帧的 RI 并发布状态与字节。
 */
function reconfigureImage(change: readonly number[], restore: readonly number[]): Uint8Array {
  return Uint8Array.from([
    ...PUSH_PULL_P1,
    ...PUSH_PULL_P2,
    0x75,
    0x8e,
    0x05, // MOV AUXR,#05H  T2x12=1、S1ST2=1
    0x75,
    0xd7,
    0xf6, // MOV T2L,#0F6H  位时间 40 µs
    0x75,
    0xd6,
    0xff, // MOV T2H,#0FFH
    0x75,
    0x98,
    0x50, // MOV SCON,#50H  模式 1、REN=1
    0x7f,
    0x2c, // MOV R7,#44
    0xdf,
    0xfe, // DJNZ R7,$ 178 µs
    ...change,
    0x7f,
    0x0c, // MOV R7,#12
    0xdf,
    0xfe, // DJNZ R7,$ 50 µs
    ...restore,
    0xe5,
    0x98,
    0x54,
    0x03,
    0xf5,
    0x90, // MOV A,SCON ; ANL A,#03H ; MOV P1,A（旧帧取消后 RI/TI=0）
    0x30,
    0x98,
    0xfd, // JNB RI,$
    0xe5,
    0x98,
    0x54,
    0x03,
    0xf5,
    0x90, // MOV A,SCON ; ANL A,#03H ; MOV P1,A（恢复帧 RI=1、TI=0）
    0xe5,
    0x99,
    0xf5,
    0xa0, // MOV A,SBUF ; MOV P2,A
    0x80,
    0xfe, // SJMP $
  ]);
}

describe('串口 1 边沿接收的配置写入', () => {
  it('帧中同模式写 SCON 清 RI/TI/SM2 不取消当前帧', async () => {
    const rig = await boot(
      Uint8Array.from([
        ...PUSH_PULL_P1,
        ...PUSH_PULL_P2,
        0x75,
        0x8e,
        0x05, // MOV AUXR,#05H
        0x75,
        0xd7,
        0xf6, // MOV T2L,#0F6H
        0x75,
        0xd6,
        0xff, // MOV T2H,#0FFH
        0x75,
        0x98,
        0x73, // MOV SCON,#73H  模式 1、REN、SM2、TI、RI 全置位
        0x7f,
        0x2c, // MOV R7,#44
        0xdf,
        0xfe, // DJNZ R7,$ 178 µs：24 µs 配置后约在起始沿后第 3 位
        0x75,
        0x98,
        0x50, // MOV SCON,#50H  同模式，清 RI/TI/SM2
        0x30,
        0x98,
        0xfd, // JNB RI,$
        0xe5,
        0x98,
        0x54,
        0x03,
        0xf5,
        0x90, // MOV A,SCON ; ANL A,#03H ; MOV P1,A
        0xe5,
        0x99,
        0xf5,
        0xa0, // MOV A,SBUF ; MOV P2,A
        0x80,
        0xfe, // SJMP $
      ]),
      [...P1_PINS, ...P2_PINS],
      ['P3_0'],
    );

    try {
      rig.harness.drive('P3_0', 1);
      driveFrame(rig.harness, 'P3_0', frameLevels(0xa6), 80 * US, BIT);
      rig.harness.board.runUntil(520 * US);

      expect(rig.harness.port(2)).toBe(0xa6);
      expect(rig.harness.port(1)).toBe(0x01); // RI=1、TI=0
      expect(rig.received).toEqual([0xa6]);
      expect(rig.harness.faults).toEqual([]);
    } finally {
      rig.close();
    }
  });

  it('关闭 REN 取消当前帧，重新打开后可接收恢复帧', async () => {
    const rig = await boot(
      Uint8Array.from([
        ...PUSH_PULL_P0,
        ...PUSH_PULL_P1,
        ...PUSH_PULL_P2,
        0x75,
        0x8e,
        0x05, // MOV AUXR,#05H
        0x75,
        0xd7,
        0xf6, // MOV T2L,#0F6H
        0x75,
        0xd6,
        0xff, // MOV T2H,#0FFH
        0x75,
        0x98,
        0x50, // MOV SCON,#50H  30 µs 打开 REN
        0x7f,
        0x2b, // MOV R7,#43
        0xdf,
        0xfe, // DJNZ R7,$ 174 µs：204 µs 清 REN（起始沿后第 3 位）
        0x75,
        0x98,
        0x40, // MOV SCON,#40H  REN=0，取消旧帧
        0x7f,
        0x0c, // MOV R7,#12
        0xdf,
        0xfe, // DJNZ R7,$ 50 µs
        0xe5,
        0x98,
        0x54,
        0x01,
        0xf5,
        0x80, // MOV A,SCON ; ANL A,#01H ; MOV P0,A（取消后 RI 应为 0）
        0x75,
        0x98,
        0x50, // MOV SCON,#50H  线上已高，重新打开 REN
        0x30,
        0x98,
        0xfd, // JNB RI,$
        0xe5,
        0x98,
        0x54,
        0x03,
        0xf5,
        0x90, // MOV A,SCON ; ANL A,#03H ; MOV P1,A
        0xe5,
        0x99,
        0xf5,
        0xa0, // MOV A,SBUF ; MOV P2,A
        0x80,
        0xfe, // SJMP $
      ]),
      [...P0_PINS, ...P1_PINS, ...P2_PINS],
      ['P3_0'],
    );

    try {
      rig.harness.drive('P3_0', 1);
      // 只注入起始位与 3 个数据位，在取消后由测试把线拉高。
      driveFrame(rig.harness, 'P3_0', frameLevels(0x5a), 80 * US, BIT, 4);
      rig.harness.drive('P3_0', 1);

      rig.harness.board.runUntil(300 * US);
      expect(rig.harness.port(0)).toBe(0x00); // 取消后、重开前的 RI 快照
      expect(rig.harness.port(2)).toBe(0xff); // 旧帧未写 SBUF
      expect(rig.received).toEqual([]);

      driveFrame(rig.harness, 'P3_0', frameLevels(0x96), 340 * US, BIT);
      rig.harness.board.runUntil(800 * US);

      expect(rig.harness.port(2)).toBe(0x96);
      expect(rig.harness.port(1)).toBe(0x01); // 恢复帧 RI=1、TI=0
      expect(rig.received).toEqual([0x96]);
      expect(rig.harness.faults).toEqual([]);
    } finally {
      rig.close();
    }
  });

  const changes = [
    {
      name: '有效位时间',
      change: [0x75, 0xd7, 0xec, 0x75, 0xd6, 0xff], // T2 重装 20 → 位时间 80 µs
      restore: [0x75, 0xd7, 0xf6, 0x75, 0xd6, 0xff],
    },
    {
      name: '模式',
      change: [0x75, 0x98, 0xd0], // 模式 3
      restore: [0x75, 0x98, 0x50], // 模式 1
    },
    {
      name: '复用',
      change: [0x75, 0xa2, 0x40], // P_SW1.S1_S1:S1_S0 = 01（RXD 改到 P3_6）
      restore: [0x75, 0xa2, 0x00],
    },
  ];

  for (const { name, change, restore } of changes) {
    it(`帧中改变${name}丢弃旧帧，恢复配置后可接收`, async () => {
      const rig = await boot(reconfigureImage(change, restore), [...P1_PINS, ...P2_PINS], [
        'P3_0',
      ]);

      try {
        rig.harness.drive('P3_0', 1);
        // 旧帧在第 3 位后被取消；拉高后旧帧的后续位不再到达。
        driveFrame(rig.harness, 'P3_0', frameLevels(0x5a), 80 * US, BIT, 4);
        rig.harness.drive('P3_0', 1);

        rig.harness.board.runUntil(520 * US);
        expect(rig.harness.port(1)).toBe(0x00); // restore 后的 RI/TI 快照
        expect(rig.harness.port(2)).toBe(0xff); // 旧帧既不写 SBUF
        expect(rig.received).toEqual([]); // 也不发布话题

        driveFrame(rig.harness, 'P3_0', frameLevels(0x9c), 560 * US, BIT);
        rig.harness.board.runUntil(1020 * US);

        expect(rig.harness.port(2)).toBe(0x9c);
        expect(rig.harness.port(1)).toBe(0x01); // 恢复帧 RI=1、TI=0
        expect(rig.received).toEqual([0x9c]);
        expect(rig.harness.faults).toEqual([]);
      } finally {
        rig.close();
      }
    });
  }

  it('UART1 与 UART2 同时 REN 且位时间不同时互不串扰', async () => {
    const rig = await boot(
      Uint8Array.from([
        ...PUSH_PULL_P2,
        ...PUSH_PULL_P0,
        0x75,
        0x92,
        0xfc, // MOV P1M0,#0FCH  P1.2/P1.3 推挽，P1.0/P1.1 保持输入
        0x75,
        0x91,
        0x00, // MOV P1M1,#00H
        0x75,
        0x87,
        0x80, // MOV PCON,#80H  SMOD=1
        0x75,
        0x8e,
        0x44, // MOV AUXR,#44H  T1x12=1、T2x12=1，UART1 用 T1
        0x75,
        0x89,
        0x20, // MOV TMOD,#20H  T1 模式 2
        0x75,
        0x8d,
        0xfd, // MOV TH1,#0FDH  UART1 位时间 16×3 = 48 µs
        0x75,
        0x8b,
        0xfd, // MOV TL1,#0FDH
        0x75,
        0xd7,
        0xf6, // MOV T2L,#0F6H  UART2 位时间 40 µs
        0x75,
        0xd6,
        0xff, // MOV T2H,#0FFH
        0x75,
        0x98,
        0x50, // MOV SCON,#50H  UART1 REN
        0x75,
        0x9a,
        0x10, // MOV S2CON,#10H UART2 REN
        0xc2,
        0x92, // CLR P1.2
        0xc2,
        0x93, // CLR P1.3
        0x30,
        0x98,
        0xfd, // JNB RI,$（等 UART1）
        0xe5,
        0x99,
        0xf5,
        0xa0, // MOV A,SBUF ; MOV P2,A
        0xe5,
        0x9a,
        0x30,
        0xe0,
        0xfb, // MOV A,S2CON ; JNB ACC.0,$（等 S2RI）
        0xe5,
        0x9b,
        0xf5,
        0x80, // MOV A,S2BUF ; MOV P0,A
        0xa2,
        0x98, // MOV C,RI
        0x92,
        0x92, // MOV P1.2,C
        0xe5,
        0x9a, // MOV A,S2CON
        0xa2,
        0xe0, // MOV C,ACC.0
        0x92,
        0x93, // MOV P1.3,C
        0x80,
        0xfe, // SJMP $
      ]),
      ['P1_2', 'P1_3', ...P0_PINS, ...P2_PINS],
      ['P3_0', 'P1_0'],
    );

    try {
      rig.harness.drive('P3_0', 1);
      rig.harness.drive('P1_0', 1);
      rig.harness.board.runUntil(120 * US);

      const first = frameLevels(0x5a);
      const second = frameLevels(0xc3);
      const span = Math.max(first.length * 48 * US, second.length * 40 * US);

      // 两帧同时从 120 µs 开始，各自按 48 µs / 40 µs 的位时间推进。
      for (let elapsed = 0; elapsed < span; elapsed += US) {
        const index1 = Math.min(first.length - 1, Math.floor(elapsed / (48 * US)));
        const index2 = Math.min(second.length - 1, Math.floor(elapsed / (40 * US)));

        rig.harness.drive('P3_0', first[index1] as 0 | 1);
        rig.harness.drive('P1_0', second[index2] as 0 | 1);
        rig.harness.board.runUntil(120 * US + elapsed + US);
      }

      rig.harness.board.runUntil(660 * US);

      expect(rig.harness.port(2)).toBe(0x5a);
      expect(rig.harness.port(0)).toBe(0xc3);
      expect(rig.harness.port(1) & 0x0c).toBe(0x0c); // P1.2=UART1 RI，P1.3=UART2 S2RI
      expect(rig.received).toEqual([0x5a]);
      expect(rig.harness.faults).toEqual([]);
    } finally {
      rig.close();
    }
  });

  it('位时间预配置后线上已低时打开 REN：候选沿锚定在使能时刻', async () => {
    const rig = await boot(
      Uint8Array.from([
        ...PUSH_PULL_P0,
        ...PUSH_PULL_P1,
        ...PUSH_PULL_P2,
        0x75,
        0x8e,
        0x05, // MOV AUXR,#05H
        0x75,
        0xd7,
        0xf6, // MOV T2L,#0F6H
        0x75,
        0xd6,
        0xff, // MOV T2H,#0FFH  位时间 40 µs，此时 REN 仍为 0
        0x7f,
        0x14, // MOV R7,#20
        0xdf,
        0xfe, // DJNZ R7,$ 82 µs：约 109 µs 才写 SCON，线上早已为低
        0x75,
        0x98,
        0x50, // MOV SCON,#50H  REN 真正由 0 变 1
        0x30,
        0x98,
        0xfd, // JNB RI,$
        0xe5,
        0x98,
        0x54,
        0x03,
        0xf5,
        0x90, // MOV A,SCON ; ANL A,#03H ; MOV P1,A
        0xe5,
        0x99,
        0xf5,
        0xa0, // MOV A,SBUF ; MOV P2,A
        0xc2,
        0x98, // CLR RI
        0x30,
        0x98,
        0xfd, // JNB RI,$
        0xe5,
        0x99,
        0xf5,
        0x80, // MOV A,SBUF ; MOV P0,A（恢复帧）
        0xe5,
        0x98,
        0x54,
        0x03,
        0xf5,
        0x90, // MOV A,SCON ; ANL A,#03H ; MOV P1,A
        0x80,
        0xfe, // SJMP $
      ]),
      [...P0_PINS, ...P1_PINS, ...P2_PINS],
      ['P3_0'],
    );

    try {
      rig.harness.drive('P3_0', 1);
      rig.harness.board.runUntil(60 * US);
      // 下降沿发生在 REN 打开之前；使能时线上已经是低电平。
      rig.harness.drive('P3_0', 0);

      rig.harness.board.runUntil(560 * US);
      // 候选沿锚定在使能时刻：持续低电平按起始位 + 8 个 0 + 低停止位收成 0x00。
      expect(rig.harness.port(2)).toBe(0x00);
      expect(rig.harness.port(1)).toBe(0x01); // RI=1、TI=0
      expect(rig.harness.port(0)).toBe(0xff); // 尚未收到恢复帧
      expect(rig.received).toEqual([0x00]);

      rig.harness.drive('P3_0', 1);
      rig.harness.board.runUntil(700 * US);
      driveFrame(rig.harness, 'P3_0', frameLevels(0x77), 700 * US, BIT);
      rig.harness.board.runUntil(1160 * US);

      expect(rig.harness.port(0)).toBe(0x77);
      expect(rig.harness.port(2)).toBe(0x00);
      expect(rig.harness.port(1)).toBe(0x01); // 恢复帧 RI=1、TI=0
      expect(rig.received).toEqual([0x00, 0x77]);
      expect(rig.harness.faults).toEqual([]);
    } finally {
      rig.close();
    }
  });
});
