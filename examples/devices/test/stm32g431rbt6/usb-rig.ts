import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import { createDeviceBuilder, types } from '@mica-js/sdk/model';
import type { Value } from '@mica-js/sdk/model';
import type { JitTranslate } from '@mica-js/sdk/device';
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
  USB,
  txState,
  periphDeadlineState,
} from '@mica-js/stm32g431rbt6-core/layout';
import { activateMachine } from '@mica-js/stm32g431rbt6-core/machine';
import type { Machine } from '@mica-js/stm32g431rbt6-core/machine';
import { USB_MODULE, initUsbMemory } from '@mica-js/stm32g431rbt6-core/usb';
import { USB_MEMORY_SIZE } from '@mica-js/stm32g431rbt6-core/usb-layout';
import type { Body } from '@mica-js/stm32g431rbt6-core/ir';

/**
 * USB 控制器的最小 IR rig：真实 Builder/JIT，真实的 USB 模块 read/write。
 * build 回调只执行一次，用于验证寄存器、PMA 与 EP 写语义；host 事务可以在
 * rig 返回后直接操作同一份 `usb` memory。
 */
export interface UsbRigState {
  readonly name: string;
  readonly type: 'number' | 'bool';
  readonly initial: number | boolean;
}

export interface UsbRigOptions {
  readonly build: (b: Body) => void;
  readonly states?: readonly UsbRigState[];
  readonly clockFrequency?: number;
}

export interface UsbRigView {
  readonly board: ReturnType<typeof createBoard>;
  memory(name: string): Uint8Array;
  state(name: string): unknown;
  dispose(): void;
}

const PICOSECONDS_PER_SECOND = 1_000_000_000_000;

function commonStates(): UsbRigState[] {
  const states: UsbRigState[] = [
    { name: 'pc', type: 'number', initial: 0 },
    { name: 'primask', type: 'number', initial: 0 },
    { name: IRQ_DIRTY, type: 'bool', initial: false },
    { name: SERVICE_MASK, type: 'number', initial: 0 },
    { name: PERIPH_ACTIVE, type: 'number', initial: 0 },
    { name: PENDING_PS, type: 'number', initial: 0 },
    { name: TICK_PS, type: 'number', initial: 1_000_000_000_000 },
    { name: TICK_ACTIVE, type: 'bool', initial: false },
    { name: SYSTICK_ON, type: 'bool', initial: false },
    { name: SYSTICK_LOAD, type: 'number', initial: 0 },
    { name: TX_MASK, type: 'number', initial: 0 },
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

  for (let slot = 0; slot < 16; slot += 1)
    states.push({ name: periphDeadlineState(slot), type: 'number', initial: 0 });

  return states;
}

interface InstanceView {
  readonly states: ReadonlyMap<string, unknown>;
  readonly memories: ReadonlyMap<string, Uint8Array>;
}

export function runUsbRig(options: UsbRigOptions): UsbRigView {
  const builder = createDeviceBuilder({ name: 'UsbRig' });
  const memories = new Map<string, Uint8Array>();

  builder.memory({ name: 'code', length: 64 });
  builder.memory({ name: 'sram', length: 0x100 });
  builder.memory({ name: 'ccm', length: 0x100 });
  builder.memory({ name: 'periph', length: 0x1000 });
  builder.memory({ name: USB, length: USB_MEMORY_SIZE, public: true });
  for (const state of [...commonStates(), ...(options.states ?? [])]) {
    if (state.type === 'bool')
      builder.state({ name: state.name, type: types.bool, initial: state.initial === true });
    else builder.state({ name: state.name, type: types.number, initial: Number(state.initial) });
  }

  const frequency = options.clockFrequency ?? 16_000_000;
  const machine: Machine = {
    clockFrequency: frequency,
    cyclePs: Math.max(1, Math.round(PICOSECONDS_PER_SECOND / frequency)),
    alternateDrivers: [],
    peripherals: [USB_MODULE],
    interruptSources: USB_MODULE.interrupts ?? [],
    profile: 'usb-rig',
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

        context.loadBytes('code', new Uint8Array(64));

        return { sync() {}, dispose: () => registration.dispose() };
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
  const usbMemory = instance.memories.get(USB);

  if (usbMemory === undefined) throw new Error('usb rig: missing usb memory');
  initUsbMemory(usbMemory);

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
    throw new Error(`usb rig faulted: ${diagnostics.join('; ') || board.status}`);
  }

  for (const [name, bytes] of instance.memories) memories.set(name, bytes);

  return {
    board,
    memory: (name) => {
      const bytes = memories.get(name);

      if (bytes === undefined) throw new Error(`usb rig: unknown memory ${name}`);

      return bytes;
    },
    state: (name) => instance.states.get(name),
    dispose: () => {
      subscription.dispose();
      board.dispose();
    },
  };
}

/** 从 IR 值读入一个公共 state，便于测试断言。 */
export function capture(b: Body, state: string, value: Value<number>): void {
  b.writeState(state, value);
}
