import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import { createJitBlockBuilder, types } from '@mica-js/sdk/model';
import type { BlockIR, Value } from '@mica-js/sdk/model';
import { compileDDL } from '@mica-js/sdk/ddl';
import type { Board } from '@mica-js/sdk';
import { activateMachine } from '@mica-js/stm32g431rbt6-core/machine';
import type { Machine } from '@mica-js/stm32g431rbt6-core/machine';
import { PERIPHERAL_CLOCKS } from '@mica-js/stm32g431rbt6-core/clock-tree';
import type { PeripheralClockName } from '@mica-js/stm32g431rbt6-core/clock-tree';
import { PERIPH, RCC_RCC_STATE } from '@mica-js/stm32g431rbt6-core/layout';
import { readWordAt, writeWordAt } from '@mica-js/stm32g431rbt6-core/ir';
import {
  TIMER_STATE_SPECS,
  setTimerClockProvider,
  timerModule,
} from '@mica-js/stm32g431rbt6-core/tim';
import type { Body } from '@mica-js/stm32g431rbt6-core/ir';

/**
 * TIM 核心的专属 IR rig。
 *
 * 不是第二套 MCU：只有 `tim` memory、定时器内部 state、真实引脚和电气网络。JIT 的
 * 每个“指令”是测试给出的一个 IR 步骤，步骤用 `redirect` 安排下一时刻；这样可以在
 * 真实 `@mica-js/simulator` 板里验证整数计时、边沿捕获、PWM 输出和 IRQ 条件，同时
 * 不依赖中央尚未接线的 bus/GPIO/NVIC/DDL 集成。
 */

export type RigStep = (body: Body) => void;

export interface RigOptions {
  readonly steps: readonly RigStep[];
  readonly clockFrequency?: number;
  readonly probePeriodPs?: number;
}

export interface RigBoard {
  readonly board: Board;
  readonly time: () => number;
  readonly state: (name: string) => unknown;
  readonly probeHistory: readonly number[];
  readonly send: (pin: 'PA15' | 'PB4', level: 0 | 1) => void;
  runUntil(timePs: number): void;
  dispose(): void;
}

const stateLines = TIMER_STATE_SPECS.map(
  (spec) => `  state ${spec.name}: number = ${spec.initial};`,
).join('\n');

