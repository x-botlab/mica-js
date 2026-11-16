import { describe, expect, it } from 'vitest';
import { SERVICE_PC, SETTLE_PC } from '../../iap15f2k61s2/src/kernel/tick.ts';
import { createSourceHarness } from './source-harness.ts';
import type { SourceHarness } from './source-harness.ts';

/**
 * UART1 异步接收的边沿路径专项。
 *
 * 默认 P3_0、模式 1/3、REN=1 且位时间 >= 32 个系统时钟时，空闲接收不再按 1/8 位
 * 时间轮询，而是由下降沿唤醒服务块；其余配置仍走原来的轮询。这里覆盖只靠
 * `faults` 无法区分的性质：空闲服务次数、沿相位/毛刺/REN 打开时机、32/24 个时钟
 * 的门槛、停止位后立即起始的背靠背帧，以及 `uart1Rx` 话题与 RI 忙时的丢弃。
 *
 * 时序单位均为皮秒；默认 1 MHz 时钟下一个周期是 1 µs。各用例只使用源码级夹具，
 * 不依赖 `mica build` 产物。
 */

const US = 1_000_000;

const PUSH_PULL_P2 = [0x75, 0x96, 0xff, 0x75, 0x95, 0x00]; // MOV P2M0,#0FFH ; MOV P2M1,#00H

const P2_PINS = Array.from({ length: 8 }, (_, bit) => `P2_${bit}`);

/** 模式 1、REN=1，循环等待 RI；默认清 RI 后把 SBUF 写到 P2。 */
function receiveImage(divisor: number, clearRi = true): Uint8Array {
  const reload = 0x1_0000 - divisor;
  const code = [
    ...PUSH_PULL_P2,
    0x75,
    0x8e,
    0x05, // MOV AUXR,#05H  T2x12=1
    0x75,
    0xd7,
    reload & 0xff, // MOV T2L,#low
    0x75,
    0xd6,
    (reload >> 8) & 0xff, // MOV T2H,#high
    0x75,
    0x98,
    0x50, // MOV SCON,#50H  模式 1、REN=1
  ];
  const loop = code.length;

  code.push(0x30, 0x98, 0xfd); // JNB RI,$
  if (clearRi) code.push(0xc2, 0x98); // CLR RI
  code.push(0xe5, 0x99, 0xf5, 0xa0); // MOV A,SBUF ; MOV P2,A
  const jump = code.length;

  code.push(0x80, (loop - (jump + 2)) & 0xff); // SJMP loop

  return Uint8Array.from(code);
}

/** 起始位、8 个数据位（低位先）、可选第 9 位、停止位。 */
function frameLevels(data: number, ninth?: number): (0 | 1)[] {
  const levels: (0 | 1)[] = [0];

  for (let bit = 0; bit < 8; bit += 1) levels.push(((data >> bit) & 1) as 0 | 1);
  if (ninth !== undefined) levels.push(ninth as 0 | 1);
  levels.push(1);

  return levels;
}

function runTo(harness: SourceHarness, untilPs: number, stepPs = US): void {
  while (harness.board.time < untilPs) {
    harness.board.runUntil(Math.min(untilPs, harness.board.time + stepPs));
  }
}

/** 在 `startPs` 起按位时间注入一帧，返回停止位结束时刻。 */
function sendFrame(
  harness: SourceHarness,
  pin: string,
  data: number,
  startPs: number,
  bitPs: number,
  ninth?: number,
): number {
  harness.board.runUntil(startPs);

  const levels = frameLevels(data, ninth);

  levels.forEach((level, index) => {
    harness.drive(pin, level);
    harness.board.runUntil(startPs + (index + 1) * bitPs);
  });

  return startPs + levels.length * bitPs;
}

/** 分步推进直到 P2 出现期望字节；返回是否在期限内看到。 */
function waitForByte(
  harness: SourceHarness,
  expected: number,
  untilPs: number,
  stepPs = US,
): boolean {
  while (harness.board.time < untilPs) {
    harness.board.runUntil(Math.min(untilPs, harness.board.time + stepPs));
    if (harness.port(2) === expected) return true;
  }

  return harness.port(2) === expected;
}

interface Execute {
  (
    host: unknown,
    args?: readonly unknown[],
    reaction?: unknown,
  ): Generator<unknown, unknown, unknown>;
}

interface CachedInstruction {
  readonly pc: number;
  execute: Execute;
}

