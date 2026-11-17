import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import type { JitTranslate } from '@mica-js/sdk/device';
import { createDeviceBuilder, types } from '@mica-js/sdk/model';
import type { Value } from '@mica-js/sdk/model';
import {
  ADVANCE_ELAPSED,
  ADVANCE_PENDING,
  CRC,
  DEFER_READ,
  DEFER_READ_OFFSET,
  DEFER_READ_PORT,
  DEFER_READ_SIGNED,
  DEFER_READ_SIZE,
  DEFER_READ_TARGET,
  DEFER_WRITE,
  DEFER_WRITE_ADDR,
  DEFER_WRITE_SIZE,
  DEFER_WRITE_VALUE,
  DMA,
  GPIO_PIN_MASK,
  GPIO_POWERED,
  GPIO_WRITE,
  GPIO_WRITE_ADDR,
  GPIO_WRITE_SIZE,
  GPIO_WRITE_VALUE,
  IRQ_DIRTY,
  NOW_PS,
  PENDING_PS,
  PERIPH_ACTIVE,
  REG_STATES,
  RNG,
  RTC,
  SERVICE_MASK,
  SERVICE_RESUME,
  SYSTICK_COUNT,
  SYSTICK_CTRL,
  SYSTICK_LOAD,
  SYSTICK_ON,
  SYSTICK_PENDING,
  SYSTICK_VAL,
  TICK_ACTIVE,
  TICK_PS,
  TX_MASK,
  WATCHDOG,
  gpioAfr0State,
  gpioAfr1State,
  gpioLockState,
  gpioLockStepState,
  gpioModerState,
  gpioOdrState,
  gpioOtyperState,
  gpioPupdrState,
  gpioSimpleOutState,
  periphDeadlineState,
  txState,
} from '@mica-js/stm32g431rbt6-core/layout';
import type { Body } from '@mica-js/stm32g431rbt6-core/ir';
import { PORTS, activateMachine } from '@mica-js/stm32g431rbt6-core/machine';
import type { Machine } from '@mica-js/stm32g431rbt6-core/machine';
import type { PeripheralModule } from '@mica-js/stm32g431rbt6-core/peripheral';

/**
 * 外设模块的独立 IR rig：一个只有 code/sram/ccm/periph 的最小器件，JIT 在 pc=0
 * 执行测试提供的 IR，然后停止。所有外设行为仍走真实 IR builder 与真实板运行时；
 * 这里不复制 DMA/CRC/RTC 的算法，只提供内存与状态容器。
 */

export interface RigState {
  readonly name: string;
  readonly type: 'number' | 'bool';
  readonly initial: number | boolean;
}

export interface RigOptions {
  readonly build: (b: Body) => void;
  readonly states?: readonly RigState[];
  readonly clockFrequency?: number;
  readonly peripherals?: readonly PeripheralModule[];
  readonly sramSize?: number;
  readonly ccmSize?: number;
  readonly codeSize?: number;
}

export interface RigView {
  readonly board: ReturnType<typeof createBoard>;
  memory(name: string): Uint8Array;
  state(name: string): unknown;
  dispose(): void;
}

const PICOSECONDS_PER_SECOND = 1_000_000_000_000;