const RIG_MODEL = `
device TimRig {
  memory code[0x100];
  memory periph[0x1000];
  memory tim[0x300];
  state pc: number = 0;
  state pendingPs: number = 0;
  state tickPs: number = 1000000000000;
  state tickActive: bool = false;
  state periphActive: number = 0;
  state periphDeadline0: number = 0;
  state serviceMask: number = 0;
  state irqDirty: bool = false;
  state systickOn: bool = false;
  state systickLoad: number = 0;
  state txMask: number = 0;
  state tx1Active: number = 0;
  state tx1Remaining: number = 0;
  state tx1Queue: number = 0;
  state tx1Count: number = 0;
  state tx1Period: number = 1;
  state tx1Publish: number = -1;
  state tx2Active: number = 0;
  state tx2Remaining: number = 0;
  state tx2Queue: number = 0;
  state tx2Count: number = 0;
  state tx2Period: number = 1;
  state tx2Publish: number = -1;
  state tx3Active: number = 0;
  state tx3Remaining: number = 0;
  state tx3Queue: number = 0;
  state tx3Count: number = 0;
  state tx3Period: number = 1;
  state tx3Publish: number = -1;
  state gpioSync: number = 0;
  state gpioModer0: number = 0;
  state gpioModer1: number = 0;
  state gpioModer2: number = 0;
  state gpioModer3: number = 0;
  state gpioModer4: number = 0;
  state gpioAfr00: number = 0;
  state gpioAfr01: number = 0;
  state gpioAfr02: number = 0;
  state gpioAfr03: number = 0;
  state gpioAfr04: number = 0;
  state gpioAfr10: number = 0;
  state gpioAfr11: number = 0;
  state gpioAfr12: number = 0;
  state gpioAfr13: number = 0;
  state gpioAfr14: number = 0;
${stateLines}
  state result0: number = 0;
  state result1: number = 0;
  state result2: number = 0;
  state result3: number = 0;
  state result4: number = 0;
  state result5: number = 0;
  state result6: number = 0;
  state result7: number = 0;
  state runs: number = 0;
  state edgeCount: number = 0;
  pin VDD;
  pin VSS;
  pin PA0(low: 0.8, high: 2.0);
  pin PA1(low: 0.8, high: 2.0);
  pin PA2(low: 0.8, high: 2.0);
  pin PA3(low: 0.8, high: 2.0);
  pin PA5(low: 0.8, high: 2.0);
  pin PA6(low: 0.8, high: 2.0);
  pin PA7(low: 0.8, high: 2.0);
  pin PA8(low: 0.8, high: 2.0);
  pin PA9(low: 0.8, high: 2.0);
  pin PA10(low: 0.8, high: 2.0);
  pin PA11(low: 0.8, high: 2.0);
  pin PA15(low: 0.8, high: 2.0);
  pin PB0(low: 0.8, high: 2.0);
  pin PB1(low: 0.8, high: 2.0);
  pin PB3(low: 0.8, high: 2.0);
  pin PB4(low: 0.8, high: 2.0);
  pin PB5(low: 0.8, high: 2.0);
  pin PB6(low: 0.8, high: 2.0);
  pin PB7(low: 0.8, high: 2.0);
  pin PB8(low: 0.8, high: 2.0);
  pin PB9(low: 0.8, high: 2.0);
  pin PB10(low: 0.8, high: 2.0);
  pin PB11(low: 0.8, high: 2.0);
  pin PB14(low: 0.8, high: 2.0);
  pin PB15(low: 0.8, high: 2.0);
  pin PC0(low: 0.8, high: 2.0);
  pin PC1(low: 0.8, high: 2.0);
  pin PC2(low: 0.8, high: 2.0);
  pin PC3(low: 0.8, high: 2.0);
  pin PC6(low: 0.8, high: 2.0);
  pin PC7(low: 0.8, high: 2.0);
  pin PC8(low: 0.8, high: 2.0);
  pin PC9(low: 0.8, high: 2.0);
}
`;

export const TIM_PROBE_MODEL = `
device TimProbe(period: number default 10_000_000) {
  pin p(low: 0.8, high: 2.0);
  output channel level: number(capacity: 256, overflow: Overflow.drop_oldest);
  fn report() {
    if p.sample.level == Logic.high {
      level.send(1);
    } else if p.sample.level == Logic.low {
      level.send(0);
    } else {
      level.send(2);
    }
  }
  process start {
    report();
    loop {
      await ticks(period);
      report();
    }
  }
}
`;

export const TIM_SOURCE_MODEL = `
device TimSource {
  pin y;
  pin vcc;
  pin gnd;
  input channel level: number(capacity: 16, overflow: Overflow.drop_oldest);
  state wanted: number = 2;
  fn apply() {
    if wanted == 1 {
      y.intent <- [resistor(to: vcc, resistance: 25)];
    } else if wanted == 0 {
      y.intent <- [resistor(to: gnd, resistance: 25)];
    } else {
      y.intent <- [];
    }
  }
  process start {
    apply();
    loop {
      wanted = await level.receive();
      apply();
    }
  }
}
`;

interface Compiled {
  readonly model: unknown;
}

async function compile(model: string): Promise<Compiled> {
  return { model: await compileDDL(model) };
}