interface JitLike {
  readonly cache: Map<number, CachedInstruction>;
  readonly direct: { readonly pcs: ReadonlySet<number> } | undefined;
}

interface BlockProbe {
  translations: number;
  executions: number;
}

interface JitProbe {
  readonly service: BlockProbe;
  readonly settle: BlockProbe;
  readonly jit: JitLike;
}

/**
 * 测试内探针：包住 JIT 缓存插入与共享块的执行函数，统计本板的 SERVICE/SETTLE。
 *
 * 不改生产代码，也不依赖 `faults`。直接后端不支持 `readSample`，两个块因此始终走
 * 解释路径（用例末尾用 `direct.pcs` 复核），执行包装能看到每一次进入。
 */
function probeBlocks(harness: SourceHarness): JitProbe {
  const runtime = harness.board as unknown as { readonly jits?: readonly JitLike[] };
  const jit = runtime.jits?.[0];

  if (jit === undefined) throw new Error('MCU JIT is missing');

  const service: BlockProbe = { translations: 0, executions: 0 };
  const settle: BlockProbe = { translations: 0, executions: 0 };
  const cache = jit.cache;
  const insert = cache.set.bind(cache);

  cache.set = (pc, instruction) => {
    const block = pc === SERVICE_PC ? service : pc === SETTLE_PC ? settle : undefined;

    if (block !== undefined) {
      block.translations += 1;

      const execute = instruction.execute;

      instruction.execute = (...args) => {
        block.executions += 1;

        return execute(...args);
      };
    }

    return insert(pc, instruction);
  };

  return { service, settle, jit };
}

interface IdleResult {
  readonly serviceTranslations: number;
  readonly settleTranslations: number;
  readonly serviceGrowth: number;
  readonly settleGrowth: number;
  readonly serviceExecutions: number;
  readonly settleExecutions: number;
  readonly directService: boolean;
  readonly faults: readonly string[];
}

/** 收一帧后进入空闲窗口，统计窗口内新增的两个共享块翻译与执行次数。 */
async function measureIdle(divisor: number): Promise<IdleResult> {
  const bitPs = 4 * divisor * US;
  const harness = await createSourceHarness({
    firmware: receiveImage(divisor),
    observe: [...P2_PINS],
    drive: ['P3_0'],
    samplePeriodPs: 200_000,
  });
  const probe = probeBlocks(harness);

  try {
    harness.drive('P3_0', 1);
    runTo(harness, 30 * US);

    const start = 40 * US;

    sendFrame(harness, 'P3_0', 0x5a, start, bitPs);
    expect(waitForByte(harness, 0x5a, start + 14 * bitPs)).toBe(true);
    // 让停止位之后的收尾服务落下来，再清空执行计数进入纯空闲。
    runTo(harness, start + 18 * bitPs);

    const serviceTranslations = probe.service.translations;
    const settleTranslations = probe.settle.translations;

    probe.service.executions = 0;
    probe.settle.executions = 0;
    const windowStart = harness.board.time;

    runTo(harness, windowStart + 4_000 * US, 10 * US);

    return {
      serviceTranslations,
      settleTranslations,
      serviceGrowth: probe.service.translations - serviceTranslations,
      settleGrowth: probe.settle.translations - settleTranslations,
      serviceExecutions: probe.service.executions,
      settleExecutions: probe.settle.executions,
      directService: probe.jit.direct?.pcs.has(SERVICE_PC) === true,
      faults: [...harness.faults],
    };
  } finally {
    harness.dispose();
  }
}

/** 边沿资格已启用、循环只读 TL0 的固件（TL0 属“非 SCON/SBUF timed read”）。 */
function timedReadImage(divisor: number): Uint8Array {
  const reload = 0x1_0000 - divisor;
  const code = [
    ...PUSH_PULL_P2,
    0x75,
    0x8e,
    0x05, // MOV AUXR,#05H
    0x75,
    0xd7,
    reload & 0xff, // MOV T2L,#low
    0x75,
    0xd6,
    (reload >> 8) & 0xff, // MOV T2H,#high
    0x75,
    0x98,
    0x50, // MOV SCON,#50H  模式 1、REN=1
  ];
  const loop = code.length;

  code.push(0xe5, 0x8a); // MOV A,TL0
  const jump = code.length;

  code.push(0x80, (loop - (jump + 2)) & 0xff); // SJMP loop

  return Uint8Array.from(code);
}

