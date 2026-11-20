import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import { createDeviceBuilder, types } from '@mica-js/sdk/model';
import type { DeviceIR } from '@mica-js/sdk/model';
import {
  IRQ_DIRTY,
  txState,
  PENDING_PS,
  PERIPH_ACTIVE,
  SERVICE_MASK,
  SYSTICK_LOAD,
  SYSTICK_ON,
  TICK_ACTIVE,
  TICK_PS,
  TX_MASK,
  periphDeadlineState,
} from '@mica-js/stm32g431rbt6-core/layout';
import { asBody } from '@mica-js/stm32g431rbt6-core/ir';
import type { Body } from '@mica-js/stm32g431rbt6-core/ir';
import { activateMachine } from '@mica-js/stm32g431rbt6-core/machine';
import type { Machine } from '@mica-js/stm32g431rbt6-core/machine';

/**
 * ADC/模拟外设的专属 IR rig。
 *
 * 用一个真实 DeviceIR + 真实板运行时执行测试提供的 IR：DUT 只有 `analog` /
 * `periph` / `code` 与必要的调度 state，外部电阻分压器由独立器件提供，参考/供电
 * 接到固定电压网络。这样 ADC 的 `readSample` 走真实电气求解，不依赖 host 注入的
 * 假电压。最终固件端到端验收仍应使用 `harness.ts` 的真实 MCU。
 */

export interface RigState {
  readonly name: string;
  readonly type: 'number' | 'bool';
  readonly initial: number | boolean;
}

export interface DividerOptions {
  readonly pin: string;
  readonly top: number;
  readonly bottom: number;
}

export interface AdcRigOptions {
  readonly build: (b: Body) => void;
  readonly dividers?: readonly DividerOptions[];
  /** 从引脚到地的负载电阻，用于验证有限输出电阻。 */
  readonly loads?: readonly { readonly pin: string; readonly resistance: number }[];
  /** 可通过 host input 切换分压比的模拟源（0=1/4、1=1/2、2=3/4、3=VDD、4=0V）。 */
  readonly sources?: readonly { readonly pin: string; readonly initial: number }[];
  /** 每个 1 µs 节拍执行一次，用于驱动 DAC/OPAMP 的周期刷新。 */
  readonly onTick?: (b: Body) => void;
  readonly clockFrequency?: number;
  /** 不连接 VREFP 时为 true；用于验证参考浮空不产生数据。 */
  readonly floatingReference?: boolean;
  /** 不连接 VDDA 时为 true；用于验证模拟供电缺失。 */
  readonly unpoweredAnalog?: boolean;
}

export interface AdcRigView {
  readonly board: ReturnType<typeof createBoard>;
  memory(name: string): Uint8Array;
  state(name: string): unknown;
  /** 读取 DUT 引脚的电气采样，用于 DAC/OPAMP 输出验收。 */
  pinSample(pin: string): unknown;
  readonly inputs: Readonly<Record<string, { send(value: number): void }>>;
  dispose(): void;
}

const PICOSECONDS_PER_SECOND = 1_000_000_000_000;

export function dividerModel(name: string, top: number, bottom: number): DeviceIR {
  const builder = createDeviceBuilder({ name });

  builder.pin({
    name: 'y',
    initial: (body) =>
      body.returnValue(
        body.combineIntents(
          body.resistor('vcc', body.constant(types.number, top)),
          body.resistor('gnd', body.constant(types.number, bottom)),
        ),
      ),
  });
  builder.pin({ name: 'vcc' });
  builder.pin({ name: 'gnd' });

  return builder.finish();
}

function loadModel(name: string, resistance: number): DeviceIR {
  const builder = createDeviceBuilder({ name });

  builder.pin({
    name: 'y',
    initial: (body) =>
      body.returnValue(body.resistor('gnd', body.constant(types.number, resistance))),
  });
  builder.pin({ name: 'gnd' });

  return builder.finish();
}

function sourceModel(name: string, initial: number): DeviceIR {
  const builder = createDeviceBuilder({ name });
  const ratio = (body: {
    resistor(to: string, resistance: number): unknown;
    combineIntents(...values: unknown[]): unknown;
  }, level: number): unknown => {
    if (level === 0) return body.combineIntents(body.resistor('vcc', 30_000), body.resistor('gnd', 10_000));
    if (level === 1) return body.combineIntents(body.resistor('vcc', 10_000), body.resistor('gnd', 10_000));
    if (level === 2) return body.combineIntents(body.resistor('vcc', 10_000), body.resistor('gnd', 30_000));
    if (level === 3) return body.combineIntents(body.resistor('vcc', 1), body.resistor('gnd', 1_000_000_000));
    return body.combineIntents(body.resistor('vcc', 1_000_000_000), body.resistor('gnd', 1));
  };

  builder.pin({
    name: 'y',
    initial: (body) => body.returnValue(ratio(body as never, initial) as never),
  });
  builder.pin({ name: 'vcc' });
  builder.pin({ name: 'gnd' });
  builder.channel({ name: 'ratio', direction: 'input', type: types.number, capacity: 4 });
  builder.start((body) => {
    body.loop((loop) => {
      const level = loop.receive('ratio', types.number);

      for (const value of [0, 1, 2, 3, 4])
        loop.if(
          loop.equal(types.number, level, loop.constant(types.number, value)),
          (hit) => {
            const scope = asBody(hit);

            scope.writeIntent('y', ratio(scope as never, value) as never);
          },
        );
    });
  });

  return builder.finish();
}