export async function createTimRig(options: RigOptions): Promise<RigBoard> {
  const [rigModel, probeModel, sourceModel] = await Promise.all([
    compile(RIG_MODEL),
    compile(TIM_PROBE_MODEL),
    compile(TIM_SOURCE_MODEL),
  ]);
  const clockFrequency = options.clockFrequency ?? 1_000_000;

  // rig 使用自己的 1 MHz 机器时钟，不受其它测试文件可能设置的 RCC provider 影响。
  setTimerClockProvider(undefined);
  const machine: Machine = {
    clockFrequency,
    cyclePs: Math.max(1, Math.round(1_000_000_000_000 / clockFrequency)),
    alternateDrivers: [],
    peripherals: [timerModule],
    interruptSources: [timerModule.interrupts ?? []].flat(),
    profile: 'tim-rig',
  };
  const probeHistory: number[] = [];
  const sources = new Map<'PA15' | 'PB4', { send(value: unknown): void }>();

  const createRig = () => {
    const registration = (context: {
      attachJit(options: unknown): { dispose(): void };
      loadBytes(name: string, bytes: Uint8Array, offset?: number): void;
    }) => {
      const attach = context.attachJit({
        entry: 'cpu',
        code: 'code',
        pc: 'pc',
        translate: (input: { readonly pc: number }): BlockIR =>
          activateMachine(machine, () => {
            const builder = createJitBlockBuilder();
            const pc = input.pc;
            const step = options.steps[pc >>> 1];

            builder.instruction({ pc, nextPc: pc }, (body) => {
              if (step === undefined) {
                body.stop();
                return;
              }
              step(body as Body);
            });

            return builder.finish();
          }),
      });
      context.loadBytes('code', new Uint8Array(0x100), 0);

      return {
        sync() {},
        dispose: () => attach.dispose(),
      };
    };

    return registration;
  };

  const createProbe = () => (context: { attachJit?: unknown }) => {
    void context;

    return {
      sync(batch: { readonly outputs: Readonly<Record<string, readonly { value: unknown }[]>> }) {
        for (const message of batch.outputs.level ?? []) probeHistory.push(message.value as number);
      },
      dispose() {},
    };
  };

  const createSource =
    (pin: 'PA15' | 'PB4') =>
    (context: { readonly inputs: Readonly<Record<string, { send(value: unknown): void }>> }) => {
      const level = context.inputs.level;

      if (level !== undefined) sources.set(pin, level);

      return { sync() {}, dispose() {} };
    };

  const entries = [
    { id: 'rig', model: rigModel.model, create: createRig() as never },
    { id: 'probe', model: probeModel.model, create: createProbe() as never },
    { id: 'srcPA15', model: sourceModel.model, create: createSource('PA15') as never },
    { id: 'srcPB4', model: sourceModel.model, create: createSource('PB4') as never },
  ];

  const board = createBoard(
    createDeviceLibrary(entries as never),
    {
      instances: [
        { id: 'rig', type: 'rig' },
        { id: 'probe', type: 'probe', props: { period: options.probePeriodPs ?? 10_000_000 } },
        { id: 'srcPA15', type: 'srcPA15' },
        { id: 'srcPB4', type: 'srcPB4' },
      ],
      nets: [
        {
          id: 'vdd',
          voltage: 3.3,
          pins: [
            { instance: 'rig', pin: 'VDD' },
            { instance: 'srcPA15', pin: 'vcc' },
            { instance: 'srcPB4', pin: 'vcc' },
          ],
        },
        {
          id: 'vss',
          voltage: 0,
          pins: [
            { instance: 'rig', pin: 'VSS' },
            { instance: 'srcPA15', pin: 'gnd' },
            { instance: 'srcPB4', pin: 'gnd' },
          ],
        },
        {
          id: 'PA0',
          pins: [
            { instance: 'rig', pin: 'PA0' },
            { instance: 'probe', pin: 'p' },
          ],
        },
        {
          id: 'PA15',
          pins: [
            { instance: 'rig', pin: 'PA15' },
            { instance: 'srcPA15', pin: 'y' },
          ],
        },
        {
          id: 'PB4',
          pins: [
            { instance: 'rig', pin: 'PB4' },
            { instance: 'srcPB4', pin: 'y' },
          ],
        },
      ],
    } as never,
    { execution: 'precise' },
  );

  const instance = (
    board as unknown as {
      readonly instances: readonly { readonly states: ReadonlyMap<string, unknown> }[];
    }
  ).instances[0]!;
  const state = (name: string): unknown => instance.states.get(name);

  return {
    board,
    time: () => board.time,
    state,
    probeHistory,
    send: (pin, level) => {
      const source = sources.get(pin);

      if (source === undefined) throw new Error(`source ${pin} is not ready`);
      source.send(level);
    },
    runUntil: (timePs) => board.runUntil(timePs),
    dispose: () => board.dispose(),
  };
}