/**
 * 1 ms 自动重装 T0 + 边沿空闲 UART1 的固件：主循环只执行 `JNB RI,$`。
 * ISR 每溢出一次 `INC P2`，用末值检查中断时间账。
 */
function timerIdleImage(): Uint8Array {
  const image = new Uint8Array(0x100);

  image.set([0x02, 0x00, 0x30], 0x000); // LJMP 0030H
  image.set([0x02, 0x00, 0x60], 0x00b); // T0 中断 → 0060H
  image.set(
    [
      ...PUSH_PULL_P2,
      0x75,
      0xa0,
      0x00, // MOV P2,#00H
      0x75,
      0x8e,
      0x85, // MOV AUXR,#85H  T0 1T、T2x12、S1ST2
      0x75,
      0x89,
      0x00, // MOV TMOD,#00H  T0 16 位自动重装
      0x75,
      0x8c,
      0xfc, // MOV TH0,#0FCH
      0x75,
      0x8a,
      0x18, // MOV TL0,#18H 1000 个周期 = 1 ms
      0x75,
      0xd7,
      0xf6, // MOV T2L,#0F6H
      0x75,
      0xd6,
      0xff, // MOV T2H,#0FFH 位时间 40 个周期
      0x75,
      0x98,
      0x50, // MOV SCON,#50H  模式 1、REN=1
      0xd2,
      0x8c, // SETB TR0
      0xd2,
      0xa9, // SETB ET0
      0xd2,
      0xaf, // SETB EA
      0x30,
      0x98,
      0xfd, // JNB RI,$
    ],
    0x30,
  );
  image.set([0x05, 0xa0, 0x32], 0x60); // INC P2 ; RETI

  return image;
}