function commonStates(): RigState[] {
  const states: RigState[] = [
    { name: 'pc', type: 'number', initial: 0 },
    { name: 'primask', type: 'number', initial: 0 },
    { name: IRQ_DIRTY, type: 'bool', initial: false },
    { name: SERVICE_MASK, type: 'number', initial: 0 },
    { name: SERVICE_RESUME, type: 'number', initial: 0 },
    { name: 'pollContinue', type: 'bool', initial: false },
    { name: PERIPH_ACTIVE, type: 'number', initial: 0 },
    { name: PENDING_PS, type: 'number', initial: 0 },
    { name: TICK_PS, type: 'number', initial: 1_000_000_000_000 },
    { name: TICK_ACTIVE, type: 'bool', initial: false },
    { name: SYSTICK_ON, type: 'bool', initial: false },
    { name: SYSTICK_CTRL, type: 'number', initial: 0 },
    { name: SYSTICK_LOAD, type: 'number', initial: 0 },
    { name: SYSTICK_VAL, type: 'number', initial: 0 },
    { name: SYSTICK_COUNT, type: 'number', initial: 0 },
    { name: SYSTICK_PENDING, type: 'number', initial: 0 },
    { name: TX_MASK, type: 'number', initial: 0 },
    { name: 'gpioSync', type: 'number', initial: 0 },
    { name: NOW_PS, type: 'number', initial: 0 },
    { name: ADVANCE_ELAPSED, type: 'number', initial: 0 },
    { name: ADVANCE_PENDING, type: 'number', initial: 0 },
    { name: GPIO_PIN_MASK, type: 'number', initial: 0 },
    { name: GPIO_POWERED, type: 'bool', initial: false },
    { name: GPIO_WRITE, type: 'number', initial: 0 },
    { name: GPIO_WRITE_ADDR, type: 'number', initial: 0 },
    { name: GPIO_WRITE_VALUE, type: 'number', initial: 0 },
    { name: GPIO_WRITE_SIZE, type: 'number', initial: 4 },
    { name: DEFER_READ, type: 'bool', initial: false },
    { name: DEFER_READ_PORT, type: 'number', initial: 0 },
    { name: DEFER_READ_OFFSET, type: 'number', initial: 0 },
    { name: DEFER_READ_TARGET, type: 'number', initial: 0 },
    { name: DEFER_READ_SIZE, type: 'number', initial: 4 },
    { name: DEFER_READ_SIGNED, type: 'bool', initial: false },
    { name: DEFER_WRITE, type: 'bool', initial: false },
    { name: DEFER_WRITE_ADDR, type: 'number', initial: 0 },
    { name: DEFER_WRITE_VALUE, type: 'number', initial: 0 },
    { name: DEFER_WRITE_SIZE, type: 'number', initial: 4 },
  ];

  for (const register of REG_STATES)
    if (register !== 'pc')
      states.push({ name: register, type: 'number', initial: register === 'lr' ? 0xffffffff : 0 });
  states.push(
    { name: 'apsr', type: 'number', initial: 0x01000000 },
    { name: 'itState', type: 'number', initial: 0 },
    { name: 'halted', type: 'bool', initial: false },
    { name: 'faultPc', type: 'number', initial: 0 },
  );

  for (let port = 0; port < 5; port += 1)
    states.push(
      { name: gpioModerState(port), type: 'number', initial: 0 },
      { name: gpioOtyperState(port), type: 'number', initial: 0 },
      { name: gpioPupdrState(port), type: 'number', initial: 0 },
      { name: gpioAfr0State(port), type: 'number', initial: 0 },
      { name: gpioAfr1State(port), type: 'number', initial: 0 },
      { name: gpioOdrState(port), type: 'number', initial: 0 },
      { name: gpioSimpleOutState(port), type: 'number', initial: 0 },
      { name: gpioLockState(port), type: 'number', initial: 0 },
      { name: gpioLockStepState(port), type: 'number', initial: 0 },
    );

  for (let slot = 0; slot < 16; slot += 1)
    states.push({ name: periphDeadlineState(slot), type: 'number', initial: 0 });

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
}