/** 常用常量，避免测试文件重复写魔数。 */
export const TIM1 = 0x40012c00;
export const TIM16 = 0x40014400;
export const TIM2 = 0x40000000;
export const TIM3 = 0x40000400;
export const TIM6 = 0x40001000;
export const CR1 = 0x00;
export const DIER = 0x0c;
export const SR = 0x10;
export const EGR = 0x14;
export const CCMR1 = 0x18;
export const CCER = 0x20;
export const CNT = 0x24;
export const PSC = 0x28;
export const ARR = 0x2c;
export const CCR1 = 0x34;
export const BDTR = 0x44;
export const RCR = 0x30;
export const CR1_OPM = 1 << 3;
export const CR1_CEN = 1 << 0;
export const CR1_ARPE = 1 << 7;
export const DIER_UIE = 1 << 0;
export const DIER_CC1IE = 1 << 1;
export const SR_UIF = 1 << 0;
export const SR_CC1IF = 1 << 1;
export const EGR_UG = 1 << 0;

export const timerWrite = (
  body: Body,
  base: number,
  register: number,
  value: number | Value<number>,
): void => {
  timerModule.write(
    body,
    body.constant(types.number, base + register),
    4,
    typeof value === 'number' ? body.constant(types.number, value) : value,
  );
};

export const timerRead = (body: Body, base: number, register: number): Value<number> =>
  timerModule.read(body, body.constant(types.number, base + register), 4);

/** rig 没有 RCC 总线；直接置 `periph` 的 RCC 门控位，模拟中央 RCC 写。 */
export const enableClock = (body: Body, name: PeripheralClockName): void => {
  const gate = PERIPHERAL_CLOCKS[name];
  const offset = RCC_RCC_STATE + gate.enable;

  writeWordAt(
    body,
    PERIPH,
    offset,
    body.bitOr(readWordAt(body, PERIPH, offset), body.constant(types.number, 1 << gate.bit)),
  );
};

/** 仅清对应时钟门控位，用于 armed 的单项负向测试。 */
export const disableClock = (body: Body, name: PeripheralClockName): void => {
  const gate = PERIPHERAL_CLOCKS[name];
  const offset = RCC_RCC_STATE + gate.enable;

  writeWordAt(
    body,
    PERIPH,
    offset,
    body.bitAnd(
      readWordAt(body, PERIPH, offset),
      body.constant(types.number, ~(1 << gate.bit) >>> 0),
    ),
  );
};

/** 置/清对应 RSTR 位，模拟外设复位保持。 */
export const setClockReset = (body: Body, name: PeripheralClockName, held: boolean): void => {
  const gate = PERIPHERAL_CLOCKS[name];

  if (gate.reset < 0) return;
  const offset = RCC_RCC_STATE + gate.reset;
  const bit = body.constant(types.number, 1 << gate.resetBit);

  writeWordAt(
    body,
    PERIPH,
    offset,
    held
      ? body.bitOr(readWordAt(body, PERIPH, offset), bit)
      : body.bitAnd(readWordAt(body, PERIPH, offset), body.bitNot(bit)),
  );
};