describe('串口 1 边沿接收', () => {
  it('空闲长窗口的共享块执行不随位率增长，短位时间仍回退轮询', async () => {
    const fast = await measureIdle(10); // 40 个时钟/位
    const slow = await measureIdle(100); // 400 个时钟/位
    const fallback = await measureIdle(6); // 24 个时钟/位，低于 32 的门槛

    for (const result of [fast, slow, fallback]) {
      expect(result.faults).toEqual([]);
      expect(result.serviceTranslations).toBe(1); // 两个共享块各只翻译一次并被缓存
      expect(result.settleTranslations).toBe(1);
      expect(result.serviceGrowth).toBe(0);
      expect(result.settleGrowth).toBe(0);
      expect(result.directService).toBe(false);
    }

    // 边沿优化下空闲没有位率驱动的轮询：`JNB RI` 只读 SCON，跳过结算，
    // 两个位率在窗口内都不进 SERVICE 或 SETTLE。
    expect(fast.serviceExecutions).toBe(0);
    expect(fast.settleExecutions).toBe(0);
    expect(slow.serviceExecutions).toBe(0);
    expect(slow.settleExecutions).toBe(0);
    expect(slow.serviceExecutions).toBe(fast.serviceExecutions);

    // 低于 32 个时钟的门槛后回到 1/8 位时间轮询，窗口内服务次数明显增长。
    expect(fallback.serviceExecutions).toBeGreaterThan(100);
  });

  it('位时间恰为 32 个系统时钟时仍由起始位沿接收', async () => {
    const atThreshold = await measureIdle(8); // 4 × 8 = 32 个时钟/位，恰在门槛上

    expect(atThreshold.faults).toEqual([]);
    expect(atThreshold.serviceTranslations).toBe(1);
    expect(atThreshold.settleTranslations).toBe(1);
    expect(atThreshold.serviceGrowth).toBe(0);
    expect(atThreshold.settleGrowth).toBe(0);
    expect(atThreshold.directService).toBe(false);
    expect(atThreshold.serviceExecutions).toBe(0); // 门槛上仍走边沿路径，不做 1/8 位轮询
    expect(atThreshold.settleExecutions).toBe(0); // SCON 只读也不进前置结算
  });

  it('MOV A,TL0 仍走保守结算：边沿空闲不掩盖其它时间相关读', async () => {
    const harness = await createSourceHarness({
      firmware: timedReadImage(10), // 40 个时钟/位，边沿资格成立
      observe: [...P2_PINS],
      drive: ['P3_0'],
      samplePeriodPs: 200_000,
    });
    const probe = probeBlocks(harness);

    try {
      harness.drive('P3_0', 1);
      runTo(harness, 30 * US);

      probe.service.executions = 0;
      probe.settle.executions = 0;
      const windowStart = harness.board.time;

      runTo(harness, windowStart + 4_000 * US, 10 * US);

      expect(harness.faults).toEqual([]);
      expect(probe.settle.executions).toBeGreaterThan(100);
      expect(probe.service.executions).toBe(0); // 没有定时器/串口活动，只由读触发结算
    } finally {
      harness.dispose();
    }
  });

  it('边沿空闲跳过 SCON 结算不推迟定时器：JNB RI 循环中 21 ms 溢出中断 21 次', async () => {
    const harness = await createSourceHarness({
      firmware: timerIdleImage(),
      clockFrequency: 1_000_000,
      observe: [...P2_PINS],
      drive: ['P3_0'],
      samplePeriodPs: 200_000,
    });
    const probe = probeBlocks(harness);

    try {
      harness.drive('P3_0', 1);
      harness.board.runUntil(100_000_000); // 100 µs，越过启动配置

      probe.service.executions = 0;
      probe.settle.executions = 0;
      harness.board.runUntil(21_100_000_000); // 再跑 21 ms

      expect(harness.faults).toEqual([]);
      expect(harness.port(2)).toBe(21); // 1 ms 自动重装中断没有因跳过结算而丢拍
      expect(probe.settle.executions).toBe(0); // JNB RI 只读 SCON 仍跳过结算
      expect(probe.service.executions).toBeGreaterThanOrEqual(21); // 定时器照常得到服务
    } finally {
      harness.dispose();
    }
  });

  it('不同沿相位注入的正常帧都按位中点采样正确', async () => {
    const bitPs = 40 * US;
    const harness = await createSourceHarness({
      firmware: receiveImage(10),
      observe: [...P2_PINS],
      drive: ['P3_0'],
      samplePeriodPs: 200_000,
    });

    try {
      harness.drive('P3_0', 1);
      runTo(harness, 30 * US);

      // 起始沿落在一个位内的不同相位，避免只碰巧测到与节拍对齐的位置。
      const phases = [0.13, 0.47, 0.83];
      const values = [0x3c, 0xa5, 0x69];
      let start = 40 * US;

      phases.forEach((phase, index) => {
        start += Math.round(phase * bitPs);

        const end = sendFrame(harness, 'P3_0', values[index] as number, start, bitPs);

        expect(waitForByte(harness, values[index] as number, end + 4 * bitPs)).toBe(true);
        start = end + 2 * bitPs;
      });

      expect(harness.faults).toEqual([]);
    } finally {
      harness.dispose();
    }
  });

  it('短毛刺被起始位中点拒绝，随后正常帧仍能接收', async () => {
    const bitPs = 40 * US;
    const harness = await createSourceHarness({
      firmware: receiveImage(10),
      observe: [...P2_PINS],
      drive: ['P3_0'],
      samplePeriodPs: 200_000,
    });

    try {
      harness.drive('P3_0', 1);
      runTo(harness, 30 * US);

      // 0.3 位宽的低脉冲：足以唤醒边沿路径，但到不了起始位中点。
      const glitch = 30 * US;

      harness.board.runUntil(glitch);
      harness.drive('P3_0', 0);
      harness.board.runUntil(glitch + Math.round(0.3 * bitPs));
      harness.drive('P3_0', 1);

      runTo(harness, glitch + 2 * bitPs);
      expect(harness.port(2)).toBe(0xff); // 没有装载任何字节

      const start = glitch + 3 * bitPs;
      const end = sendFrame(harness, 'P3_0', 0x5a, start, bitPs);

      expect(waitForByte(harness, 0x5a, end + 4 * bitPs)).toBe(true);
      expect(harness.faults).toEqual([]);
    } finally {
      harness.dispose();
    }
  });

  it('线上为低时打开 REN：不误收低电平帧，松手后的正常帧可接收', async () => {
    const bitPs = 40 * US;
    const harness = await createSourceHarness({
      firmware: receiveImage(10),
      observe: [...P2_PINS],
      drive: ['P3_0'],
      samplePeriodPs: 200_000,
    });
    const received: number[] = [];
    const subscription = harness.board.topics.onDidReceive(({ topic, payload }) => {
      if (topic === 'uart1Rx') received.push(...(payload as Uint8Array));
    });

    try {
      // 固件约在 10 µs 写 SCON 打开 REN，此时线上已经是低电平。
      harness.drive('P3_0', 0);
      runTo(harness, 20 * US);
      harness.drive('P3_0', 1); // 在起始位中点之前释放，伪帧应被拒绝

      runTo(harness, 60 * US);
      expect(harness.port(2)).toBe(0xff);
      expect(received).toEqual([]);

      const end = sendFrame(harness, 'P3_0', 0x3c, 80 * US, bitPs);

      expect(waitForByte(harness, 0x3c, end + 4 * bitPs)).toBe(true);
      expect(received).toEqual([0x3c]);
      expect(harness.faults).toEqual([]);
    } finally {
      subscription.dispose();
      harness.dispose();
    }
  });

  it('uart1Rx 帧间有 2 位空闲时按序发布每个完整字节', async () => {
    const bitPs = 40 * US;
    const harness = await createSourceHarness({
      firmware: receiveImage(10),
      observe: [...P2_PINS],
      drive: ['P3_0'],
      samplePeriodPs: 200_000,
    });
    const received: number[] = [];
    const subscription = harness.board.topics.onDidReceive(({ topic, payload }) => {
      if (topic === 'uart1Rx') received.push(...(payload as Uint8Array));
    });

    try {
      harness.drive('P3_0', 1);
      runTo(harness, 30 * US);

      let start = 40 * US;

      for (const value of [0x00, 0xff, 0x5a])
        start = sendFrame(harness, 'P3_0', value, start, bitPs) + 2 * bitPs;

      runTo(harness, start);
      expect(received).toEqual([0x00, 0xff, 0x5a]);
      expect(harness.port(2)).toBe(0x5a);
      expect(harness.faults).toEqual([]);
    } finally {
      subscription.dispose();
      harness.dispose();
    }
  });

  it('uart1Rx 停止位后立即起始的背靠背帧仍按序发布', async () => {
    const bitPs = 40 * US;
    const harness = await createSourceHarness({
      firmware: receiveImage(10),
      observe: [...P2_PINS],
      drive: ['P3_0'],
      samplePeriodPs: 200_000,
    });
    const received: number[] = [];
    const subscription = harness.board.topics.onDidReceive(({ topic, payload }) => {
      if (topic === 'uart1Rx') received.push(...(payload as Uint8Array));
    });

    try {
      harness.drive('P3_0', 1);
      runTo(harness, 30 * US);

      const values = [0x00, 0xff, 0x5a];
      let start = 40 * US;

      // 每帧停止位结束的时刻就是下一帧起始位开始，帧间没有空闲高电平。
      for (const value of values) start = sendFrame(harness, 'P3_0', value, start, bitPs);

      runTo(harness, start + 4 * bitPs);
      expect(received).toEqual([0x00, 0xff, 0x5a]);
      expect(harness.port(2)).toBe(0x5a);
      expect(harness.faults).toEqual([]);
    } finally {
      subscription.dispose();
      harness.dispose();
    }
  });

  it('uart1Rx 在 RI 忙时丢弃后续帧', async () => {
    const bitPs = 40 * US;
    const harness = await createSourceHarness({
      firmware: receiveImage(10, false), // 不清 RI：第一帧后接收端保持忙
      observe: [...P2_PINS],
      drive: ['P3_0'],
      samplePeriodPs: 200_000,
    });
    const received: number[] = [];
    const subscription = harness.board.topics.onDidReceive(({ topic, payload }) => {
      if (topic === 'uart1Rx') received.push(...(payload as Uint8Array));
    });

    try {
      harness.drive('P3_0', 1);
      runTo(harness, 30 * US);

      const firstEnd = sendFrame(harness, 'P3_0', 0x11, 40 * US, bitPs);

      expect(waitForByte(harness, 0x11, firstEnd + 4 * bitPs)).toBe(true);

      const secondStart = firstEnd + 3 * bitPs;

      sendFrame(harness, 'P3_0', 0x22, secondStart, bitPs);
      runTo(harness, secondStart + 13 * bitPs);

      expect(harness.port(2)).toBe(0x11); // RI 未清，第二个字节不进 SBUF
      expect(received).toEqual([0x11]);
      expect(harness.faults).toEqual([]);
    } finally {
      subscription.dispose();
      harness.dispose();
    }
  });
});
