import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import { createDeviceBuilder, types } from '@mica-js/sdk/model';
import { compileDDL } from '@mica-js/sdk/ddl';
import {
  IRQ_DIRTY,
  PENDING_PS,
  PERIPH_ACTIVE,
  SERVICE_MASK,
  SYSTICK_LOAD,
  SYSTICK_ON,
  TICK_ACTIVE,
  TICK_PS,
  TX_MASK,
  txState,
  periphDeadlineState,
} from '@mica-js/stm32g431rbt6-core/layout';
import type { Body } from '@mica-js/stm32g431rbt6-core/ir';
import { activateMachine } from '@mica-js/stm32g431rbt6-core/machine';
import type { Machine } from '@mica-js/stm32g431rbt6-core/machine';
import { UCPD_MODULE } from '@mica-js/stm32g431rbt6-core/ucpd';

/** UCPD 的专属 IR rig：真实电阻 fixture、真实板电气求解、1 ms 等待后采样。 */

const FIXTURE_MODEL = `
device UcpdFixture(resistance: number default 56000, toVcc: bool default true, initialOn: bool default false) {
  pin y;
  pin vcc;
  pin gnd;
  input channel enable: number(capacity: 8, overflow: Overflow.drop_oldest);
  state enabled: number = 0;
  fn apply() {
    if enabled == 1 {
      if toVcc {
        y.intent <- [resistor(to: vcc, resistance: resistance)];
      } else {
        y.intent <- [resistor(to: gnd, resistance: resistance)];
      }
    } else {
      y.intent <- [];
    }
  }
  process start {
    if initialOn { enabled = 1; }
    apply();
    loop {
      enabled = await enable.receive();
      apply();
    }
  }
}
`;

const VOLTMETER_MODEL = `
device UcpdVoltmeter {
  pin p;
  output channel voltage: number(capacity: 64, overflow: Overflow.drop_oldest);
  fn report() {
    const v = p.sample.voltage;
    if v != none { voltage.send(v); } else { voltage.send(-1); }
  }
  process start { report(); }
  reaction changed on p.sample.voltage as (previous, current) { report(); }
}
`;

export interface UcpdRigOptions {
  readonly build: (b: Body, wait: (durationPs: number) => void) => void;
  /** PB6 外部的 5 V→56 k 源；关闭时为高阻。 */
  readonly cc1Source?: boolean;
  /** PB6 外部 5.1 k 下拉；用于验证 MCU source Rp。 */
  readonly cc1Load?: boolean;
  /** PB4 外部 5 V→56 k 源。 */
  readonly cc2Source?: boolean;
}

export interface UcpdRigView {
  readonly board: ReturnType<typeof createBoard>;
  memory(name: string): Uint8Array;
  state(name: string): unknown;
  voltage(pin: string): number | undefined;
  voltageHistory(pin: string): readonly number[];
  input(pin: string): { send(value: unknown): void } | undefined;
  dispose(): void;
}

interface InstanceView {
  readonly states: ReadonlyMap<string, unknown>;
  readonly memories: ReadonlyMap<string, Uint8Array>;
}

interface RigState {
  readonly name: string;
  readonly type: 'number' | 'bool';
  readonly initial: number | boolean;
}

function rigStates(): readonly RigState[] {
  return [
    { name: 'pc', type: 'number', initial: 0 },
    { name: 'primask', type: 'number', initial: 0 },
    { name: IRQ_DIRTY, type: 'bool', initial: false },
    { name: SERVICE_MASK, type: 'number', initial: 0 },
    { name: PENDING_PS, type: 'number', initial: 0 },
    { name: 'nowPs', type: 'number', initial: 0 },
    { name: TICK_PS, type: 'number', initial: 1_000_000_000_000 },
    { name: TICK_ACTIVE, type: 'bool', initial: false },
    { name: SYSTICK_ON, type: 'bool', initial: false },
    { name: SYSTICK_LOAD, type: 'number', initial: 0 },
    { name: TX_MASK, type: 'number', initial: 0 },
    { name: PERIPH_ACTIVE, type: 'number', initial: 0 },
    ...([1, 2, 3] as const).flatMap((index) =>
      (['Active', 'Remaining', 'Queue', 'Count', 'Period', 'Publish'] as const).map((field) => ({
        name: txState(index, field),
        type: 'number' as const,
        initial: field === 'Period' ? 1 : field === 'Publish' ? -1 : 0,
      })),
    ),
    { name: periphDeadlineState(11), type: 'number', initial: 0 },
  ];
}