function commonStates(): RigState[] {
  const states: RigState[] = [
    { name: 'pc', type: 'number', initial: 0 },
    { name: 'primask', type: 'number', initial: 0 },
    { name: IRQ_DIRTY, type: 'bool', initial: false },
    { name: SERVICE_MASK, type: 'number', initial: 0 },
    { name: PENDING_PS, type: 'number', initial: 0 },
    { name: TICK_PS, type: 'number', initial: 1_000_000_000_000 },
    { name: TICK_ACTIVE, type: 'bool', initial: false },
    { name: SYSTICK_ON, type: 'bool', initial: false },
    { name: SYSTICK_LOAD, type: 'number', initial: 0 },
    { name: TX_MASK, type: 'number', initial: 0 },
    { name: PERIPH_ACTIVE, type: 'number', initial: 0 },
    { name: periphDeadlineState(1), type: 'number', initial: 0 },
    { name: periphDeadlineState(14), type: 'number', initial: 0 },
    { name: periphDeadlineState(15), type: 'number', initial: 0 },
    { name: 'gpioModer0', type: 'number', initial: 0 },
    { name: 'gpioModer1', type: 'number', initial: 0 },
    { name: 'gpioModer2', type: 'number', initial: 0 },
    { name: 'gpioModer4', type: 'number', initial: 0 },
    { name: 'gpioPowered', type: 'bool', initial: false },
  ];

  for (const index of [1, 2, 3]) {
    states.push(
      { name: txState(index, 'Active'), type: 'number', initial: 0 },
      { name: txState(index, 'Remaining'), type: 'number', initial: 0 },
      { name: txState(index, 'Queue'), type: 'number', initial: 0 },
      { name: txState(index, 'Count'), type: 'number', initial: 0 },
      { name: txState(index, 'Period'), type: 'number', initial: 1 },
      { name: txState(index, 'Publish'), type: 'number', initial: -1 },
    );
  }

  return states;
}

interface InstanceView {
  readonly states: ReadonlyMap<string, unknown>;
  readonly memories: ReadonlyMap<string, Uint8Array>;
  readonly pins: ReadonlyMap<string, { readonly sample: unknown }>;
}

