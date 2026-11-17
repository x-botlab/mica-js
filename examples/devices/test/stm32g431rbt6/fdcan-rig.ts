import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import { createDeviceBuilder, types } from '@mica-js/sdk/model';
import type { DeviceIR } from '@mica-js/sdk/model';
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
import { FDCAN_MODULE } from '@mica-js/stm32g431rbt6-core/fdcan';

/** FDCAN 的专属 IR rig：真实 DeviceIR + 板运行时，不经过完整 MCU 固件。 */

export interface FdcanRigOptions {
  readonly build: (b: Body) => void;
}

export interface FdcanRigView {
  readonly board: ReturnType<typeof createBoard>;
  memory(name: string): Uint8Array;
  state(name: string): unknown;
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
    ...Array.from({ length: 16 }, (_, slot) => ({
      name: periphDeadlineState(slot),
      type: 'number' as const,
      initial: 0,
    })),
  ];
}

export function runFdcanRig(options: FdcanRigOptions): FdcanRigView {
  const builder = createDeviceBuilder({ name: 'FdcanRig' });

  builder.memory({ name: 'code', length: 64 });
  builder.memory({ name: 'sram', length: 0x200, public: true });
  builder.memory({ name: 'ccm', length: 0x100, public: true });
  builder.memory({ name: 'periph', length: 0x1000, public: true });
  builder.memory({ name: 'sys', length: 0x200, public: true });
  builder.memory({ name: 'can', length: 0x800, public: true });
  builder.memory({ name: 'flashState', length: 0x100, public: true });
  builder.memory({ name: 'out', length: 0x100, public: true });

  for (const state of rigStates()) {
    if (state.type === 'bool')
      builder.state({ name: state.name, type: types.bool, initial: state.initial === true });
    else builder.state({ name: state.name, type: types.number, initial: Number(state.initial) });
  }

  const machine: Machine = {
    clockFrequency: 16_000_000,
    cyclePs: 62_500,
    alternateDrivers: [],
    peripherals: [FDCAN_MODULE],
    interruptSources: FDCAN_MODULE.interrupts ?? [],
    profile: 'fdcan-rig',
  };

  activateMachine(machine, () => {
    builder.start((body) => options.build(body as unknown as Body));
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
  const board = createBoard(createDeviceLibrary(entries as never), {
    instances: [{ id: 'dut', type: 'dut' }],
    nets: [],
  } as never);
  const instance = (board as unknown as { instances: readonly InstanceView[] }).instances[0]!;
  const memories = new Map<string, Uint8Array>();

  try {
    board.runUntil(0);
  } catch (cause) {
    board.dispose();
    throw cause;
  }

  for (const [name, bytes] of instance.memories) memories.set(name, bytes);

  return {
    board,
    memory: (name) => {
      const bytes = memories.get(name);

      if (bytes === undefined) throw new Error(`fdcan-rig: unknown memory ${name}`);

      return bytes;
    },
    state: (name) => instance.states.get(name),
    dispose: () => board.dispose(),
  };
}