export async function runUcpdRig(options: UcpdRigOptions): Promise<UcpdRigView> {
  const builder = createDeviceBuilder({ name: 'UcpdRig' });

  builder.memory({ name: 'code', length: 64 });
  builder.memory({ name: 'sram', length: 0x200, public: true });
  builder.memory({ name: 'periph', length: 0x1000, public: true });
  builder.memory({ name: 'sys', length: 0x200, public: true });
  builder.memory({ name: 'ucpd', length: 0x100, public: true });
  builder.memory({ name: 'out', length: 0x100, public: true });

  for (const state of rigStates()) {
    if (state.type === 'bool')
      builder.state({ name: state.name, type: types.bool, initial: state.initial === true });
    else builder.state({ name: state.name, type: types.number, initial: Number(state.initial) });
  }

  builder.pin({ name: 'PB6' });
  builder.pin({ name: 'PB4' });
  builder.pin({ name: 'VDD1' });
  builder.pin({ name: 'VSS1' });

  const machine: Machine = {
    clockFrequency: 16_000_000,
    cyclePs: 62_500,
    alternateDrivers: [],
    peripherals: [UCPD_MODULE],
    interruptSources: UCPD_MODULE.interrupts ?? [],
    profile: 'ucpd-rig',
  };

  activateMachine(machine, () => {
    builder.start((body) => {
      const wait = (durationPs: number): void => {
        body.wait(body.constant(types.number, durationPs));
      };

      options.build(body as unknown as Body, wait);
    });
  });

  const [fixture, voltmeter] = await Promise.all([
    compileDDL(FIXTURE_MODEL),
    compileDDL(VOLTMETER_MODEL),
  ]);
  const inputs = new Map<string, { send(value: unknown): void }>();
  const voltages = new Map<string, number>();
  const voltageHistory = new Map<string, number[]>();

  const entries = [
    {
      id: 'dut',
      model: builder.finish(),
      create: () => ({ sync() {}, dispose() {} }),
    },
    {
      id: 'cc1_source',
      model: fixture,
      create: (context: { readonly inputs: Record<string, { send(value: unknown): void }> }) => {
        const channel = context.inputs.enable;

        if (channel !== undefined) inputs.set('cc1_source', channel);

        return { sync() {}, dispose() {} };
      },
    },
    {
      id: 'cc1_load',
      model: fixture,
      create: (context: { readonly inputs: Record<string, { send(value: unknown): void }> }) => {
        const channel = context.inputs.enable;

        if (channel !== undefined) inputs.set('cc1_load', channel);

        return { sync() {}, dispose() {} };
      },
    },
    {
      id: 'cc2_source',
      model: fixture,
      create: (context: { readonly inputs: Record<string, { send(value: unknown): void }> }) => {
        const channel = context.inputs.enable;

        if (channel !== undefined) inputs.set('cc2_source', channel);

        return { sync() {}, dispose() {} };
      },
    },
    ...['cc1', 'cc2'].map((pin) => ({
      id: `volt_${pin}`,
      model: voltmeter,
      create: () => ({
        sync(batch: { readonly outputs: Readonly<Record<string, readonly { value: unknown }[]>> }) {
          const values = batch.outputs.voltage ?? [];

          for (const message of values) {
            const value = message.value as number;

            (voltageHistory.get(pin) ?? voltageHistory.set(pin, []).get(pin)!).push(value);
            voltages.set(pin, value);
          }
        },
        dispose() {},
      }),
    })),
  ];
  const instances = [
    { id: 'dut', type: 'dut' },
    {
      id: 'cc1_source',
      type: 'cc1_source',
      props: {
        resistance: 56_000,
        toVcc: true,
        initialOn: options.cc1Source !== false,
      },
    },
    {
      id: 'cc1_load',
      type: 'cc1_load',
      props: {
        resistance: 5_100,
        toVcc: false,
        initialOn: options.cc1Load === true,
      },
    },
    {
      id: 'cc2_source',
      type: 'cc2_source',
      props: {
        resistance: 56_000,
        toVcc: true,
        initialOn: options.cc2Source === true,
      },
    },
    { id: 'volt_cc1', type: 'volt_cc1' },
    { id: 'volt_cc2', type: 'volt_cc2' },
  ];
  const nets = [
    {
      id: 'vdd',
      pins: [{ instance: 'dut', pin: 'VDD1' }],
      voltage: 3.3,
    },
    {
      id: 'vss',
      pins: [
        { instance: 'dut', pin: 'VSS1' },
        { instance: 'cc1_source', pin: 'gnd' },
        { instance: 'cc1_load', pin: 'gnd' },
        { instance: 'cc2_source', pin: 'gnd' },
      ],
      voltage: 0,
    },
    {
      id: 'cc1_5v',
      pins: [{ instance: 'cc1_source', pin: 'vcc' }],
      voltage: 5,
    },
    {
      id: 'cc2_5v',
      pins: [{ instance: 'cc2_source', pin: 'vcc' }],
      voltage: 5,
    },
    {
      id: 'cc1',
      pins: [
        { instance: 'dut', pin: 'PB6' },
        { instance: 'cc1_source', pin: 'y' },
        { instance: 'cc1_load', pin: 'y' },
        { instance: 'volt_cc1', pin: 'p' },
      ],
    },
    {
      id: 'cc2',
      pins: [
        { instance: 'dut', pin: 'PB4' },
        { instance: 'cc2_source', pin: 'y' },
        { instance: 'volt_cc2', pin: 'p' },
      ],
    },
  ];

  const board = createBoard(createDeviceLibrary(entries as never), {
    instances: instances as never,
    nets: nets as never,
  });
  const instance = (board as unknown as { instances: readonly InstanceView[] }).instances[0]!;
  const memories = new Map<string, Uint8Array>();

  try {
    board.runUntil(5_000_000_000);
  } catch (cause) {
    board.dispose();
    throw cause;
  }

  for (const [name, bytes] of instance.memories) memories.set(name, bytes);

  return {
    board,
    memory: (name) => {
      const bytes = memories.get(name);

      if (bytes === undefined) throw new Error(`ucpd-rig: unknown memory ${name}`);

      return bytes;
    },
    state: (name) => instance.states.get(name),
    voltage: (pin) => voltages.get(pin),
    voltageHistory: (pin) => voltageHistory.get(pin) ?? [],
    input: (pin) => inputs.get(`${pin}_source`) ?? inputs.get(`${pin}_load`),
    dispose: () => board.dispose(),
  };
}