export function runAdcRig(options: AdcRigOptions): AdcRigView {
  const builder = createDeviceBuilder({ name: 'AdcRig' });

  builder.memory({ name: 'code', length: 64 });
  builder.memory({ name: 'sram', length: 0x200, public: true });
  builder.memory({ name: 'periph', length: 0x1000, public: true });
  builder.memory({ name: 'analog', length: 0x400, public: true });
  builder.memory({ name: 'out', length: 0x100, public: true });

  for (const state of commonStates()) {
    if (state.type === 'bool')
      builder.state({ name: state.name, type: types.bool, initial: state.initial === true });
    else builder.state({ name: state.name, type: types.number, initial: Number(state.initial) });
  }

  const pins = [
    'VDDA',
    'VREFP',
    'VSSA',
    'VDD1',
    'VSS1',
    'VBAT',
    'PA0',
    'PA1',
    'PA2',
    'PA3',
    'PA4',
    'PA5',
    'PA6',
    'PA7',
    'PB0',
    'PB1',
    'PB2',
    'PB11',
    'PB12',
    'PB14',
    'PB15',
    'PC0',
    'PC1',
    'PC2',
    'PC3',
    'PC4',
    'PC5',
    'PF0',
    'PF1',
  ];
  for (const pin of pins) builder.pin({ name: pin });

  const dividerPins = new Set<string>();
  for (const load of options.loads ?? []) {
    if (!dividerPins.has(load.pin)) {
      if (!pins.includes(load.pin)) builder.pin({ name: load.pin });
      dividerPins.add(load.pin);
    }
  }
  for (const divider of options.dividers ?? []) {
    if (!dividerPins.has(divider.pin)) {
      if (!pins.includes(divider.pin)) builder.pin({ name: divider.pin });
      dividerPins.add(divider.pin);
    }
  }

  const frequency = options.clockFrequency ?? 16_000_000;
  const machine: Machine = {
    clockFrequency: frequency,
    cyclePs: Math.max(1, Math.round(PICOSECONDS_PER_SECOND / frequency)),
    alternateDrivers: [],
    peripherals: [],
    interruptSources: [],
    profile: 'adc-rig',
  };

  // 用 process start 而不是 JIT：板运行时会在初始电气求解之后执行 start，
  // 因此 `readSample` 直接看到外部电阻网络的分压结果。
  activateMachine(machine, () => {
    builder.start((body) => {
      options.build(body as unknown as Body);
      if (options.onTick !== undefined) {
        const tick = options.onTick;

        body.loop((loop) => {
          loop.wait(1_000_000);
          activateMachine(machine, () => tick(loop as unknown as Body));
        });
      }
    });
  });

  const entries: {
    id: string;
    model: DeviceIR;
    create: (context: never) => { sync(): void; dispose(): void };
  }[] = [
    {
      id: 'dut',
      model: builder.finish(),
      create: () => ({ sync() {}, dispose() {} }),
    },
  ];
  const instances: {
    id: string;
    type: string;
  }[] = [{ id: 'dut', type: 'dut' }];
  const sourcedPins = new Set((options.sources ?? []).map((source) => source.pin));
  const nets: {
    id: string;
    pins: { instance: string; pin: string }[];
    voltage?: number;
  }[] = [
    {
      id: 'vdd',
      pins: [
        ...(options.unpoweredAnalog ? [] : [{ instance: 'dut', pin: 'VDDA' }]),
        ...(options.floatingReference || sourcedPins.has('VREFP')
          ? []
          : [{ instance: 'dut', pin: 'VREFP' }]),
        { instance: 'dut', pin: 'VDD1' },
      ],
      voltage: 3.3,
    },
    {
      id: 'vss',
      pins: [
        { instance: 'dut', pin: 'VSSA' },
        { instance: 'dut', pin: 'VSS1' },
      ],
      voltage: 0,
    },
  ];

  for (const load of options.loads ?? []) {
    const id = `load_${load.pin}`;

    entries.push({
      id,
      model: loadModel(`Load_${load.pin}_${load.resistance}`, load.resistance),
      create: () => ({ sync() {}, dispose() {} }),
    });
    instances.push({ id, type: id });
    nets.push({
      id: `load_net_${load.pin}`,
      pins: [
        { instance: 'dut', pin: load.pin },
        { instance: id, pin: 'y' },
      ],
    });
    nets.push({
      id: `load_gnd_${load.pin}`,
      pins: [{ instance: id, pin: 'gnd' }],
      voltage: 0,
    });
  }

  for (const source of options.sources ?? []) {
    const id = `src_${source.pin}`;

    entries.push({
      id,
      model: sourceModel(`Source_${source.pin}`, source.initial),
      create: (context: never) => {
        const typed = context as unknown as {
          inputs: { ratio: { send(value: number): void } };
        };

        sourceHandles[source.pin] = typed.inputs.ratio;

        return { sync() {}, dispose() {} };
      },
    });
    instances.push({ id, type: id });
    nets.push({
      id: `src_net_${source.pin}`,
      pins: [
        { instance: 'dut', pin: source.pin },
        { instance: id, pin: 'y' },
      ],
    });
    nets.push({
      id: `src_vcc_${source.pin}`,
      pins: [{ instance: id, pin: 'vcc' }],
      voltage: 3.3,
    });
    nets.push({
      id: `src_gnd_${source.pin}`,
      pins: [{ instance: id, pin: 'gnd' }],
      voltage: 0,
    });
  }

  for (const divider of options.dividers ?? []) {
    const id = `div_${divider.pin}`;

    entries.push({
      id,
      model: dividerModel(`Divider_${divider.pin}_${divider.top}_${divider.bottom}`, divider.top, divider.bottom),
      create: () => ({ sync() {}, dispose() {} }),
    });
    instances.push({ id, type: id });
    nets.push({
      id: `net_${divider.pin}`,
      pins: [
        { instance: 'dut', pin: divider.pin },
        { instance: id, pin: 'y' },
      ],
    });
    nets.push({
      id: `vcc_${divider.pin}`,
      pins: [{ instance: id, pin: 'vcc' }],
      voltage: 3.3,
    });
    nets.push({
      id: `gnd_${divider.pin}`,
      pins: [{ instance: id, pin: 'gnd' }],
      voltage: 0,
    });
  }

  const sourceHandles: Record<string, { send(value: number): void }> = {};
  const board = createBoard(createDeviceLibrary(entries as never), {
    instances: instances as never,
    nets: nets as never,
  });
  const instance = (board as unknown as { instances: readonly InstanceView[] }).instances[0]!;
  const memories = new Map<string, Uint8Array>();

  try {
    board.runUntil(10_000_000);
  } catch (cause) {
    board.dispose();
    throw cause;
  }

  for (const [name, bytes] of instance.memories) memories.set(name, bytes);

  return {
    board,
    memory: (name) => {
      const bytes = memories.get(name);

      if (bytes === undefined) throw new Error(`adc-rig: unknown memory ${name}`);

      return bytes;
    },
    state: (name) => instance.states.get(name),
    pinSample: (pin) => instance.pins.get(pin)?.sample,
    inputs: sourceHandles,
    dispose: () => board.dispose(),
  };
}