export function runRig(options: RigOptions): RigView {
  const builder = createDeviceBuilder({ name: 'PeripheralRig' });
  const memories = new Map<string, Uint8Array>();

  builder.memory({ name: 'code', length: options.codeSize ?? 64 });
  builder.memory({ name: 'sram', length: options.sramSize ?? 0x100 });
  builder.memory({ name: 'ccm', length: options.ccmSize ?? 0x100 });
  builder.memory({ name: 'periph', length: 0x1000 });
  builder.memory({ name: 'sys', length: 0x200, public: true });
  builder.memory({ name: 'generic', length: 0x2000, public: true });
  builder.memory({ name: 'flashState', length: 0x100, public: true });
  for (const [name, length] of [
    ['analog', 0x400],
    ['i2c', 0x200],
    ['spi', 0x200],
    ['tim', 0x300],
    ['serial', 0x200],
    ['exti', 0x100],
    ['syscfg', 0x100],
    ['usb', 0x800],
    ['can', 0x800],
    ['ucpd', 0x100],
  ] as const)
    builder.memory({ name, length, public: true });
  builder.memory({ name: DMA, length: 0x400, public: true });
  builder.memory({ name: CRC, length: 0x20, public: true });
  builder.memory({ name: RNG, length: 0x20, public: true });
  builder.memory({ name: RTC, length: 0x100, public: true });
  builder.memory({ name: WATCHDOG, length: 0x40, public: true });
  builder.pin({ name: 'VDD1' });
  builder.pin({ name: 'VSS1' });
  for (const port of PORTS)
    for (const pin of port.pins) if (pin !== null) builder.pin({ name: pin });
  for (const state of commonStates()) {
    if (state.type === 'bool')
      builder.state({ name: state.name, type: types.bool, initial: state.initial === true });
    else builder.state({ name: state.name, type: types.number, initial: Number(state.initial) });
  }
  for (const state of options.states ?? []) {
    if (state.type === 'bool')
      builder.state({ name: state.name, type: types.bool, initial: state.initial === true });
    else builder.state({ name: state.name, type: types.number, initial: Number(state.initial) });
  }
  for (const index of [1, 2, 3]) {
    builder.channel({
      name: `uart${index}Tx`,
      direction: 'output',
      type: types.number,
      capacity: 64,
    });
  }

  const frequency = options.clockFrequency ?? 16_000_000;
  const machine: Machine = {
    clockFrequency: frequency,
    cyclePs: Math.max(1, Math.round(PICOSECONDS_PER_SECOND / frequency)),
    alternateDrivers: [],
    peripherals: options.peripherals ?? [],
    interruptSources: (options.peripherals ?? []).flatMap((peripheral) => peripheral.interrupts ?? []),
    profile: 'rig',
  };
  const translate: JitTranslate = ({ pc }, block) => {
    block.instruction({ pc, nextPc: pc }, (body) => {
      activateMachine(machine, () => options.build(body as unknown as Body));
      body.elapse(body.constant(types.number, 0));
      body.stop();
    });

    return block.finish();
  };

  const library = createDeviceLibrary([
    {
      id: 'rig',
      model: builder.finish(),
      create: (context) => {
        const registration = context.attachJit({
          entry: 'rig',
          code: 'code',
          pc: 'pc',
          translate,
        });

        try {
          context.loadBytes('code', new Uint8Array(options.codeSize ?? 64));
        } catch (cause) {
          registration.dispose();
          throw cause;
        }

        return {
          sync() {},
          dispose: () => registration.dispose(),
        };
      },
    },
  ]);
  const board = createBoard(library, {
    instances: [{ id: 'rig', type: 'rig' }],
    nets: [],
  });
  const diagnostics: string[] = [];
  const subscription = board.onDidError((diagnostic) => {
    diagnostics.push(`${diagnostic.code}: ${diagnostic.message}`);
  });
  const instance = (board as unknown as { instances: readonly InstanceView[] }).instances[0]!;

  try {
    board.runUntil(1);
  } catch (cause) {
    subscription.dispose();
    board.dispose();
    throw cause;
  }
  if (board.status !== 'ready') {
    subscription.dispose();
    board.dispose();
    throw new Error(`rig board faulted: ${diagnostics.join('; ') || board.status}`);
  }

  for (const [name, bytes] of instance.memories) memories.set(name, bytes);

  return {
    board,
    memory: (name) => {
      const bytes = memories.get(name);

      if (bytes === undefined) throw new Error(`rig: unknown memory ${name}`);

      return bytes;
    },
    state: (name) => instance.states.get(name),
    dispose: () => {
      subscription.dispose();
      board.dispose();
    },
  };
}

/** 从 IR 值读出 32 位结果并写入一个公共 state，便于测试断言。 */
export function capture(b: Body, state: string, value: Value<number>): void {
  b.writeState(state, value);
}
